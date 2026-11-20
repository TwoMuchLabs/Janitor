import fs from 'node:fs';
import { DEFAULT_CONFIG, type JanitorConfig } from './config.js';
import { Git } from './git.js';
import type {
  Category,
  CleanupItem,
  JanitorContext,
  Logger,
  RunReport,
  StepFailure,
  StepRecord,
} from './types.js';
import { runVerify } from './verify.js';

export type JanitorErrorCode = 'not-a-repo' | 'dirty-tree' | 'no-verify' | 'baseline-failed' | 'branch-exists';

/** A precondition was not met. Nothing in the repository has been changed. */
export class JanitorError extends Error {
  constructor(
    readonly code: JanitorErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'JanitorError';
  }
}

export interface RunOptions {
  root: string;
  categories: Category[];
  /** Shell commands that must all pass for a step to be kept. */
  verify: string[];
  config?: JanitorConfig;
  /** YYYY-MM-DD used in the branch name. Defaults to today (UTC). */
  date?: string;
  /** Scan and report only; do not touch the repository. */
  dryRun?: boolean;
  /** Permit running with no verification commands. Off by default: without tests, nothing is "safe". */
  allowUnverified?: boolean;
  /**
   * Categories (by name) whose changes are verified and reported but never
   * committed: the tree is put back after the checks pass.
   */
  proposeOnly?: string[];
  log?: Logger;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

const MAX_COMMIT_LINES = 50;

function commitMessage(cat: Category, items: CleanupItem[], verify: string[]): string {
  const lines = items.slice(0, MAX_COMMIT_LINES).map((i) => `- ${i.description}`);
  if (items.length > MAX_COMMIT_LINES) lines.push(`- ... and ${items.length - MAX_COMMIT_LINES} more`);
  const verified = verify.length ? `Verified with: ${verify.join(' && ')}` : 'Not verified (no verification commands)';
  return [
    `chore(janitor): ${cat.title.toLowerCase()} (${items.length} item${items.length === 1 ? '' : 's'})`,
    '',
    ...lines,
    '',
    `Applied by janitor. ${verified}`,
    '',
  ].join('\n');
}

/**
 * The safe-apply loop.
 *
 *   1. Refuse to start unless the tree is clean and the untouched code passes
 *      verification (otherwise a failure could not be attributed to a step).
 *   2. Create `<prefix>/<date>` and work through one category at a time.
 *   3. Apply a category's items, run the verification suite, and either commit
 *      or put the tree back exactly as it was at the last good commit.
 *   4. When a group fails, bisect it so one bad item cannot sink the rest.
 *
 * Invariant: between steps the working tree is clean and HEAD is the last
 * verified commit. Every kept step is exactly one commit, so every step can be
 * undone on its own with `git revert <sha>`.
 */
export async function runJanitor(options: RunOptions): Promise<RunReport> {
  const root = fs.realpathSync(options.root);
  const config = options.config ?? structuredClone(DEFAULT_CONFIG);
  const git = new Git(root);
  const ctx: JanitorContext = { root, git, config, log: options.log ?? (() => {}) };

  await refuseUnlessReady(git, root, options);
  const baseSha = await git.head();
  const date = options.date ?? todayUtc();
  const report: RunReport = {
    date,
    branch: `${config.branchPrefix}/${date}`,
    originalRef: await git.currentRef(),
    baseSha,
    headSha: baseSha,
    dryRun: Boolean(options.dryRun),
    changed: false,
    verifyCommands: options.verify,
    baseline: [],
    verifyRuns: 0,
    steps: [],
    notes: [],
  };
  const loop = new SafeApply(ctx, report, new Set(options.proposeOnly ?? []));

  if (options.dryRun) {
    for (const cat of options.categories) await loop.plan(cat);
    return report;
  }

  await loop.start();
  try {
    for (const cat of options.categories) await loop.clean(cat);
  } catch (err) {
    // Unexpected failure (git itself, disk, ...): leave a clean tree at the last verified commit.
    await loop.restoreLastGood().catch(() => {});
    throw err;
  }
  await loop.finish();
  return report;
}

/** Step 1 of the loop, the part that needs nothing run: is this a repository, is it clean, is there a safety net? */
async function refuseUnlessReady(git: Git, root: string, options: RunOptions): Promise<void> {
  if (!(await git.isRepo())) throw new JanitorError('not-a-repo', `${root} is not a git repository`);
  if (!options.dryRun && (await git.hasChanges())) {
    const paths = await git.changedPaths();
    const shown = paths.slice(0, 8).join(', ') + (paths.length > 8 ? `, and ${paths.length - 8} more` : '');
    throw new JanitorError(
      'dirty-tree',
      `working tree has uncommitted or untracked changes (${shown}); commit, stash or ignore them first`,
    );
  }
  if (options.verify.length === 0 && !options.allowUnverified && !options.dryRun) {
    throw new JanitorError(
      'no-verify',
      'no test, build or typecheck command found; pass --verify "<command>" (or --allow-unverified to proceed with no safety net)',
    );
  }
}

// A change that cannot even be made (the package manager's own command fails, say) usually
// fails the same way for every item. Two single items in a row is enough evidence to stop.
const APPLY_FAILURE_LIMIT = 2;

type StepOutcome = Omit<StepRecord, 'category' | 'title' | 'countsAsDeadCode' | 'items'>;

/** One run of the loop: the report being written, and the last commit known to pass verification. */
class SafeApply {
  private lastGood: string;
  private readonly applyFailures = new Map<string, number>();
  private readonly git: Git;
  private readonly timeoutMs: number;

  constructor(
    private readonly ctx: JanitorContext,
    private readonly report: RunReport,
    private readonly proposeOnly: Set<string>,
  ) {
    this.git = ctx.git;
    this.lastGood = report.baseSha;
    this.timeoutMs = ctx.config.verifyTimeoutSec * 1000;
  }

  /** Dry run: record what a category would try. */
  async plan(cat: Category): Promise<void> {
    const items = await this.scan(cat);
    if (items.length) this.record(cat, items, { status: 'planned', proposeOnly: this.proposeOnly.has(cat.name) });
  }

  /** Verify the untouched tree, then move to a fresh branch. */
  async start(): Promise<void> {
    const { report, git } = this;
    this.ctx.log('running baseline verification on the untouched tree');
    const baseline = await runVerify(report.verifyCommands, this.ctx.root, this.timeoutMs);
    report.baseline = baseline.results;
    if (!baseline.ok) {
      const f = baseline.failed!;
      throw new JanitorError(
        'baseline-failed',
        `baseline verification failed before any cleanup: \`${f.command}\` ${f.timedOut ? 'timed out' : `exited ${f.exitCode}`}`,
        f.outputTail,
      );
    }
    // A suite that writes untracked files would make every later step look dirty.
    if (await git.hasChanges()) await git.restore(report.baseSha);

    if (await git.branchExists(report.branch)) {
      throw new JanitorError('branch-exists', `branch ${report.branch} already exists; delete it or pass a different --date`);
    }
    await git.createBranch(report.branch);
  }

  /** Scan one category and work through what it found. */
  async clean(cat: Category): Promise<void> {
    const items = await this.scan(cat);
    // Scans are read-only by contract; enforce it rather than trust it.
    if (await this.git.hasChanges()) await this.restoreLastGood();
    if (items.length) await this.processGroup(cat, items);
  }

  restoreLastGood(): Promise<void> {
    return this.git.restore(this.lastGood);
  }

  async finish(): Promise<void> {
    const { report } = this;
    report.headSha = this.lastGood;
    report.changed = this.lastGood !== report.baseSha;
    if (!report.changed) {
      // Nothing survived verification: do not leave an empty branch behind.
      await this.git.checkout(report.originalRef);
      await this.git.deleteBranch(report.branch);
    }
  }

  private record(cat: Category, items: CleanupItem[], outcome: StepOutcome): void {
    this.report.steps.push({
      category: cat.name,
      title: cat.title,
      countsAsDeadCode: cat.countsAsDeadCode,
      items: items.map((i) => ({ id: i.id, description: i.description, ...(i.paths ? { paths: i.paths } : {}) })),
      ...outcome,
    });
  }

  private async scan(cat: Category): Promise<CleanupItem[]> {
    const { log } = this.ctx;
    log(`[${cat.name}] scanning`);
    try {
      const result = await cat.scan(this.ctx);
      for (const note of result.notes) this.report.notes.push({ category: cat.name, note });
      log(`[${cat.name}] ${result.items.length} candidate(s)`);
      return result.items;
    } catch (err) {
      this.report.notes.push({ category: cat.name, note: `Scan failed and the category was skipped: ${(err as Error).message}` });
      return [];
    }
  }

  private async revert(cat: Category): Promise<void> {
    await this.restoreLastGood();
    if (cat.afterRevert) await cat.afterRevert(this.ctx);
  }

  /** Why a group will not even be tried, if there is a reason. */
  private skipReason(cat: Category): string | undefined {
    const { maxVerifyRuns } = this.ctx.config;
    if ((this.applyFailures.get(cat.name) ?? 0) >= APPLY_FAILURE_LIMIT) {
      return `the ${APPLY_FAILURE_LIMIT} before could not be applied at all, so the rest were not tried`;
    }
    if (this.report.verifyRuns >= maxVerifyRuns) return `verification budget of ${maxVerifyRuns} runs exhausted`;
    return undefined;
  }

  /** Make the changes. Returns what went wrong when one of them could not be made. */
  private async applyItems(cat: Category, items: CleanupItem[]): Promise<StepFailure | undefined> {
    try {
      for (const item of items) await item.apply(this.ctx);
    } catch (err) {
      if (items.length === 1) this.applyFailures.set(cat.name, (this.applyFailures.get(cat.name) ?? 0) + 1);
      return { command: '(apply)', exitCode: -1, timedOut: false, outputTail: err instanceof Error ? err.message : String(err) };
    }
    this.applyFailures.delete(cat.name);
    return undefined;
  }

  /** Verify the applied changes and keep, propose or drop them. Returns the failed check when they must be reverted. */
  private async settle(cat: Category, items: CleanupItem[]): Promise<StepFailure | undefined> {
    const { git, report } = this;
    const { log } = this.ctx;
    // Stage the step now, so that anything the verification suite writes
    // (coverage, build output, updated snapshots) can never end up in the commit.
    if (!(await git.stageAll())) {
      this.record(cat, items, { status: 'noop' });
      log(`[${cat.name}] ${items.length} item(s) changed nothing; skipped`);
      return undefined;
    }
    report.verifyRuns++;
    log(`[${cat.name}] verifying ${items.length} item(s)`);
    const result = await runVerify(report.verifyCommands, this.ctx.root, this.timeoutMs);
    if (!result.ok) {
      const f = result.failed!;
      return { command: f.command, exitCode: f.exitCode, timedOut: f.timedOut, outputTail: f.outputTail };
    }
    if (this.proposeOnly.has(cat.name)) {
      // The project passes without these, which is worth telling a reviewer; acting on it is their call.
      await this.revert(cat);
      this.record(cat, items, { status: 'proposed' });
      log(`[${cat.name}] ${items.length} item(s) pass the checks when removed; proposed, not applied`);
      return undefined;
    }
    const sha = await git.commitStaged(commitMessage(cat, items, report.verifyCommands));
    if (await git.hasChanges()) await git.restore(sha);
    const stats = await git.diffStats(this.lastGood, sha);
    this.lastGood = sha;
    this.record(cat, items, { status: 'kept', sha, stats });
    log(`[${cat.name}] kept ${items.length} item(s) as ${sha.slice(0, 9)}`);
    return undefined;
  }

  /** Resolves to true when every item ended up kept, proposed or a no-op. */
  private async processGroup(cat: Category, items: CleanupItem[]): Promise<boolean> {
    const reason = this.skipReason(cat);
    if (reason) {
      this.record(cat, items, { status: 'skipped', reason });
      return false;
    }
    const failure = (await this.applyItems(cat, items)) ?? (await this.settle(cat, items));
    if (!failure) return true;

    await this.revert(cat);
    this.ctx.log(`[${cat.name}] reverted ${items.length} item(s): ${failure.command} failed`);
    if (items.length > 1 && this.ctx.config.bisect) return this.bisect(cat, items, failure);
    this.record(cat, items, { status: 'reverted', failure });
    return false;
  }

  /** A group failed: try its halves, so one bad item cannot sink the rest. */
  private async bisect(cat: Category, items: CleanupItem[], failure: StepFailure): Promise<boolean> {
    const mid = Math.ceil(items.length / 2);
    const first = await this.processGroup(cat, items.slice(0, mid));
    const second = await this.processGroup(cat, items.slice(mid));
    if (first && second && failure.command !== '(apply)') {
      // Together they failed, apart they all passed. Changes can interact, but far more
      // often this is a check that does not give the same answer twice.
      this.report.notes.push({
        category: cat.name,
        note: `\`${failure.command}\` failed on ${items.length} changes together, then passed on every one of them separately. That usually means the check is flaky. The changes were kept because each passed, so give them a second look.`,
      });
    }
    return first && second;
  }
}

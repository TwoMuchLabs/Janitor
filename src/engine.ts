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
  const log = options.log ?? (() => {});
  const git = new Git(root);
  const ctx: JanitorContext = { root, git, config, log };
  const verify = options.verify;
  const timeoutMs = config.verifyTimeoutSec * 1000;

  if (!(await git.isRepo())) throw new JanitorError('not-a-repo', `${root} is not a git repository`);
  if (!options.dryRun && (await git.hasChanges())) {
    throw new JanitorError('dirty-tree', 'working tree has uncommitted or untracked changes; commit or stash them first');
  }
  if (verify.length === 0 && !options.allowUnverified && !options.dryRun) {
    throw new JanitorError(
      'no-verify',
      'no test, build or typecheck command found; pass --verify "<command>" (or --allow-unverified to proceed with no safety net)',
    );
  }

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
    verifyCommands: verify,
    baseline: [],
    verifyRuns: 0,
    steps: [],
    notes: [],
  };

  const record = (cat: Category, items: CleanupItem[], rest: Omit<StepRecord, 'category' | 'title' | 'countsAsDeadCode' | 'items'>) => {
    report.steps.push({
      category: cat.name,
      title: cat.title,
      countsAsDeadCode: cat.countsAsDeadCode,
      items: items.map((i) => ({ id: i.id, description: i.description })),
      ...rest,
    });
  };

  const scan = async (cat: Category) => {
    log(`[${cat.name}] scanning`);
    try {
      const result = await cat.scan(ctx);
      for (const note of result.notes) report.notes.push({ category: cat.name, note });
      log(`[${cat.name}] ${result.items.length} candidate(s)`);
      return result.items;
    } catch (err) {
      report.notes.push({ category: cat.name, note: `Scan failed and the category was skipped: ${(err as Error).message}` });
      return [];
    }
  };

  if (options.dryRun) {
    for (const cat of options.categories) {
      const items = await scan(cat);
      if (items.length) record(cat, items, { status: 'planned' });
    }
    return report;
  }

  log('running baseline verification on the untouched tree');
  const baseline = await runVerify(verify, root, timeoutMs);
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
  if (await git.hasChanges()) await git.restore(baseSha);

  if (await git.branchExists(report.branch)) {
    throw new JanitorError('branch-exists', `branch ${report.branch} already exists; delete it or pass a different --date`);
  }
  await git.createBranch(report.branch);

  let lastGood = baseSha;

  const revert = async (cat: Category) => {
    await git.restore(lastGood);
    if (cat.afterRevert) await cat.afterRevert(ctx);
  };

  const processGroup = async (cat: Category, items: CleanupItem[]): Promise<void> => {
    if (report.verifyRuns >= config.maxVerifyRuns) {
      record(cat, items, { status: 'skipped', reason: `verification budget of ${config.maxVerifyRuns} runs exhausted` });
      return;
    }

    let failure: StepFailure | undefined;
    try {
      for (const item of items) await item.apply(ctx);
    } catch (err) {
      failure = { command: '(apply)', exitCode: -1, timedOut: false, outputTail: err instanceof Error ? err.message : String(err) };
    }

    if (!failure) {
      // Stage the step now, so that anything the verification suite writes
      // (coverage, build output, updated snapshots) can never end up in the commit.
      if (!(await git.stageAll())) {
        record(cat, items, { status: 'noop' });
        return;
      }
      report.verifyRuns++;
      log(`[${cat.name}] verifying ${items.length} item(s)`);
      const result = await runVerify(verify, root, timeoutMs);
      if (result.ok) {
        const sha = await git.commitStaged(commitMessage(cat, items, verify));
        if (await git.hasChanges()) await git.restore(sha);
        const stats = await git.diffStats(lastGood, sha);
        lastGood = sha;
        record(cat, items, { status: 'kept', sha, stats });
        log(`[${cat.name}] kept ${items.length} item(s) as ${sha.slice(0, 9)}`);
        return;
      }
      const f = result.failed!;
      failure = { command: f.command, exitCode: f.exitCode, timedOut: f.timedOut, outputTail: f.outputTail };
    }

    await revert(cat);
    log(`[${cat.name}] reverted ${items.length} item(s): ${failure.command} failed`);

    if (items.length > 1 && config.bisect) {
      const mid = Math.ceil(items.length / 2);
      await processGroup(cat, items.slice(0, mid));
      await processGroup(cat, items.slice(mid));
      return;
    }
    record(cat, items, { status: 'reverted', failure });
  };

  try {
    for (const cat of options.categories) {
      const items = await scan(cat);
      // Scans are read-only by contract; enforce it rather than trust it.
      if (await git.hasChanges()) await git.restore(lastGood);
      if (items.length) await processGroup(cat, items);
    }
  } catch (err) {
    // Unexpected failure (git itself, disk, ...): leave a clean tree at the last verified commit.
    await git.restore(lastGood).catch(() => {});
    throw err;
  }

  report.headSha = lastGood;
  report.changed = lastGood !== baseSha;
  if (!report.changed) {
    // Nothing survived verification: do not leave an empty branch behind.
    await git.checkout(report.originalRef);
    await git.deleteBranch(report.branch);
  }
  return report;
}

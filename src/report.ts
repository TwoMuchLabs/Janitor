import type { RunReport, StepRecord } from './types.js';

interface CategoryTotals {
  category: string;
  title: string;
  kept: number;
  reverted: number;
  skipped: number;
  /** Net bytes removed from the repository (negative if the category added bytes). */
  bytesRemoved: number;
  linesDeleted: number;
  linesAdded: number;
  commits: string[];
}

interface Totals {
  categories: CategoryTotals[];
  /** Net bytes removed across everything that was kept. */
  bytesRemoved: number;
  /** Lines deleted by dead-code categories only (lockfile churn is not dead code). */
  deadCodeLines: number;
  deadCodeBytes: number;
  itemsKept: number;
  itemsReverted: number;
  commits: number;
}

export function computeTotals(report: RunReport): Totals {
  const byCategory = new Map<string, CategoryTotals>();
  const totals: Totals = {
    categories: [],
    bytesRemoved: 0,
    deadCodeLines: 0,
    deadCodeBytes: 0,
    itemsKept: 0,
    itemsReverted: 0,
    commits: 0,
  };

  for (const step of report.steps) {
    let cat = byCategory.get(step.category);
    if (!cat) {
      cat = {
        category: step.category,
        title: step.title,
        kept: 0,
        reverted: 0,
        skipped: 0,
        bytesRemoved: 0,
        linesDeleted: 0,
        linesAdded: 0,
        commits: [],
      };
      byCategory.set(step.category, cat);
      totals.categories.push(cat);
    }
    if (step.status === 'kept' && step.stats && step.sha) {
      const bytes = step.stats.bytesBefore - step.stats.bytesAfter;
      cat.kept += step.items.length;
      cat.bytesRemoved += bytes;
      cat.linesDeleted += step.stats.linesDeleted;
      cat.linesAdded += step.stats.linesAdded;
      cat.commits.push(step.sha);
      totals.itemsKept += step.items.length;
      totals.bytesRemoved += bytes;
      totals.commits++;
      if (step.countsAsDeadCode) {
        totals.deadCodeLines += step.stats.linesDeleted;
        totals.deadCodeBytes += bytes;
      }
    } else if (step.status === 'reverted') {
      cat.reverted += step.items.length;
      totals.itemsReverted += step.items.length;
    } else if (step.status === 'skipped') {
      cat.skipped += step.items.length;
    }
  }
  return totals;
}

export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} kB`;
  return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MB`;
}

const short = (sha: string) => sha.slice(0, 9);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function fence(text: string, lang = ''): string {
  // Use a fence longer than any backtick run in the content.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function itemList(step: StepRecord, limit = 15): string[] {
  const lines = step.items.slice(0, limit).map((i) => `- ${i.description}`);
  if (step.items.length > limit) lines.push(`- ... and ${step.items.length - limit} more`);
  return lines;
}

export function prTitle(report: RunReport): string {
  return `chore(janitor): nightly cleanup ${report.date}`;
}

/** The structured PR description: what was removed, what was reverted, and how to undo it. */
export function renderPrBody(report: RunReport): string {
  const totals = computeTotals(report);
  const kept = report.steps.filter((s) => s.status === 'kept');
  const reverted = report.steps.filter((s) => s.status === 'reverted');
  const skipped = report.steps.filter((s) => s.status === 'skipped');
  const out: string[] = [];

  out.push(`## Nightly janitor: ${report.date}`, '');
  out.push(
    `Removed **${formatBytes(totals.deadCodeBytes)}** and **${plural(totals.deadCodeLines, 'line')}** of dead code ` +
      `in ${plural(totals.commits, 'verified commit')}. ` +
      `${plural(totals.itemsKept, 'change')} kept, ${totals.itemsReverted} reverted automatically.`,
    '',
  );
  out.push(
    `Every commit on this branch passed the full verification suite on its own. Base: \`${short(report.baseSha)}\`, head: \`${short(report.headSha)}\`.`,
    '',
  );

  out.push('### Summary', '');
  out.push('| Category | Kept | Reverted | Bytes removed | Lines deleted | Lines added | Commits |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const c of totals.categories) {
    out.push(
      `| ${c.title} | ${c.kept} | ${c.reverted} | ${formatBytes(c.bytesRemoved)} | ${c.linesDeleted} | ${c.linesAdded} | ${c.commits.map((s) => `\`${short(s)}\``).join(' ') || '-'} |`,
    );
  }
  out.push(
    `| **Total** | **${totals.itemsKept}** | **${totals.itemsReverted}** | **${formatBytes(totals.bytesRemoved)}** | | | ${totals.commits} |`,
    '',
  );

  if (kept.length) {
    out.push('### What changed', '');
    for (const step of kept) {
      out.push(`**${step.title}** (\`${short(step.sha!)}\`, ${plural(step.items.length, 'item')})`, '', ...itemList(step), '');
    }
  }

  if (reverted.length) {
    out.push('### Reverted automatically', '');
    out.push('These changes broke verification, were rolled back, and are **not** in this PR.', '');
    for (const step of reverted) {
      const f = step.failure!;
      const why = f.timedOut ? 'timed out' : `exited ${f.exitCode}`;
      out.push(...itemList(step));
      out.push('', `<details><summary><code>${f.command}</code> ${why}</summary>`, '', fence(f.outputTail || '(no output)'), '', '</details>', '');
    }
  }

  if (skipped.length) {
    out.push('### Not attempted', '');
    for (const step of skipped) out.push(`- ${step.title}: ${plural(step.items.length, 'item')} (${step.reason})`);
    out.push('');
  }

  if (report.notes.length) {
    out.push('### Needs a human', '');
    for (const n of report.notes) out.push(`- **${n.category}**: ${n.note}`);
    out.push('');
  }

  out.push('### Verification', '');
  if (report.baseline.length) {
    out.push(`Run before any change and again after every step (${plural(report.verifyRuns, 'step run')}):`, '');
    for (const b of report.baseline) out.push(`- \`${b.command}\` (baseline ${seconds(b.durationMs)})`);
  } else {
    out.push('No verification commands were run.');
  }
  out.push('');

  out.push('### Rollback', '');
  const cmds: string[] = [];
  if (kept.length) {
    cmds.push('# Undo a single step (on this branch, or on the base branch after a merge-commit merge):');
    for (const step of kept) cmds.push(`git revert --no-edit ${step.sha}   # ${step.title}`);
    cmds.push('');
    cmds.push('# Undo everything before merge: close this PR, then delete the branch');
    cmds.push(`git push origin --delete ${report.branch}`);
    cmds.push('');
    cmds.push('# Undo everything after a merge-commit merge:');
    cmds.push(`git revert --no-edit ${report.baseSha}..${report.headSha}`);
    cmds.push('');
    cmds.push('# Squash or rebase merges rewrite the shas above; revert the commit(s) GitHub created instead:');
    cmds.push('git revert --no-edit <sha-on-base-branch>');
  } else {
    cmds.push('# Nothing was changed.');
  }
  out.push(fence(cmds.join('\n'), 'bash'), '');
  out.push('<sub>Generated by janitor.</sub>', '');
  return out.join('\n');
}

/** Plain-text plan for `janitor scan`. */
export function renderPlan(report: RunReport): string {
  const out: string[] = [];
  const total = report.steps.reduce((n, s) => n + s.items.length, 0);
  out.push(`janitor plan (dry run): ${plural(total, 'candidate')}`, '');
  for (const step of report.steps) {
    out.push(`${step.title} (${step.items.length})`);
    for (const item of step.items) out.push(`  - ${item.description.replace(/`/g, '')}`);
    out.push('');
  }
  if (report.notes.length) {
    out.push('Notes');
    for (const n of report.notes) out.push(`  - [${n.category}] ${n.note.replace(/`/g, '')}`);
    out.push('');
  }
  out.push(
    report.verifyCommands.length
      ? `A real run would verify each step with: ${report.verifyCommands.join(' && ')}`
      : 'No verification commands detected: a real run would refuse to start. Pass --verify "<command>".',
  );
  return out.join('\n');
}

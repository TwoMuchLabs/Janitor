#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { selectCategories } from './categories/index.js';
import { ALL_CATEGORIES, ConfigError, loadConfig } from './config.js';
import { JanitorError, runJanitor } from './engine.js';
import { Git } from './git.js';
import { computeTotals, formatBytes, prTitle, renderPlan, renderPrBody } from './report.js';
import { detectVerifyCommands } from './verify.js';

const VERSION = '0.1.0';

const HELP = `janitor ${VERSION}
Clean up a repository one verified step at a time.

Usage
  janitor run  [options]   Create nightly-janitor/YYYY-MM-DD and apply verified cleanups
  janitor scan [options]   Dry run: list what would be attempted, change nothing

Options
  --repo <path>            Repository to clean (default: current directory)
  --categories <list>      Comma-separated subset of: ${ALL_CATEGORIES.join(', ')}
  --verify <command>       Verification command; repeat for several. Default: detected
                           from the project (typecheck, build, test)
  --date <YYYY-MM-DD>      Date used in the branch name (default: today, UTC)
  --no-bisect              Revert a whole category on failure instead of salvaging safe items
  --max-verify-runs <n>    Upper bound on verification runs for the night (default: 25)
  --timeout-sec <n>        Timeout per verification command (default: 1200)
  --pr-body <file>         Where to write the PR description (default: <git-dir>/janitor/pr-body.md)
  --report-json <file>     Where to write the machine-readable report
  --allow-unverified       Run even when no verification command exists (not recommended)
  -h, --help               Show this help
  -v, --version            Show the version

Configuration is read from .janitor.json in the repository root; flags win.

Exit codes: 0 finished (with or without changes), 2 a precondition failed and nothing
was touched (dirty tree, failing baseline, existing branch, no verification), 1 error.
`;

function fail(message: string, code: number, detail?: string): never {
  process.stderr.write(`janitor: ${message}\n`);
  if (detail) process.stderr.write(`\n${detail}\n`);
  process.exit(code);
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      categories: { type: 'string' },
      verify: { type: 'string', multiple: true },
      date: { type: 'string' },
      'no-bisect': { type: 'boolean' },
      'max-verify-runs': { type: 'string' },
      'timeout-sec': { type: 'string' },
      'pr-body': { type: 'string' },
      'report-json': { type: 'string' },
      'allow-unverified': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  const command = positionals[0] ?? 'run';
  if (values.help || command === 'help') return void process.stdout.write(HELP);
  if (command !== 'run' && command !== 'scan') fail(`unknown command "${command}" (try --help)`, 1);

  const root = path.resolve(values.repo ?? process.cwd());
  if (!fs.existsSync(root)) fail(`${root} does not exist`, 2);

  const config = loadConfig(root);
  if (values.categories) config.categories = values.categories.split(',').map((s) => s.trim()).filter(Boolean);
  if (values['no-bisect']) config.bisect = false;
  for (const [flag, key] of [['max-verify-runs', 'maxVerifyRuns'], ['timeout-sec', 'verifyTimeoutSec']] as const) {
    const raw = values[flag];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) fail(`--${flag} must be a positive number`, 1);
    config[key] = n;
  }
  if (values.date && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) fail('--date must be YYYY-MM-DD', 1);

  const verify = (values.verify?.length ? values.verify : config.verify) ?? detectVerifyCommands(root);
  const report = await runJanitor({
    root,
    categories: selectCategories(config.categories),
    verify: verify.map((v) => v.trim()).filter(Boolean),
    config,
    date: values.date,
    dryRun: command === 'scan',
    allowUnverified: values['allow-unverified'],
    log: (m) => process.stderr.write(`${m}\n`),
  });

  if (command === 'scan') {
    process.stdout.write(`${renderPlan(report)}\n`);
    return;
  }

  // Outputs live inside the git directory by default so the working tree stays clean.
  const outDir = path.join(await new Git(root).gitDir(), 'janitor');
  const prBodyFile = path.resolve(values['pr-body'] ?? path.join(outDir, 'pr-body.md'));
  const reportFile = path.resolve(values['report-json'] ?? path.join(outDir, 'report.json'));
  const totals = computeTotals(report);
  writeFile(prBodyFile, renderPrBody(report));
  writeFile(reportFile, `${JSON.stringify({ ...report, totals }, null, 2)}\n`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `changed=${report.changed}`,
        `branch=${report.branch}`,
        `base-sha=${report.baseSha}`,
        `head-sha=${report.headSha}`,
        `pr-title=${prTitle(report)}`,
        `pr-body-file=${prBodyFile}`,
        `report-file=${reportFile}`,
        '',
      ].join('\n'),
    );
  }

  if (report.changed) {
    process.stdout.write(
      [
        '',
        `Branch ${report.branch}: ${totals.commits} verified commit(s), ${totals.itemsKept} change(s) kept, ${totals.itemsReverted} reverted.`,
        `Dead code removed: ${formatBytes(totals.deadCodeBytes)}, ${totals.deadCodeLines} line(s).`,
        `PR description: ${prBodyFile}`,
        '',
      ].join('\n'),
    );
  } else {
    process.stdout.write(
      `\nNothing to clean up${totals.itemsReverted ? ` (${totals.itemsReverted} candidate(s) reverted)` : ''}. No branch was left behind.\nReport: ${reportFile}\n`,
    );
  }
}

main().catch((err: unknown) => {
  if (err instanceof JanitorError) fail(err.message, 2, err.detail);
  if (err instanceof ConfigError) fail(err.message, 2);
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err), 1);
});

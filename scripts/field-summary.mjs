#!/usr/bin/env node
// Turns one field-test run into a Markdown summary and a one-line JSON result.
//
//   node scripts/field-summary.mjs <project> <exit code> <report.json> <pr-body.md> <log file> <result.json>
//
// Exit codes from `janitor run`: 0 finished, 2 a precondition failed (nothing
// touched, almost always the project's own baseline failing), 1 crashed.
import fs from 'node:fs';

const [project, exitCodeRaw, reportFile, bodyFile, logFile, resultFile] = process.argv.slice(2);
const exitCode = Number(exitCodeRaw);
const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const tail = (text, lines) => text.trimEnd().split('\n').slice(-lines).join('\n');

const out = [`## ${project}`, ''];
const result = { project, exitCode, outcome: 'error', kept: 0, reverted: 0, proposed: 0, commits: 0, verifyRuns: 0 };

const reportText = read(reportFile);
if (exitCode === 0 && reportText) {
  const report = JSON.parse(reportText);
  const t = report.totals;
  Object.assign(result, {
    outcome: 'ran',
    sha: report.baseSha,
    kept: t.itemsKept,
    reverted: t.itemsReverted,
    proposed: t.itemsProposed ?? 0,
    commits: t.commits,
    verifyRuns: report.verifyRuns,
    checks: report.verifyCommands,
    baselineSeconds: Math.round(report.baseline.reduce((n, b) => n + b.durationMs, 0) / 1000),
  });
  out.push(
    `Ran against \`${report.baseSha.slice(0, 9)}\`. **${t.itemsKept} kept**, **${t.itemsReverted} reverted**, ${result.proposed} proposed, in ${t.commits} commit(s) and ${report.verifyRuns} check run(s).`,
    '',
    `Checks: ${report.verifyCommands.map((c) => `\`${c}\``).join(', ') || 'none'} (baseline ${result.baselineSeconds}s).`,
    '',
  );
  const body = read(bodyFile);
  if (body) out.push('<details><summary>Pull-request description it would have written</summary>', '', body, '', '</details>', '');
} else if (exitCode === 2) {
  result.outcome = 'refused';
  out.push(
    'Janitor **refused to start** and changed nothing. This is the project (or this runner), not Janitor: the untouched code did not pass its own checks, the tree was not clean after install, or no checks were found.',
    '',
  );
} else {
  out.push(`Janitor **failed** with exit code ${exitCode}. This one is a Janitor bug until shown otherwise.`, '');
}

const log = read(logFile);
if (log && result.outcome !== 'ran') {
  result.reason = tail(log, 3).slice(0, 400);
  out.push('```', tail(log, 40), '```', '');
}

if (resultFile) fs.writeFileSync(resultFile, `${JSON.stringify(result)}\n`);
process.stdout.write(`${out.join('\n')}\n`);
// Only a crash fails the job: a project whose own baseline is red is a finding, not a failure.
process.exit(result.outcome === 'error' ? 1 : 0);

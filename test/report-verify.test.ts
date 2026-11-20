import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, resolveConfig } from '../src/config.js';
import { runJanitor } from '../src/engine.js';
import { computeTotals, formatBytes, prTitle, renderPlan, renderPrBody } from '../src/report.js';
import { globToRegExp } from '../src/util/glob.js';
import { detectVerifyCommands, runVerify } from '../src/verify.js';
import { deleteItem, fakeCategory, git, makeRepo, write } from './helpers.js';

test('PR body carries totals, reverted steps, notes and exact rollback commands', async () => {
  const root = makeRepo({
    'required.txt': 'x\n',
    'dead.ts': 'line1\nline2\nline3\n',
  });
  const base = git(root, 'rev-parse', 'HEAD');
  const report = await runJanitor({
    root,
    date: '2026-11-20',
    verify: ['test -f required.txt'],
    categories: [
      fakeCategory('dead-files', [deleteItem('dead.ts')]),
      fakeCategory('breaker', [deleteItem('required.txt')]),
      fakeCategory('noter', [], {
        async scan() {
          return { items: [], notes: ['`left-pad` 1.0.0 -> 2.0.0 needs review'] };
        },
      }),
    ],
  });

  const totals = computeTotals(report);
  assert.equal(totals.deadCodeLines, 3);
  assert.equal(totals.deadCodeBytes, 18);
  assert.equal(totals.itemsKept, 1);
  assert.equal(totals.itemsReverted, 1);

  const body = renderPrBody(report);
  const deadSha = report.steps.find((s) => s.category === 'dead-files')!.sha!;
  assert.match(body, /## Nightly janitor: 2026-11-20/);
  assert.match(body, /Removed \*\*18 B\*\* and \*\*3 lines\*\* of dead code/);
  assert.ok(body.includes(`git revert --no-edit ${deadSha}   # Fake dead-files`));
  assert.ok(body.includes(`git revert --no-edit ${base}..${report.headSha}`));
  assert.ok(body.includes('git push origin --delete nightly-janitor/2026-11-20'));
  assert.match(body, /### Reverted automatically[\s\S]*delete required\.txt[\s\S]*<code>test -f required\.txt<\/code> exited 1/);
  assert.match(body, /\| Fake dead-files \| 1 \| 0 \| 18 B \| 3 \| 0 \|/);
  assert.match(body, /### Needs a human[\s\S]*\*\*noter\*\*: `left-pad` 1\.0\.0 -> 2\.0\.0 needs review/);
  assert.equal(prTitle(report), 'chore(janitor): nightly cleanup 2026-11-20');
});

test('lockfile churn is reported but never counted as dead code', async () => {
  const root = makeRepo({ 'package-lock.json': '{"a":1}\n' });
  const report = await runJanitor({
    root,
    date: '2026-11-20',
    verify: ['true'],
    categories: [
      fakeCategory(
        'outdated-deps',
        [
          {
            id: 'dep',
            description: 'update x',
            async apply(ctx) {
              write(ctx.root, { 'package-lock.json': '{"a":2,\n"b":3}\n' });
            },
          },
        ],
        { countsAsDeadCode: false },
      ),
    ],
  });
  const totals = computeTotals(report);
  assert.equal(totals.itemsKept, 1);
  assert.equal(totals.deadCodeLines, 0);
  assert.equal(totals.deadCodeBytes, 0);
  assert.equal(totals.bytesRemoved, -7);
  assert.match(renderPrBody(report), /\| Fake outdated-deps \| 1 \| 0 \| -7 B \| 1 \| 2 \|/);
});

test('dry-run plan lists candidates and the verification that would run', async () => {
  const root = makeRepo({ 'a.txt': 'a\n' });
  const report = await runJanitor({ root, dryRun: true, verify: ['npm test'], categories: [fakeCategory('x', [deleteItem('a.txt')])] });
  const plan = renderPlan(report);
  assert.match(plan, /1 candidate/);
  assert.match(plan, /- delete a\.txt/);
  assert.match(plan, /verify each step with: npm test/);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 kB');
  assert.equal(formatBytes(-2048), '-2.0 kB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
});

test('detectVerifyCommands reads the project, cheapest check first', () => {
  const npm = makeRepo({
    'package.json': JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc', typecheck: 'tsc --noEmit', lint: 'eslint .' } }),
  });
  assert.deepEqual(detectVerifyCommands(npm), ['npm run typecheck', 'npm run build', 'npm test']);

  const pnpm = makeRepo({
    'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'vite build' } }),
    'pnpm-lock.yaml': '',
  });
  assert.deepEqual(detectVerifyCommands(pnpm), ['pnpm run build']);

  const checkOnly = makeRepo({ 'package.json': JSON.stringify({ scripts: { check: 'node --check app.js', build: 'node build.mjs' } }) });
  assert.deepEqual(detectVerifyCommands(checkOnly), ['npm run build', 'npm run check']);

  assert.deepEqual(detectVerifyCommands(makeRepo({ 'Cargo.toml': '[package]' })), ['cargo check --all-targets', 'cargo test']);
  assert.deepEqual(detectVerifyCommands(makeRepo({ 'README.md': '' })), []);
});

test('runVerify stops at the first failing command and keeps its output', async () => {
  const root = makeRepo({ 'a.txt': '' });
  const ok = await runVerify(['true', 'echo fine'], root, 5000);
  assert.equal(ok.ok, true);
  assert.equal(ok.results.length, 2);

  const bad = await runVerify(['true', 'echo "TS2304: nope" >&2; exit 3', 'echo never'], root, 5000);
  assert.equal(bad.ok, false);
  assert.equal(bad.results.length, 2);
  assert.equal(bad.failed!.exitCode, 3);
  assert.match(bad.failed!.outputTail, /TS2304: nope/);
});

test('globToRegExp', () => {
  const m = (glob: string, p: string) => globToRegExp(glob).test(p);
  assert.ok(m('**/*.test.*', 'src/a/b.test.ts'));
  assert.ok(m('**/*.test.*', 'b.test.ts'));
  assert.ok(!m('*.ts', 'src/a.ts'));
  assert.ok(m('src/**', 'src/a/b/c.ts'));
  assert.ok(m('**/src/{index,main}.*', 'packages/x/src/main.tsx'));
  assert.ok(m('**/src/{index,main}.*', 'src/index.ts'));
  assert.ok(!m('**/src/{index,main}.*', 'src/other.ts'));
  assert.ok(m('**/.*', '.eslintrc.cjs'));
  assert.ok(m('a?c.js', 'abc.js'));
  assert.ok(!m('a.ts', 'axts'));
});

test('resolveConfig validates and merges over defaults', () => {
  const cfg = resolveConfig({ categories: ['dead-files'], flags: { staleDays: 30 }, deps: { exclude: ['react'] }, bisect: false });
  assert.deepEqual(cfg.categories, ['dead-files']);
  assert.equal(cfg.flags.staleDays, 30);
  assert.deepEqual(cfg.deps, { exclude: ['react'], max: 20 });
  assert.equal(cfg.bisect, false);
  assert.equal(cfg.branchPrefix, 'nightly-janitor');
  assert.throws(() => resolveConfig({ categories: ['nope'] }), ConfigError);
  assert.throws(() => resolveConfig({ maxVerifyRuns: 0 }), ConfigError);
  assert.throws(() => resolveConfig({ branchPrefix: 'bad prefix;rm' }), ConfigError);
});

test('an edited line is not counted as a removed line of dead code', async () => {
  const root = makeRepo({ 'lib.js': 'export const a = 1;\nexport const b = 2;\n' });
  const report = await runJanitor({
    root,
    date: '2026-11-20',
    verify: ['true'],
    categories: [
      fakeCategory('unused-exports', [
        {
          id: 'x',
          description: 'unexport a',
          async apply(ctx) {
            write(ctx.root, { 'lib.js': 'const a = 1;\nexport const b = 2;\n' });
          },
        },
      ]),
    ],
  });
  const totals = computeTotals(report);
  assert.equal(totals.deadCodeBytes, 7);
  assert.equal(totals.deadCodeLines, 0);
  assert.match(renderPrBody(report), /Removed \*\*7 B\*\* and \*\*0 lines\*\* of dead code/);
});

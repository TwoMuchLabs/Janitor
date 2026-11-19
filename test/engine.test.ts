import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { JanitorError, runJanitor } from '../src/engine.js';
import { config, deleteItem, exists, fakeCategory, git, makeRepo, read, write, writeItem } from './helpers.js';

// The "test suite" of the fixture repo: fails if a required file is missing or a poison file exists.
const VERIFY = ['test -f required.txt', 'test ! -e poison.txt'];
const DATE = '2026-11-20';

const baseFiles = {
  'required.txt': 'needed\n',
  'junk-a.txt': 'a\n',
  'junk-b.txt': 'b\nb\n',
  'junk-c.txt': 'c\n',
};

/** Breaks the build: removes a required file and leaves an untracked file behind. */
const breaking = {
  id: 'breaking',
  description: 'delete required.txt',
  async apply(ctx: { root: string }) {
    fs.rmSync(path.join(ctx.root, 'required.txt'));
    fs.writeFileSync(path.join(ctx.root, 'leftover.tmp'), 'x');
  },
};

function run(root: string, categories: Parameters<typeof runJanitor>[0]['categories'], extra = {}) {
  return runJanitor({ root, categories, verify: VERIFY, date: DATE, ...extra });
}

test('keeps a passing step as one commit on nightly-janitor/YYYY-MM-DD', async () => {
  const root = makeRepo(baseFiles);
  const base = git(root, 'rev-parse', 'HEAD');
  const report = await run(root, [fakeCategory('a', [deleteItem('junk-a.txt'), deleteItem('junk-b.txt')])]);

  assert.equal(report.branch, 'nightly-janitor/2026-11-20');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'nightly-janitor/2026-11-20');
  assert.equal(report.changed, true);
  assert.equal(report.baseSha, base);
  assert.equal(report.headSha, git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'rev-list', '--count', `${base}..HEAD`), '1');
  assert.equal(git(root, 'status', '--porcelain'), '');

  const [step] = report.steps;
  assert.equal(step!.status, 'kept');
  assert.equal(step!.sha, report.headSha);
  assert.equal(step!.stats!.linesDeleted, 3);
  assert.equal(step!.stats!.bytesBefore - step!.stats!.bytesAfter, 6);
  assert.ok(!exists(root, 'junk-a.txt'));
  // main is untouched
  assert.equal(git(root, 'rev-parse', 'main'), base);
});

test('reverts a breaking step completely, including untracked leftovers', async () => {
  const root = makeRepo(baseFiles);
  const base = git(root, 'rev-parse', 'HEAD');
  const report = await run(root, [fakeCategory('bad', [breaking])]);

  assert.equal(report.steps[0]!.status, 'reverted');
  assert.equal(report.steps[0]!.failure!.command, 'test -f required.txt');
  assert.equal(report.steps[0]!.failure!.exitCode, 1);
  assert.ok(exists(root, 'required.txt'));
  assert.ok(!exists(root, 'leftover.tmp'));
  assert.equal(git(root, 'status', '--porcelain'), '');
  // Nothing survived: back on the original branch, no empty janitor branch left behind.
  assert.equal(report.changed, false);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(git(root, 'branch', '--list', 'nightly-janitor/*'), '');
});

test('one failing category does not stop later categories', async () => {
  const root = makeRepo(baseFiles);
  const report = await run(root, [
    fakeCategory('bad', [breaking]),
    fakeCategory('good', [deleteItem('junk-a.txt')]),
  ]);
  assert.deepEqual(
    report.steps.map((s) => [s.category, s.status]),
    [
      ['bad', 'reverted'],
      ['good', 'kept'],
    ],
  );
  assert.ok(exists(root, 'required.txt'));
  assert.ok(!exists(root, 'junk-a.txt'));
});

test('bisects a failing category to salvage the safe items', async () => {
  const root = makeRepo(baseFiles);
  const base = git(root, 'rev-parse', 'HEAD');
  const report = await run(root, [
    fakeCategory('mixed', [deleteItem('junk-a.txt'), deleteItem('junk-b.txt'), breaking, deleteItem('junk-c.txt')]),
  ]);

  const kept = report.steps.filter((s) => s.status === 'kept');
  const reverted = report.steps.filter((s) => s.status === 'reverted');
  assert.deepEqual(kept.flatMap((s) => s.items.map((i) => i.id)), ['delete:junk-a.txt', 'delete:junk-b.txt', 'delete:junk-c.txt']);
  assert.deepEqual(reverted.flatMap((s) => s.items.map((i) => i.id)), ['breaking']);
  assert.equal(report.verifyRuns, 5); // all, [a,b], [breaking,c], [breaking], [c]
  assert.equal(git(root, 'rev-list', '--count', `${base}..HEAD`), String(kept.length));
  assert.ok(exists(root, 'required.txt'));
  assert.ok(!exists(root, 'junk-a.txt') && !exists(root, 'junk-b.txt') && !exists(root, 'junk-c.txt'));

  // Each kept step is its own commit, so it can be reverted individually.
  assert.deepEqual(kept.map((s) => s.sha).reverse(), git(root, 'rev-list', `${base}..HEAD`).split('\n'));
});

test('with bisect disabled the whole category is reverted', async () => {
  const root = makeRepo(baseFiles);
  const report = await run(root, [fakeCategory('mixed', [deleteItem('junk-a.txt'), breaking])], {
    config: config({ bisect: false }),
  });
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0]!.status, 'reverted');
  assert.equal(report.steps[0]!.items.length, 2);
  assert.ok(exists(root, 'junk-a.txt'));
  assert.equal(report.changed, false);
});

test('an apply() that throws is reverted like a test failure', async () => {
  const root = makeRepo(baseFiles);
  const exploding = {
    id: 'boom',
    description: 'half-applies then throws',
    async apply(ctx: { root: string }) {
      fs.rmSync(path.join(ctx.root, 'junk-a.txt'));
      throw new Error('boom');
    },
  };
  const report = await run(root, [fakeCategory('x', [exploding])]);
  assert.equal(report.steps[0]!.status, 'reverted');
  assert.equal(report.steps[0]!.failure!.command, '(apply)');
  assert.match(report.steps[0]!.failure!.outputTail, /boom/);
  assert.ok(exists(root, 'junk-a.txt'));
  assert.equal(report.verifyRuns, 0);
});

test('refuses to run on a dirty working tree and changes nothing', async () => {
  const root = makeRepo(baseFiles);
  write(root, { 'wip.txt': 'uncommitted work' });
  await assert.rejects(run(root, [fakeCategory('a', [deleteItem('junk-a.txt')])]), (err: JanitorError) => {
    assert.equal(err.code, 'dirty-tree');
    return true;
  });
  assert.equal(read(root, 'wip.txt'), 'uncommitted work');
  assert.ok(exists(root, 'junk-a.txt'));
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('refuses to run when the baseline is already failing', async () => {
  const root = makeRepo({ ...baseFiles, 'poison.txt': 'already broken' });
  await assert.rejects(run(root, [fakeCategory('a', [deleteItem('junk-a.txt')])]), (err: JanitorError) => {
    assert.equal(err.code, 'baseline-failed');
    return true;
  });
  assert.equal(git(root, 'branch', '--list', 'nightly-janitor/*'), '');
  assert.ok(exists(root, 'junk-a.txt'));
});

test('refuses to run without verification commands unless explicitly allowed', async () => {
  const root = makeRepo(baseFiles);
  const cats = [fakeCategory('a', [deleteItem('junk-a.txt')])];
  await assert.rejects(runJanitor({ root, categories: cats, verify: [], date: DATE }), (err: JanitorError) => {
    assert.equal(err.code, 'no-verify');
    return true;
  });
  const report = await runJanitor({ root, categories: cats, verify: [], date: DATE, allowUnverified: true });
  assert.equal(report.steps[0]!.status, 'kept');
});

test('refuses to reuse an existing branch', async () => {
  const root = makeRepo(baseFiles);
  git(root, 'branch', 'nightly-janitor/2026-11-20');
  await assert.rejects(run(root, [fakeCategory('a', [deleteItem('junk-a.txt')])]), (err: JanitorError) => {
    assert.equal(err.code, 'branch-exists');
    return true;
  });
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('dry run reports candidates without touching the repository', async () => {
  const root = makeRepo(baseFiles);
  const report = await run(root, [fakeCategory('a', [deleteItem('junk-a.txt')])], { dryRun: true });
  assert.equal(report.steps[0]!.status, 'planned');
  assert.equal(report.changed, false);
  assert.ok(exists(root, 'junk-a.txt'));
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(root, 'branch', '--list', 'nightly-janitor/*'), '');
});

test('files written by the verification suite never end up in a commit', async () => {
  const root = makeRepo(baseFiles);
  const report = await runJanitor({
    root,
    categories: [fakeCategory('a', [deleteItem('junk-a.txt')])],
    verify: ['echo report > coverage.out', ...VERIFY],
    date: DATE,
  });
  assert.equal(report.steps[0]!.status, 'kept');
  assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD'), 'junk-a.txt');
  assert.ok(!exists(root, 'coverage.out'));
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('stops attempting steps once the verification budget is spent', async () => {
  const root = makeRepo(baseFiles);
  const report = await run(
    root,
    [fakeCategory('a', [deleteItem('junk-a.txt')]), fakeCategory('b', [deleteItem('junk-b.txt')])],
    { config: config({ maxVerifyRuns: 1 }) },
  );
  assert.deepEqual(report.steps.map((s) => s.status), ['kept', 'skipped']);
  assert.ok(exists(root, 'junk-b.txt'));
});

test('a step that changes nothing is recorded as a no-op without running verification', async () => {
  const root = makeRepo(baseFiles);
  const report = await run(root, [fakeCategory('a', [writeItem('junk-a.txt', 'a\n')])]);
  assert.equal(report.steps[0]!.status, 'noop');
  assert.equal(report.verifyRuns, 0);
  assert.equal(report.changed, false);
});

test('calls afterRevert so categories can restore untracked state', async () => {
  const root = makeRepo(baseFiles);
  let calls = 0;
  const cat = fakeCategory('bad', [breaking], {
    async afterRevert() {
      calls++;
    },
  });
  await run(root, [cat]);
  assert.equal(calls, 1);
});

test('a timed-out verification command counts as a failure', async () => {
  const root = makeRepo(baseFiles);
  let slow = false;
  const cat = fakeCategory('a', [
    {
      id: 'slow',
      description: 'makes the suite hang',
      async apply(ctx) {
        slow = true;
        fs.writeFileSync(path.join(ctx.root, 'hang.flag'), '1');
      },
    },
  ]);
  const report = await runJanitor({
    root,
    categories: [cat],
    verify: ['if [ -e hang.flag ]; then sleep 30; fi'],
    date: DATE,
    config: config({ verifyTimeoutSec: 1 }),
  });
  assert.ok(slow);
  assert.equal(report.steps[0]!.status, 'reverted');
  assert.equal(report.steps[0]!.failure!.timedOut, true);
  assert.ok(!exists(root, 'hang.flag'));
});

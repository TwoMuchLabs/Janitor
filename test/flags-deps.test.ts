import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { classifyUpdate, parseNpmOutdated, planUpdates } from '../src/categories/outdated-deps.js';
import { isFullyOn, nameVariants, parseRegistry, removeFlag, staleFlags } from '../src/categories/stale-flags.js';
import { context, makeRepo, read } from './helpers.js';

test('stale-flags: removes unreferenced flags and reports long-lived fully-on flags', async () => {
  const registry = JSON.stringify(
    {
      $schema: './flags.schema.json',
      'new-checkout': true,
      'orphaned-flag': false,
      'dark-mode': { enabled: true, rollout: 50 },
      'old-rollout': { enabled: true, rollout: 100 },
    },
    null,
    2,
  );
  const root = makeRepo({
    'flags.json': `${registry}\n`,
    'src/checkout.ts': `if (flags.newCheckout) { run(); }\n`,
    'src/theme.ts': `isEnabled('dark-mode');\nisEnabled(Flags.OLD_ROLLOUT);\n`,
  });
  // Pretend the registry was last touched 200 days ago.
  const old = new Date(Date.now() - 200 * 86400 * 1000).toISOString();
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit', '--date', old], {
    cwd: root,
    env: { ...process.env, GIT_COMMITTER_DATE: old },
  });

  const ctx = context(root);
  const { items, notes } = await staleFlags.scan(ctx);
  assert.deepEqual(items.map((i) => i.id), ['stale-flag:orphaned-flag']);
  assert.equal(notes.length, 2);
  assert.match(notes.join('\n'), /`new-checkout` has been fully on for \d+ days.*src\/checkout\.ts/);
  assert.match(notes.join('\n'), /`old-rollout`/);
  assert.doesNotMatch(notes.join('\n'), /dark-mode/);

  await items[0]!.apply(ctx);
  const after = JSON.parse(read(root, 'flags.json')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(after), ['$schema', 'new-checkout', 'dark-mode', 'old-rollout']);
  assert.ok(read(root, 'flags.json').endsWith('}\n'));
});

test('stale-flags: does nothing without a registry', async () => {
  const root = makeRepo({ 'src/a.ts': `export {};\n` });
  assert.deepEqual(await staleFlags.scan(context(root)), { items: [], notes: [] });
});

test('flag helpers', () => {
  assert.deepEqual(parseRegistry('{"flags": {"a": true}, "version": 1}'), { wrapper: 'flags', flags: { a: true } });
  assert.equal(parseRegistry('[1]'), null);
  assert.equal(parseRegistry('not json'), null);

  assert.equal(removeFlag('{\n\t"flags": {\n\t\t"a": true,\n\t\t"b": false\n\t}\n}', 'b'), '{\n\t"flags": {\n\t\t"a": true\n\t}\n}');
  assert.equal(removeFlag('{"a": true}', 'zzz'), null);

  assert.deepEqual(nameVariants('new-checkout'), ['new-checkout', 'new_checkout', 'NEW_CHECKOUT', 'new.checkout', 'newCheckout', 'NewCheckout']);
  assert.ok(nameVariants('newCheckoutV2').includes('NEW_CHECKOUT_V2'));

  assert.equal(isFullyOn(true), true);
  assert.equal(isFullyOn(false), false);
  assert.equal(isFullyOn({ enabled: true }), true);
  assert.equal(isFullyOn({ enabled: true, rollout: 20 }), false);
  assert.equal(isFullyOn({ enabled: false, rollout: 100 }), false);
  assert.equal(isFullyOn('on'), false);
});

test('classifyUpdate follows semver, treating 0.x minors as breaking', () => {
  assert.equal(classifyUpdate('1.2.3', '1.2.4'), 'patch');
  assert.equal(classifyUpdate('1.2.3', '1.3.0'), 'minor');
  assert.equal(classifyUpdate('1.2.3', '2.0.0'), 'major');
  assert.equal(classifyUpdate('0.2.3', '0.2.9'), 'patch');
  assert.equal(classifyUpdate('0.2.3', '0.3.0'), 'major');
  assert.equal(classifyUpdate('1.2.3', '1.2.3'), 'none');
  assert.equal(classifyUpdate('1.2.3', '1.2.2'), 'none');
  assert.equal(classifyUpdate('1.2.3', '1.3.0-beta.1'), 'none');
  assert.equal(classifyUpdate('git+ssh://x', '1.0.0'), 'none');
});

test('planUpdates keeps in-range minor/patch updates and notes the rest', () => {
  const outdated = JSON.stringify({
    zod: { current: '3.22.0', wanted: '3.23.8', latest: '4.1.0' },
    react: { current: '18.2.0', wanted: '18.2.0', latest: '19.0.0' },
    lodash: { current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' },
    pinned: { current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
    missing: { wanted: '1.0.0', latest: '1.0.0' },
    ws: [{ current: '8.0.0', wanted: '8.1.0', latest: '8.1.0' }],
  });
  const { updates, notes } = planUpdates(parseNpmOutdated(outdated), ['pinned'], 2);
  assert.deepEqual(updates, [
    { name: 'lodash', from: '4.17.20', to: '4.17.21', kind: 'patch' },
    { name: 'ws', from: '8.0.0', to: '8.1.0', kind: 'minor' },
  ]);
  assert.match(notes[0]!, /1 more minor\/patch update/);
  assert.match(notes[1]!, /`react` 18\.2\.0 -> 19\.0\.0/);
  assert.match(notes[1]!, /`zod` 3\.23\.8 -> 4\.1\.0/);

  assert.deepEqual(parseNpmOutdated(''), []);
  assert.deepEqual(parseNpmOutdated('npm ERR!'), []);
});

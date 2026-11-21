import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, parseCategoryList } from '../src/config.js';
import { makeRepo } from './helpers.js';

test('--categories forgives case, spaces and underscores, and drops repeats', () => {
  assert.deepEqual(parseCategoryList('dead-files, Stale_Flags ,unused exports,dead-files'), ['dead-files', 'stale-flags', 'unused-exports']);
});

test('--categories rejects a name it does not know, and suggests the nearest', () => {
  assert.throws(() => parseCategoryList('dead-file'), (err: Error) => err instanceof ConfigError && /unknown category "dead-file"; did you mean "dead-files"\?/.test(err.message));
  assert.throws(() => parseCategoryList('deadfiles'), /did you mean "dead-files"/);
  assert.throws(() => parseCategoryList('nope'), (err: Error) => /unknown category "nope" \(known: dead-files, /.test(err.message));
  assert.throws(() => parseCategoryList(' , '), /names no category/);
});

test('an unknown category on the command line is one line and exit 1, not a stack trace', () => {
  const root = makeRepo({ 'a.txt': 'x\n' });
  const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
  const done = spawnSync('node', [tsx, path.resolve('src/cli.ts'), 'scan', '--repo', root, '--categories', 'unused-export'], { encoding: 'utf8' });
  assert.equal(done.status, 1);
  assert.equal(done.stderr.trim().split('\n').length, 1, done.stderr);
  assert.match(done.stderr, /^janitor: unknown category "unused-export"; did you mean "unused-exports"\?/);
  assert.equal(done.stdout, '');
});

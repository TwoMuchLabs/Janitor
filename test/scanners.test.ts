import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapToSources } from '../src/analysis/entries.js';
import { deadFiles } from '../src/categories/dead-files.js';
import { removeExport, unusedExports } from '../src/categories/unused-exports.js';
import { context, exists, makeRepo, read } from './helpers.js';

const pkg = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'fixture', main: 'dist/index.js', ...extra }, null, 2);

const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();

test('dead-files: finds unreachable files and keeps everything that is plausibly used', async () => {
  const root = makeRepo({
    'package.json': pkg(),
    'src/index.ts': `import { a } from './used.js';\nimport('./lazy');\nconsole.log(a);\n`,
    'src/used.ts': `export const a = 1;\n`,
    'src/lazy.ts': `export default 1;\n`,
    'src/dead.ts': `import './dead-dep';\nexport const x = 1;\n`,
    'src/dead-dep.ts': `export {};\n`,
    // used only by a test: still used
    'src/test-helper.ts': `export const h = 1;\n`,
    'src/used.test.ts': `import { h } from './test-helper';\nconsole.log(h);\n`,
    // referenced from a non-code file
    'src/worker.ts': `postMessage(1);\n`,
    'Dockerfile': `CMD ["node", "dist/worker.js"]\n`,
    // loaded through a template-literal dynamic import
    'src/loader.ts': `export const load = (l: string) => import(\`./locales/\${l}.js\`);\n`,
    'src/locales/en.ts': `export default {};\n`,
    // conventions and ignores
    'vite.config.ts': `export default {};\n`,
    'src/generated/schema.ts': `export const s = 1;\n`,
    'src/types.d.ts': `declare const X: number;\n`,
  });
  const ctx = context(root);
  const { items, notes } = await deadFiles.scan(ctx);
  assert.deepEqual(ids(items), ['dead-file:src/dead-dep.ts', 'dead-file:src/dead.ts', 'dead-file:src/loader.ts']);
  assert.match(notes.join('\n'), /3 unreachable file\(s\) were kept/); // worker.ts, locales/en.ts, generated/schema.ts

  // Deleting a dead dependency takes its dead importer with it, so the step is valid on its own.
  const dep = items.find((i) => i.id === 'dead-file:src/dead-dep.ts')!;
  assert.match(dep.description, /together with the dead file\(s\) importing it: `src\/dead\.ts`/);
  await dep.apply(ctx);
  assert.ok(!exists(root, 'src/dead-dep.ts') && !exists(root, 'src/dead.ts'));
  assert.ok(exists(root, 'src/loader.ts'));
});

test('dead-files: refuses to guess when the project has no entry points', async () => {
  const root = makeRepo({ 'lib/a.ts': `export const a = 1;\n`, 'lib/b.ts': `export const b = 1;\n` });
  const { items, notes } = await deadFiles.scan(context(root));
  assert.equal(items.length, 0);
  assert.match(notes[0]!, /No entry points/);
});

test('dead-files: honours user entry and ignore globs and tsconfig paths', async () => {
  const root = makeRepo({
    'package.json': pkg(),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/index.ts': `import { v } from '@/aliased';\nconsole.log(v);\n`,
    'src/aliased.ts': `export const v = 1;\n`,
    'src/jobs/nightly.ts': `console.log('cron');\n`,
    'src/legacy/keep.ts': `console.log('keep');\n`,
    'src/legacy/drop.ts': `console.log('drop');\n`,
  });
  const { items } = await deadFiles.scan(context(root, { entry: ['src/jobs/**'], ignore: ['src/legacy/keep.ts'] }));
  assert.deepEqual(ids(items), ['dead-file:src/legacy/drop.ts']);
});

test('mapToSources maps build outputs back to source files', () => {
  const sources = new Set(['src/index.ts', 'src/cli.ts', 'packages/a/src/main.tsx', 'lib/util/index.js']);
  assert.deepEqual(mapToSources('./dist/index.js', '.', sources), ['src/index.ts']);
  assert.deepEqual(mapToSources('dist/cli.d.ts', '.', sources), ['src/cli.ts']);
  assert.deepEqual(mapToSources('./build/main.js', 'packages/a', sources), ['packages/a/src/main.tsx']);
  assert.deepEqual(mapToSources('./lib/util', '.', sources), ['lib/util/index.js']);
  assert.deepEqual(mapToSources('./dist/*.js', '.', sources).sort(), ['src/cli.ts', 'src/index.ts']);
  assert.deepEqual(mapToSources('../outside.js', '.', sources), []);
});

test('unused-exports: reports only exports nothing imports', async () => {
  const root = makeRepo({
    'package.json': pkg(),
    'src/index.ts': [
      `import { used, type UsedType } from './lib';`,
      `import * as ns from './namespace';`,
      `export * from './barrel';`,
      `const C = require('./cjs');`,
      `console.log(used, ns, C, {} as UsedType);`,
      `export const publicApi = 1;`,
      '',
    ].join('\n'),
    'src/lib.ts': [
      `export const used = 1;`,
      `export type UsedType = string;`,
      `export function unusedFn() {}`,
      `export interface UnusedShape { a: number }`,
      `export const usedInTemplate = 2;`,
      `export default function main() {}`,
      '',
    ].join('\n'),
    'src/namespace.ts': `export const viaNamespace = 1;\n`,
    'src/barrel.ts': `export const viaBarrel = 1;\n`,
    'src/cjs.ts': `export const viaRequire = 1;\n`,
    'src/App.vue': `<script setup>import { usedInTemplate } from './lib'</script>\n`,
  });
  const { items } = await unusedExports.scan(context(root));
  assert.deepEqual(ids(items), ['unused-export:src/lib.ts#UnusedShape', 'unused-export:src/lib.ts#unusedFn']);
});

test('unused-exports: applying items edits the file in place, and is idempotent', async () => {
  const root = makeRepo({
    'package.json': pkg(),
    'src/index.ts': `import { keep } from './lib';\nconsole.log(keep);\n`,
    'src/lib.ts': `export const keep = 1;\n\n/** Old helper. */\nexport function gone() {\n  return 1;\n}\n\nexport const alsoGone = () => 2;\n`,
  });
  const ctx = context(root);
  const { items } = await unusedExports.scan(ctx);
  assert.equal(items.length, 2);
  for (const item of items) await item.apply(ctx);
  for (const item of items) await item.apply(ctx);
  assert.equal(read(root, 'src/lib.ts'), `export const keep = 1;\n`);
});

test('removeExport deletes a side-effect-free, unreferenced declaration with its JSDoc', () => {
  const src = `import x from 'x';\n\n/**\n * Docs.\n */\nexport function dead(a: number): number {\n  return a;\n}\n\nexport const live = x;\n`;
  const out = removeExport(src, 'f.ts', 'dead');
  assert.equal(out!.kind, 'deleted');
  assert.equal(out!.text, `import x from 'x';\n\nexport const live = x;\n`);
});

test('removeExport only drops the keyword when the name is still used locally', () => {
  const src = `export function helper() {}\nexport const api = () => helper();\n`;
  const out = removeExport(src, 'f.ts', 'helper');
  assert.equal(out!.kind, 'unexported');
  assert.equal(out!.text, `function helper() {}\nexport const api = () => helper();\n`);
});

test('removeExport never deletes a declaration whose initializer may have side effects', () => {
  const src = `export const registry = createRegistry();\nexport const table = { a: 1, b: [2, 'x'] };\n`;
  assert.deepEqual(removeExport(src, 'f.ts', 'registry'), {
    kind: 'unexported',
    text: `const registry = createRegistry();\nexport const table = { a: 1, b: [2, 'x'] };\n`,
  });
  assert.deepEqual(removeExport(src, 'f.ts', 'table'), {
    kind: 'deleted',
    text: `export const registry = createRegistry();\n`,
  });
});

test('removeExport handles overloads, classes and modifiers', () => {
  const overloads = `export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: unknown) {}\n`;
  assert.deepEqual(removeExport(overloads, 'f.ts', 'f'), { kind: 'deleted', text: '' });
  const usedOverloads = `${overloads}export const g = () => f(1);\n`;
  assert.equal(
    removeExport(usedOverloads, 'f.ts', 'f')!.text,
    `function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown) {}\nexport const g = () => f(1);\n`,
  );

  const cls = `export abstract class Base {\n  static count = 0;\n}\nexport class Registered {\n  static id = register();\n}\n`;
  assert.equal(removeExport(cls, 'f.ts', 'Base')!.kind, 'deleted');
  assert.equal(removeExport(cls, 'f.ts', 'Registered')!.kind, 'unexported');

  const decorated = `@Injectable()\nexport class Service {}\n`;
  assert.equal(removeExport(decorated, 'f.ts', 'Service')!.kind, 'unexported');
});

test('removeExport leaves unsupported shapes alone', () => {
  assert.equal(removeExport(`export const a = 1, b = 2;\n`, 'f.ts', 'a'), null);
  assert.equal(removeExport(`export default function a() {}\n`, 'f.ts', 'a'), null);
  assert.equal(removeExport(`const a = 1;\nexport { a };\n`, 'f.ts', 'a'), null);
  assert.equal(removeExport(`export const b = 1;\n`, 'f.ts', 'missing'), null);
});

test('dead-files: keeps whatever a held-back file still imports', async () => {
  const root = makeRepo({
    'package.json': pkg(),
    'src/index.ts': `console.log(1);\n`,
    // unreachable, but named in a workflow file, so it stays...
    'src/cron.ts': `import { job } from './cron-job';\njob();\n`,
    '.github/workflows/cron.yml': `run: node dist/cron.js\n`,
    // ...and so must its dependency
    'src/cron-job.ts': `export const job = () => {};\n`,
    'src/orphan.ts': `export {};\n`,
  });
  const { items } = await deadFiles.scan(context(root));
  assert.deepEqual(ids(items), ['dead-file:src/orphan.ts']);
});

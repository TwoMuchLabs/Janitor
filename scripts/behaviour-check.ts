/**
 * Does a change to the code change what janitor does? Measure it before pushing a refactor.
 *
 *   node --import tsx scripts/behaviour-check.ts <base-ref> <repo> [<repo> ...] [--only a,b]
 *
 * Runs the code from <base-ref> and the code in the working tree over the same inputs and
 * compares everything they produce. <repo> is any JavaScript or TypeScript git checkout;
 * the more shapes of project, the better. A clean result is evidence, not proof.
 *
 * What one snapshot covers (the names are what --only accepts):
 *   project   for each repository, and for a project made to contain every framework
 *             convention and every way of loading a directory: the module graph, entry points, reachability and
 *             mentions, with the default config, with `entry` globs and with `ignore`
 *             globs; and what each scanning category proposes
 *   edits     removeExport() for the exports of each source file, and tidyImports() on
 *             each file's imports with all, half and none of the names still in use
 *   paths     mapToSources() for package.json paths built from each repository's files:
 *             build outputs, wildcards, nested packages, paths outside the package
 *   config    resolveConfig() on 4,000 made-up config objects, valid and not
 *   engine    the safe-apply loop on small repositories with made-up categories: steps
 *             that pass, break the checks, cannot be applied, change nothing or interact;
 *             bisecting on and off; a verification budget; propose-only; every refusal;
 *             the report, the PR description, the commits made and the tree left behind
 *   cli       the command line on a small project with a dead file, an unused export and
 *             a stale flag: scan, run, run again, and every argument error
 *
 * Not covered: outdated-deps (it asks the package registry), the formatter hook in
 * editKeepingFormat beyond what the sample projects trigger, and the GitHub Action wrapper.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const DATE = '2026-01-02';
type Snap = Record<string, unknown>;

/** Remove what legitimately differs between two runs: where the scratch files are, and how long things took. */
function scrub(text: string, work: string): string {
  return text
    .split(work).join('WORK')
    .replace(/(durationMs\\?":\s*)[\d.]+/g, '$10')
    .replace(/\b\d+\.\d+s\b/g, 'N.Ns')
    .replace(/\(node:\d+\)/g, '(node)')
    .replace(/\\n\s+at [^\\]+/g, ''); // stack frames name source lines, which a refactor moves
}

function digest(value: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(value, plain)).digest('hex').slice(0, 16);
}

/** JSON cannot hold a Map or a Set; keep their contents and their order. */
function plain(_key: string, value: unknown): unknown {
  if (value instanceof Map) return { map: [...value.entries()] };
  if (value instanceof Set) return { set: [...value.values()] };
  return value;
}

/** A small repeatable random source (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
    sample: <T>(items: readonly T[], n: number): T[] => {
      const pool = [...items];
      const out: T[] = [];
      while (pool.length && out.length < n) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]!);
      return out;
    },
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeRepo(root: string, files: Record<string, string>): string {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Check'], ['user.email', 'check@example.com'], ['commit.gpgsign', 'false']]) {
    git(root, 'config', key!, value!);
  }
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return fs.realpathSync(root);
}

async function attempt<T>(fn: () => T | Promise<T>): Promise<T | { raised: string; code?: unknown }> {
  try {
    return await fn();
  } catch (err) {
    return { raised: err instanceof Error ? `${err.name}: ${err.message}` : String(err), code: (err as { code?: unknown }).code };
  }
}

// --- analysis of real projects --------------------------------------------------------------

async function snapProject(src: string, repo: string, snap: Snap): Promise<void> {
  const { Git } = await import(pathToFileURL(path.join(src, 'git.ts')).href);
  const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(src, 'config.ts')).href);
  const { analyzeProject } = await import(pathToFileURL(path.join(src, 'analysis/project.ts')).href);
  const { deadFiles } = await import(pathToFileURL(path.join(src, 'categories/dead-files.ts')).href);
  const { unusedExports } = await import(pathToFileURL(path.join(src, 'categories/unused-exports.ts')).href);
  const { staleFlags } = await import(pathToFileURL(path.join(src, 'categories/stale-flags.ts')).href);
  const name = path.basename(repo);
  const variants: [string, object][] = [['default', {}], ['entry', { entry: ['src/**', 'lib/*.js'] }], ['ignore', { ignore: ['**/*.js', 'src/utils/**'] }]];
  for (const [label, overrides] of variants) {
    const ctx = { root: repo, git: new Git(repo), config: { ...structuredClone(DEFAULT_CONFIG), ...overrides }, log: () => {} };
    const project = await analyzeProject(ctx);
    snap[`project/${name}/${label}/analysis`] = digest({
      sources: project.sources,
      graph: project.graph,
      entryPoints: project.entryPoints,
      reachable: project.reachable,
      mentions: project.mentions,
      separatePackages: project.separatePackages,
      ignored: project.sources.filter((f: string) => project.isIgnored(f)),
    });
    for (const category of [deadFiles, unusedExports, staleFlags]) {
      const result = await attempt(() => category.scan(ctx));
      const shown = 'raised' in result ? result : { notes: result.notes, items: result.items.map(({ id, description, paths }: any) => ({ id, description, paths })) };
      snap[`project/${name}/${label}/${category.name}`] = digest(shown);
    }
  }
}

async function snapEdits(src: string, repo: string, snap: Snap): Promise<void> {
  const { removeExport } = await import(pathToFileURL(path.join(src, 'categories/unused-exports.ts')).href);
  const { tidyImports } = await import(pathToFileURL(path.join(src, 'analysis/imports.ts')).href);
  const { declaredExports } = await import(pathToFileURL(path.join(src, 'analysis/module-graph.ts')).href);
  const name = path.basename(repo);
  const rng = random(11);
  const sources = git(repo, 'ls-files').split('\n').filter((f) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f) && !f.includes('node_modules/'));
  for (const file of rng.sample(sources, 250)) {
    const abs = path.join(repo, file);
    const text = fs.readFileSync(abs, 'utf8');
    if (text.length > 200_000) continue;
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
    const exported = sf.statements.flatMap((stmt) => declaredExports(stmt).map((e: { name: string }) => e.name));
    const removals = [...new Set([...exported, 'default', 'noSuchExport'])].map((n) => [n, removeExport(text, abs, n)]);

    const imports = sf.statements.filter(ts.isImportDeclaration);
    const bound = new Set<string>();
    for (const stmt of imports) {
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) bound.add(n.text);
        ts.forEachChild(n, visit);
      };
      if (stmt.importClause) visit(stmt.importClause);
    }
    const names = [...bound];
    const half = new Set(names.filter(() => rng.chance(0.5)));
    const importsOnly = imports.map((stmt) => text.slice(stmt.getFullStart(), stmt.end)).join('') + '\n';
    const usesHalf = `${importsOnly}\nconsole.log(${names.filter((n) => !half.has(n)).join(', ')});\n`;
    const tidied = [
      tidyImports(text, abs, new Set(names)),
      tidyImports(importsOnly, abs, new Set(names)),
      tidyImports(importsOnly, abs, half),
      tidyImports(usesHalf, abs, new Set(names)),
      tidyImports(importsOnly.replace(/\n/g, '\r\n'), abs, half),
      tidyImports(importsOnly, abs, new Set()),
    ];
    snap[`edits/${name}/${file}`] = digest([removals, tidied]);
  }
}

async function snapPaths(src: string, repo: string, snap: Snap): Promise<void> {
  const { mapToSources, findEntryPoints } = await import(pathToFileURL(path.join(src, 'analysis/entries.ts')).href);
  const name = path.basename(repo);
  const rng = random(5);
  const tracked = git(repo, 'ls-files').split('\n');
  const sources = tracked.filter((f) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f) && !f.includes('node_modules/'));
  const sourceSet = new Set(sources);
  const dirs = ['.', '', ...new Set(sources.filter((f) => f.includes('/')).map((f) => f.split('/')[0]!))].slice(0, 6);
  const declared: string[] = ['./index.js', 'index', './dist/index.js', './lib/*', './dist/*.d.ts', './*', '../outside.js', './build/esm/index.mjs', './dist/types/a/src/*.d.ts', 'dist/*/index.js'];
  for (const file of rng.sample(sources, 60)) {
    const stem = file.replace(/\.[^./]+$/, '');
    const rest = stem.split('/').slice(1).join('/') || stem;
    declared.push(`./${file}`, stem, `./dist/${rest}.js`, `lib/${rest}.d.ts`, `./out/${stem}.cjs`, `./distribution/${rest}.js`,
      `./${stem.split('/')[0]}/*`, `./dist/${rest.split('/')[0]}/*.js`, `./${path.posix.dirname(stem)}/*/index.js`, `types/x/y/${rest}.d.ts`);
  }
  snap[`paths/${name}/map`] = digest(dirs.map((dir) => declared.map((d) => mapToSources(d, dir, sourceSet))));
  for (const [label, globs] of [['none', []], ['src', ['src/**']], ['odd', ['**/*.cjs', 'lib/**', '*.md']]] as const) {
    snap[`paths/${name}/entries/${label}`] = digest(findEntryPoints(repo, tracked, sources, [...globs]));
  }
}

/**
 * A project made to contain what the sample projects may not: every framework convention,
 * every way of loading a directory, components, pages that load scripts, nested packages.
 */
const SHAPES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'shapes', main: 'dist/index.js', types: './dist/index.d.ts', bin: { shapes: './bin/cli.js' },
    exports: { '.': './dist/index.js', './unsafe/*': './lib/*', './deep': { import: './distribution/deep.mjs' } },
    scripts: { build: 'node tools/build.mjs && tsx src/gen.ts', test: 'vitest' }, workspaces: ['packages/*'],
    dependencies: { 'unplugin-auto-import': '1' },
  }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] }, allowJs: true, module: 'ESNext', moduleResolution: 'Bundler' } }),
  'src/index.ts': "import def, { a as renamed, type T } from './named';\nimport * as ns from './ns';\nimport './side-effect';\nexport * from './reexported';\nexport { x as y } from './picked';\nimport legacy = require('./legacy');\nexport const used = [def, renamed, ns, legacy];\nexport type U = T;\n",
  'src/named.ts': 'export default 1;\nexport const a = 1;\nexport type T = string;\nexport const unusedConst = { a: 1, b: [2, -3], c: () => 4 };\nexport let sideEffect = compute();\nexport function unusedFn() {}\nexport class Plain { static n = 1; m() {} }\nexport class Impure { static n = compute(); }\nexport enum E { A }\nexport interface Merged { a: 1 }\nexport namespace Merged { export const b = 2; }\nexport const [d1, d2] = [1, 2];\nfunction compute() { return 1; }\n',
  'src/ns.ts': 'export const one = 1;\nexport const two = 2;\n',
  // Committed with the fixed date the check uses, so every flag here is months old.
  'flags.json': JSON.stringify({ $schema: 'x', version: 2, 'never-used': true, 'on-for-good': { enabled: true }, 'full-rollout': { rollout: 100 },
    'half-rollout': { percentage: 50 }, 'switched-off': { on: false, rollout: 100 }, 'plain-on': true, 'camelCased-flag': true, '_private': true }, null, 2) + '\n',
  'src/flags.ts': "export const flags = ['on-for-good', 'full-rollout', 'half-rollout', 'switched-off', isOn('plain-on'), camelCasedFlag, CAMEL_CASED_FLAG];\n",
  'docs/flags.md': 'never-used is documented here only\n',
  'src/side-effect.ts': 'console.log(1);\n',
  'src/reexported.ts': 'export const r = 1;\n',
  'src/picked.ts': 'export const x = 1;\nexport const notPicked = 2;\n',
  'src/legacy.js': "module.exports = { a: 1 };\nexports.b = 2;\n",
  'src/gen.ts': "const worker = new Worker('./worker.js');\nconst url = new URL('./asset-loader.ts', import.meta.url);\njest.mock('./mocked');\nexport {};\n",
  'src/worker.js': 'postMessage(1);\n',
  'src/asset-loader.ts': 'export const load = 1;\n',
  'src/mocked.ts': 'export const m = 1;\n',
  'src/loaders.ts': "const pages = import.meta.glob('./pages/*.ts');\nconst eager = import.meta.globEager(['/src/eager/**', '!./pages/skip.ts']);\nconst ctx = require.context('./ctx', true);\nconst ctx2 = require.context(dirVar);\nconst lang = import(`./locales/${name}.js`);\nconst any = import(somewhere);\nconst lit = import('./lazy');\nconst res = require.resolve('./resolved');\nfs.readdirSync(path.join(__dirname, 'tasks'));\nrequireDirectory(__dirname);\nglob('./jobs/*.js');\nglobby(['../outside/*.js', '/abs/*.js']);\nreaddir(import.meta.dirname);\npath.join(__dirname, 'not-a-loader');\nwalk('./walked/');\nexport {};\n",
  'src/pages/home.ts': 'export const page = 1;\n',
  'src/eager/e.ts': 'export const e = 1;\n',
  'src/ctx/c.ts': 'export const c = 1;\n',
  'src/locales/en.js': 'export default {};\n',
  'src/lazy.ts': 'export const lazy = 1;\n',
  'src/resolved.ts': 'export const resolved = 1;\n',
  'src/tasks/t.ts': 'export const t = 1;\n',
  'src/jobs/j.js': 'export const j = 1;\n',
  'src/walked/w.ts': 'export const w = 1;\n',
  'src/jsdoc.js': "/** @type {import('./typed-only').Foo} */\nexport const typed = {};\n",
  'src/typed-only.ts': 'export interface Foo { a: 1 }\nexport interface UnusedType { b: 2 }\n',
  'src/alias.ts': "import { viaAlias } from '@lib/aliased';\nexport const z = viaAlias;\n",
  'lib/aliased.ts': 'export const viaAlias = 1;\nexport const aliasUnused = 2;\n',
  'lib/extra/deep.ts': 'export const deep = 1;\n',
  'source/deep.ts': 'export const fromUnknownLayout = 1;\n',
  'src/orphan.ts': "import { chained } from './orphan-dep';\nexport const orphan = chained;\n",
  'src/orphan-dep.ts': 'export const chained = 1;\n',
  'src/script-like.ts': 'console.log("run by hand");\n',
  'src/platform.ts': 'export const p = 1;\n',
  'src/platform-browser.ts': 'export const p = 2;\n',
  'src/mentioned-in-yaml.ts': 'export const fromYaml = 1;\n',
  'ci.yml': 'run: node src/mentioned-in-yaml.ts\nflag: fromYaml\n',
  'src/App.vue': "<template><div/></template>\n<script setup lang=\"ts\">\nimport { onlyFromVue } from './vue-dep';\n</script>\n",
  'src/vue-dep.ts': 'export const onlyFromVue = 1;\nexport const vueUnused = 2;\n',
  'src/Widget.svelte': "<script>\n  import { s } from './svelte-dep.js';\n</script>\n<p>{s}</p>\n",
  'src/svelte-dep.js': 'export const s = 1;\n',
  'src/pages/index.astro': "---\nimport { fm } from '../astro-dep';\n---\n<script>import '../astro-script';</script>\n",
  'src/astro-dep.ts': 'export const fm = 1;\n',
  'src/astro-script.ts': 'export {};\n',
  'index.html': '<script type="module" src="/src/main.tsx"></script>\n<script src="./src/relative.js"></script>\n<script src="https://cdn.example/x.js"></script>\n<script src="//cdn.example/y.js"></script>\n',
  'src/main.tsx': 'export const App = () => null;\n',
  'src/relative.js': 'window.x = 1;\n',
  'bin/cli.js': "#!/usr/bin/env node\nrequire('../src/legacy');\n",
  'tools/build.mjs': 'console.log("build");\n',
  'broken/package.json': '{ not json',
  'node_modules/dep/package.json': '{"main":"index.js"}',
  'node_modules/dep/index.js': 'module.exports = 1;\n',
  ...Object.fromEntries([
    ['next', ['next'], ['app/page.tsx', 'pages/api/hello.ts', 'middleware.ts', 'src/app/layout.tsx', 'lib/unused.ts', 'next.config.mjs']],
    ['kit', ['@sveltejs/kit'], ['src/routes/+page.ts', 'src/hooks.server.ts', 'src/params/id.ts', 'src/lib/unused.ts']],
    ['remix', ['@remix-run/react'], ['app/routes/home.tsx', 'app/root.tsx', 'app/unused.ts']],
    ['nuxt', ['nuxt'], ['pages/index.ts', 'composables/useThing.ts', 'utils/helper.ts', 'app.ts', 'other/unused.ts']],
    ['astro', ['astro'], ['src/pages/a.ts', 'src/middleware.ts', 'src/content/config.ts', 'src/unused.ts']],
    ['expo', ['expo-router', 'expo'], ['app/tab.tsx', 'App.tsx', 'index.js', 'app.config.ts', 'lib/unused.ts']],
    ['gatsby', ['gatsby'], ['src/pages/p.tsx', 'src/templates/t.tsx', 'gatsby-node.js', 'src/unused.ts']],
    ['nest', ['@nestjs/core'], ['src/main.ts', 'src/unused.ts']],
    ['docusaurus', ['@docusaurus/core'], ['src/theme/x.tsx', 'docusaurus.config.js', 'sidebars.js', 'docs/intro.tsx', 'src/unused.ts']],
    ['vitepress', ['vitepress'], ['.vitepress/config.ts', 'docs/.vitepress/theme/index.ts', 'src/unused.ts']],
    ['storybook', ['storybook'], ['.storybook/main.ts', 'src/unused.ts']],
    ['plain', [], ['src/index.ts', 'src/cli.ts', 'src/unused.ts', 'index.js']],
  ].flatMap(([name, deps, files]) => [
    [`packages/${name}/package.json`, JSON.stringify({ name, peerDependencies: Object.fromEntries((deps as string[]).map((d) => [d, '*'])), devDependencies: 'not an object' })],
    ...(files as string[]).map((f) => [`packages/${name}/${f}`, `export const from_${String(name)} = ${JSON.stringify(f)};\n`]),
  ])),
};

/** The same project, as one package without workspaces: nested packages then count as separate. */
function writeShapes(work: string): string[] {
  const whole = makeRepo(path.join(work, 'shapes'), SHAPES);
  const { workspaces: _dropped, ...rootPackage } = JSON.parse(SHAPES['package.json']!);
  const separate = makeRepo(path.join(work, 'shapes-separate'), { ...SHAPES, 'package.json': JSON.stringify({ ...rootPackage, dependencies: {} }) });
  return [whole, separate];
}

// --- config ---------------------------------------------------------------------------------

async function snapConfig(src: string, snap: Snap): Promise<void> {
  const { resolveConfig } = await import(pathToFileURL(path.join(src, 'config.ts')).href);
  const rng = random(3);
  const strings = [['a'], [], ['dead-files'], ['dead-files', 'nope'], 'x', [1], null, ['unused-exports', 'stale-flags', 'outdated-deps']];
  const numbers = [1, 0, -1, 2.5, '3', null, Number.NaN, 1e9, Number.POSITIVE_INFINITY];
  const pool: Record<string, unknown[]> = {
    categories: strings, verify: strings, entry: strings, ignore: strings,
    branchPrefix: ['janitor', 'a/b', 'bad name', '', 7, null, 'x.y-z_1'],
    bisect: [true, false, 0, 'yes', null],
    deadFiles: ['propose', 'apply', 'delete', true, null],
    maxVerifyRuns: numbers, verifyTimeoutSec: numbers,
    flags: [{}, { registry: 'f.json' }, { registry: 3 }, { staleDays: 30 }, { staleDays: 0 }, { registry: 'x', staleDays: '9' }, null, 'no'],
    deps: [{}, { exclude: ['a'] }, { exclude: 'a' }, { max: 3 }, { max: -3 }, { exclude: [], max: 1 }, null],
    unknownKey: [1],
  };
  const out: unknown[] = [];
  for (let i = 0; i < 4000; i++) {
    const raw: Record<string, unknown> = {};
    for (const key of Object.keys(pool)) if (rng.chance(i % 4 === 0 ? 0.15 : 0.35)) raw[key] = rng.pick(pool[key]!);
    out.push(await attempt(() => resolveConfig(raw)));
  }
  snap['config/made-up'] = digest(out);
}

// --- the safe-apply loop --------------------------------------------------------------------

/** The fixture's "test suite": rules.json says which files must exist and which may not all be missing at once. */
const CHECK = `const fs = require('fs');
const rules = JSON.parse(fs.readFileSync('rules.json', 'utf8'));
if (rules.litter) fs.writeFileSync('coverage.tmp', 'x');
for (const f of rules.must) if (!fs.existsSync(f)) { console.error('missing ' + f); process.exit(1); }
for (const group of rules.notAll) if (group.every((f) => !fs.existsSync(f))) { console.error('all gone: ' + group.join(' ')); process.exit(3); }
for (const f of rules.poison) if (fs.existsSync(f)) { console.error('poison ' + f); process.exit(4); }
`;

async function snapEngine(src: string, work: string, snap: Snap): Promise<void> {
  const { runJanitor } = await import(pathToFileURL(path.join(src, 'engine.ts')).href);
  const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(src, 'config.ts')).href);
  const report = await import(pathToFileURL(path.join(src, 'report.ts')).href);
  const rng = random(17);
  for (let n = 0; n < 70; n++) {
    const files = Array.from({ length: 4 + rng.int(6) }, (_, i) => `f${i}.txt`);
    const rules = {
      must: rng.sample(files, rng.int(3)),
      notAll: rng.chance(0.4) ? [rng.sample(files, 2)] : [],
      poison: rng.chance(0.3) ? ['poison.txt'] : [],
      litter: rng.chance(0.3),
    };
    const initial: Record<string, string> = { 'check.cjs': CHECK, 'rules.json': JSON.stringify(rules), '.gitignore': rng.chance(0.5) ? 'coverage.tmp\n' : '' };
    for (const f of files) initial[f] = `${f}\n`.repeat(1 + rng.int(4));
    const root = makeRepo(path.join(work, `engine-${n}`), initial);
    const hooks: string[] = [];

    const item = (i: number) => {
      const file = rng.pick(files);
      const kind = rng.pick(['delete', 'delete', 'delete', 'write', 'same', 'throw', 'poison', 'two']);
      const other = rng.pick(files);
      return {
        id: `${kind}:${file}:${i}`,
        description: `${kind} ${file}`,
        ...(kind === 'two' ? { paths: [file, other] } : {}),
        async apply(ctx: { root: string }) {
          const abs = path.join(ctx.root, file);
          if (kind === 'delete') fs.rmSync(abs); // throws when an earlier item already removed it
          else if (kind === 'write') fs.writeFileSync(abs, 'rewritten\n');
          else if (kind === 'same') fs.writeFileSync(abs, fs.existsSync(abs) ? fs.readFileSync(abs) : '');
          else if (kind === 'throw') throw i % 2 ? new Error(`cannot apply ${i}`) : `not an Error ${i}`;
          else if (kind === 'poison') fs.writeFileSync(path.join(ctx.root, 'poison.txt'), 'x');
          else for (const f of [file, other]) fs.rmSync(path.join(ctx.root, f), { force: true });
        },
      };
    };
    const categories = Array.from({ length: 1 + rng.int(3) }, (_, c) => {
      const behaviour = rng.pick(['plain', 'plain', 'plain', 'scan-throws', 'scan-dirties', 'notes', 'after-revert', 'empty']);
      const items = behaviour === 'empty' ? [] : Array.from({ length: 1 + rng.int(6) }, (_, i) => item(c * 10 + i));
      return {
        name: `cat${c}`,
        title: `Category ${c}`,
        countsAsDeadCode: rng.chance(0.6),
        async scan(ctx: { root: string }) {
          if (behaviour === 'scan-throws') throw new Error('scan exploded');
          if (behaviour === 'scan-dirties') fs.writeFileSync(path.join(ctx.root, 'scan-leftover.tmp'), 'x');
          return { items, notes: behaviour === 'notes' ? ['a note', 'another | note'] : [] };
        },
        ...(behaviour === 'after-revert' ? { afterRevert: async () => void hooks.push(`reverted cat${c}`) } : {}),
      };
    });

    const setup = rng.pick(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'dirty', 'untracked', 'no-verify', 'unverified', 'baseline', 'branch', 'not-a-repo', 'detached']);
    if (setup === 'dirty') fs.writeFileSync(path.join(root, files[0]!), 'changed\n');
    if (setup === 'untracked') for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, `new-${i}.txt`), 'x');
    if (setup === 'baseline') git(root, 'rm', '-q', 'check.cjs'), git(root, 'commit', '-q', '-m', 'break the checks');
    if (setup === 'branch') git(root, 'branch', `nightly-janitor/${DATE}`);
    if (setup === 'detached') git(root, 'checkout', '-q', '--detach');
    const target = setup === 'not-a-repo' ? path.join(work, `plain-${n}`) : root;
    fs.mkdirSync(target, { recursive: true });
    const config = { ...structuredClone(DEFAULT_CONFIG), bisect: rng.chance(0.8), maxVerifyRuns: rng.pick([200, 200, 200, 3, 1]), branchPrefix: rng.pick(['nightly-janitor', 'nightly-janitor', 'tidy/up']) };
    const options = {
      root: target,
      categories,
      verify: setup === 'no-verify' || setup === 'unverified' ? [] : rng.chance(0.2) ? ['node check.cjs', 'test -f rules.json'] : ['node check.cjs'],
      config,
      date: DATE,
      dryRun: rng.chance(0.12),
      allowUnverified: setup === 'unverified',
      proposeOnly: rng.chance(0.25) ? ['cat0'] : rng.chance(0.1) ? ['cat1', 'nope'] : undefined,
      log: (m: string) => void hooks.push(m),
    };
    const result = await attempt(() => runJanitor(options));
    const rendered = 'raised' in result ? null : await attempt(() => [report.renderPrBody(result), report.renderPlan(result), report.computeTotals(result), report.prTitle(result)]);
    const state = setup === 'not-a-repo' ? null : [
      git(root, 'log', '--all', '--format=%H %D%n%B'), git(root, 'status', '--porcelain'), git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), git(root, 'ls-files'),
    ];
    snap[`engine/${n}`] = scrub(JSON.stringify([setup, result, rendered, state, hooks], plain), work);
  }
}

// --- the command line -----------------------------------------------------------------------

const PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', main: 'src/index.js', scripts: { test: 'node check.mjs' } }, null, 2) + '\n',
  'check.mjs': "import { run } from './src/index.js';\nif (run() !== 3) process.exit(1);\n",
  'src/index.js': "import { add } from './math.js';\nexport function run() {\n  return add(1, 2);\n}\n",
  'src/math.js': "import { helper } from './helper.js';\nexport const add = (a, b) => helper(a) + b;\nexport const unusedThing = 42;\nexport function alsoUnused() {\n  return helper(1);\n}\n",
  'src/helper.js': 'export const helper = (x) => x;\n',
  'src/dead.js': "import { deader } from './deader.js';\nexport const dead = () => deader();\n",
  'src/deader.js': 'export const deader = () => 1;\n',
  'flags.json': JSON.stringify({ 'old-flag': true, 'used-flag': { enabled: true }, $schema: 'x' }, null, 2) + '\n',
  'src/flags.js': "export const on = (flags) => flags['used-flag'];\n",
};

function snapCli(src: string, work: string, snap: Snap): void {
  const root = makeRepo(path.join(work, 'cli-project'), PROJECT);
  const outputs = path.join(work, 'cli-github-output');
  const runs: [string, string[], Record<string, string>?][] = [
    ['version', ['--version']],
    ['help', ['--help']],
    ['help-command', ['help']],
    ['unknown', ['frobnicate']],
    ['missing-repo', ['scan', '--repo', path.join(work, 'nowhere')]],
    ['bad-date', ['run', '--repo', root, '--date', 'tomorrow']],
    ['bad-number', ['run', '--repo', root, '--max-verify-runs', 'lots']],
    ['bad-timeout', ['run', '--repo', root, '--timeout-sec', '0']],
    ['scan', ['scan', '--repo', root]],
    ['scan-some', ['scan', '--repo', root, '--categories', 'dead-files, stale-flags']],
    ['scan-unknown-category', ['scan', '--repo', root, '--categories', 'nope']],
    ['no-verify', ['run', '--repo', root, '--categories', 'stale-flags', '--verify', ' ', '--date', DATE]],
    ['run', ['run', '--repo', root, '--categories', 'dead-files,unused-exports,stale-flags', '--verify', 'node check.mjs', '--date', DATE,
      '--pr-body', path.join(work, 'cli-pr.md'), '--report-json', path.join(work, 'cli-report.json')], { GITHUB_OUTPUT: outputs }],
    ['run-again', ['run', '--repo', root, '--verify', 'node check.mjs', '--date', DATE]],
    ['run-delete-files', ['run', '--repo', root, '--categories', 'dead-files', '--delete-files', '--no-bisect', '--verify', 'node check.mjs', '--date', '2026-01-03']],
    ['run-nothing-left', ['run', '--repo', root, '--categories', 'stale-flags', '--verify', 'node check.mjs', '--date', '2026-01-04', '--allow-unverified']],
    ['run-no-change', ['run', '--repo', root, '--categories', 'stale-flags', '--verify', 'node check.mjs', '--date', '2026-01-05']],
    ['baseline-fails', ['run', '--repo', root, '--categories', 'unused-exports', '--verify', 'node -e "process.exit(7)"', '--date', '2026-01-06']],
    ['bad-config', ['scan', '--repo', root]],
  ];
  for (const [name, args, env] of runs) {
    if (name === 'bad-config') fs.writeFileSync(path.join(root, '.janitor.json'), '{"deadFiles": "burn"}');
    const done = spawnSync('node', [TSX, path.join(src, 'cli.ts'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
    const written = ['cli-pr.md', 'cli-report.json', 'cli-github-output'].map((f) => (fs.existsSync(path.join(work, f)) ? fs.readFileSync(path.join(work, f), 'utf8') : null));
    const state = [git(root, 'log', '--all', '--format=%H %D %s'), git(root, 'status', '--porcelain'), git(root, 'ls-files')];
    const text = JSON.stringify([done.status, done.stdout, done.stderr, written, state]);
    snap[`cli/${name}`] = scrub(text, work);
  }
}

// --- running both sides ---------------------------------------------------------------------

async function takeSnapshot(src: string, out: string, work: string, repos: string[], only: string[]): Promise<void> {
  const snap: Snap = {};
  const wanted = (part: string) => only.length === 0 || only.includes(part);
  for (const repo of [...repos, ...(only.length === 0 || ['project', 'edits', 'paths'].some(wanted) ? writeShapes(work) : [])]) {
    if (wanted('project')) await snapProject(src, repo, snap);
    if (wanted('edits')) await snapEdits(src, repo, snap);
    if (wanted('paths')) await snapPaths(src, repo, snap);
  }
  if (wanted('config')) await snapConfig(src, snap);
  if (wanted('engine')) await snapEngine(src, work, snap);
  if (wanted('cli')) snapCli(src, work, snap);
  fs.writeFileSync(out, JSON.stringify(snap, null, 0));
}

async function compare(base: string, repos: string[], only: string[], keep?: string): Promise<number> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'behaviour-')));
  const oldTree = path.join(tmp, 'old-tree');
  fs.mkdirSync(oldTree);
  const archive = execFileSync('git', ['-C', ROOT, 'archive', base, 'src', 'package.json'], { maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', oldTree], { input: archive });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(oldTree, 'node_modules'));
  // Same commit dates on both sides, so the commits janitor makes get the same hashes.
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z', GITHUB_OUTPUT: '' };
  const sides: [string, string][] = [['old', path.join(oldTree, 'src')], ['new', path.join(ROOT, 'src')]];
  const codes = await Promise.all(sides.map(([side, src]) => new Promise<number | null>((resolve) => {
    const work = path.join(tmp, 'work', side);
    fs.mkdirSync(work, { recursive: true });
    const args = [TSX, fileURLToPath(import.meta.url), '--snapshot', src, path.join(tmp, `${side}.json`), work, ...repos, ...(only.length ? ['--only', only.join(',')] : [])];
    spawn('node', args, { stdio: 'inherit', env }).on('exit', resolve);
  })));
  if (codes.some((code) => code !== 0)) {
    console.error('a snapshot run failed');
    return 2;
  }
  const [before, after] = ['old', 'new'].map((side) => JSON.parse(fs.readFileSync(path.join(tmp, `${side}.json`), 'utf8')) as Snap);
  if (keep) for (const side of ['old', 'new']) fs.copyFileSync(path.join(tmp, `${side}.json`), `${keep}.${side}.json`);
  fs.rmSync(tmp, { recursive: true, force: true });
  const keys = [...new Set([...Object.keys(before!), ...Object.keys(after!)])].sort();
  const differing = keys.filter((k) => before![k] !== after![k]);
  const parts = new Map<string, number>();
  for (const key of keys) parts.set(key.split('/')[0]!, (parts.get(key.split('/')[0]!) ?? 0) + 1);
  console.log(`${keys.length} outputs compared: ${[...parts].map(([part, n]) => `${part} ${n}`).join(', ')}`);
  if (differing.length === 0) {
    console.log('identical');
    return 0;
  }
  console.log(`${differing.length} differ:`);
  for (const key of differing.slice(0, 40)) console.log(`  ${key}`);
  return 1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv.splice(at, 2)[1];
  };
  const only = (flag('--only') ?? '').split(',').filter(Boolean);
  const keep = flag('--keep');
  if (argv[0] === '--snapshot') {
    await takeSnapshot(argv[1]!, argv[2]!, argv[3]!, argv.slice(4), only);
    return 0;
  }
  if (argv.length < 1) {
    console.error('usage: behaviour-check.ts <base-ref> <repo> [<repo> ...] [--only project,edits,paths,config,engine,cli] [--keep prefix]');
    return 2;
  }
  return compare(argv[0]!, argv.slice(1).map((r) => fs.realpathSync(r)), only, keep);
}

process.exitCode = await main();

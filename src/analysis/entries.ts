import path from 'node:path';
import { SOURCE_EXTS, readText, stripSourceExt } from '../util/files.js';
import { makeMatcher } from '../util/glob.js';

/**
 * Files that are used by convention rather than by import: tests, tool
 * configuration, scripts and framework routing directories. Deliberately
 * broad; a missed cleanup costs nothing, a wrong deletion costs trust.
 */
const CONVENTION_ENTRY_GLOBS = [
  // tests
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/test/**',
  '**/tests/**',
  '**/e2e/**',
  '**/cypress/**',
  '**/playwright/**',
  '**/*.stories.*',
  // tooling and configuration
  '**/*.config.*',
  '**/*.conf.*',
  '**/*.setup.*',
  '**/*.workspace.*',
  '**/{gulpfile,Gruntfile,Jakefile,webpack,rollup}.*',
  '**/{setupTests,setup-tests,service-worker,sw}.*',
  // Anything at the top of the repository is far more often tool configuration
  // or a script (gulpfile.js, server.js) than a forgotten module.
  '*',
  '**/.*',
  '**/.*/**',
  '**/scripts/**',
  '**/bin/**',
  '**/tools/**',
  '**/examples/**',
  '**/docs/**',
  '**/bench/**',
  '**/benchmarks/**',
  // framework conventions (file-system routing, serverless, migrations)
  '**/pages/**',
  '**/app/**',
  '**/routes/**',
  '**/api/**',
  '**/functions/**',
  '**/migrations/**',
  '**/seeds/**',
  '**/seeders/**',
  '**/public/**',
  '**/static/**',
  '**/middleware.*',
  '**/instrumentation.*',
];

/** Conventional program roots, used when package.json declares none. */
const ROOT_CONVENTION_GLOBS = ['{index,main}.*', '**/src/{index,main,cli,server,app}.*'];

const OUTPUT_DIRS = new Set(['dist', 'build', 'lib', 'out', 'esm', 'cjs', 'es', 'umd', 'types']);
const SCRIPT_PATH = /[\w@./-]+\.(?:[cm]?[jt]s|[jt]sx)\b/g;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
}

/**
 * Map a path declared in package.json (often a build output such as
 * `dist/index.js`) back to the source files it most plausibly comes from.
 */
export function mapToSources(declared: string, pkgDir: string, sources: Set<string>): string[] {
  const rel = path.posix.normalize(path.posix.join(pkgDir, declared));
  if (rel.startsWith('..')) return [];
  const stem = stripSourceExt(rel);

  const inner = pkgDir === '.' || pkgDir === '' ? stem : stem.slice(pkgDir.length + 1);
  const prefix = pkgDir === '.' || pkgDir === '' ? '' : `${pkgDir}/`;
  const segments = inner.split('/');
  const stems = new Set([stem]);
  if (segments.length > 1 && OUTPUT_DIRS.has(segments[0]!)) {
    const rest = segments.slice(1).join('/');
    stems.add(`${prefix}src/${rest}`);
    // Dropping the output directory from a wildcard path would match the whole package.
    if (!rest.startsWith('*')) stems.add(`${prefix}${rest}`);
  }

  const found = new Set<string>();
  const lookup = (s: string) => {
    for (const ext of SOURCE_EXTS) {
      if (sources.has(s + ext)) found.add(s + ext);
      if (sources.has(`${s}/index${ext}`)) found.add(`${s}/index${ext}`);
    }
  };
  for (const s of stems) {
    if (s.includes('*')) {
      // In package.json `exports`, `*` matches across directories: "./unsafe/*": "./lib/*"
      // publishes every file under lib/, however deep.
      const re = new RegExp(`^${s.replace(/[.+^$()|[\]\\{}?]/g, '\\$&').replace(/\*/g, '.*')}(?:\\.[^/]*)?$`);
      for (const f of sources) if (re.test(f)) found.add(f);
      continue;
    }
    lookup(s);
  }

  // Build output under a directory name we do not know (`distribution/index.js`
  // built from `source/index.ts`): accept the same path under any sibling directory.
  if (found.size === 0 && segments.length > 1 && !stem.includes('*')) {
    const rest = segments.slice(1).join('/');
    const firstDirs = new Set<string>();
    for (const f of sources) {
      if (!f.startsWith(prefix)) continue;
      const first = f.slice(prefix.length).split('/')[0]!;
      if (first !== segments[0]) firstDirs.add(first);
    }
    for (const dir of firstDirs) lookup(`${prefix}${dir}/${rest}`);
  }
  return [...found];
}

export interface EntryPoints {
  /** All files treated as used regardless of imports. */
  entries: Set<string>;
  /** Number of genuine program roots (package.json, conventions, user config). Zero means "do not trust reachability". */
  roots: number;
}

export function findEntryPoints(root: string, tracked: string[], sources: string[], userGlobs: string[]): EntryPoints {
  const sourceSet = new Set(sources);
  const entries = new Set<string>();
  let roots = 0;

  const addRoot = (file: string) => {
    if (!entries.has(file)) roots++;
    entries.add(file);
  };

  for (const pkgFile of tracked) {
    if (path.posix.basename(pkgFile) !== 'package.json' || pkgFile.includes('node_modules/')) continue;
    const text = readText(root, pkgFile);
    if (!text) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const declared: string[] = [];
    for (const key of ['main', 'module', 'types', 'typings', 'browser', 'bin', 'exports', 'source']) {
      collectStrings(pkg[key], declared);
    }
    const scripts: string[] = [];
    collectStrings(pkg.scripts, scripts);
    for (const script of scripts) declared.push(...(script.match(SCRIPT_PATH) ?? []));

    const pkgDir = path.posix.dirname(pkgFile);
    for (const d of declared) for (const f of mapToSources(d, pkgDir, sourceSet)) addRoot(f);
  }

  const isUser = makeMatcher(userGlobs);
  const isRootConvention = makeMatcher(ROOT_CONVENTION_GLOBS);
  const isConvention = makeMatcher(CONVENTION_ENTRY_GLOBS);
  for (const f of sources) {
    if (isUser(f) || isRootConvention(f)) addRoot(f);
    else if (isConvention(f)) entries.add(f);
  }
  return { entries, roots };
}

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
  '**/*.test-d.*',
  '**/test-d/**',
  // sample inputs that test runners and compilers read from disk rather than import
  '**/{fixtures,fixture,__fixtures__,testdata,test-data,stubs,mock,mocks,snapshots,__snapshots__}/**',
  '**/{samples,templates,template,playground,sandbox,demo,demos}/**',
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

/**
 * Frameworks that find their entry points on disk instead of through
 * package.json. When one is a dependency, these paths (relative to that
 * package) are genuine program roots.
 */
const FRAMEWORK_ROOTS: { deps: string[]; globs: string[] }[] = [
  {
    deps: ['next'],
    globs: ['{app,pages}/**', 'src/{app,pages}/**', '{middleware,proxy,instrumentation}*.*', 'src/{middleware,proxy,instrumentation}*.*', 'next.config.*'],
  },
  { deps: ['@sveltejs/kit'], globs: ['src/routes/**', 'src/hooks*.*', 'src/params/**', 'src/service-worker.*', 'svelte.config.*'] },
  { deps: ['@remix-run/react', '@remix-run/node', '@react-router/dev'], globs: ['app/routes/**', 'app/{root,entry,routes}*.*'] },
  {
    deps: ['nuxt'],
    globs: ['{pages,app,server,plugins,middleware,layouts,composables,components,utils,shared,modules,stores,layers}/**', 'app.*', 'nuxt.config.*'],
  },
  { deps: ['astro'], globs: ['src/pages/**', 'src/middleware.*', 'src/content/config.*', 'src/content.config.*', 'astro.config.*'] },
  { deps: ['expo-router'], globs: ['app/**', 'src/app/**'] },
  { deps: ['expo', 'react-native'], globs: ['{App,index}.*', 'app.config.*'] },
  { deps: ['gatsby'], globs: ['src/pages/**', 'src/templates/**', 'gatsby-*.*'] },
  { deps: ['@nestjs/core', '@angular/core'], globs: ['src/main*.*'] },
  {
    deps: ['@docusaurus/core'],
    globs: ['src/{theme,pages,plugins,css}/**', 'docusaurus.config.*', 'sidebars*.*', '{docs,blog}/**'],
  },
  { deps: ['vitepress'], globs: ['.vitepress/**', '**/.vitepress/**'] },
  { deps: ['@storybook/react', 'storybook'], globs: ['.storybook/**'] },
];

/**
 * Tools that make exports available everywhere without an import statement.
 * In such a project "nobody imports it" does not mean "nobody uses it".
 */
const AUTO_IMPORT_DEPS = ['nuxt', 'nuxt3', '@nuxt/kit', 'nitropack', 'unplugin-auto-import', 'unimport', 'unplugin-vue-components'];

const HTML_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']([^"'?#]+)/gi;

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

  // Build output laid out in a way we do not know (`distribution/index.js` from
  // `source/index.ts`, or `dist/types/element/src/*.d.ts` from `src/*`): drop
  // leading directories of the declared path until what is left exists in the
  // package, trying it both in place and under each top-level directory.
  if (found.size === 0 && segments.length > 1) {
    const firstDirs = new Set<string>(['']);
    for (const f of sources) {
      if (!f.startsWith(prefix)) continue;
      const parts = f.slice(prefix.length).split('/');
      if (parts.length > 1) firstDirs.add(`${parts[0]}/`);
    }
    for (let drop = 1; drop < segments.length && found.size === 0; drop++) {
      const rest = segments.slice(drop).join('/');
      if (rest.startsWith('*')) break;
      for (const dir of firstDirs) {
        if (drop === 1 && dir === '') continue; // already tried above as "output directory removed"
        const candidate = `${prefix}${dir}${rest}`;
        if (candidate.includes('*')) {
          const re = new RegExp(`^${candidate.replace(/[.+^$()|[\]\\{}?]/g, '\\$&').replace(/\*/g, '.*')}(?:\\.[^/]*)?$`);
          for (const f of sources) if (re.test(f)) found.add(f);
        } else {
          lookup(candidate);
        }
      }
    }
  }

  // A wildcard that still matches nothing we can name publishes files we cannot
  // tell apart from the rest, so the whole package is treated as public.
  if (found.size === 0 && stem.includes('*')) {
    for (const f of sources) if (f.startsWith(prefix)) found.add(f);
  }
  return [...found];
}

export interface EntryPoints {
  /** All files treated as used regardless of imports. */
  entries: Set<string>;
  /** Number of genuine program roots (package.json, conventions, user config). Zero means "do not trust reachability". */
  roots: number;
  /** Whether the project uses a tool that injects imports automatically (Nuxt, unplugin-auto-import, ...). */
  autoImports: boolean;
}

export function findEntryPoints(root: string, tracked: string[], sources: string[], userGlobs: string[]): EntryPoints {
  const sourceSet = new Set(sources);
  const entries = new Set<string>();
  let roots = 0;
  let autoImports = false;

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

    const deps = new Set<string>();
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (pkg[key] && typeof pkg[key] === 'object') for (const name of Object.keys(pkg[key] as object)) deps.add(name);
    }
    if (AUTO_IMPORT_DEPS.some((d) => deps.has(d))) autoImports = true;
    const prefix = pkgDir === '.' ? '' : `${pkgDir}/`;
    for (const framework of FRAMEWORK_ROOTS) {
      if (!framework.deps.some((d) => deps.has(d))) continue;
      const matches = makeMatcher(framework.globs);
      for (const f of sources) if (f.startsWith(prefix) && matches(f.slice(prefix.length))) addRoot(f);
    }
  }

  // A page that loads a script is an entry point for it: <script type="module" src="/src/main.tsx">.
  for (const html of tracked) {
    if (!/\.html?$/i.test(html) || html.includes('node_modules/')) continue;
    const text = readText(root, html);
    if (!text) continue;
    const dir = path.posix.dirname(html);
    for (const match of text.matchAll(HTML_SCRIPT)) {
      const src = match[1]!;
      if (/^(?:[a-z]+:)?\/\//i.test(src)) continue;
      const relative = src.replace(/^\/+/, '');
      for (const base of src.startsWith('/') ? [dir, '.'] : [dir]) {
        const candidate = path.posix.normalize(path.posix.join(base, relative));
        if (sourceSet.has(candidate)) addRoot(candidate);
      }
    }
  }

  const isUser = makeMatcher(userGlobs);
  const isRootConvention = makeMatcher(ROOT_CONVENTION_GLOBS);
  const isConvention = makeMatcher(CONVENTION_ENTRY_GLOBS);
  for (const f of sources) {
    if (isUser(f) || isRootConvention(f)) addRoot(f);
    else if (isConvention(f)) entries.add(f);
  }
  return { entries, roots, autoImports };
}

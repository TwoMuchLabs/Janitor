import path from 'node:path';
import { DEFAULT_IGNORE } from '../config.js';
import type { JanitorContext } from '../types.js';
import { isLockfile, isSource, readText, stripSourceExt, trackedFiles } from '../util/files.js';
import { makeMatcher } from '../util/glob.js';
import { findEntryPoints, type EntryPoints } from './entries.js';
import { buildModuleGraph, reachableFrom, type ModuleGraph } from './module-graph.js';

/**
 * Loose references found outside the import graph: path-like tokens and
 * identifiers in files the graph cannot parse (HTML, YAML, Dockerfiles,
 * `.vue`/`.svelte` components, ...) and path-like tokens in reachable source
 * (catches bundler aliases the resolver does not know about).
 */
interface Mentions {
  /** File names with a source extension, e.g. `worker.js`. */
  basenames: Set<string>;
  /** `<parent dir>/<name without extension>`, e.g. `jobs/worker`. */
  pairs: Set<string>;
  /** Identifier-like words in non-source files. */
  identifiers: Set<string>;
  /**
   * For projects with automatic imports only: how many source files mention
   * each identifier-like word. A name seen in more than its own file may be
   * used there without an import.
   */
  sourceFileCounts: Map<string, number>;
}

interface ProjectAnalysis {
  sources: string[];
  graph: ModuleGraph;
  entryPoints: EntryPoints;
  reachable: Set<string>;
  mentions: Mentions;
  isIgnored: (file: string) => boolean;
  /**
   * Directories holding their own package.json that the root project does not
   * declare as workspaces. The root verification suite does not exercise them,
   * so nothing inside them is touched.
   */
  separatePackages: string[];
}

const PATH_TOKEN = /[A-Za-z0-9_@.\-/]+/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const SOURCE_NAME = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function addPathTokens(text: string, mentions: Mentions): void {
  for (const token of text.match(PATH_TOKEN) ?? []) {
    const hasSlash = token.includes('/');
    if (!hasSlash && !SOURCE_NAME.test(token)) continue;
    const segments = token.split('/').filter(Boolean);
    const last = segments.at(-1);
    if (!last) continue;
    if (SOURCE_NAME.test(last)) mentions.basenames.add(last);
    const parent = segments.at(-2);
    if (parent) mentions.pairs.add(`${parent}/${stripSourceExt(last)}`);
  }
}

const VARIANT_SUFFIX =
  /[-._](?:browser|node|native|web|ios|android|windows|macos|worker|server|client|deno|bun|edge|electron|react-native|rn|esm|cjs|legacy|modern|dev|prod|development|production)$/;

/**
 * Is `file` a platform or build variant of a sibling (`md5-browser.ts` next to
 * `md5.ts`, `Button.ios.tsx` next to `Button.tsx`)? Such files are swapped in
 * by bundlers and build scripts by naming convention, never by import, and a
 * test suite running on one platform will not notice another's variant missing.
 */
export function isVariantOfSibling(file: string, sources: Set<string>): boolean {
  const dir = path.posix.dirname(file);
  const stem = stripSourceExt(path.posix.basename(file));
  const base = stem.replace(VARIANT_SUFFIX, '');
  if (base === stem || !base) return false;
  const prefix = dir === '.' ? '' : `${dir}/`;
  return ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].some((ext) => sources.has(prefix + base + ext));
}

/** True when something outside the import graph appears to refer to `file`. */
export function isMentioned(file: string, mentions: Mentions): boolean {
  const base = path.posix.basename(file);
  const stem = stripSourceExt(base);
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
    if (mentions.basenames.has(stem + ext)) return true;
  }
  const parent = path.posix.basename(path.posix.dirname(file));
  if (parent && parent !== '.') {
    if (mentions.pairs.has(`${parent}/${stem}`)) return true;
    // `import x from './widgets'` style reference to widgets/index.ts
    if (stem === 'index') {
      const grand = path.posix.basename(path.posix.dirname(path.posix.dirname(file)));
      if (grand && grand !== '.' && mentions.pairs.has(`${grand}/${parent}`)) return true;
    }
  }
  return false;
}

/** Nested packages that are projects of their own rather than workspaces of the root. */
function findSeparatePackages(root: string, tracked: string[]): string[] {
  const nested = tracked
    .filter((f) => path.posix.basename(f) === 'package.json' && f !== 'package.json' && !f.includes('node_modules/'))
    .map((f) => path.posix.dirname(f));
  if (nested.length === 0) return [];
  let hasWorkspaces = tracked.includes('pnpm-workspace.yaml') || tracked.includes('lerna.json');
  const rootPkg = readText(root, 'package.json');
  if (rootPkg) {
    try {
      hasWorkspaces ||= (JSON.parse(rootPkg) as { workspaces?: unknown }).workspaces !== undefined;
    } catch {
      /* unreadable root package.json: treat nested packages as separate */
    }
  }
  return hasWorkspaces ? [] : nested.sort();
}

export async function analyzeProject(ctx: JanitorContext): Promise<ProjectAnalysis> {
  const tracked = await trackedFiles(ctx);
  const sources = tracked.filter((f) => isSource(f) && !f.includes('node_modules/'));
  const componentFiles = tracked.filter((f) => /\.(?:vue|svelte|astro)$/.test(f) && !f.includes('node_modules/'));
  const graph = buildModuleGraph(ctx.root, sources, componentFiles);
  const entryPoints = findEntryPoints(ctx.root, tracked, sources, ctx.config.entry);
  // Components are always in use, so whatever they import is reachable.
  const importedByComponents = graph.components.flatMap((c) => [...c.edges.keys()]);
  const reachable = reachableFrom(graph, [...entryPoints.entries, ...importedByComponents]);

  const mentions: Mentions = { basenames: new Set(), pairs: new Set(), identifiers: new Set(), sourceFileCounts: new Map() };
  for (const file of tracked) {
    if (isLockfile(file) || /\.(?:map|snap|svg|lock)$/i.test(file)) continue;
    if (isSource(file)) {
      const text = readText(ctx.root, file);
      if (!text) continue;
      if (entryPoints.autoImports) {
        for (const id of new Set(text.match(IDENTIFIER) ?? [])) {
          mentions.sourceFileCounts.set(id, (mentions.sourceFileCounts.get(id) ?? 0) + 1);
        }
      }
      if (reachable.has(file)) addPathTokens(text, mentions);
    } else {
      const text = readText(ctx.root, file);
      if (!text) continue;
      addPathTokens(text, mentions);
      // Prose and package.json can name a file (`node scripts/x.mjs`) but never "use" an export.
      if (path.posix.basename(file) !== 'package.json' && !/\.md$/i.test(file)) {
        for (const id of text.match(IDENTIFIER) ?? []) mentions.identifiers.add(id);
      }
    }
  }

  const separatePackages = findSeparatePackages(ctx.root, tracked);
  const matchesIgnore = makeMatcher([...DEFAULT_IGNORE, ...ctx.config.ignore]);
  return {
    sources,
    graph,
    entryPoints,
    reachable,
    mentions,
    isIgnored: (file) => matchesIgnore(file) || separatePackages.some((dir) => file.startsWith(`${dir}/`)),
    separatePackages,
  };
}

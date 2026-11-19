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
}

interface ProjectAnalysis {
  sources: string[];
  graph: ModuleGraph;
  entryPoints: EntryPoints;
  reachable: Set<string>;
  mentions: Mentions;
  isIgnored: (file: string) => boolean;
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

export async function analyzeProject(ctx: JanitorContext): Promise<ProjectAnalysis> {
  const tracked = await trackedFiles(ctx);
  const sources = tracked.filter((f) => isSource(f) && !f.includes('node_modules/'));
  const graph = buildModuleGraph(ctx.root, sources);
  const entryPoints = findEntryPoints(ctx.root, tracked, sources, ctx.config.entry);
  const reachable = reachableFrom(graph, entryPoints.entries);

  const mentions: Mentions = { basenames: new Set(), pairs: new Set(), identifiers: new Set() };
  for (const file of tracked) {
    if (isLockfile(file) || /\.(?:md|map|snap|svg|lock)$/i.test(file)) continue;
    if (isSource(file)) {
      if (!reachable.has(file)) continue;
      const text = readText(ctx.root, file);
      if (text) addPathTokens(text, mentions);
    } else {
      const text = readText(ctx.root, file);
      if (!text) continue;
      addPathTokens(text, mentions);
      // package.json names its own dependencies and scripts; it never "uses" an export.
      if (path.posix.basename(file) !== 'package.json') {
        for (const id of text.match(IDENTIFIER) ?? []) mentions.identifiers.add(id);
      }
    }
  }

  return {
    sources,
    graph,
    entryPoints,
    reachable,
    mentions,
    isIgnored: makeMatcher([...DEFAULT_IGNORE, ...ctx.config.ignore]),
  };
}

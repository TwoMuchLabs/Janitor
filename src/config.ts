import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE = '.janitor.json';

export const ALL_CATEGORIES = ['dead-files', 'unused-exports', 'stale-flags', 'outdated-deps'] as const;

export interface JanitorConfig {
  /** Which cleanup categories to run, in order. */
  categories: string[];
  /** Verification commands. When omitted they are detected from the project. */
  verify?: string[];
  /** Extra entry-point globs: files that are used even though nothing imports them. */
  entry: string[];
  /** Files the janitor must never delete or edit. */
  ignore: string[];
  flags: {
    /** JSON flag registry, repo-relative. Detected when omitted. */
    registry?: string;
    /** A fully-on flag untouched for this long is reported as stale. */
    staleDays: number;
  };
  deps: {
    exclude: string[];
    /** Upper bound on dependency updates attempted per run. */
    max: number;
  };
  /**
   * What to do with dead files. `propose` (the default) checks that the
   * project still passes without them and lists them in the PR, but deletes
   * nothing: a wrongly deleted file is the costliest mistake this tool can
   * make, and tests often cannot see it. `apply` deletes them.
   */
  deadFiles: 'propose' | 'apply';
  branchPrefix: string;
  /** When a category fails as a whole, split it to salvage the safe items. */
  bisect: boolean;
  /** Upper bound on verification runs per night (the baseline run is extra). */
  maxVerifyRuns: number;
  /** Timeout for each verification command. */
  verifyTimeoutSec: number;
}

export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/vendor/**',
  '**/generated/**',
  '**/__generated__/**',
  '**/*.generated.*',
  '**/*.gen.*',
  '**/*.min.js',
];

export const DEFAULT_CONFIG: JanitorConfig = {
  categories: [...ALL_CATEGORIES],
  entry: [],
  ignore: [],
  flags: { staleDays: 90 },
  deps: { exclude: [], max: 20 },
  deadFiles: 'propose',
  branchPrefix: 'nightly-janitor',
  bisect: true,
  maxVerifyRuns: 25,
  verifyTimeoutSec: 1200,
};

export class ConfigError extends Error {}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ConfigError(`${CONFIG_FILE}: "${key}" must be an array of strings`);
  }
  return value as string[];
}

function positive(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${CONFIG_FILE}: "${key}" must be a positive number`);
  }
  return value;
}

/**
 * A `--categories` value as someone typed it. Forgiving about case, spaces and
 * underscores (`Dead_Files` is `dead-files`); strict about names, because a
 * misspelt category silently skipped would look like a clean run.
 */
export function parseCategoryList(raw: string): string[] {
  const known: readonly string[] = ALL_CATEGORIES;
  const names = raw.split(',').map((s) => s.trim().toLowerCase().replace(/[\s_]+/g, '-')).filter(Boolean);
  if (names.length === 0) throw new ConfigError(`--categories names no category (known: ${known.join(', ')})`);
  for (const name of names) {
    if (known.includes(name)) continue;
    const near = known.find((k) => k.startsWith(name.slice(0, 4)) || k.replace(/-/g, '') === name.replace(/-/g, ''));
    throw new ConfigError(`unknown category "${name}"${near ? `; did you mean "${near}"?` : ''} (known: ${known.join(', ')})`);
  }
  return [...new Set(names)];
}

/** Merge a parsed config object over the defaults, validating as it goes. */
export function resolveConfig(raw: Record<string, unknown>): JanitorConfig {
  const cfg: JanitorConfig = structuredClone(DEFAULT_CONFIG);
  if (raw.categories !== undefined) {
    cfg.categories = stringArray(raw.categories, 'categories');
    const unknown = cfg.categories.filter((c) => !(ALL_CATEGORIES as readonly string[]).includes(c));
    if (unknown.length) {
      throw new ConfigError(`unknown categories: ${unknown.join(', ')} (known: ${ALL_CATEGORIES.join(', ')})`);
    }
  }
  if (raw.verify !== undefined) cfg.verify = stringArray(raw.verify, 'verify');
  if (raw.entry !== undefined) cfg.entry = stringArray(raw.entry, 'entry');
  if (raw.ignore !== undefined) cfg.ignore = stringArray(raw.ignore, 'ignore');
  if (raw.branchPrefix !== undefined) {
    if (typeof raw.branchPrefix !== 'string' || !/^[\w./-]+$/.test(raw.branchPrefix)) {
      throw new ConfigError(`${CONFIG_FILE}: "branchPrefix" must be a plain branch-name prefix`);
    }
    cfg.branchPrefix = raw.branchPrefix;
  }
  if (raw.bisect !== undefined) cfg.bisect = Boolean(raw.bisect);
  if (raw.deadFiles !== undefined) {
    if (raw.deadFiles !== 'propose' && raw.deadFiles !== 'apply') {
      throw new ConfigError(`${CONFIG_FILE}: "deadFiles" must be "propose" or "apply"`);
    }
    cfg.deadFiles = raw.deadFiles;
  }
  if (raw.maxVerifyRuns !== undefined) cfg.maxVerifyRuns = positive(raw.maxVerifyRuns, 'maxVerifyRuns');
  if (raw.verifyTimeoutSec !== undefined) cfg.verifyTimeoutSec = positive(raw.verifyTimeoutSec, 'verifyTimeoutSec');

  const flags = (raw.flags ?? {}) as Record<string, unknown>;
  if (flags.registry !== undefined) {
    if (typeof flags.registry !== 'string') throw new ConfigError(`${CONFIG_FILE}: "flags.registry" must be a path`);
    cfg.flags.registry = flags.registry;
  }
  if (flags.staleDays !== undefined) cfg.flags.staleDays = positive(flags.staleDays, 'flags.staleDays');

  const deps = (raw.deps ?? {}) as Record<string, unknown>;
  if (deps.exclude !== undefined) cfg.deps.exclude = stringArray(deps.exclude, 'deps.exclude');
  if (deps.max !== undefined) cfg.deps.max = positive(deps.max, 'deps.max');
  return cfg;
}

export function loadConfig(root: string): JanitorConfig {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${CONFIG_FILE} must contain a JSON object`);
  }
  return resolveConfig(raw as Record<string, unknown>);
}

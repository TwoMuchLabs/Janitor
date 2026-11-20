import fs from 'node:fs';
import path from 'node:path';
import { exec } from '../exec.js';
import type { Category, CleanupItem } from '../types.js';

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}

function parseSemVer(version: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: Boolean(m[4]) };
}

type UpdateKind = 'patch' | 'minor' | 'major' | 'none';

/**
 * Classify an update by what semver promises. For 0.x versions a minor bump
 * may be breaking by convention, so it is classified as major.
 */
export function classifyUpdate(from: string, to: string): UpdateKind {
  const a = parseSemVer(from);
  const b = parseSemVer(to);
  if (!a || !b || a.prerelease || b.prerelease) return 'none';
  if (b.major !== a.major) return b.major > a.major ? 'major' : 'none';
  if (b.minor !== a.minor) {
    if (b.minor < a.minor) return 'none';
    return a.major === 0 ? 'major' : 'minor';
  }
  if (b.patch > a.patch) return 'patch';
  return 'none';
}

interface OutdatedEntry {
  name: string;
  current: string;
  /** Highest version the range in package.json allows. */
  wanted: string;
  latest: string;
}

interface PlannedUpdate {
  name: string;
  from: string;
  to: string;
  kind: 'patch' | 'minor';
}

/** Parse `npm outdated --json` (an object keyed by package name; values may be arrays in workspaces). */
export function parseNpmOutdated(stdout: string): OutdatedEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout || '{}');
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null) return [];
  const entries: OutdatedEntry[] = [];
  for (const [name, value] of Object.entries(json)) {
    const info = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined;
    if (!info || typeof info.current !== 'string' || typeof info.wanted !== 'string') continue;
    entries.push({ name, current: info.current, wanted: info.wanted, latest: String(info.latest ?? info.wanted) });
  }
  return entries;
}

/**
 * Keep only minor/patch updates that the declared range already permits, and
 * describe everything else as a note for a human.
 */
export function planUpdates(
  entries: OutdatedEntry[],
  exclude: string[],
  max: number,
): { updates: PlannedUpdate[]; notes: string[] } {
  const updates: PlannedUpdate[] = [];
  const majors: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (exclude.includes(e.name)) continue;
    const kind = classifyUpdate(e.current, e.wanted);
    if (kind === 'patch' || kind === 'minor') updates.push({ name: e.name, from: e.current, to: e.wanted, kind });
    if (classifyUpdate(e.wanted, e.latest) !== 'none') majors.push(`\`${e.name}\` ${e.wanted} -> ${e.latest}`);
  }
  const notes: string[] = [];
  if (updates.length > max) {
    notes.push(`${updates.length - max} more minor/patch update(s) were deferred to a later night (limit ${max} per run).`);
  }
  if (majors.length) {
    notes.push(`Updates beyond the declared range (not applied, review by hand): ${majors.join(', ')}.`);
  }
  return { updates: updates.slice(0, max), notes };
}

/**
 * Parse `pnpm outdated --format json`. pnpm reports the locked version as
 * `wanted` (and `current` only when installed) plus `latest`; it does not say
 * how far the declared range reaches. So the target is "latest, if that is a
 * minor or patch step", and `pnpm update` then goes as far as the range allows.
 */
export function parsePnpmOutdated(stdout: string): OutdatedEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout || '{}');
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null) return [];
  const entries: OutdatedEntry[] = [];
  for (const [name, value] of Object.entries(json)) {
    const info = value as Record<string, unknown>;
    const locked = typeof info.current === 'string' ? info.current : info.wanted;
    if (typeof locked !== 'string' || typeof info.latest !== 'string') continue;
    const step = classifyUpdate(locked, info.latest);
    entries.push({ name, current: locked, wanted: step === 'patch' || step === 'minor' ? info.latest : locked, latest: info.latest });
  }
  return entries;
}

type Manager = 'npm' | 'pnpm';

const QUIET = ['--loglevel=error'];
const NPM_FLAGS = ['--no-audit', '--no-fund', ...QUIET];
const TIMEOUT_MS = 10 * 60 * 1000;

const MANAGERS: Record<Manager, {
  lockfile: string;
  outdated: string[];
  parse: (stdout: string) => OutdatedEntry[];
  update: (name: string) => string[];
  reinstall: string[];
  /** pnpm cannot say where the declared range ends, so the target is an upper bound. */
  upperBound: boolean;
}> = {
  npm: {
    lockfile: 'package-lock.json',
    outdated: ['outdated', '--json', ...NPM_FLAGS],
    parse: parseNpmOutdated,
    update: (name) => ['update', name, ...NPM_FLAGS],
    reinstall: ['install', '--prefer-offline', ...NPM_FLAGS],
    upperBound: false,
  },
  pnpm: {
    lockfile: 'pnpm-lock.yaml',
    outdated: ['outdated', '--format', 'json'],
    parse: parsePnpmOutdated,
    update: (name) => ['update', name, ...QUIET],
    reinstall: ['install', '--frozen-lockfile', '--prefer-offline', ...QUIET],
    upperBound: true,
  },
};

function detectManager(root: string): Manager | null {
  for (const manager of ['npm', 'pnpm'] as const) {
    if (fs.existsSync(path.join(root, MANAGERS[manager].lockfile))) return manager;
  }
  return null;
}

/**
 * Minor and patch dependency updates, one package per item so a single bad
 * release cannot block the others. Only the lockfile changes: versions stay
 * inside the ranges package.json already declares.
 */
export const outdatedDeps: Category = {
  name: 'outdated-deps',
  title: 'Update minor/patch dependencies',
  countsAsDeadCode: false,

  async scan(ctx) {
    if (!fs.existsSync(path.join(ctx.root, 'package.json'))) return { items: [], notes: [] };
    const manager = detectManager(ctx.root);
    if (!manager) {
      let hasDeps = false;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8')) as Record<string, object>;
        hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
      } catch {
        /* unreadable package.json: nothing to update */
      }
      if (!hasDeps) return { items: [], notes: [] };
      return {
        items: [],
        notes: ['Dependency updates need a committed `package-lock.json` (npm) or `pnpm-lock.yaml` (pnpm); skipped.'],
      };
    }
    const m = MANAGERS[manager];
    // `outdated` exits 1 when anything is outdated; only the JSON matters.
    const res = await exec(manager, m.outdated, { cwd: ctx.root, timeoutMs: TIMEOUT_MS });
    const { updates, notes } = planUpdates(m.parse(res.stdout), ctx.config.deps.exclude, ctx.config.deps.max);

    const items: CleanupItem[] = updates.map((u) => ({
      id: `dep:${u.name}@${u.to}`,
      description: m.upperBound
        ? `update \`${u.name}\` from ${u.from}, up to ${u.to} as far as its declared range allows (${u.kind})`
        : `update \`${u.name}\` ${u.from} -> ${u.to} (${u.kind})`,
      async apply(c) {
        const r = await exec(manager, m.update(u.name), { cwd: c.root, timeoutMs: TIMEOUT_MS });
        if (r.code !== 0) throw new Error(`${manager} update ${u.name} failed: ${r.stderr.trim() || r.stdout.trim()}`);
      },
    }));
    return { items, notes };
  },

  /** git restored the lockfile; bring node_modules back in line with it. */
  async afterRevert(ctx) {
    const manager = detectManager(ctx.root);
    if (!manager || !fs.existsSync(path.join(ctx.root, 'node_modules'))) return;
    await exec(manager, MANAGERS[manager].reinstall, { cwd: ctx.root, timeoutMs: TIMEOUT_MS });
  },
};

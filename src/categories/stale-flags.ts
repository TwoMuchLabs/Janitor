import fs from 'node:fs/promises';
import path from 'node:path';
import type { Category, CleanupItem, JanitorContext } from '../types.js';
import { isLockfile, readText, trackedFiles } from '../util/files.js';

const REGISTRY_CANDIDATES = [
  'flags.json',
  'feature-flags.json',
  'featureFlags.json',
  'features.json',
  'config/flags.json',
  'config/feature-flags.json',
  'config/features.json',
  'src/flags.json',
  'src/feature-flags.json',
  'src/config/flags.json',
  'src/config/feature-flags.json',
];
const WRAPPER_KEYS = ['flags', 'features', 'featureFlags', 'feature_flags'];

export interface Registry {
  /** Key under which the flag map lives, or null when it is the top-level object. */
  wrapper: string | null;
  flags: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A registry is a JSON object mapping flag names to values, optionally under a `flags`-style key. */
export function parseRegistry(text: string): Registry | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(json)) return null;
  for (const key of WRAPPER_KEYS) {
    if (isPlainObject(json[key])) return { wrapper: key, flags: json[key] };
  }
  return { wrapper: null, flags: json };
}

/** Delete one flag, keeping the file's indentation and trailing newline. */
export function removeFlag(text: string, name: string): string | null {
  const registry = parseRegistry(text);
  if (!registry || !(name in registry.flags)) return null;
  const json = JSON.parse(text) as Record<string, unknown>;
  const target = registry.wrapper ? (json[registry.wrapper] as Record<string, unknown>) : json;
  delete target[name];
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
  return JSON.stringify(json, null, indent) + (text.endsWith('\n') ? '\n' : '');
}

/** The spellings a flag name commonly takes in code: `new-checkout`, `newCheckout`, `NEW_CHECKOUT`, ... */
export function nameVariants(name: string): string[] {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return [name];
  const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
  return [
    ...new Set([
      name,
      words.join('-'),
      words.join('_'),
      words.join('_').toUpperCase(),
      words.join('.'),
      words[0] + words.slice(1).map(cap).join(''),
      words.map(cap).join(''),
    ]),
  ];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function referencePattern(name: string): RegExp {
  return new RegExp(`(?<![\\w-])(?:${nameVariants(name).map(escapeRe).join('|')})(?![\\w-])`);
}

/** Is the flag permanently on (so the code behind it could simply be inlined)? */
export function isFullyOn(value: unknown): boolean {
  if (value === true) return true;
  if (isPlainObject(value)) {
    const off = value.enabled === false || value.on === false;
    const rollout = value.rollout ?? value.percentage ?? value.percent;
    if (off) return false;
    if (typeof rollout === 'number') return rollout >= 100;
    return value.enabled === true || value.on === true;
  }
  return false;
}

async function lastTouchedDaysAgo(ctx: JanitorContext, registry: string, name: string): Promise<number | null> {
  // -S finds the last commit that added or removed the flag's key in the registry.
  const res = await ctx.git.raw(['log', '-1', '--format=%ct', `-S"${name}"`, '--', registry]);
  const ts = Number(res.stdout.trim());
  if (res.code !== 0 || !ts) return null;
  return Math.floor((Date.now() / 1000 - ts) / 86400);
}

/**
 * Feature flags in a JSON registry.
 *
 * - A flag nothing references is removed from the registry (verified like any
 *   other step).
 * - A flag that is fully on and has not been touched for `flags.staleDays` is
 *   reported for a human: inlining the guarded code path changes behaviour-
 *   bearing code, which the janitor does not do unattended.
 */
export const staleFlags: Category = {
  name: 'stale-flags',
  title: 'Remove stale feature flags',
  countsAsDeadCode: true,

  async scan(ctx) {
    const tracked = await trackedFiles(ctx);
    const registryFile = ctx.config.flags.registry ?? REGISTRY_CANDIDATES.find((c) => tracked.includes(c));
    if (!registryFile) return { items: [], notes: [] };

    const registryText = readText(ctx.root, registryFile);
    const registry = registryText ? parseRegistry(registryText) : null;
    if (!registry) {
      return { items: [], notes: [`Flag registry \`${registryFile}\` is missing or is not a JSON object; flags were not checked.`] };
    }

    // Only flag-shaped entries: skips "$schema", "version": 2 and similar metadata.
    const names = Object.keys(registry.flags).filter((n) => {
      const value = registry.flags[n];
      return /^[A-Za-z0-9]/.test(n) && (typeof value === 'boolean' || isPlainObject(value));
    });
    const patterns = new Map(names.map((n) => [n, referencePattern(n)]));
    const references = new Map<string, string[]>(names.map((n) => [n, []]));
    for (const file of tracked) {
      if (file === registryFile || isLockfile(file) || /\.(?:md|map|snap)$/i.test(file)) continue;
      const text = readText(ctx.root, file);
      if (!text) continue;
      for (const [name, pattern] of patterns) if (pattern.test(text)) references.get(name)!.push(file);
    }

    const items: CleanupItem[] = [];
    const notes: string[] = [];
    for (const name of names) {
      const refs = references.get(name)!;
      if (refs.length === 0) {
        items.push({
          id: `stale-flag:${name}`,
          description: `remove flag \`${name}\` from \`${registryFile}\` (no references in the codebase)`,
          async apply(c) {
            const abs = path.join(c.root, registryFile);
            const next = removeFlag(await fs.readFile(abs, 'utf8'), name);
            if (next !== null) await fs.writeFile(abs, next);
          },
        });
        continue;
      }
      if (!isFullyOn(registry.flags[name])) continue;
      const days = await lastTouchedDaysAgo(ctx, registryFile, name);
      if (days !== null && days >= ctx.config.flags.staleDays) {
        const shown = refs.slice(0, 5).map((r) => `\`${r}\``).join(', ');
        const more = refs.length > 5 ? ` and ${refs.length - 5} more` : '';
        notes.push(
          `Flag \`${name}\` has been fully on for ${days} days. Inline it and delete the off-path by hand; it is referenced in ${shown}${more}.`,
        );
      }
    }
    return { items, notes };
  },
};

import fs from 'node:fs';
import path from 'node:path';
import type { JanitorContext } from '../types.js';

const SOURCE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const DTS_RE = /\.d\.[cm]?ts$/;
export const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/** JS/TS implementation files (declaration files are not candidates for cleanup). */
export function isSource(file: string): boolean {
  return SOURCE_RE.test(file) && !DTS_RE.test(file);
}

export function stripSourceExt(file: string): string {
  return file.replace(DTS_RE, '').replace(SOURCE_RE, '');
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'go.sum',
]);

export function isLockfile(file: string): boolean {
  return LOCKFILES.has(path.posix.basename(file));
}

const MAX_TEXT_BYTES = 1024 * 1024;

/** Read a tracked file as text; null when missing, oversized or binary. */
export function readText(root: string, rel: string, maxBytes = MAX_TEXT_BYTES): string | null {
  const abs = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

/** Tracked files that currently exist on disk. */
export async function trackedFiles(ctx: JanitorContext): Promise<string[]> {
  const files = await ctx.git.lsFiles();
  return files.filter((f) => fs.existsSync(path.join(ctx.root, f)));
}

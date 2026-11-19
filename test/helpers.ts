import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type JanitorConfig } from '../src/config.js';
import { Git } from '../src/git.js';
import type { Category, CleanupItem, JanitorContext } from '../src/types.js';

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

export function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** A throwaway git repository with `files` committed on `main`. */
export function makeRepo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-test-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

export function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

export function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

export function config(overrides: Partial<JanitorConfig> = {}): JanitorConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides };
}

export function context(root: string, overrides: Partial<JanitorConfig> = {}): JanitorContext {
  return { root, git: new Git(root), config: config(overrides), log: () => {} };
}

export function deleteItem(file: string): CleanupItem {
  return {
    id: `delete:${file}`,
    description: `delete ${file}`,
    async apply(ctx) {
      fs.rmSync(path.join(ctx.root, file));
    },
  };
}

export function writeItem(file: string, content: string): CleanupItem {
  return {
    id: `write:${file}`,
    description: `write ${file}`,
    async apply(ctx) {
      fs.writeFileSync(path.join(ctx.root, file), content);
    },
  };
}

/** A category that always proposes the same items (filtered to those still applicable). */
export function fakeCategory(name: string, items: CleanupItem[], extra: Partial<Category> = {}): Category {
  return {
    name,
    title: `Fake ${name}`,
    countsAsDeadCode: true,
    async scan() {
      return { items, notes: [] };
    },
    ...extra,
  };
}

import { exec, type ExecResult } from './exec.js';

class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: ExecResult,
  ) {
    super(`git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'GitError';
  }
}

interface FileStat {
  path: string;
  linesAdded: number;
  linesDeleted: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface DiffStats {
  files: FileStat[];
  linesAdded: number;
  linesDeleted: number;
  bytesBefore: number;
  bytesAfter: number;
}

const EMPTY_STATS: DiffStats = { files: [], linesAdded: 0, linesDeleted: 0, bytesBefore: 0, bytesAfter: 0 };

const ZERO_SHA = /^0+$/;

/** Thin, promise-based wrapper over the git CLI for one working tree. */
export class Git {
  private identityArgs: string[] | undefined;

  constructor(readonly cwd: string) {}

  raw(args: string[], input?: string): Promise<ExecResult> {
    return exec('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: this.cwd,
      input,
      env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
  }

  async run(args: string[], input?: string): Promise<string> {
    const res = await this.raw(args, input);
    if (res.code !== 0) throw new GitError(args, res);
    return res.stdout.replace(/\n$/, '');
  }

  async isRepo(): Promise<boolean> {
    const res = await this.raw(['rev-parse', '--is-inside-work-tree']);
    return res.code === 0 && res.stdout.trim() === 'true';
  }

  head(): Promise<string> {
    return this.run(['rev-parse', 'HEAD']);
  }

  /** Branch name, or the commit sha when HEAD is detached. */
  async currentRef(): Promise<string> {
    const res = await this.raw(['symbolic-ref', '-q', '--short', 'HEAD']);
    return res.code === 0 ? res.stdout.trim() : this.head();
  }

  async gitDir(): Promise<string> {
    return this.run(['rev-parse', '--absolute-git-dir']);
  }

  /** True when there are staged, unstaged or untracked (non-ignored) changes. */
  async hasChanges(): Promise<boolean> {
    return (await this.run(['status', '--porcelain'])).length > 0;
  }

  async branchExists(name: string): Promise<boolean> {
    return (await this.raw(['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code === 0;
  }

  async createBranch(name: string): Promise<void> {
    await this.run(['checkout', '-q', '-b', name]);
  }

  async checkout(ref: string): Promise<void> {
    await this.run(['checkout', '-q', ref]);
  }

  async deleteBranch(name: string): Promise<void> {
    await this.run(['branch', '-q', '-D', name]);
  }

  /** Tracked files, repo-relative with forward slashes. */
  async lsFiles(): Promise<string[]> {
    const out = await this.run(['ls-files', '-z']);
    return out.split('\0').filter(Boolean);
  }

  /**
   * Put the working tree back exactly at `sha`: tracked files restored,
   * files created by a failed step removed. Ignored files are left alone.
   */
  async restore(sha: string): Promise<void> {
    await this.run(['reset', '-q', '--hard', sha]);
    await this.run(['clean', '-q', '-fd']);
  }

  /** Stage every change in the working tree. Returns false when there is nothing to stage. */
  async stageAll(): Promise<boolean> {
    await this.run(['add', '-A']);
    return (await this.raw(['diff', '--cached', '--quiet'])).code !== 0;
  }

  /** Commit exactly what is staged (not later working-tree changes) and return the new sha. */
  async commitStaged(message: string): Promise<string> {
    // --no-verify: the janitor has already run the project's verification suite.
    await this.run([...(await this.identity()), 'commit', '-q', '--no-verify', '-F', '-'], message);
    return this.head();
  }

  /** Fall back to a bot identity when the environment (e.g. a CI runner) has none. */
  private async identity(): Promise<string[]> {
    if (this.identityArgs) return this.identityArgs;
    const name = (await this.raw(['config', 'user.name'])).stdout.trim();
    const email = (await this.raw(['config', 'user.email'])).stdout.trim();
    this.identityArgs = [];
    if (!name) this.identityArgs.push('-c', 'user.name=janitor[bot]');
    if (!email) this.identityArgs.push('-c', 'user.email=janitor@users.noreply.github.com');
    return this.identityArgs;
  }

  /** Per-file line and byte deltas between two commits. */
  async diffStats(from: string, to: string): Promise<DiffStats> {
    const numstat = await this.run(['diff', '--numstat', '--no-renames', from, to]);
    const raw = await this.run(['diff', '--raw', '--no-abbrev', '--no-renames', from, to]);
    if (!raw) return { ...EMPTY_STATS, files: [] };

    const lines = new Map<string, { added: number; deleted: number }>();
    for (const line of numstat.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
      if (m) lines.set(m[3]!, { added: Number(m[1]) || 0, deleted: Number(m[2]) || 0 });
    }

    const blobs: { path: string; before: string; after: string }[] = [];
    for (const line of raw.split('\n')) {
      const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) \w+\t(.*)$/.exec(line);
      if (m) blobs.push({ before: m[1]!, after: m[2]!, path: m[3]! });
    }

    const shas = [...new Set(blobs.flatMap((b) => [b.before, b.after]).filter((s) => !ZERO_SHA.test(s)))];
    const sizes = new Map<string, number>();
    if (shas.length) {
      const out = await this.run(['cat-file', '--batch-check'], shas.join('\n') + '\n');
      for (const line of out.split('\n')) {
        const [sha, type, size] = line.split(' ');
        if (sha && type === 'blob') sizes.set(sha, Number(size));
      }
    }

    const stats: DiffStats = { files: [], linesAdded: 0, linesDeleted: 0, bytesBefore: 0, bytesAfter: 0 };
    for (const b of blobs) {
      const l = lines.get(b.path) ?? { added: 0, deleted: 0 };
      const file: FileStat = {
        path: b.path,
        linesAdded: l.added,
        linesDeleted: l.deleted,
        bytesBefore: sizes.get(b.before) ?? 0,
        bytesAfter: sizes.get(b.after) ?? 0,
      };
      stats.files.push(file);
      stats.linesAdded += file.linesAdded;
      stats.linesDeleted += file.linesDeleted;
      stats.bytesBefore += file.bytesBefore;
      stats.bytesAfter += file.bytesAfter;
    }
    return stats;
  }
}

import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the whole process group after this many milliseconds. */
  timeoutMs?: number;
  /** Written to stdin, which is then closed. */
  input?: string;
  /** Run `cmd` through the platform shell (used for user-supplied verify commands). */
  shell?: boolean;
  /** Keep only the last N bytes of each stream. Unlimited when omitted. */
  tailBytes?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function append(buf: string, chunk: string, tailBytes?: number): string {
  const next = buf + chunk;
  if (tailBytes !== undefined && next.length > tailBytes) return next.slice(next.length - tailBytes);
  return next;
}

/**
 * Run a command and always resolve (never reject): callers decide what a
 * non-zero exit means. A spawn failure is reported as exit code 127.
 */
export function exec(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const posix = process.platform !== 'win32';
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell ?? false,
      // Own process group, so a timeout can take down grandchildren (test runners fork).
      detached: posix,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };

    const killTree = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree();
        }, opts.timeoutMs)
      : undefined;

    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = append(stdout, d, opts.tailBytes)));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = append(stderr, d, opts.tailBytes)));
    child.stdin.on('error', () => {
      /* child exited before reading stdin */
    });
    child.stdin.end(opts.input ?? '');

    child.on('error', (err) => {
      stderr = append(stderr, String(err), opts.tailBytes);
      finish(127);
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 137 : 1)));
  });
}

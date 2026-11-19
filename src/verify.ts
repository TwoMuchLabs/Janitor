import fs from 'node:fs';
import path from 'node:path';
import { exec } from './exec.js';

export interface CommandResult {
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** Last part of combined stdout/stderr, for the PR description. */
  outputTail: string;
}

interface VerifyResult {
  ok: boolean;
  results: CommandResult[];
  failed?: CommandResult;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

function detectPackageManager(root: string): PackageManager {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'types', 'tsc'];

/**
 * Work out the project's existing verification suite, cheapest first so a
 * broken step fails fast: typecheck, then build, then tests.
 */
export function detectVerifyCommands(root: string): string[] {
  const commands: string[] = [];
  const pkgPath = path.join(root, 'package.json');

  if (fs.existsSync(pkgPath)) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      /* unreadable package.json: fall through with no scripts */
    }
    const pm = detectPackageManager(root);

    const typecheck = TYPECHECK_SCRIPTS.find((s) => typeof scripts[s] === 'string');
    if (typecheck) {
      commands.push(`${pm} run ${typecheck}`);
    } else if (
      fs.existsSync(path.join(root, 'tsconfig.json')) &&
      fs.existsSync(path.join(root, 'node_modules', 'typescript'))
    ) {
      commands.push('npx --no-install tsc --noEmit');
    }
    if (typeof scripts.build === 'string') commands.push(`${pm} run build`);
    if (typeof scripts.test === 'string' && !/no test specified/i.test(scripts.test)) commands.push(`${pm} test`);
    return commands;
  }

  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return ['cargo check --all-targets', 'cargo test'];
  if (fs.existsSync(path.join(root, 'go.mod'))) return ['go build ./...', 'go vet ./...', 'go test ./...'];
  return commands;
}

const TAIL_BYTES = 64 * 1024;
const REPORT_TAIL_LINES = 40;

function tail(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-REPORT_TAIL_LINES).join('\n');
}

/** Run every command in order; stop at the first failure. */
export async function runVerify(commands: string[], root: string, timeoutMs: number): Promise<VerifyResult> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    const res = await exec(command, [], {
      cwd: root,
      shell: true,
      timeoutMs,
      tailBytes: TAIL_BYTES,
      env: { CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const result: CommandResult = {
      command,
      exitCode: res.code,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      outputTail: tail([res.stdout, res.stderr].filter(Boolean).join('\n')),
    };
    results.push(result);
    if (res.code !== 0 || res.timedOut) return { ok: false, results, failed: result };
  }
  return { ok: true, results };
}

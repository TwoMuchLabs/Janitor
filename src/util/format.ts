import fs from 'node:fs';
import path from 'node:path';
import { exec } from '../exec.js';

interface Formatter {
  name: string;
  bin: string;
  check: (file: string) => string[];
  write: (file: string) => string[];
}

const TIMEOUT_MS = 60 * 1000;

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
];

function hasPrettierConfig(root: string): boolean {
  if (PRETTIER_CONFIGS.some((f) => fs.existsSync(path.join(root, f)))) return true;
  try {
    // Many projects run prettier on its defaults: a direct dependency is as clear a signal as a config file.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    return 'prettier' in pkg || Boolean(pkg.devDependencies?.prettier ?? pkg.dependencies?.prettier);
  } catch {
    return false;
  }
}

/** The formatter this project has installed and configured, if any. */
function detectFormatter(root: string): Formatter | null {
  const local = (name: string) => path.join(root, 'node_modules', '.bin', name);
  if (fs.existsSync(local('prettier')) && hasPrettierConfig(root)) {
    return { name: 'prettier', bin: local('prettier'), check: (f) => ['--check', f], write: (f) => ['--write', '--log-level', 'silent', f] };
  }
  if (fs.existsSync(local('biome')) && ['biome.json', 'biome.jsonc'].some((f) => fs.existsSync(path.join(root, f)))) {
    return { name: 'biome', bin: local('biome'), check: (f) => ['format', f], write: (f) => ['format', '--write', f] };
  }
  return null;
}

const formatters = new Map<string, Formatter | null>();
/** Files known to satisfy the formatter, so each is only checked once per run. */
const clean = new Map<string, boolean>();

/**
 * Run `edit` on a file and, if the file satisfied the project's formatter
 * beforehand, re-format it afterwards.
 *
 * Removing `export` shortens a line, which can change how the formatter wants
 * the next lines wrapped. A project that checks formatting in CI would then
 * reject an otherwise correct change. Files that were not formatted to begin
 * with are left exactly as edited: reformatting them would bury the change.
 */
export async function editKeepingFormat(root: string, file: string, edit: () => Promise<void>): Promise<void> {
  if (!formatters.has(root)) formatters.set(root, detectFormatter(root));
  const formatter = formatters.get(root);
  if (!formatter) return edit();

  const key = `${root}\0${file}`;
  let wasClean = clean.get(key);
  if (wasClean === undefined) {
    wasClean = (await exec(formatter.bin, formatter.check(file), { cwd: root, timeoutMs: TIMEOUT_MS })).code === 0;
    clean.set(key, wasClean);
  }
  await edit();
  if (!wasClean) return;
  const written = await exec(formatter.bin, formatter.write(file), { cwd: root, timeoutMs: TIMEOUT_MS });
  // If the formatter fails (syntax it cannot parse, a crash), keep the edit and stop vouching for the file.
  if (written.code !== 0) clean.set(key, false);
}

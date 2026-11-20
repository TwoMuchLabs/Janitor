import type { JanitorConfig } from './config.js';
import type { DiffStats, Git } from './git.js';
import type { CommandResult } from './verify.js';

export type Logger = (message: string) => void;

export interface JanitorContext {
  /** Absolute, real path of the repository root. */
  root: string;
  git: Git;
  config: JanitorConfig;
  log: Logger;
}

/** One independently revertible change, e.g. "delete src/old.ts". */
export interface CleanupItem {
  id: string;
  description: string;
  /** Files this item deletes outright, for categories that only propose their changes. */
  paths?: string[];
  /**
   * Mutate the working tree. Must re-read whatever it edits: by the time it
   * runs, earlier items may already have changed the same files.
   */
  apply(ctx: JanitorContext): Promise<void>;
}

export interface ScanResult {
  items: CleanupItem[];
  /** Findings the janitor will not act on itself; surfaced in the PR for a human. */
  notes: string[];
}

export interface Category {
  /** Stable machine name, used in config and on the CLI. */
  name: string;
  /** Human title, used in commits and the PR. */
  title: string;
  /** Whether this category's deletions count as "dead code" in the totals. */
  countsAsDeadCode: boolean;
  /** Read-only: must not modify the working tree. */
  scan(ctx: JanitorContext): Promise<ScanResult>;
  /** Restore state git does not track (e.g. node_modules) after a revert. */
  afterRevert?(ctx: JanitorContext): Promise<void>;
}

type StepStatus = 'kept' | 'proposed' | 'reverted' | 'noop' | 'skipped' | 'planned';

export interface StepFailure {
  command: string;
  exitCode: number;
  timedOut: boolean;
  outputTail: string;
}

export interface StepRecord {
  category: string;
  title: string;
  countsAsDeadCode: boolean;
  status: StepStatus;
  items: { id: string; description: string; paths?: string[] }[];
  /** Set on planned steps of a category whose changes are proposed rather than applied. */
  proposeOnly?: boolean;
  /** Commit sha, for kept steps. */
  sha?: string;
  stats?: DiffStats;
  failure?: StepFailure;
  /** Why a step was skipped. */
  reason?: string;
}

export interface RunReport {
  date: string;
  branch: string;
  /** Where the user was before the run (branch name, or sha if detached). */
  originalRef: string;
  baseSha: string;
  headSha: string;
  dryRun: boolean;
  changed: boolean;
  verifyCommands: string[];
  baseline: CommandResult[];
  verifyRuns: number;
  steps: StepRecord[];
  notes: { category: string; note: string }[];
}

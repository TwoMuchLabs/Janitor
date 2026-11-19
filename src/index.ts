/** Programmatic API: bring your own categories or embed the safe-apply loop. */
export { runJanitor, JanitorError, todayUtc, type RunOptions, type JanitorErrorCode } from './engine.js';
export { CATEGORIES, selectCategories } from './categories/index.js';
export { loadConfig, resolveConfig, DEFAULT_CONFIG, type JanitorConfig } from './config.js';
export { detectVerifyCommands, runVerify } from './verify.js';
export { renderPrBody, renderPlan, computeTotals, prTitle } from './report.js';
export type { Category, CleanupItem, JanitorContext, RunReport, ScanResult, StepRecord } from './types.js';

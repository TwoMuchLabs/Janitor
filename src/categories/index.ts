import type { Category } from '../types.js';
import { deadFiles } from './dead-files.js';
import { outdatedDeps } from './outdated-deps.js';
import { staleFlags } from './stale-flags.js';
import { unusedExports } from './unused-exports.js';

/**
 * Registry of cleanup categories, in the order they should run: deleting dead
 * files first means later scans see a smaller, more accurate import graph.
 */
export const CATEGORIES: Category[] = [deadFiles, unusedExports, staleFlags, outdatedDeps];

export function selectCategories(names: string[]): Category[] {
  return names.map((name) => {
    const cat = CATEGORIES.find((c) => c.name === name);
    if (!cat) throw new Error(`unknown category "${name}" (known: ${CATEGORIES.map((c) => c.name).join(', ')})`);
    return cat;
  });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { reachableFrom } from '../analysis/module-graph.js';
import { analyzeProject, isMentioned } from '../analysis/project.js';
import type { Category, CleanupItem } from '../types.js';

/**
 * Source files nothing can reach: not imported (directly or transitively) from
 * any entry point, not under a dynamically-loaded directory, and not referred
 * to by name from any non-code file.
 */
export const deadFiles: Category = {
  name: 'dead-files',
  title: 'Remove dead files',
  countsAsDeadCode: true,

  async scan(ctx) {
    const project = await analyzeProject(ctx);
    const notes: string[] = [];

    if (project.entryPoints.roots === 0) {
      notes.push(
        'No entry points were found (no `main`/`exports`/`bin` in package.json and no `src/index.*`), so reachability cannot be trusted and no files were removed. Add `entry` globs to `.janitor.json`.',
      );
      return { items: [], notes };
    }

    // Unreachable files we will not touch are still alive for the purposes of
    // the graph: whatever they import has to stay too.
    const heldBack = project.sources.filter(
      (file) =>
        !project.reachable.has(file) &&
        (project.isIgnored(file) ||
          project.graph.dynamicPrefixes.some((prefix) => file.startsWith(prefix)) ||
          isMentioned(file, project.mentions)),
    );
    const live = reachableFrom(project.graph, [...project.entryPoints.entries, ...heldBack]);
    const dead = project.sources.filter((file) => !live.has(file));
    const deadSet = new Set(dead);

    const importers = new Map<string, string[]>();
    for (const file of dead) {
      for (const target of project.graph.modules.get(file)?.edges.keys() ?? []) {
        if (!deadSet.has(target)) continue;
        if (!importers.has(target)) importers.set(target, []);
        importers.get(target)!.push(file);
      }
    }

    /**
     * A dead file can only go together with every (dead) file that imports it,
     * so each item deletes that whole closure. Items therefore stay valid on
     * their own however the engine bisects the group.
     */
    const closure = (file: string): string[] => {
      const seen = new Set([file]);
      const queue = [file];
      while (queue.length) {
        for (const importer of importers.get(queue.pop()!) ?? []) {
          if (!seen.has(importer)) {
            seen.add(importer);
            queue.push(importer);
          }
        }
      }
      return [...seen];
    };

    const items: CleanupItem[] = dead
      .map((file) => ({ file, files: closure(file) }))
      // Files nothing imports first, so dependants are usually gone before their dependencies.
      .sort((x, y) => x.files.length - y.files.length || x.file.localeCompare(y.file))
      .map(({ file, files }) => {
        const others = files.slice(1).sort();
        const withImporters = others.length
          ? `, together with the dead file(s) importing it: ${others.map((f) => `\`${f}\``).join(', ')}`
          : '';
        return {
          id: `dead-file:${file}`,
          description: `delete \`${file}\` (unreachable from any entry point${withImporters})`,
          async apply(c) {
            for (const f of files) await fs.rm(path.join(c.root, f), { force: true });
          },
        };
      });

    if (heldBack.length > 0) {
      notes.push(
        `${heldBack.length} unreachable file(s) were kept because they are ignored, sit under a dynamically imported directory, or are mentioned by name in a non-code file.`,
      );
    }
    return { items, notes };
  },
};

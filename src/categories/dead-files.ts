import fs from 'node:fs/promises';
import path from 'node:path';
import { reachableFrom } from '../analysis/module-graph.js';
import { analyzeProject, isMentioned, isVariantOfSibling } from '../analysis/project.js';
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
    if (project.separatePackages.length > 0) {
      const shown = project.separatePackages.slice(0, 5).map((d) => `\`${d}/\``).join(', ');
      notes.push(
        `${project.separatePackages.length} nested package(s) were left untouched because this project's checks do not cover them: ${shown}. Run janitor inside each one (the Action's \`working-directory\` input) to clean them.`,
      );
    }

    if (project.entryPoints.roots === 0) {
      notes.push(
        'No entry points were found (no `main`/`exports`/`bin` in package.json and no `src/index.*`), so reachability cannot be trusted and no files were removed. Add `entry` globs to `.janitor.json`.',
      );
      return { items: [], notes };
    }

    // Unreachable files we will not touch are still alive for the purposes of
    // the graph: whatever they import has to stay too.
    const sourceSet = new Set(project.sources);
    const heldBack: string[] = [];
    const scripts: string[] = [];
    for (const file of project.sources) {
      if (project.reachable.has(file)) continue;
      if (
        project.isIgnored(file) ||
        project.graph.dynamicPrefixes.some((prefix) => file.startsWith(prefix)) ||
        isMentioned(file, project.mentions) ||
        isVariantOfSibling(file, sourceSet)
      ) {
        heldBack.push(file);
      } else if (!project.graph.modules.get(file)?.exportsAnything) {
        // Nothing imports it and it exports nothing: that is the shape of a
        // program someone runs by hand (`node tools/report.mjs`), not of a
        // forgotten module. No test would notice it going missing.
        scripts.push(file);
      }
    }
    const live = reachableFrom(project.graph, [
      ...project.entryPoints.entries,
      ...project.graph.components.flatMap((c) => [...c.edges.keys()]),
      ...heldBack,
      ...scripts,
    ]);
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
          paths: files,
          description: `delete \`${file}\` (unreachable from any entry point${withImporters})`,
          async apply(c) {
            for (const f of files) await fs.rm(path.join(c.root, f), { force: true });
          },
        };
      });

    if (scripts.length > 0) {
      const shown = scripts.slice(0, 5).map((f) => `\`${f}\``).join(', ');
      const more = scripts.length > 5 ? ` and ${scripts.length - 5} more` : '';
      notes.push(
        `${scripts.length} file(s) that nothing imports were kept because they export nothing, so they look like scripts run by hand: ${shown}${more}. Delete them yourself if they are obsolete, or list them under \`entry\` to silence this note.`,
      );
    }
    if (heldBack.length > 0) {
      const shown = heldBack.slice(0, 8).map((f) => `\`${f}\``).join(', ');
      const more = heldBack.length > 8 ? ` and ${heldBack.length - 8} more` : '';
      notes.push(
        `${heldBack.length} unreachable file(s) were kept because they are ignored, sit under a dynamically imported directory, are a platform variant of a sibling file (\`x-browser.ts\` beside \`x.ts\`), or are mentioned by name in a non-code file or the docs: ${shown}${more}.`,
      );
    }
    return { items, notes };
  },
};

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
type Project = Awaited<ReturnType<typeof analyzeProject>>;

function separatePackagesNote(separatePackages: string[]): string {
  const shown = separatePackages.slice(0, 5).map((d) => `\`${d}/\``).join(', ');
  return `${separatePackages.length} nested package(s) were left untouched because this project's checks do not cover them: ${shown}. Run janitor inside each one (the Action's \`working-directory\` input) to clean them.`;
}

interface KeptUnreachable {
  /** Ignored, under a dynamically imported directory, mentioned somewhere, or a platform variant of a sibling. */
  heldBack: string[];
  /** Export nothing, so they look like programs run by hand. */
  scripts: string[];
}

/**
 * Unreachable files we will not touch. They are still alive for the purposes
 * of the graph: whatever they import has to stay too.
 */
function keptUnreachable(project: Project): KeptUnreachable {
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
  return { heldBack, scripts };
}

/** For each dead file, the dead files that import it. */
function deadImporters(dead: string[], graph: Project['graph']): Map<string, string[]> {
  const deadSet = new Set(dead);
  const importers = new Map<string, string[]>();
  for (const file of dead) {
    for (const target of graph.modules.get(file)?.edges.keys() ?? []) {
      if (!deadSet.has(target)) continue;
      if (!importers.has(target)) importers.set(target, []);
      importers.get(target)!.push(file);
    }
  }
  return importers;
}

/**
 * A dead file can only go together with every (dead) file that imports it,
 * so each item deletes that whole closure. Items therefore stay valid on
 * their own however the engine bisects the group.
 */
function withImporters(file: string, importers: Map<string, string[]>): string[] {
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
}

function deletionItem(file: string, files: string[]): CleanupItem {
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
}

function scriptsNote(scripts: string[]): string {
  const shown = scripts.slice(0, 5).map((f) => `\`${f}\``).join(', ');
  const more = scripts.length > 5 ? ` and ${scripts.length - 5} more` : '';
  return `${scripts.length} file(s) that nothing imports were kept because they export nothing, so they look like scripts run by hand: ${shown}${more}. Delete them yourself if they are obsolete, or list them under \`entry\` to silence this note.`;
}

function heldBackNote(heldBack: string[]): string {
  const shown = heldBack.slice(0, 8).map((f) => `\`${f}\``).join(', ');
  const more = heldBack.length > 8 ? ` and ${heldBack.length - 8} more` : '';
  return `${heldBack.length} unreachable file(s) were kept because they are ignored, sit under a dynamically imported directory, are a platform variant of a sibling file (\`x-browser.ts\` beside \`x.ts\`), or are mentioned by name in a non-code file or the docs: ${shown}${more}.`;
}

export const deadFiles: Category = {
  name: 'dead-files',
  title: 'Remove dead files',
  countsAsDeadCode: true,

  async scan(ctx) {
    const project = await analyzeProject(ctx);
    const notes: string[] = [];
    if (project.separatePackages.length > 0) notes.push(separatePackagesNote(project.separatePackages));
    if (project.entryPoints.roots === 0) {
      notes.push(
        'No entry points were found (no `main`/`exports`/`bin` in package.json and no `src/index.*`), so reachability cannot be trusted and no files were removed. Add `entry` globs to `.janitor.json`.',
      );
      return { items: [], notes };
    }

    const { heldBack, scripts } = keptUnreachable(project);
    const live = reachableFrom(project.graph, [
      ...project.entryPoints.entries,
      ...project.graph.components.flatMap((c) => [...c.edges.keys()]),
      ...heldBack,
      ...scripts,
    ]);
    const dead = project.sources.filter((file) => !live.has(file));
    const importers = deadImporters(dead, project.graph);
    const items = dead
      .map((file) => ({ file, files: withImporters(file, importers) }))
      // Files nothing imports first, so dependants are usually gone before their dependencies.
      .sort((x, y) => x.files.length - y.files.length || x.file.localeCompare(y.file))
      .map(({ file, files }) => deletionItem(file, files));

    if (scripts.length > 0) notes.push(scriptsNote(scripts));
    if (heldBack.length > 0) notes.push(heldBackNote(heldBack));
    return { items, notes };
  },
};

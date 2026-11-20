import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { collectIdentifiers, tidyImports } from '../analysis/imports.js';
import { ALL, declaredExports } from '../analysis/module-graph.js';
import { analyzeProject } from '../analysis/project.js';
import type { Category, CleanupItem } from '../types.js';
import { editKeepingFormat } from '../util/format.js';

function isPure(expr: ts.Expression): boolean {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return true;
  if (ts.isStringLiteralLike(expr) || ts.isNumericLiteral(expr) || ts.isBigIntLiteral(expr)) return true;
  if (ts.isRegularExpressionLiteral(expr)) return true;
  switch (expr.kind) {
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return isPure(expr.expression);
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) return isPure(expr.operand);
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.every((e) => !ts.isSpreadElement(e) && isPure(e));
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.every(
      (p) =>
        ts.isMethodDeclaration(p) ||
        (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && isPure(p.initializer)),
    );
  }
  return false;
}

/** Can the whole statement go without changing runtime behaviour (given the name is unreferenced)? */
function isDeletable(stmt: ts.Statement): boolean {
  if (ts.isFunctionDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) return true;
  if (ts.isEnumDeclaration(stmt)) return true;
  if (ts.isClassDeclaration(stmt)) {
    if (ts.getDecorators(stmt)?.length) return false;
    if (stmt.heritageClauses?.some((h) => h.types.some((t) => !ts.isIdentifier(t.expression) && !ts.isPropertyAccessExpression(t.expression)))) {
      return false;
    }
    return stmt.members.every((m) => {
      if (ts.isClassStaticBlockDeclaration(m)) return false;
      if (ts.canHaveDecorators(m) && ts.getDecorators(m)?.length) return false;
      const isStatic = ts.canHaveModifiers(m) && ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
      return !(isStatic && ts.isPropertyDeclaration(m) && m.initializer && !isPure(m.initializer));
    });
  }
  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations;
    return decls.length === 1 && (!decls[0]!.initializer || isPure(decls[0]!.initializer));
  }
  return false;
}

function countIdentifier(sf: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === name) count++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return count;
}

type RemovalKind = 'deleted' | 'unexported';

/**
 * Remove the named export `name` from `text`.
 *
 * - If nothing else in the file refers to it and its declaration has no side
 *   effects, the whole declaration (with its JSDoc) is deleted.
 * - Otherwise only the `export` keyword is removed, so the file keeps working.
 *
 * Returns null when the export is not there (already cleaned up) or is in a
 * shape that is not handled.
 */
export function removeExport(text: string, fileName: string, name: string): { text: string; kind: RemovalKind } | null {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const matches = sf.statements.filter((s) => declaredExports(s).some((e) => e.name === name));
  if (matches.length === 0) return null;
  if (sf.statements.some((s) => ts.isModuleDeclaration(s) && ts.isIdentifier(s.name) && s.name.text === name)) return null;
  // `export const a = 1, b = 2;` cannot be partially un-exported.
  if (matches.some((s) => ts.isVariableStatement(s) && s.declarationList.declarations.length !== 1)) return null;

  const referencedElsewhere = countIdentifier(sf, name) > matches.length;
  const deletable = !referencedElsewhere && matches.every(isDeletable);

  const edits: { start: number; end: number }[] = [];
  for (const stmt of matches) {
    if (deletable) {
      let start = stmt.getStart(sf, true);
      let lineStart = start;
      while (lineStart > 0 && (text[lineStart - 1] === ' ' || text[lineStart - 1] === '\t')) lineStart--;
      if (lineStart === 0 || text[lineStart - 1] === '\n') start = lineStart;
      let end = stmt.end;
      while (text[end] === ' ' || text[end] === '\t') end++;
      if (text[end] === '\r') end++;
      if (text[end] === '\n') end++;
      // Do not leave a double blank line where the declaration used to be.
      if (start > 0 && text[start - 1] === '\n' && (start < 2 || text[start - 2] === '\n') && text[end] === '\n') end++;
      // ...or a trailing blank line when it was the last thing in the file.
      if (end === text.length) while (start > 1 && text[start - 1] === '\n' && text[start - 2] === '\n') start--;
      // ...or a leading one when it was the first.
      if (start === 0) while (text[end] === '\n' || text[end] === '\r') end++;
      edits.push({ start, end });
    } else {
      const mod = ts.getModifiers(stmt as ts.HasModifiers)!.find((m) => m.kind === ts.SyntaxKind.ExportKeyword)!;
      let end = mod.end;
      while (text[end] === ' ' || text[end] === '\t') end++;
      edits.push({ start: mod.getStart(sf), end });
    }
  }

  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + out.slice(e.end);
  if (deletable) {
    // Whatever the deleted code was the last user of should not be left imported.
    const mentioned = new Set<string>();
    for (const stmt of matches) collectIdentifiers(stmt, mentioned);
    out = tidyImports(out, fileName, mentioned);
  }
  return { text: out, kind: deletable ? 'deleted' : 'unexported' };
}

/**
 * Named exports that no other module imports. Entry-point files are skipped
 * (their exports are public API), as is anything whose name appears in a file
 * the import graph cannot parse (`.vue`, `.svelte`, HTML, ...).
 */
export const unusedExports: Category = {
  name: 'unused-exports',
  title: 'Remove unused exports',
  countsAsDeadCode: true,

  async scan(ctx) {
    const project = await analyzeProject(ctx);
    if (project.entryPoints.roots === 0) {
      // Without knowing the entry points, every export might be public API.
      return {
        items: [],
        notes: ['No entry points were found, so exports could not be told apart from public API and none were removed. Add `entry` globs to `.janitor.json`.'],
      };
    }
    const used = new Map<string, Set<string>>();
    for (const mod of [...project.graph.modules.values(), ...project.graph.components]) {
      for (const [target, names] of mod.edges) {
        let set = used.get(target);
        if (!set) used.set(target, (set = new Set()));
        for (const n of names) set.add(n);
      }
    }

    const items: CleanupItem[] = [];
    for (const mod of project.graph.modules.values()) {
      const file = mod.file;
      // Unreachable files belong to the dead-files category; entry files are public API.
      if (!project.reachable.has(file) || project.entryPoints.entries.has(file) || project.isIgnored(file)) continue;
      const importedNames = used.get(file) ?? new Set<string>();
      if (importedNames.has(ALL)) continue;

      const seen = new Set<string>();
      for (const exp of mod.exports) {
        if (seen.has(exp.name) || importedNames.has(exp.name) || project.mentions.identifiers.has(exp.name)) continue;
        // With automatic imports, a name another file mentions may be used there without importing it.
        if (project.entryPoints.autoImports && (project.mentions.sourceFileCounts.get(exp.name) ?? 0) > 1) continue;
        // `interface X` merged with `namespace X` must stay exported together.
        if (mod.namespaces.has(exp.name)) continue;
        seen.add(exp.name);
        items.push({
          id: `unused-export:${file}#${exp.name}`,
          description: `remove unused export \`${exp.name}\` (${exp.kind}) from \`${file}\``,
          async apply(c) {
            const abs = path.join(c.root, file);
            const result = removeExport(await fs.readFile(abs, 'utf8'), abs, exp.name);
            if (result) await editKeepingFormat(c.root, file, () => fs.writeFile(abs, result.text));
          },
        });
      }
    }
    return { items, notes: [] };
  },
};

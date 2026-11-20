import ts from 'typescript';

export function collectIdentifiers(node: ts.Node, into: Set<string>): void {
  if (ts.isIdentifier(node)) into.add(node.text);
  ts.forEachChild(node, (child) => collectIdentifiers(child, into));
}

/**
 * Drop import bindings that just-deleted code was the last user of.
 *
 * Only names in `candidates` (identifiers that appeared in the deleted code)
 * are considered, so imports that were already unused are left as they were.
 * An import that loses every binding is removed when it is type-only, and
 * otherwise reduced to `import 'module'` so the module is still loaded for
 * any side effects it has.
 */
export function tidyImports(text: string, fileName: string, candidates: Set<string>): string {
  if (candidates.size === 0) return text;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const used = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n)) used.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const unused = (name: ts.Identifier) => candidates.has(name.text) && !used.has(name.text);

  const edits: { start: number; end: number; text: string }[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const clause = stmt.importClause;
    const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : undefined;
    const namespace = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings : undefined;

    const keepDefault = clause.name !== undefined && !unused(clause.name);
    const keepNamespace = namespace !== undefined && !unused(namespace.name);
    const keptElements = named ? named.elements.filter((el) => !unused(el.name)) : [];
    const removedSomething =
      (clause.name !== undefined && !keepDefault) ||
      (namespace !== undefined && !keepNamespace) ||
      (named !== undefined && keptElements.length < named.elements.length);
    if (!removedSomething) continue;

    if (!keepDefault && !keepNamespace && keptElements.length === 0) {
      const typeOnly =
        clause.isTypeOnly || (!clause.name && !namespace && named !== undefined && named.elements.every((el) => el.isTypeOnly));
      if (typeOnly) {
        let end = stmt.end;
        while (text[end] === ' ' || text[end] === '\t') end++;
        if (text[end] === '\r') end++;
        if (text[end] === '\n') end++;
        edits.push({ start: stmt.getStart(sf), end, text: '' });
      } else {
        const semicolon = text[stmt.end - 1] === ';' ? ';' : '';
        edits.push({ start: stmt.getStart(sf), end: stmt.end, text: `import ${stmt.moduleSpecifier.getText(sf)}${semicolon}` });
      }
      continue;
    }

    const parts: string[] = [];
    if (keepDefault) parts.push(clause.name!.text);
    if (keepNamespace) parts.push(namespace!.getText(sf));
    if (keptElements.length > 0) {
      const original = named!.getText(sf);
      const names = keptElements.map((el) => el.getText(sf));
      if (original.includes('\n')) {
        const indent = /\n([ \t]*)\S/.exec(original)?.[1] ?? '  ';
        const trailingComma = /,\s*}$/.test(original) ? ',' : '';
        parts.push(`{\n${names.map((n) => indent + n).join(',\n')}${trailingComma}\n}`);
      } else {
        const pad = /^{\s/.test(original) ? ' ' : '';
        parts.push(`{${pad}${names.join(', ')}${pad}}`);
      }
    }
    edits.push({ start: clause.getStart(sf), end: clause.end, text: `${clause.isTypeOnly ? 'type ' : ''}${parts.join(', ')}` });
  }

  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

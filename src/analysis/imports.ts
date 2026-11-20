import ts from 'typescript';

export function collectIdentifiers(node: ts.Node, into: Set<string>): void {
  if (ts.isIdentifier(node)) into.add(node.text);
  ts.forEachChild(node, (child) => collectIdentifiers(child, into));
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Every identifier the file uses outside its import statements. */
function identifiersOutsideImports(sf: ts.SourceFile): Set<string> {
  const used = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n)) used.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return used;
}

/** Past the blanks and the one line break that follow a statement. */
function endOfLine(text: string, end: number): number {
  while (text[end] === ' ' || text[end] === '\t') end++;
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;
  return end;
}

/** `{ a, b }` with only `names` left, laid out the way the original was. */
function namedBindings(original: string, names: string[]): string {
  if (original.includes('\n')) {
    const indent = /\n([ \t]*)\S/.exec(original)?.[1] ?? '  ';
    const trailingComma = /,\s*}$/.test(original) ? ',' : '';
    return `{\n${names.map((n) => indent + n).join(',\n')}${trailingComma}\n}`;
  }
  const pad = /^{\s/.test(original) ? ' ' : '';
  return `{${pad}${names.join(', ')}${pad}}`;
}

/** An import that lost every binding: gone when it is type-only, else `import 'module'` for its side effects. */
function emptiedImport(stmt: ts.ImportDeclaration, typeOnly: boolean, sf: ts.SourceFile, text: string): Edit {
  if (typeOnly) return { start: stmt.getStart(sf), end: endOfLine(text, stmt.end), text: '' };
  const semicolon = text[stmt.end - 1] === ';' ? ';' : '';
  return { start: stmt.getStart(sf), end: stmt.end, text: `import ${stmt.moduleSpecifier.getText(sf)}${semicolon}` };
}

type IsUnused = (name: ts.Identifier) => boolean;

/** Does the import bring in types only (`import type ...`, or every named binding marked `type`)? */
function isTypeOnlyImport(clause: ts.ImportClause, named: ts.NamedImports | undefined, namespace: ts.NamespaceImport | undefined): boolean {
  return clause.isTypeOnly || (!clause.name && !namespace && named !== undefined && named.elements.every((el) => el.isTypeOnly));
}

/** The edit that drops one import's unused bindings, or null when it has none. */
function importEdit(stmt: ts.ImportDeclaration, clause: ts.ImportClause, sf: ts.SourceFile, text: string, unused: IsUnused): Edit | null {
  const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : undefined;
  const namespace = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings : undefined;
  const all = [clause.name, namespace?.name, ...(named?.elements.map((el) => el.name) ?? [])].filter((name) => name !== undefined);
  const dropped = all.filter(unused);
  if (dropped.length === 0) return null;
  if (dropped.length === all.length) return emptiedImport(stmt, isTypeOnlyImport(clause, named, namespace), sf, text);

  const keeps = (name: ts.Identifier | undefined) => name !== undefined && !unused(name);
  const keptElements = named?.elements.filter((el) => keeps(el.name)) ?? [];
  const parts = [
    keeps(clause.name) ? clause.name!.text : undefined,
    keeps(namespace?.name) ? namespace!.getText(sf) : undefined,
    keptElements.length > 0 ? namedBindings(named!.getText(sf), keptElements.map((el) => el.getText(sf))) : undefined,
  ].filter((part) => part !== undefined);
  return { start: clause.getStart(sf), end: clause.end, text: `${clause.isTypeOnly ? 'type ' : ''}${parts.join(', ')}` };
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
  const used = identifiersOutsideImports(sf);
  const unused: IsUnused = (name) => candidates.has(name.text) && !used.has(name.text);

  const edits: Edit[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const edit = importEdit(stmt, stmt.importClause, sf, text, unused);
    if (edit) edits.push(edit);
  }

  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

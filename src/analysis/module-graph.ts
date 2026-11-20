import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type ExportKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable';

interface ExportDecl {
  name: string;
  kind: ExportKind;
}

/** Marks "every export of the target is used" (namespace import, re-export, dynamic import, ...). */
export const ALL = '*';

interface ModuleNode {
  file: string;
  /** Resolved in-repo dependencies: target file -> imported names (may contain ALL). */
  edges: Map<string, Set<string>>;
  /** Named, non-default exports declared with an `export` modifier. */
  exports: ExportDecl[];
  /**
   * Whether the file exposes anything at all to importers (ES exports of any
   * shape, or CommonJS `module.exports` / `exports.x`). A file that exports
   * nothing can only be useful when run directly or loaded for its side effects.
   */
  exportsAnything: boolean;
  /** Names of top-level namespaces: an export merged with one cannot be un-exported on its own. */
  namespaces: Set<string>;
}

export interface ModuleGraph {
  modules: Map<string, ModuleNode>;
  /**
   * Single-file components (`.vue`, `.svelte`, `.astro`). Only their script
   * blocks are read, and only for what they import: they are never candidates
   * for cleanup themselves and are always treated as in use.
   */
  components: ModuleNode[];
  /**
   * Directory prefixes that are loaded through non-literal `import()` /
   * `require()` calls. Anything underneath may be used at runtime.
   */
  dynamicPrefixes: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function loadCompilerOptions(root: string): ts.CompilerOptions {
  const forced: ts.CompilerOptions = { allowJs: true, resolveJsonModule: true, noEmit: true };
  const configPath = path.join(root, 'tsconfig.json');
  if (fs.existsSync(configPath)) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
      return { ...parsed.options, ...forced };
    }
  }
  return {
    ...forced,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

/** Named exports a top-level statement declares via an `export` modifier (never `default`). */
export function declaredExports(stmt: ts.Statement): ExportDecl[] {
  if (!hasModifier(stmt, ts.SyntaxKind.ExportKeyword) || hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) return [];
  if (ts.isFunctionDeclaration(stmt) && stmt.name) return [{ name: stmt.name.text, kind: 'function' }];
  if (ts.isClassDeclaration(stmt) && stmt.name) return [{ name: stmt.name.text, kind: 'class' }];
  if (ts.isInterfaceDeclaration(stmt)) return [{ name: stmt.name.text, kind: 'interface' }];
  if (ts.isTypeAliasDeclaration(stmt)) return [{ name: stmt.name.text, kind: 'type' }];
  if (ts.isEnumDeclaration(stmt)) return [{ name: stmt.name.text, kind: 'enum' }];
  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations;
    // Destructuring exports are left alone.
    if (decls.every((d) => ts.isIdentifier(d.name))) {
      return decls.map((d) => ({ name: (d.name as ts.Identifier).text, kind: 'variable' as const }));
    }
  }
  return [];
}

/** Functions that load every file in a directory or matching a pattern. */
const DIRECTORY_LOADER =
  /^(?:readdir|readdirSync|readdirp|glob|globSync|globby|globbySync|fg|fastGlob|requireDirectory|requireDir|requireAll|importDir|importDirectory|loadDir|loadDirectory|autoload|autoLoad|walk|walkSync)$/;
const PATH_HELPER = /^(?:join|resolve|dirname|basename|relative|normalize|extname|fileURLToPath|pathToFileURL)$/;

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** `__dirname` or `import.meta.dirname`: "the directory this file is in". */
function isOwnDirectory(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === '__dirname';
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === 'dirname' &&
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function isImportMetaGlob(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    /^glob(?:Eager)?$/.test(expr.name.text) &&
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function stringLiterals(node: ts.Node, out: string[] = []): string[] {
  if (ts.isStringLiteralLike(node)) out.push(node.text);
  else ts.forEachChild(node, (child) => void stringLiterals(child, out));
  return out;
}

/** The fixed directory part of a glob: `./modules/*.ts` -> `./modules/`. */
function globBase(pattern: string): string {
  const fixed = pattern.split(/[*{[?]/)[0]!;
  return fixed.endsWith('/') ? fixed : fixed.slice(0, fixed.lastIndexOf('/') + 1);
}

const JSDOC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const COMMONJS_EXPORT = /\bmodule\.exports\b|\bexports\s*(?:\.[A-Za-z_$]|\[)/;

const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const ASTRO_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** The script source of a single-file component, with everything else dropped. */
function componentScript(file: string, text: string): string {
  const blocks = [...text.matchAll(SCRIPT_BLOCK)].map((m) => m[1]!);
  if (file.endsWith('.astro')) {
    const frontmatter = ASTRO_FRONTMATTER.exec(text)?.[1];
    if (frontmatter) blocks.unshift(frontmatter);
  }
  return blocks.join('\n;\n');
}

/** What a static `import` brings in: `default`, ALL for a namespace, or the imported names. */
function importedNames(clause: ts.ImportClause | undefined): string[] {
  const names: string[] = [];
  if (clause?.name) names.push('default');
  const bindings = clause?.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) names.push(ALL);
    else for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
}

interface Dependency {
  spec: string;
  /** May contain ALL. */
  names: string[];
}

/** The module a top-level statement loads and what it takes from it: `import`, `export ... from`, `import x = require()`. */
function staticDependency(stmt: ts.Statement): Dependency | null {
  if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
    return { spec: stmt.moduleSpecifier.text, names: importedNames(stmt.importClause) };
  }
  if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
    const clause = stmt.exportClause;
    const names = clause && ts.isNamedExports(clause) ? clause.elements.map((el) => (el.propertyName ?? el.name).text) : [ALL];
    return { spec: stmt.moduleSpecifier.text, names };
  }
  if (
    ts.isImportEqualsDeclaration(stmt) &&
    ts.isExternalModuleReference(stmt.moduleReference) &&
    ts.isStringLiteralLike(stmt.moduleReference.expression)
  ) {
    return { spec: stmt.moduleReference.expression.text, names: [ALL] };
  }
  return null;
}

/** Is this string the module name of a static `import` or `export ... from`? Those are read as statements. */
function isStaticSpecifier(n: ts.StringLiteralLike): boolean {
  return (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)) && n.parent.moduleSpecifier === n;
}

/** Directories a call loads wholesale, relative to the calling file. */
function loadedDirectories(call: ts.CallExpression): string[] {
  const callee = call.expression;
  const name = calleeName(callee);
  if (isImportMetaGlob(callee)) {
    // import.meta.glob('./modules/*.ts'): every match is loaded, none is imported by name.
    return stringLiterals(call.arguments[0]!).filter((pattern) => !pattern.startsWith('!')).map((pattern) => globBase(pattern) || '.');
  }
  if (name === 'context' && ts.isPropertyAccessExpression(callee) && calleeName(callee.expression) === 'require') {
    const first = call.arguments[0]!;
    return [ts.isStringLiteralLike(first) ? first.text : '.'];
  }
  // requireDirectory(__dirname), fs.readdirSync(path.join(__dirname, 'tasks')), glob('./jobs/*.js')
  if (!name || PATH_HELPER.test(name)) return [];
  if (!call.arguments.some(isOwnDirectory) && !DIRECTORY_LOADER.test(name)) return [];
  const literals = call.arguments
    .flatMap((arg) => stringLiterals(arg))
    .map((text) => (/[*{[?]/.test(text) ? globBase(text) || '.' : text));
  const explicit = literals.filter((text) => /^\.{0,2}\//.test(text));
  // Bare words are only directory names when joined onto something
  // (`path.join(__dirname, 'tasks')`); they never replace the default.
  const words = literals.filter((text) => /^[\w@-][\w@/-]*$/.test(text));
  return [...(explicit.length === 0 ? ['.'] : []), ...explicit, ...words];
}

/** `import(x)`, `require(x)` or `require.resolve(x)` and the like. */
function isModuleLoader(callee: ts.Expression): boolean {
  return (
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === 'require') ||
    (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'require')
  );
}

type LoaderTarget = { spec: string } | { dir: string };

/** What a module loader can reach: the module it names, or a directory when its argument is computed. */
function loaderTarget(arg: ts.Expression): LoaderTarget {
  if (ts.isStringLiteralLike(arg)) return { spec: arg.text };
  if (ts.isTemplateExpression(arg) && /^\.\.?\//.test(arg.head.text)) {
    // import(`./locales/${lang}.js`): everything under ./locales may be loaded.
    const head = arg.head.text;
    return { dir: head.endsWith('/') ? head : path.posix.dirname(head) };
  }
  // Fully dynamic: assume it can reach anything next to this file.
  return { dir: '.' };
}

/** The repo-relative prefix for a directory named from a file in `dir`, or null when it lies outside the repository. */
function protectedPrefix(dir: string, relativeDir: string): string | null {
  // A leading slash is relative to the project root (Vite's `/src/pages/*`).
  const joined = relativeDir.startsWith('/')
    ? path.posix.normalize(relativeDir.replace(/^\/+/, '') || '.')
    : path.posix.normalize(path.posix.join(dir, relativeDir));
  if (joined.startsWith('..')) return null;
  return joined === '.' ? '' : joined.replace(/\/?$/, '/');
}

interface DynamicLoads {
  /** Module names: path-like strings, and the arguments of `import()` / `require()`. */
  specs: string[];
  /** Directories loaded wholesale, relative to the file. */
  directories: string[];
}

/** Everything a file may load other than through its import statements, in source order. */
function dynamicLoads(root: ts.Node): DynamicLoads {
  const loads: DynamicLoads = { specs: [], directories: [] };
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) {
      if (!isStaticSpecifier(n) && /^\.\.?(\/|$)/.test(n.text)) loads.specs.push(n.text);
    } else if (ts.isCallExpression(n) && n.arguments.length > 0) {
      loads.directories.push(...loadedDirectories(n));
      if (isModuleLoader(n.expression)) {
        const target = loaderTarget(n.arguments[0]!);
        if ('spec' in target) loads.specs.push(target.spec);
        else loads.directories.push(target.dir);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return loads;
}

function addEdge(node: ModuleNode, target: string | null, names: string[]): void {
  if (!target || target === node.file) return;
  let set = node.edges.get(target);
  if (!set) node.edges.set(target, (set = new Set()));
  for (const n of names) set.add(n);
}

interface ScannedModule {
  node: ModuleNode;
  /** Directories the file loads through computed paths, as repo-relative prefixes. */
  prefixes: string[];
}

type Resolve = (spec: string, fromAbs: string) => string | null;

/** Read one file: its exports, what it imports, and the directories it loads through computed paths. */
function scanModule(file: string, abs: string, text: string, isComponent: boolean, resolve: Resolve): ScannedModule {
  const sf = isComponent
    ? ts.createSourceFile(`${abs}.tsx`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    : ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const node: ModuleNode = { file, edges: new Map(), exports: [], exportsAnything: COMMONJS_EXPORT.test(text), namespaces: new Set() };
  const add = (spec: string, names: string[]) => addEdge(node, resolve(spec, abs), names);

  for (const stmt of sf.statements) {
    node.exports.push(...declaredExports(stmt));
    if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) node.namespaces.add(stmt.name.text);
    if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword) || ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) {
      node.exportsAnything = true;
    }
    const dependency = staticDependency(stmt);
    if (dependency) add(dependency.spec, dependency.names);
  }

  const loads = dynamicLoads(sf);
  for (const spec of loads.specs) add(spec, [ALL]);
  // JSDoc type imports are not part of the walked tree: /** @type {import('./x').Foo} */
  for (const m of text.matchAll(JSDOC_IMPORT)) add(m[1]!, [ALL]);

  const dir = path.posix.dirname(file);
  const prefixes = loads.directories.map((d) => protectedPrefix(dir, d)).filter((prefix) => prefix !== null);
  return { node, prefixes };
}

/**
 * Build the import graph for `files` (repo-relative source files) using the
 * TypeScript compiler's own module resolution, so tsconfig `paths`, `.js` ->
 * `.ts` mapping and index files behave exactly as they do in the project.
 *
 * The graph deliberately over-approximates usage: any string literal that
 * looks like a relative path and resolves to a source file counts as a
 * namespace import of it (covers `jest.mock('./x')`, `new Worker('./x.js')`,
 * `new URL('./x.js', import.meta.url)` and friends).
 */
export function buildModuleGraph(root: string, files: string[], componentFiles: string[] = []): ModuleGraph {
  const options = loadCompilerOptions(root);
  const fileSet = new Set(files);
  const cache = ts.createModuleResolutionCache(root, (f) => f, options);
  const modules = new Map<string, ModuleNode>();
  const components: ModuleNode[] = [];
  const componentSet = new Set(componentFiles);
  const dynamicPrefixes = new Set<string>();

  const resolve: Resolve = (spec, fromAbs) => {
    const resolved = ts.resolveModuleName(spec, fromAbs, options, ts.sys, cache).resolvedModule?.resolvedFileName;
    if (!resolved) return null;
    const rel = toPosix(path.relative(root, resolved));
    return fileSet.has(rel) ? rel : null;
  };

  for (const file of [...files, ...componentFiles]) {
    const abs = path.join(root, file);
    const isComponent = componentSet.has(file);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (isComponent) text = componentScript(file, text);
    const { node, prefixes } = scanModule(file, abs, text, isComponent, resolve);
    if (isComponent) components.push(node);
    else modules.set(file, node);
    for (const prefix of prefixes) dynamicPrefixes.add(prefix);
  }

  return { modules, components, dynamicPrefixes: [...dynamicPrefixes] };
}

/** Every module reachable from `entries` by following imports. */
export function reachableFrom(graph: ModuleGraph, entries: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries].filter((e) => graph.modules.has(e));
  for (const e of queue) seen.add(e);
  while (queue.length) {
    const current = graph.modules.get(queue.pop()!)!;
    for (const target of current.edges.keys()) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

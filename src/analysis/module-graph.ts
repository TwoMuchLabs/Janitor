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
export function buildModuleGraph(root: string, files: string[]): ModuleGraph {
  const options = loadCompilerOptions(root);
  const fileSet = new Set(files);
  const cache = ts.createModuleResolutionCache(root, (f) => f, options);
  const modules = new Map<string, ModuleNode>();
  const dynamicPrefixes = new Set<string>();

  const resolve = (spec: string, fromAbs: string): string | null => {
    const resolved = ts.resolveModuleName(spec, fromAbs, options, ts.sys, cache).resolvedModule?.resolvedFileName;
    if (!resolved) return null;
    const rel = toPosix(path.relative(root, resolved));
    return fileSet.has(rel) ? rel : null;
  };

  for (const file of files) {
    const abs = path.join(root, file);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
    const node: ModuleNode = { file, edges: new Map(), exports: [], exportsAnything: COMMONJS_EXPORT.test(text), namespaces: new Set() };
    modules.set(file, node);
    const dir = path.posix.dirname(file);

    const add = (spec: string, names: string[]) => {
      const target = resolve(spec, abs);
      if (!target || target === file) return;
      let set = node.edges.get(target);
      if (!set) node.edges.set(target, (set = new Set()));
      for (const n of names) set.add(n);
    };

    const protect = (relativeDir: string) => {
      // A leading slash is relative to the project root (Vite's `/src/pages/*`).
      const joined = relativeDir.startsWith('/')
        ? path.posix.normalize(relativeDir.replace(/^\/+/, '') || '.')
        : path.posix.normalize(path.posix.join(dir, relativeDir));
      if (joined.startsWith('..')) return;
      dynamicPrefixes.add(joined === '.' ? '' : joined.replace(/\/?$/, '/'));
    };

    for (const stmt of sf.statements) {
      node.exports.push(...declaredExports(stmt));
      if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) node.namespaces.add(stmt.name.text);
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword) || ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) {
        node.exportsAnything = true;
      }

      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const names: string[] = [];
        const clause = stmt.importClause;
        if (clause?.name) names.push('default');
        const bindings = clause?.namedBindings;
        if (bindings) {
          if (ts.isNamespaceImport(bindings)) names.push(ALL);
          else for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
        }
        add(stmt.moduleSpecifier.text, names);
      } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const clause = stmt.exportClause;
        const names =
          clause && ts.isNamedExports(clause) ? clause.elements.map((el) => (el.propertyName ?? el.name).text) : [ALL];
        add(stmt.moduleSpecifier.text, names);
      } else if (
        ts.isImportEqualsDeclaration(stmt) &&
        ts.isExternalModuleReference(stmt.moduleReference) &&
        ts.isStringLiteralLike(stmt.moduleReference.expression)
      ) {
        add(stmt.moduleReference.expression.text, [ALL]);
      }
    }

    const visit = (n: ts.Node) => {
      if (ts.isStringLiteralLike(n)) {
        const isStaticSpecifier =
          (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)) && n.parent.moduleSpecifier === n;
        if (!isStaticSpecifier && /^\.\.?(\/|$)/.test(n.text)) add(n.text, [ALL]);
      } else if (ts.isCallExpression(n) && n.arguments.length > 0) {
        const callee = n.expression;
        const name = calleeName(callee);
        if (isImportMetaGlob(callee)) {
          // import.meta.glob('./modules/*.ts'): every match is loaded, none is imported by name.
          for (const pattern of stringLiterals(n.arguments[0]!)) if (!pattern.startsWith('!')) protect(globBase(pattern) || '.');
        } else if (name === 'context' && ts.isPropertyAccessExpression(callee) && calleeName(callee.expression) === 'require') {
          const first = n.arguments[0]!;
          protect(ts.isStringLiteralLike(first) ? first.text : '.');
        } else if (name && !PATH_HELPER.test(name)) {
          // requireDirectory(__dirname), fs.readdirSync(path.join(__dirname, 'tasks')), glob('./jobs/*.js')
          const passesOwnDirectory = n.arguments.some(isOwnDirectory);
          if (passesOwnDirectory || DIRECTORY_LOADER.test(name)) {
            const literals = n.arguments
              .flatMap((arg) => stringLiterals(arg))
              .map((text) => (/[*{[?]/.test(text) ? globBase(text) || '.' : text));
            const explicit = literals.filter((text) => /^\.{0,2}\//.test(text));
            // Bare words are only directory names when joined onto something
            // (`path.join(__dirname, 'tasks')`); they never replace the default.
            const words = literals.filter((text) => /^[\w@-][\w@/-]*$/.test(text));
            if (explicit.length === 0) protect('.');
            for (const target of [...explicit, ...words]) protect(target);
          }
        }
        const isLoader =
          callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === 'require') ||
          (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === 'require');
        const arg = n.arguments[0]!;
        if (isLoader) {
          if (ts.isStringLiteralLike(arg)) {
            add(arg.text, [ALL]);
          } else if (ts.isTemplateExpression(arg) && /^\.\.?\//.test(arg.head.text)) {
            // import(`./locales/${lang}.js`): everything under ./locales may be loaded.
            const head = arg.head.text;
            protect(head.endsWith('/') ? head : path.posix.dirname(head));
          } else {
            // Fully dynamic: assume it can reach anything next to this file.
            protect('.');
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);

    // JSDoc type imports are not part of the walked tree: /** @type {import('./x').Foo} */
    for (const m of text.matchAll(JSDOC_IMPORT)) add(m[1]!, [ALL]);
  }

  return { modules, dynamicPrefixes: [...dynamicPrefixes] };
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

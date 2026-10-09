/**
 * The folders an entry's `import.meta.glob()` calls read. Vite replaces each call with the files that match it
 * when it bundles, so the bundle names those files and nothing else: a file added later that matches is in no
 * bundle's module list. To bundle again when the files a glob selects change, the plugin reads each call itself,
 * just before Vite's own import-glob transform does, and notes the folder below which it can match (its scope).
 *
 * A scope is a superset of what the glob matches: a file added to it or removed from it may not match (a negated
 * pattern, a name the wildcards leave out), which only bundles again for nothing. The calls are read with acorn as Vite reads them: patterns are
 * string literals, template literals without expressions, or arrays of those; `base` and `exhaustive` are literal
 * options. A call written otherwise is one Vite rejects, and the bundle fails before its scope matters.
 *
 * Code that is a module is read whole, so only real calls count. Code that is not (yet) one, as a plugin may hand
 * on a component file or TypeScript it transforms later, is read the way Vite's import-glob reads every module:
 * each `import.meta.glob(` in the text, with TypeScript type arguments allowed, is read on its own as a call.
 * Text in a comment or a string that reads as a call then adds a scope too, which only costs a bundle for nothing.
 */
import { readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import type { AnyNode, Expression, ObjectExpression, Options, SpreadElement } from 'acorn';
import { tokTypes } from 'acorn';
import { AcornParser, trySyntax } from '../js-syntax.js';
import { isRecord } from '../util.js';
import { fileKey, isViteConfigTemp, keyWithin, toPosix } from './paths.js';
import { missingImportFolders } from './watch-targets.js';

/**
 * Where a glob can match:
 * - `dir`: the folder below which it can (forward slashes);
 * - `deep`: whether it also matches in the folders below `dir`, or only among `dir`'s own files;
 * - `dot`: whether it may match a name that starts with a dot, which Vite's import-glob gives no wildcard unless
 *   the call is `exhaustive` or the pattern spells the dot;
 * - `exhaustive`: the call's option, which also lets a match pass through `node_modules`;
 * - `suffix`: the literal end of the pattern's last segment (`.js` of `*.js`), lower-cased, which every file it
 *   matches ends with (in any case, as a case-insensitive glob matches).
 */
export interface GlobScope {
  readonly dir: string;
  readonly deep: boolean;
  readonly dot: boolean;
  readonly exhaustive: boolean;
  readonly suffix: string;
}

/** One `import.meta.glob()` call: its patterns as written, and the options that decide where they match. */
export interface GlobCall {
  readonly patterns: readonly string[];
  readonly base: string | undefined;
  readonly exhaustive: boolean;
}

/** A module, as the bundler hands it to a plugin's transform hook (the entry build's code is a module). */
const MODULE_OPTIONS: Readonly<Options> = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true };

/** Whether `code` may hold a glob call, as Vite's import-glob filters the modules it reads. */
function mayHoldGlob(code: string): boolean {
  return code.includes('import.meta.glob');
}

function isNode(value: unknown): value is AnyNode {
  return isRecord(value) && typeof value['type'] === 'string';
}

/** Every node below `root`, `root` first, in source order. */
function* nodesOf(root: AnyNode): Generator<AnyNode> {
  const stack: unknown[] = [root];
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    if (isNode(value)) yield value;
    const children: readonly unknown[] = Array.isArray(value) ? value : isNode(value) ? Object.values(value) : [];
    stack.push(...children.toReversed());
  }
}

/** Whether `node` is the callee `import.meta.glob`. */
function isGlobCallee(node: Expression | AnyNode): boolean {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === 'glob' &&
    node.object.type === 'MetaProperty' &&
    node.object.meta.name === 'import' &&
    node.object.property.name === 'meta'
  );
}

/** The string a pattern argument spells: a string literal, or a template literal without expressions. */
function stringOf(node: Expression | SpreadElement | null): string | undefined {
  if (node === null) return undefined;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.raw;
  return undefined;
}

/** The literal value of the option `name` of a call's options object. */
function optionOf(options: ObjectExpression | undefined, name: string): unknown {
  for (const property of options?.properties ?? []) {
    if (property.type !== 'Property' || property.computed || property.value.type !== 'Literal') continue;
    const { key } = property;
    const keyName = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : undefined;
    if (keyName === name) return property.value.value;
  }
  return undefined;
}

/** The call a glob call's arguments make. */
function callOf(args: readonly (Expression | SpreadElement)[]): GlobCall {
  const [first, second] = args;
  const patterns = (first === undefined ? [] : first.type === 'ArrayExpression' ? first.elements : [first])
    .map(stringOf)
    .filter((pattern) => pattern !== undefined);
  const options = second?.type === 'ObjectExpression' ? second : undefined;
  const base = optionOf(options, 'base');
  return {
    patterns,
    base: typeof base === 'string' ? base : undefined,
    exhaustive: optionOf(options, 'exhaustive') === true,
  };
}

/** Where Vite's import-glob finds a call in a module's text: the callee, any TypeScript type arguments, `(`. */
const GLOB_CALL_START = /\bimport\.meta\.glob(?:<\w+>)?\s*\(/g;

/**
 * The end (offset just past it) of the argument list that opens at `paren`, as acorn's tokenizer reads the text from
 * there: past strings, template literals, regular expressions and comments that hold parentheses. Undefined when the
 * list does not close, or the text cannot be tokenized.
 */
function argumentsEnd(code: string, paren: number): number | undefined {
  const read = trySyntax(() => {
    let depth = 0;
    for (const token of AcornParser.tokenizer(code.slice(paren), MODULE_OPTIONS)) {
      if (token.type === tokTypes.parenL) depth += 1;
      else if (token.type === tokTypes.parenR) depth -= 1;
      if (depth === 0) return paren + token.end;
    }
    return undefined;
  });
  return read.ok ? read.value : undefined;
}

/** `text` read as one expression, which must take all of it; undefined when acorn reads it otherwise. */
function wholeExpression(text: string, options: Readonly<Options>): AnyNode | undefined {
  const read = trySyntax(() => AcornParser.parseExpressionAt(text, 0, options));
  return read.ok && read.value.end === text.length ? read.value : undefined;
}

/**
 * The call whose callee starts at `start` and whose argument list opens at `paren`, read on its own, up to the end
 * of its argument list: as a call expression, or, with type arguments between the two (which JavaScript reads as
 * comparisons), as its argument list in parentheses. Undefined when acorn reads neither.
 */
function callAt(code: string, start: number, paren: number): GlobCall | undefined {
  const end = argumentsEnd(code, paren);
  if (end === undefined) return undefined;
  const call = wholeExpression(code.slice(start, end), MODULE_OPTIONS);
  if (call?.type === 'CallExpression' && isGlobCallee(call.callee)) return callOf(call.arguments);
  const list = wholeExpression(code.slice(paren, end), { ...MODULE_OPTIONS, preserveParens: true });
  if (list?.type !== 'ParenthesizedExpression') return undefined;
  const { expression } = list;
  return callOf(expression.type === 'SequenceExpression' ? expression.expressions : [expression]);
}

/** The glob calls of a module's code, and where each call is that could not be read (by offset). */
export interface GlobReading {
  readonly calls: readonly GlobCall[];
  readonly unreadable: readonly number[];
}

/** The glob calls of a module's code: read whole when it is a module, else each call on its own. */
export function globCalls(code: string): GlobReading {
  const parsed = trySyntax(() => AcornParser.parse(code, MODULE_OPTIONS));
  if (parsed.ok) {
    const calls = [...nodesOf(parsed.value)].flatMap((node) =>
      node.type === 'CallExpression' && isGlobCallee(node.callee) ? [callOf(node.arguments)] : [],
    );
    return { calls, unreadable: [] };
  }
  const calls: GlobCall[] = [];
  const unreadable: number[] = [];
  for (const match of code.matchAll(GLOB_CALL_START)) {
    const call = callAt(code, match.index, match.index + match[0].length - 1);
    if (call === undefined) unreadable.push(match.index);
    else calls.push(call);
  }
  return { calls, unreadable };
}

/** Where `offset` is in `code`, as `line:column`, both from 1. */
function lineColumn(code: string, offset: number): string {
  const lines = code.slice(0, offset).split('\n');
  return `${String(lines.length)}:${String((lines.at(-1)?.length ?? 0) + 1)}`;
}

/** Characters that make a segment of a pattern match more than its own name (picomatch's, and its escape). */
const MAGIC = /[*?[\]{}()!+@\\]/;

/** The characters at the end of a segment after its last MAGIC one. */
const LITERAL_END = /[^*?[\]{}()!+@\\]*$/;

/** Whether a pattern's segments may match a name starting with a dot, which a wildcard alone never does. */
function namesDot(segments: readonly string[]): boolean {
  return segments.some((segment) => segment !== '..' && /(?:^|[{,])\./.test(segment));
}

/**
 * The scope of the pattern `rest` below an absolute folder `dir` (as the file system spells it, so nothing in it
 * is taken for a wildcard): the folder its leading plain segments name (`..` included), whether the segments after
 * those reach below it, and the literal end of its last segment.
 */
function scopeOf(dir: string, rest: string, exhaustive: boolean): GlobScope {
  const segments = posix.normalize(rest).split('/');
  const magic = segments.findIndex((segment) => MAGIC.test(segment));
  const plain = magic === -1 ? segments.slice(0, -1) : segments.slice(0, magic);
  const below = segments.slice(plain.length);
  return {
    dir: toPosix(resolve(dir, ...plain)),
    deep: below.length > 1 || below.some((segment) => segment.includes('**')),
    dot: exhaustive || namesDot(below),
    exhaustive,
    suffix: (LITERAL_END.exec(below.at(-1) ?? '')?.[0] ?? '').toLowerCase(),
  };
}

/** How a plugin hook resolves an import, as Vite's import-glob resolves a pattern that is not a path. */
export type GlobResolver = (pattern: string) => Promise<string | undefined>;

/**
 * The scopes of the patterns of `call`, made in the module `importer` (a file path, or undefined for a virtual
 * module) under `root`, as Vite's import-glob places them: `/` from the root, `./` and `../` from the importer's
 * folder or the `base` option, `**` from the root, and anything else (an alias, a `#` import) as the resolver
 * resolves it. A negated pattern only takes files away, and has none.
 */
export async function scopesOf(
  call: GlobCall,
  importer: string | undefined,
  root: string,
  resolver: GlobResolver,
): Promise<GlobScope[]> {
  const folder = importer === undefined ? root : dirname(importer);
  const from =
    call.base === undefined ? folder : call.base.startsWith('/') ? join(root, call.base) : resolve(folder, call.base);
  const scopes: GlobScope[] = [];
  for (const pattern of call.patterns) {
    if (pattern.startsWith('!')) continue;
    if (pattern.startsWith('/')) scopes.push(scopeOf(root, pattern.slice(1), call.exhaustive));
    else if (pattern.startsWith('./') || pattern.startsWith('../'))
      scopes.push(scopeOf(from, pattern, call.exhaustive));
    else if (pattern.startsWith('**')) scopes.push(scopeOf(root, pattern, call.exhaustive));
    else {
      const resolved = await resolver(pattern);
      if (resolved === undefined || !isAbsolute(resolved)) continue;
      // The resolver turns the pattern's leading part into a path and keeps the rest; the part the two share at
      // the end is the pattern's own (as Vite's globSafeResolvedPath reads it).
      const spelled = toPosix(resolved);
      let shared = 0;
      while (shared < Math.min(spelled.length, pattern.length) && spelled.at(-1 - shared) === pattern.at(-1 - shared)) {
        shared += 1;
      }
      const cut = spelled.lastIndexOf('/', spelled.length - shared);
      scopes.push(scopeOf(spelled.slice(0, Math.max(cut, 0)) || '/', spelled.slice(cut + 1), call.exhaustive));
    }
  }
  return scopes;
}

/** A key that is the same for two equal scopes. */
export function scopeId(scope: GlobScope): string {
  return JSON.stringify([scope.dir, scope.deep, scope.dot, scope.exhaustive, scope.suffix]);
}

/**
 * Whether an entry named `name` of a folder in the scope may be matched, or, for a folder, lead to a match. The
 * temporary copies Vite makes of a config file never are: they come and go with every entry build.
 */
function admits(scope: GlobScope, name: string, isDir: boolean): boolean {
  if ((name.startsWith('.') && !scope.dot) || isViteConfigTemp(name)) return false;
  if (isDir) return scope.deep && (scope.exhaustive || name !== 'node_modules');
  return name.toLowerCase().endsWith(scope.suffix);
}

/**
 * What is in a scope, as a string that changes when a file the glob may match is added to it, removed from it or
 * renamed in it, and stays the same otherwise: the files of its folder that `admits` lets through, and for a deep
 * scope the folders below it and theirs. A link is listed as a file, and not followed. A scope whose folder does
 * not exist (yet) lists as missing.
 */
export function scopeListing(scope: GlobScope): string {
  const entries: string[] = [];
  const list = (dir: string, prefix: string): boolean => {
    let found;
    try {
      found = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const isDir = entry.isDirectory();
      if (!admits(scope, entry.name, isDir)) continue;
      const path = `${prefix}${entry.name}`;
      entries.push(`${isDir ? 'd' : 'f'}:${path}`);
      if (isDir) list(join(dir, entry.name), `${path}/`);
    }
    return true;
  };
  return list(scope.dir, '') ? entries.join('\n') : '\0missing';
}

/**
 * Whether adding or removing the file (or folder, `isDir`) at `path` may change what the glob of `scope` matches:
 * it is in the scope and `admits` lets it through, or it is the scope's folder itself. Folders are compared by
 * identity key, so one is recognised however the path spells it.
 */
export function scopeAdmits(scope: GlobScope, path: string, isDir: boolean): boolean {
  const folder = fileKey(scope.dir);
  if (fileKey(path) === folder) return true;
  const parent = fileKey(dirname(path));
  return (scope.deep ? keyWithin(parent, [folder]) : parent === folder) && admits(scope, basename(path), isDir);
}

/**
 * The folders a watcher watches for `scopes`: each scope's folder, or, for one that does not exist, the nearest
 * folder above it that does, where creating it shows.
 */
export function scopeWatchTargets(scopes: Iterable<GlobScope>): string[] {
  return [...new Set([...scopes].map(({ dir }) => toPosix(missingImportFolders([dir])[0] ?? dir)))];
}

/**
 * The part of a plugin's transform hook context the glob reading uses: resolving an import, and warning.
 */
interface GlobHookContext {
  resolve(
    source: string,
    importer?: string,
    options?: { custom?: Record<string, unknown> },
  ): Promise<{ readonly id: string } | null>;
  warn(message: string): void;
}

/**
 * The file `pattern` (an alias or a `#` import, not a path) resolves to from `importer`, asked as Vite's
 * import-glob asks; undefined when it resolves to none, or the resolver fails (Vite's import-glob then reports
 * the pattern itself).
 */
async function resolveGlob(context: GlobHookContext, pattern: string, importer: string): Promise<string | undefined> {
  const isSubImportsPattern = pattern.startsWith('#') && pattern.includes('*');
  try {
    const resolved = await context.resolve(pattern, importer, {
      custom: { 'vite:import-glob': { isSubImportsPattern } },
    });
    return resolved?.id.replace(/[?#].*$/s, '');
  } catch {
    return undefined;
  }
}

/**
 * The scopes of the glob calls in a module's code, read in a plugin's transform hook, whose `context` resolves an
 * alias or `#` pattern as Vite's import-glob would; a call acorn cannot read is reported with a warning and has
 * none.
 */
export async function moduleGlobScopes(
  context: GlobHookContext,
  code: string,
  id: string,
  root: string,
): Promise<GlobScope[]> {
  if (!mayHoldGlob(code)) return [];
  const { calls, unreadable } = globCalls(code);
  if (unreadable.length > 0) {
    const where = unreadable.map((offset) => lineColumn(code, offset)).join(', ');
    context.warn(
      `twee-ts could not read the import.meta.glob() call at ${where} of ${id}; ` +
        'files added to its folders are bundled the next time something else changes.',
    );
  }
  const file = id.replace(/[?#].*$/s, '');
  const importer = isAbsolute(file) && !id.startsWith('\0') ? file : undefined;
  const resolver: GlobResolver = (pattern) => resolveGlob(context, pattern, id);
  const scopes = await Promise.all(calls.map((call) => scopesOf(call, importer, root, resolver)));
  return scopes.flat();
}

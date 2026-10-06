/**
 * Story format file decoding: find the object a Twine 2 `format.js` passes to `storyFormat()` and
 * read its metadata, without evaluating anything.
 *
 * The file is parsed as a classic script with acorn (see `js-syntax.ts`); a file that is not valid
 * JavaScript is rejected with acorn's error and its position. The format object is the first
 * argument of the one call whose callee is `storyFormat` itself or a property access ending in
 * `storyFormat`: `storyFormat(…)`, `window.storyFormat(…)`, `window['storyFormat'](…)`,
 * `a.b.storyFormat(…)`, `window.storyFormat?.(…)`, parenthesized or not, anywhere in the file
 * (Unicode escapes in the name count, as JavaScript reads them). A file with no such call is read
 * as a format object only if all of it is one object literal (as Tweego reads it); a file with
 * several such calls is rejected, as which one a loader sees is not knowable without running it.
 *
 * The object is read as data, never run. Supported, with JavaScript's own values:
 * - string, number, `true`, `false` and `null` literals, numbers in every notation the Script goal
 *   allows (hexadecimal, octal, binary, legacy octal `010`, separators `1_000`, exponents);
 * - a `-` or `+` before a number literal;
 * - template literals without substitutions;
 * - arrays without holes or spreads, and nested objects;
 * - property keys that are identifiers, strings or numbers (numeric keys become the string
 *   JavaScript makes of them: `0x10` is `"16"`, `1e3` is `"1000"`), with duplicate keys resolved as
 *   JavaScript resolves them (the last value wins, in the place of the first).
 *
 * A property whose value is a function (`setup: function () {…}`, an arrow function, or a method
 * such as Harlowe's `setup() {…}`) is not data: it is left out, and a note says so. Anything else is
 * an error naming the property and its line and column: identifiers (including `undefined`, `NaN`
 * and `Infinity`), BigInts, regular expressions, computed keys, spreads, getters and setters,
 * shorthand properties, array holes, operators and calls. So is a `__proto__` key, which in
 * JavaScript sets the prototype rather than adding a property.
 */
import type {
  AnyNode,
  ArrayExpression,
  CallExpression,
  Expression,
  ObjectExpression,
  Program,
  Property,
  SpreadElement,
  Super,
} from 'acorn';
import { tokTypes } from 'acorn';
import type { FormatDecodeResult, Twine2FormatJSON } from './types.js';
import { describePosition, lineColumnFinder } from './js-chars.js';
import type { LineColumn } from './js-chars.js';
import { AcornParser, SCRIPT_OPTIONS, parseScript, trySyntax } from './js-syntax.js';
import { parseVersion } from './semver.js';

/** The name given to a format.js that names no format. */
export const UNNAMED_FORMAT_NAME = 'Untitled Story Format';

const STORY_FORMAT = 'storyFormat';

/** Whether a value read from the tree is an acorn node. */
function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

/** Every `storyFormat(…)` call in the program, in source order. */
function findStoryFormatCalls(program: Program): CallExpression[] {
  const calls: CallExpression[] = [];
  // An explicit stack, so deeply nested code cannot exhaust the call stack.
  const pending: AnyNode[] = [program];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'CallExpression' && callsStoryFormat(node.callee)) calls.push(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) pending.push(item);
      } else if (isNode(child)) {
        pending.push(child);
      }
    }
  }
  return calls.sort((a, b) => a.start - b.start);
}

/** Whether a callee names `storyFormat`: the identifier, or a property access that ends in it. */
function callsStoryFormat(callee: Expression | Super): boolean {
  switch (callee.type) {
    case 'Identifier':
      return callee.name === STORY_FORMAT;
    case 'ChainExpression':
      return callee.expression.type === 'MemberExpression' && callsStoryFormat(callee.expression);
    case 'MemberExpression': {
      const { property } = callee;
      return callee.computed
        ? property.type === 'Literal' && property.value === STORY_FORMAT
        : property.type === 'Identifier' && property.name === STORY_FORMAT;
    }
    default:
      return false;
  }
}

/** What reading the format object found: its top-level properties, or the first error. */
type ObjectRead = { readonly ok: true; readonly value: ReadonlyMap<string, unknown> } | ErrorResult;
type ValueRead = { readonly ok: true; readonly value: unknown } | ErrorResult;
interface ErrorResult {
  readonly ok: false;
  readonly reason: string;
}

/** A property left out of the value: a function, which is not data. */
const SKIPPED: unique symbol = Symbol('skipped');

/** Reads literal values out of the tree of one file, collecting notes about what it leaves out. */
class LiteralReader {
  readonly notes: string[] = [];
  private readonly where: (offset: number) => LineColumn;

  constructor(source: string) {
    this.where = lineColumnFinder(source);
  }

  position(offset: number): string {
    return describePosition(this.where(offset));
  }

  fail(path: string, node: AnyNode, what: string): ErrorResult {
    return {
      ok: false,
      reason: `Unsupported ${what} at ${describePath(path)} (${this.position(node.start)}); only literal data is read`,
    };
  }

  /** The properties of an object literal, in JavaScript's order, functions left out. */
  readObject(node: ObjectExpression, path: string): ObjectRead {
    const entries = new Map<string, unknown>();
    for (const property of node.properties) {
      const read = this.readProperty(property, path);
      if (!read.ok) return read;
      const { key, value } = read;
      // A later definition replaces an earlier one in its place, as in JavaScript; a skipped
      // function still replaces it, so the earlier value is not kept in its stead.
      entries.set(key, value);
    }
    for (const [key, value] of entries) if (value === SKIPPED) entries.delete(key);
    return { ok: true, value: entries };
  }

  private readProperty(
    property: Property | SpreadElement,
    path: string,
  ): { readonly ok: true; readonly key: string; readonly value: unknown } | ErrorResult {
    if (property.type === 'SpreadElement') return this.fail(path, property, 'spread property');
    const key = propertyKey(property);
    if (key === undefined) return this.fail(path, property, 'computed property key');
    const keyPath = joinPath(path, key);
    if (property.kind !== 'init') return this.fail(keyPath, property, `${property.kind}ter`);
    if (property.shorthand) return this.fail(keyPath, property, 'shorthand property');
    if (property.method || isFunction(property.value)) {
      this.notes.push(`Skipped the function at ${describePath(keyPath)} (${this.position(property.start)})`);
      return { ok: true, key, value: SKIPPED };
    }
    if (key === '__proto__') return this.fail(keyPath, property, '__proto__ key (it sets the prototype)');
    const value = this.readValue(property.value, keyPath);
    return value.ok ? { ok: true, key, value: value.value } : value;
  }

  readValue(node: Expression, path: string): ValueRead {
    switch (node.type) {
      case 'Literal':
        if (typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean') {
          return { ok: true, value: node.value };
        }
        if (node.value === null && node.regex === undefined && node.bigint === undefined) {
          return { ok: true, value: null };
        }
        return this.fail(path, node, node.bigint === undefined ? 'regular expression' : 'BigInt');
      case 'UnaryExpression': {
        const { argument } = node;
        if ((node.operator === '-' || node.operator === '+') && argument.type === 'Literal') {
          const { value } = argument;
          if (typeof value === 'number') return { ok: true, value: node.operator === '-' ? -value : value };
        }
        return this.fail(path, node, `${node.operator} expression`);
      }
      case 'TemplateLiteral': {
        const [quasi] = node.quasis;
        const cooked = quasi?.value.cooked;
        return node.expressions.length === 0 && typeof cooked === 'string'
          ? { ok: true, value: cooked }
          : this.fail(path, node, 'template literal with substitutions');
      }
      case 'ArrayExpression':
        return this.readArray(node, path);
      case 'ObjectExpression': {
        const read = this.readObject(node, path);
        return read.ok ? { ok: true, value: Object.fromEntries(read.value) } : read;
      }
      default:
        return this.fail(path, node, describeNode(node));
    }
  }

  private readArray(node: ArrayExpression, path: string): ValueRead {
    const values: unknown[] = [];
    for (const [index, element] of node.elements.entries()) {
      const elementPath = `${path}[${index}]`;
      if (element === null) return this.fail(elementPath, node, 'array hole');
      if (element.type === 'SpreadElement') return this.fail(elementPath, element, 'spread element');
      if (isFunction(element)) return this.fail(elementPath, element, 'function in an array');
      const value = this.readValue(element, elementPath);
      if (!value.ok) return value;
      values.push(value.value);
    }
    return { ok: true, value: values };
  }
}

function isFunction(node: Expression): boolean {
  return node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

/** A property's key as JavaScript makes it, or `undefined` for a computed key. */
function propertyKey(property: Property): string | undefined {
  if (property.computed) return undefined;
  const { key } = property;
  if (key.type === 'Identifier') return key.name;
  // Otherwise a string, number or BigInt literal (acorn parses no other key that is not computed),
  // named by its string form as in JavaScript: `0x10` is "16", `1.50` is "1.5", `1n` is "1".
  return key.type === 'Literal' ? String(key.value) : undefined;
}

const IDENTIFIER_NAME = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

/** The path of a property, written as JavaScript would access it: `a.b`, `a["c-d"]`, `a[0]`. */
function joinPath(path: string, key: string): string {
  if (IDENTIFIER_NAME.test(key)) return path === '' ? key : `${path}.${key}`;
  return `${path}[${JSON.stringify(key)}]`;
}

function describePath(path: string): string {
  return path === '' ? 'the format object' : `property ${path}`;
}

/** A readable name for a kind of expression: `CallExpression` is "call expression". */
function describeNode(node: AnyNode): string {
  if (node.type === 'Identifier') return `identifier ${JSON.stringify(node.name)}`;
  return node.type.replace(/(?<=[a-z])(?=[A-Z])/g, ' ').toLowerCase();
}

/**
 * The object literal that is all of `source`, if it is one: a format.js written as bare JSON or as
 * an object literal, which Tweego reads too.
 */
function wholeFileObject(source: string, program: Program | undefined): ObjectExpression | undefined {
  // In parentheses, the object is a script of one expression statement.
  const [statement, ...others] = program?.body ?? [];
  if (statement?.type === 'ExpressionStatement' && others.length === 0) {
    return statement.expression.type === 'ObjectExpression' ? statement.expression : undefined;
  }
  // Bare, it is no valid script ({a: 1, b: 2}) or a labelled block ({a: 1}): read it as an expression.
  const read = trySyntax(() => {
    const node = AcornParser.parseExpressionAt(source, 0, SCRIPT_OPTIONS);
    // Only comments and white space may follow.
    const after = AcornParser.tokenizer(source.slice(node.end), SCRIPT_OPTIONS).getToken();
    return node.type === 'ObjectExpression' && after.type === tokTypes.eof ? node : undefined;
  });
  return read.ok ? read.value : undefined;
}

/** The format object of a parsed file, or why there is none. */
function locateFormatObject(
  source: string,
  program: Program,
  reader: LiteralReader,
): { readonly ok: true; readonly node: ObjectExpression } | ErrorResult {
  const calls = findStoryFormatCalls(program);
  const [call, ...others] = calls;
  if (call === undefined) {
    const node = wholeFileObject(source, program);
    return node === undefined
      ? { ok: false, reason: 'Could not find a storyFormat({…}) call in the story format file.' }
      : { ok: true, node };
  }
  if (others.length > 0) {
    const where = calls.map((c) => reader.position(c.start)).join('; ');
    return {
      ok: false,
      reason: `The story format file calls storyFormat() ${calls.length} times (${where}); expected exactly one call.`,
    };
  }
  const [argument] = call.arguments;
  if (argument?.type !== 'ObjectExpression') {
    return {
      ok: false,
      reason: `The storyFormat() call at ${reader.position(call.start)} is not given an object literal.`,
    };
  }
  return { ok: true, node: argument };
}

/** The properties of a format.js's format object, with notes on what was left out, or why it has none. */
type FormatObjectRead =
  { readonly ok: true; readonly fields: ReadonlyMap<string, unknown>; readonly notes: string[] } | ErrorResult;

/**
 * Find and read the format object of a format.js, as the module comment describes. (Exported for
 * tests; the module is not part of the package's API.)
 */
export function readFormatObject(source: string): FormatObjectRead {
  const reader = new LiteralReader(source);
  const parsed = parseScript(source);
  let node: ObjectExpression | undefined;
  if (parsed.ok) {
    const located = locateFormatObject(source, parsed.value, reader);
    if (!located.ok) return located;
    node = located.node;
  } else {
    // A file that is one object literal with several properties is not a valid script.
    node = wholeFileObject(source, undefined);
    if (node === undefined) {
      const { error } = parsed;
      return {
        ok: false,
        reason: `The story format file is not valid JavaScript: ${error.message} at ${reader.position(error.pos)}.`,
      };
    }
  }
  const read = reader.readObject(node, '');
  if (!read.ok) return { ok: false, reason: `Could not decode the story format object: ${read.reason}.` };
  return { ok: true, fields: read.value, notes: reader.notes };
}

/**
 * Read the metadata of a Twine 2 format.js, or say why it cannot be used. See the module comment
 * for what the file and its format object may contain.
 */
export function decodeFormatJSON(source: string): FormatDecodeResult {
  const read = readFormatObject(source);
  return read.ok ? toFormatJSON(read.fields, read.notes) : read;
}

/**
 * Check a format object's fields. Per spec, `name` is optional; `version` and `source` are
 * required. An optional field of the wrong type is ignored, with a note.
 */
function toFormatJSON(fields: ReadonlyMap<string, unknown>, notes: string[]): FormatDecodeResult {
  const version = fields.get('version');
  const source = fields.get('source');
  if (typeof version !== 'string') return { ok: false, reason: 'Story format has no "version" string.' };
  if (typeof source !== 'string') return { ok: false, reason: 'Story format has no "source" string.' };
  if (!parseVersion(version)) {
    return { ok: false, reason: `Story format version ${JSON.stringify(version)} is not a SemVer version.` };
  }
  const optionalString = (key: string): string | undefined => {
    const value = fields.get(key);
    if (value === undefined || typeof value === 'string') return value;
    notes.push(`Ignored "${key}": it is not a string`);
    return undefined;
  };
  const name = optionalString('name') ?? UNNAMED_FORMAT_NAME;
  const proofing = fields.get('proofing');
  if (proofing !== undefined && typeof proofing !== 'boolean') notes.push('Ignored "proofing": it is not a boolean');
  const data: Twine2FormatJSON = { name, version, source, proofing: proofing === true };
  for (const key of ['author', 'description', 'image', 'url', 'license'] as const) {
    const value = optionalString(key);
    if (value !== undefined) data[key] = value;
  }
  return { ok: true, data, notes };
}

/**
 * Read the format object of a Twine 2 `format.js` (the object literal passed to its `storyFormat()` call);
 * null when the file holds no usable format. Compiling reports why a format cannot be used.
 */
export function parseFormatJSON(source: string): Twine2FormatJSON | null {
  const result = decodeFormatJSON(source);
  return result.ok ? result.data : null;
}

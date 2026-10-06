/**
 * Typed decoding of untrusted JSON text, with issues that say where a value was rejected.
 *
 * Two layers:
 *
 * 1. `parseJSON(text)` is a strict RFC 8259 parser. Unlike `JSON.parse`, it keeps every object member in
 *    document order, duplicates included, and builds no JavaScript objects from the keys, so a key such as
 *    `__proto__` or `constructor` is plain data. It runs in linear time and without recursion, and limits
 *    nesting to 10000 levels, as Go's `encoding/json` does.
 *
 * 2. Decoders turn a parsed `JsonValue` into typed values. Each one checks the type of what it reads and
 *    records a `DecodeIssue` (with a path such as `$.options[1]`) for anything it rejects, so a caller never
 *    drops a value silently: it decides per issue kind whether to report an error or a warning.
 *    `readObject()` reads the members of an object into named fields. Its keys can match the field names
 *    exactly or as Go's `encoding/json` matches struct fields, regardless of letter case.
 *
 * Results are built with own properties only (`Map`s, or objects made with `ownRecord()`), so untrusted keys
 * never reach a prototype.
 */

// --- Values ---

/** A JSON object, with its members in document order (a repeated key appears once per occurrence). */
export class JsonObject {
  constructor(readonly members: readonly JsonMember[]) {}
}

export interface JsonMember {
  readonly key: string;
  readonly value: JsonValue;
}

/** A parsed JSON value. Arrays are JavaScript arrays; objects are `JsonObject`s. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** Where and why JSON text is not valid JSON. `line` and `column` count from 1; `column` counts UTF-16 units. */
interface JsonSyntaxError {
  readonly message: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export type JsonParseResult =
  { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly error: JsonSyntaxError };

/** The deepest nesting of arrays and objects `parseJSON()` accepts, as in Go's `encoding/json`. */
export const MAX_JSON_DEPTH = 10000;

// --- Parser ---

/** Thrown inside the parser only; `parseJSON()` turns it into its result. */
class SyntaxFailure extends Error {
  constructor(
    readonly reason: string,
    readonly offset: number,
  ) {
    super(reason);
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  skipWhitespace(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      // JSON whitespace: space, tab, line feed, carriage return.
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      this.pos++;
    }
  }

  fail(expected: string): never {
    const cp = this.text.codePointAt(this.pos);
    if (cp === undefined) throw new SyntaxFailure(`unexpected end of input; expected ${expected}`, this.pos);
    const ch = String.fromCodePoint(cp);
    throw new SyntaxFailure(`unexpected character ${JSON.stringify(ch)}; expected ${expected}`, this.pos);
  }

  /** Consume `ch` if it is next. */
  eat(ch: string): boolean {
    if (this.text[this.pos] !== ch) return false;
    this.pos++;
    return true;
  }

  expect(ch: string, expected: string): void {
    if (!this.eat(ch)) this.fail(expected);
  }

  string(): string {
    this.expect('"', 'a string');
    let out = '';
    let chunk = this.pos;
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (Number.isNaN(c)) this.fail('a closing quotation mark');
      if (c === 0x22) {
        out += this.text.slice(chunk, this.pos);
        this.pos++;
        return out;
      }
      if (c < 0x20) this.fail('an escaped control character');
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      out += this.text.slice(chunk, this.pos);
      this.pos++;
      out += this.escape();
      chunk = this.pos;
    }
  }

  /** The character an escape sequence stands for; `pos` is just past the backslash. */
  private escape(): string {
    const ch = this.text[this.pos] ?? '';
    const simple = SIMPLE_ESCAPES.get(ch);
    if (simple !== undefined) {
      this.pos++;
      return simple;
    }
    if (ch !== 'u') this.fail('an escape sequence');
    const hex = this.text.slice(this.pos + 1, this.pos + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      this.pos++;
      this.fail('four hexadecimal digits');
    }
    this.pos += 5;
    return String.fromCharCode(parseInt(hex, 16));
  }

  scalar(): JsonValue {
    const c = this.text[this.pos];
    if (c === '"') return this.string();
    for (const [word, value] of LITERALS) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length;
        return value;
      }
    }
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (match === null) this.fail('a JSON value');
    this.pos += match[0].length;
    return Number(match[0]);
  }
}

const LITERALS: readonly (readonly [string, JsonValue])[] = [
  ['true', true],
  ['false', false],
  ['null', null],
];

type Frame =
  | { readonly kind: 'array'; readonly items: JsonValue[] }
  | { readonly kind: 'object'; readonly members: JsonMember[]; key: string };

/** Parse one JSON value, iteratively: nesting depth is limited by `MAX_JSON_DEPTH`, not by the call stack. */
function parseValue(s: Scanner): JsonValue {
  const stack: Frame[] = [];
  // Called at each `[` or `{`, empty ones included, as Go counts the depth.
  const checkDepth = (): void => {
    if (stack.length >= MAX_JSON_DEPTH) {
      throw new SyntaxFailure(`exceeded the maximum nesting depth of ${MAX_JSON_DEPTH}`, s.pos - 1);
    }
  };
  const memberKey = (): string => {
    s.skipWhitespace();
    const key = s.string();
    s.skipWhitespace();
    s.expect(':', '":" after an object key');
    return key;
  };

  for (;;) {
    s.skipWhitespace();
    let value: JsonValue;
    if (s.eat('[')) {
      checkDepth();
      s.skipWhitespace();
      if (!s.eat(']')) {
        stack.push({ kind: 'array', items: [] });
        continue;
      }
      value = [];
    } else if (s.eat('{')) {
      checkDepth();
      s.skipWhitespace();
      if (!s.eat('}')) {
        if (s.text[s.pos] !== '"') s.fail('a string key or "}"');
        stack.push({ kind: 'object', members: [], key: memberKey() });
        continue;
      }
      value = new JsonObject([]);
    } else {
      value = s.scalar();
    }

    // Hand the value to the enclosing arrays and objects, closing each one that ends here.
    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined) return value;
      s.skipWhitespace();
      if (top.kind === 'array') {
        top.items.push(value);
        if (s.eat(',')) break;
        s.expect(']', '"," or "]" after an array element');
        stack.pop();
        value = top.items;
      } else {
        top.members.push({ key: top.key, value });
        if (s.eat(',')) {
          top.key = memberKey();
          break;
        }
        s.expect('}', '"," or "}" after an object member');
        stack.pop();
        value = new JsonObject(top.members);
      }
    }
  }
}

/** Line and column (both from 1) of a UTF-16 offset. */
function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Parse JSON text strictly (RFC 8259): one value, surrounded only by JSON whitespace. Accepts what
 * `JSON.parse` accepts and gives the same values, except that objects keep every member in order
 * (see `JsonObject`). An invalid text gives a `JsonSyntaxError` instead of throwing.
 */
export function parseJSON(text: string): JsonParseResult {
  const s = new Scanner(text);
  try {
    const value = parseValue(s);
    s.skipWhitespace();
    if (s.pos < text.length) s.fail('the end of input after the JSON value');
    return { ok: true, value };
  } catch (e) {
    if (!(e instanceof SyntaxFailure)) throw e;
    const { line, column } = lineAndColumn(text, e.offset);
    return {
      ok: false,
      error: { message: `${e.reason} at line ${line}, column ${column}`, offset: e.offset, line, column },
    };
  }
}

// --- Paths ---

/** Where a value sits in a document: object keys and array indices from the root. */
export type JsonPath = readonly (string | number)[];

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A path as text: `$` for the root, then `.key`, `["odd key"]` or `[index]` for each step. */
export function formatJsonPath(path: JsonPath): string {
  return path
    .map((step) =>
      typeof step === 'number' ? `[${step}]` : IDENTIFIER.test(step) ? `.${step}` : `[${JSON.stringify(step)}]`,
    )
    .reduce((text, step) => text + step, '$');
}

// --- Issues ---

export type DecodeIssueKind =
  /** A value of the wrong type; the value is not used. */
  | 'type'
  /** An object key that matches no field; the member is not used. */
  | 'unknown-key'
  /** A key that matches a field only when letter case is ignored; the member is used for that field. */
  | 'case-variant-key'
  /** A second member for the same field; the last one is used. */
  | 'duplicate-key';

export interface DecodeIssue {
  readonly kind: DecodeIssueKind;
  readonly path: JsonPath;
  /** What is wrong, as a sentence fragment that starts with the path (see `formatJsonPath`). */
  readonly message: string;
}

/** Describe a JSON value for an issue message: `a number (3)`, `an array`, `null`. */
export function describeJsonValue(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `a string (${JSON.stringify(value)})`;
  if (typeof value === 'number') return `a number (${String(value)})`;
  if (typeof value === 'boolean') return `a boolean (${String(value)})`;
  return value instanceof JsonObject ? 'an object' : 'an array';
}

// --- Decoders ---

type DecodeOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * Reads a `JsonValue` as a `T`. On a value it cannot use, it records at least one issue in `issues` and
 * returns `{ ok: false }`; it may also accept a value and still record issues about parts it left out.
 */
export type Decoder<T> = (value: JsonValue, path: JsonPath, issues: DecodeIssue[]) => DecodeOutcome<T>;

function rejected(value: JsonValue, path: JsonPath, issues: DecodeIssue[], expected: string): { ok: false } {
  issues.push({
    kind: 'type',
    path,
    message: `${formatJsonPath(path)} must be ${expected}, not ${describeJsonValue(value)}`,
  });
  return { ok: false };
}

export const jsonString: Decoder<string> = (value, path, issues) =>
  typeof value === 'string' ? { ok: true, value } : rejected(value, path, issues, 'a string');

/** A finite number. JSON can write a number too large for a double (`1e400`); that is rejected, as in Go. */
export const jsonNumber: Decoder<number> = (value, path, issues) =>
  typeof value === 'number' && Number.isFinite(value)
    ? { ok: true, value }
    : rejected(value, path, issues, 'a finite number');

export const jsonBoolean: Decoder<boolean> = (value, path, issues) =>
  typeof value === 'boolean' ? { ok: true, value } : rejected(value, path, issues, 'a boolean');

/** An array whose elements `element` reads. An element it rejects is left out (and its issue recorded). */
export function jsonArrayOf<T>(element: Decoder<T>): Decoder<readonly T[]> {
  return (value, path, issues) => {
    if (!Array.isArray(value)) return rejected(value, path, issues, 'an array');
    const items: readonly JsonValue[] = value;
    const out = items.flatMap((item, i) => {
      const r = element(item, [...path, i], issues);
      return r.ok ? [r.value] : [];
    });
    return { ok: true, value: out };
  };
}

/**
 * An object read as a map from each key to what `entry` reads from its value. A repeated key takes its
 * last value, as in `JSON.parse`; a value `entry` rejects is left out (and its issue recorded).
 */
export function jsonRecordOf<T>(entry: Decoder<T>): Decoder<ReadonlyMap<string, T>> {
  return (value, path, issues) => {
    if (!(value instanceof JsonObject)) return rejected(value, path, issues, 'an object');
    const out = new Map<string, T>();
    for (const { key, value: item } of value.members) {
      const r = entry(item, [...path, key], issues);
      if (r.ok) out.set(key, r.value);
      else out.delete(key);
    }
    return { ok: true, value: out };
  };
}

/**
 * `decoder`, with `null` read as `zero`, as Go's `encoding/json` reads `null` into a field of a non-pointer
 * type (it leaves the field's zero value).
 */
export function nullAsZero<T>(decoder: Decoder<T>, zero: T): Decoder<T> {
  return (value, path, issues) => (value === null ? { ok: true, value: zero } : decoder(value, path, issues));
}

// --- Objects with named fields ---

/** One named field of `readObject()`: reads a member's value and hands what it read to the caller. */
export interface FieldReader {
  read(value: JsonValue, path: JsonPath, issues: DecodeIssue[]): void;
}

/** A field read with `decoder`, whose value goes to `assign` (called again for each repeated member). */
export function field<T>(decoder: Decoder<T>, assign: (value: T) => void): FieldReader {
  return {
    read(value, path, issues) {
      const r = decoder(value, path, issues);
      if (r.ok) assign(r.value);
    },
  };
}

export interface ObjectSpec {
  /** The fields by name. Names must be ASCII. */
  readonly fields: Readonly<Record<string, FieldReader>>;
  /**
   * How member keys match field names:
   * - `exact`: only the exact name;
   * - `go`: as Go's `encoding/json` matches struct fields: an exact match, else a match regardless of
   *   letter case (see `goFoldKey`), which also records a `case-variant-key` issue.
   */
  readonly keys: 'exact' | 'go';
  /**
   * Called for each member whose key matches no field. Without it, such a member records an `unknown-key`
   * issue and is not used.
   */
  readonly unknown?: ((member: JsonMember, path: JsonPath, issues: DecodeIssue[]) => void) | undefined;
}

/**
 * Fold a key as Go's `encoding/json` folds object keys to match struct field names: ASCII letters to upper
 * case, and the non-ASCII letters whose simple case folding is an ASCII letter (`ſ` U+017F to S, `K` U+212A
 * KELVIN SIGN to K, `ı` U+0131 and `İ` U+0130 to I). Any other character is kept, which is exact for field
 * names that are ASCII, as every name here is.
 */
export function goFoldKey(key: string): string {
  let out = '';
  for (const ch of key) {
    out += GO_FOLD_TO_ASCII.get(ch) ?? (ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch);
  }
  return out;
}

const GO_FOLD_TO_ASCII: ReadonlyMap<string, string> = new Map([
  ['ſ', 'S'],
  ['K', 'K'],
  ['ı', 'I'],
  ['İ', 'I'],
]);

/**
 * The result of decoding JSON text: what was read (`T`) and the issues about what was left out or read
 * differently, or, when the text cannot be used at all, why.
 */
export type TextDecodeResult<T> =
  | (T & { readonly ok: true; readonly issues: readonly DecodeIssue[] })
  | { readonly ok: false; readonly reason: string };

/**
 * Parse `text` and read the object it holds with `readObject()`. Returns the issues, or `ok: false` with the
 * reason when the text is not JSON or not an object. The values read reach the caller through `spec`'s fields.
 */
export function readObjectText(text: string, spec: ObjectSpec): TextDecodeResult<object> {
  const parsed = parseJSON(text);
  if (!parsed.ok) return { ok: false, reason: parsed.error.message };
  const issues: DecodeIssue[] = [];
  if (!readObject(parsed.value, [], issues, spec)) return { ok: false, reason: 'expected a JSON object' };
  return { ok: true, issues };
}

/**
 * Read the members of an object into the fields of `spec`, in document order: a field named twice is read
 * twice, so the last member wins (as in Go and `JSON.parse`), and a `duplicate-key` issue is recorded.
 * Returns false, with a `type` issue, when `value` is not an object.
 */
export function readObject(value: JsonValue, path: JsonPath, issues: DecodeIssue[], spec: ObjectSpec): boolean {
  if (!(value instanceof JsonObject)) {
    rejected(value, path, issues, 'an object');
    return false;
  }
  const exact = new Map(Object.entries(spec.fields));
  const folded = new Map([...exact.keys()].map((name) => [goFoldKey(name), name]));
  const seen = new Set<string>();
  for (const member of value.members) {
    const at = [...path, member.key];
    const name = exact.has(member.key)
      ? member.key
      : spec.keys === 'go'
        ? folded.get(goFoldKey(member.key))
        : undefined;
    const reader = name === undefined ? undefined : exact.get(name);
    if (name === undefined || reader === undefined) {
      if (spec.unknown) spec.unknown(member, at, issues);
      else issues.push({ kind: 'unknown-key', path: at, message: `${formatJsonPath(at)} is not a known field` });
      continue;
    }
    if (name !== member.key) {
      issues.push({
        kind: 'case-variant-key',
        path: at,
        message: `${formatJsonPath(at)} is read as "${name}", since keys match regardless of letter case`,
      });
    }
    if (seen.has(name)) {
      issues.push({
        kind: 'duplicate-key',
        path: at,
        message: `${formatJsonPath(at)} repeats the field "${name}"; the last one is used`,
      });
    }
    seen.add(name);
    reader.read(member.value, at, issues);
  }
  return true;
}

// --- Own-property-safe records ---

/**
 * A plain object with `entries` as its own enumerable properties. Every key is defined as data, so a key such
 * as `__proto__` becomes an own property instead of changing the prototype.
 */
export function ownRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

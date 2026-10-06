/**
 * Story format file decoding: find the object passed to `window.storyFormat()` in a Twine 2
 * format.js and read its metadata, without evaluating anything.
 */
import type { FormatDecodeResult, Twine2FormatJSON } from './types.js';
import { parseRelaxedJSON } from './relaxed-json.js';
import { parseVersion } from './semver.js';

/** A `"setup": function` property, which Harlowe appends to its otherwise-JSON format object. */
const SETUP_FUNCTION_PROPERTY = /,\s*"setup"\s*:\s*function\b/g;

/** Drop a trailing `"setup": function(){…}` property from a format object, if it has one. */
function stripSetupFunction(chunk: string): string | undefined {
  let lastIndex = -1;
  for (const match of chunk.matchAll(SETUP_FUNCTION_PROPERTY)) lastIndex = match.index;
  return lastIndex === -1 ? undefined : chunk.slice(0, lastIndex) + '}';
}

/** Index after the whitespace and `//` or block comments starting at `i`. */
function skipTrivia(text: string, i: number): number {
  let pos = i;
  for (;;) {
    const ch = text[pos];
    if (ch !== undefined && /\s/.test(ch)) {
      pos++;
    } else if (text.startsWith('//', pos)) {
      const newline = text.indexOf('\n', pos);
      pos = newline === -1 ? text.length : newline + 1;
    } else if (text.startsWith('/*', pos)) {
      const close = text.indexOf('*/', pos + 2);
      pos = close === -1 ? text.length : close + 2;
    } else {
      return pos;
    }
  }
}

/** Index after the quoted string starting at `i` (a quote character); template literals nest `${…}`. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  let pos = i + 1;
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === '\\') {
      pos += 2;
    } else if (ch === quote) {
      return pos + 1;
    } else if (quote === '`' && ch === '$' && text[pos + 1] === '{') {
      const close = findClosingBrace(text, pos + 1);
      if (close === -1) return text.length;
      pos = close + 1;
    } else {
      pos++;
    }
  }
  return text.length;
}

function startsComment(text: string, pos: number): boolean {
  return text[pos] === '/' && (text[pos + 1] === '/' || text[pos + 1] === '*');
}

function startsString(text: string, pos: number): boolean {
  const ch = text[pos];
  return ch === '"' || ch === "'" || ch === '`';
}

/** Index of the `}` matching the `{` at `open`, skipping comments and strings; -1 when unbalanced. */
function findClosingBrace(text: string, open: number): number {
  let depth = 0;
  let pos = open;
  while (pos < text.length) {
    if (startsComment(text, pos)) {
      pos = skipTrivia(text, pos);
    } else if (startsString(text, pos)) {
      pos = skipString(text, pos);
    } else {
      if (text[pos] === '{') depth++;
      else if (text[pos] === '}' && --depth === 0) return pos;
      pos++;
    }
  }
  return -1;
}

const STORY_FORMAT = 'storyFormat';
const IDENTIFIER_CHAR = /[\w$]/;

/**
 * Locate the object literal passed to `storyFormat(` as `[start, end)` offsets, ignoring comments and
 * strings outside it and never evaluating anything. Without such a call, the first `{` outside comments
 * and strings starts the object. When its closing brace cannot be matched (a Harlowe setup function can
 * hold regular expression literals), the last `}` of the file ends it.
 */
function locateFormatObject(text: string): { readonly start: number; readonly end: number } | undefined {
  let start = -1;
  let firstBrace = -1;
  let pos = 0;
  while (pos < text.length && start === -1) {
    if (startsComment(text, pos)) {
      pos = skipTrivia(text, pos);
    } else if (startsString(text, pos)) {
      pos = skipString(text, pos);
    } else if (text[pos] === '{') {
      if (firstBrace === -1) firstBrace = pos;
      pos++;
    } else if (text.startsWith(STORY_FORMAT, pos) && !IDENTIFIER_CHAR.test(text[pos - 1] ?? '')) {
      const paren = skipTrivia(text, pos + STORY_FORMAT.length);
      const brace = text[paren] === '(' ? skipTrivia(text, paren + 1) : -1;
      if (text[brace] === '{') start = brace;
      pos += STORY_FORMAT.length;
    } else {
      pos++;
    }
  }
  if (start === -1) start = firstBrace;
  if (start === -1) return undefined;
  const close = findClosingBrace(text, start);
  const end = close === -1 ? text.lastIndexOf('}') : close;
  return end < start ? undefined : { start, end: end + 1 };
}

type ObjectParse = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/**
 * Parse the format object at `start`–`end` of `text`: strict JSON first (fast), then the
 * JavaScript literal subset formats use. Error positions point into `text`.
 */
function parseFormatObject(text: string, start: number, end: number): ObjectParse {
  try {
    return { ok: true, value: JSON.parse(text.slice(start, end)) };
  } catch {
    // Not strict JSON; the spec does not require it to be.
  }
  try {
    return { ok: true, value: parseRelaxedJSON(text, start, end) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The name given to a format.js that names no format. */
export const UNNAMED_FORMAT_NAME = 'Untitled Story Format';

/** Check a parsed format object's fields. Per spec, `name` is optional; `version` and `source` are required. */
function toFormatJSON(raw: unknown): FormatDecodeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'Story format JSON chunk is not an object.' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== 'string') return { ok: false, reason: 'Story format has no "version" string.' };
  if (typeof obj.source !== 'string') return { ok: false, reason: 'Story format has no "source" string.' };
  if (!parseVersion(obj.version)) {
    return { ok: false, reason: `Story format version ${JSON.stringify(obj.version)} is not a SemVer version.` };
  }
  const data: Twine2FormatJSON = {
    name: typeof obj.name === 'string' ? obj.name : UNNAMED_FORMAT_NAME,
    version: obj.version,
    source: obj.source,
    proofing: obj.proofing === true,
  };
  if (typeof obj.author === 'string') data.author = obj.author;
  if (typeof obj.description === 'string') data.description = obj.description;
  if (typeof obj.image === 'string') data.image = obj.image;
  if (typeof obj.url === 'string') data.url = obj.url;
  if (typeof obj.license === 'string') data.license = obj.license;
  return { ok: true, data };
}

/**
 * Read the metadata of a Twine 2 format.js, or say why it cannot be used.
 *
 * The object passed to `window.storyFormat()` may be strict JSON or a JavaScript object literal
 * (single quotes, unquoted keys, trailing commas, comments). String values come back exactly as
 * JavaScript evaluation gives them. Harlowe's function-valued `setup` property is dropped; the
 * workaround keys on the property itself, so the same bytes parse whether they come from a
 * `harlowe-3` directory or a direct download.
 */
export function decodeFormatJSON(source: string): FormatDecodeResult {
  const located = locateFormatObject(source);
  if (located === undefined) {
    return { ok: false, reason: 'Could not find Twine 2 style story format JSON chunk.' };
  }

  const parsed = parseFormatObject(source, located.start, located.end);
  if (parsed.ok) return toFormatJSON(parsed.value);

  // Harlowe workaround: strip the "setup" function property.
  const stripped = stripSetupFunction(source.slice(located.start, located.end));
  const retried = stripped === undefined ? undefined : parseFormatObject(stripped, 0, stripped.length);
  if (retried?.ok) return toFormatJSON(retried.value);
  return { ok: false, reason: `Could not decode story format JSON chunk: ${parsed.error}` };
}

/**
 * Parse the Twine 2 format.js JSON chunk; null when it cannot be used ({@link decodeFormatJSON}
 * gives the reason).
 *
 * @param _formatId No longer used; kept so existing callers keep compiling.
 */
export function parseFormatJSON(source: string, _formatId?: string): Twine2FormatJSON | null {
  const result = decodeFormatJSON(source);
  return result.ok ? result.data : null;
}

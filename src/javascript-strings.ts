/**
 * Reads the strings in JavaScript source, as the link check needs them: SugarCube evaluates
 * quoted macro arguments as strict-mode JavaScript, and stories build macro calls in the strings
 * of their scripts (`$.wiki('<<goto "Room">>')`).
 */

/**
 * Stands in for each `${…}` substitution in a template literal's value: a Unicode noncharacter,
 * which text doesn't contain. A passage name that includes it is known only in play.
 */
export const SUBSTITUTION = '\ufdd0';

const SINGLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
]);
const HEX_RE = /^[0-9A-Fa-f]+$/;
const DIGIT_RE = /^[0-9]$/;
const LINE_TERMINATORS = '\n\r\u2028\u2029';

/**
 * The value of a quoted JavaScript string literal (quotes included), as strict-mode JavaScript
 * evaluates it: `\"`, `\'`, `\\`, `\n`, `\xHH`, `\uHHHH`, `\u{H…}`, line continuations, and a
 * backslash before any other character gives that character. Returns `undefined` for what
 * strict mode rejects, such as `\1` or a raw carriage return.
 */
export function evalStringLiteral(literal: string): string | undefined {
  const quote = literal[0];
  const last = literal.length - 1;
  if ((quote !== '"' && quote !== "'") || last < 1 || literal[last] !== quote) {
    return undefined;
  }
  return cookEscapes(literal.slice(1, last), quote);
}

/**
 * Decodes the body of a string literal, given its quote, or a piece of a template literal
 * (`quote` undefined), as strict-mode JavaScript does. A string may not hold its own quote or a
 * raw line feed or carriage return; a template piece may, and turns `\r\n` and `\r` into `\n`.
 */
function cookEscapes(body: string, quote: string | undefined): string | undefined {
  let value = '';
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch !== '\\') {
      if (quote !== undefined && (ch === quote || ch === '\n' || ch === '\r')) {
        return undefined;
      }
      if (ch === '\r') {
        value += '\n';
        i += body.charAt(i + 1) === '\n' ? 2 : 1;
      } else {
        value += ch;
        i += 1;
      }
      continue;
    }
    if (i + 1 >= body.length) {
      // In a string, the backslash would escape the closing quote.
      return undefined;
    }
    const escaped = body.charAt(i + 1);
    i += 2;
    const single = SINGLE_ESCAPES.get(escaped);
    if (single !== undefined) {
      value += single;
      continue;
    }
    switch (escaped) {
      case '0':
        if (DIGIT_RE.test(body.charAt(i))) {
          return undefined;
        }
        value += '\0';
        break;
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        return undefined;
      case 'x': {
        const hex = body.slice(i, i + 2);
        if (hex.length !== 2 || !HEX_RE.test(hex)) {
          return undefined;
        }
        value += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case 'u': {
        const unicode = readUnicodeEscape(body, i);
        if (unicode === undefined) {
          return undefined;
        }
        value += unicode.char;
        i = unicode.end;
        break;
      }
      case '\r':
        // A line continuation; `\r\n` counts as one line break.
        if (body[i] === '\n') {
          i += 1;
        }
        break;
      case '\n':
      case '\u2028':
      case '\u2029':
        break;
      default:
        value += escaped;
    }
  }
  return value;
}

/** Reads the part of `\uHHHH` or `\u{H…}` after the `u`. */
function readUnicodeEscape(body: string, from: number): { char: string; end: number } | undefined {
  if (body[from] === '{') {
    const close = body.indexOf('}', from + 1);
    if (close === -1) {
      return undefined;
    }
    const hex = body.slice(from + 1, close);
    if (!HEX_RE.test(hex)) {
      return undefined;
    }
    const codePoint = parseInt(hex, 16);
    return codePoint > 0x10ffff ? undefined : { char: String.fromCodePoint(codePoint), end: close + 1 };
  }
  const hex = body.slice(from, from + 4);
  if (hex.length !== 4 || !HEX_RE.test(hex)) {
    return undefined;
  }
  return { char: String.fromCharCode(parseInt(hex, 16)), end: from + 4 };
}

// Words after which a `/` starts a regular expression rather than a division.
const REGEX_KEYWORDS: ReadonlySet<string> = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);
const WORD_RE = /[$\p{ID_Continue}\u200c\u200d]+/uy;
const WHITESPACE_RE = /\s/;
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/g;

/** A template literal being read: its value so far, and where its current piece starts. */
interface TemplateFrame {
  readonly kind: 'template';
  readonly value: string;
  readonly pieceStart: number;
  /** False once a piece holds an escape that strict mode rejects. */
  readonly valid: boolean;
}

/** Code: the whole source, or a template's `${…}` substitution, with its open `{` count. */
interface CodeFrame {
  readonly kind: 'code';
  readonly braces: number;
}

type Frame = TemplateFrame | CodeFrame;

/**
 * The values of the string and template literals in JavaScript source. A template literal's
 * value keeps its text and has `SUBSTITUTION` where each `${…}` was; the strings inside a
 * substitution are values of their own. Comments and regular expression literals are skipped;
 * whether a `/` starts a regular expression is judged from the token before it. Malformed
 * source is read on as far as it can be.
 */
export function javaScriptStrings(source: string): string[] {
  const strings: string[] = [];
  // The bottom frame is the source itself, which is never closed.
  const frames: Frame[] = [{ kind: 'code', braces: 0 }];
  let regexAllowed = true;
  let afterDot = false;
  // Where a string of each quote, or a regular expression, is known not to close.
  const failedUntil = new Map<string, number>();
  let i = 0;
  while (i < source.length) {
    const frame = frames[frames.length - 1];
    if (frame === undefined) {
      // The bottom frame is never popped.
      break;
    }
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);

    if (frame.kind === 'template') {
      if (ch === '`' || (ch === '$' && next === '{')) {
        const piece = cookEscapes(source.slice(frame.pieceStart, i), undefined);
        const value = frame.value + (piece ?? '');
        const valid = frame.valid && piece !== undefined;
        frames.pop();
        if (ch === '`') {
          if (valid) {
            strings.push(value);
          }
          i += 1;
          regexAllowed = false;
          afterDot = false;
        } else {
          frames.push({ kind: 'template', value: value + SUBSTITUTION, pieceStart: -1, valid });
          frames.push({ kind: 'code', braces: 0 });
          i += 2;
          regexAllowed = true;
          afterDot = false;
        }
      } else {
        i += ch === '\\' ? 2 : 1;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      const lineEnd = searchFrom(LINE_TERMINATOR_RE, source, i + 2);
      i = lineEnd === -1 ? source.length : lineEnd;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (ch === '/' && regexAllowed && i >= (failedUntil.get('/') ?? 0)) {
      const end = endOfRegularExpression(source, i);
      if (end.end !== undefined) {
        i = end.end;
        regexAllowed = false;
        afterDot = false;
        continue;
      }
      failedUntil.set('/', end.stop);
    }
    if ((ch === '"' || ch === "'") && i >= (failedUntil.get(ch) ?? 0)) {
      const end = endOfJavaScriptString(source, i);
      if (end.end !== undefined) {
        const value = evalStringLiteral(source.slice(i, end.end));
        if (value !== undefined) {
          strings.push(value);
        }
        i = end.end;
        regexAllowed = false;
        afterDot = false;
        continue;
      }
      failedUntil.set(ch, end.stop);
    }
    if (ch === '`') {
      frames.push({ kind: 'template', value: '', pieceStart: i + 1, valid: true });
      i += 1;
      continue;
    }
    const word = wordAt(source, i);
    if (word !== null) {
      // A keyword after a `.` is a property name, which a `/` divides.
      regexAllowed = !afterDot && REGEX_KEYWORDS.has(word[0]);
      afterDot = false;
      i += word[0].length;
      continue;
    }
    if ((ch === '+' || ch === '-') && next === ch) {
      // After `x++` or `x--`, a `/` divides.
      regexAllowed = false;
      afterDot = false;
      i += 2;
      continue;
    }
    if (frames.length > 1 && (ch === '{' || ch === '}')) {
      if (ch === '{') {
        frames[frames.length - 1] = { kind: 'code', braces: frame.braces + 1 };
      } else if (frame.braces > 0) {
        frames[frames.length - 1] = { kind: 'code', braces: frame.braces - 1 };
      } else {
        // The `}` that closes a substitution: the template goes on after it.
        frames.pop();
        const template = frames.pop();
        if (template?.kind === 'template') {
          frames.push({ ...template, pieceStart: i + 1 });
        }
        i += 1;
        continue;
      }
    }
    if (!WHITESPACE_RE.test(ch)) {
      // After a closing bracket, as after a name or a number, a `/` divides.
      regexAllowed = !')]}'.includes(ch);
      afterDot = ch === '.';
    }
    i += 1;
  }
  return strings;
}

/** The name, keyword or number that starts at `pos`, if one does. */
function wordAt(source: string, pos: number): RegExpExecArray | null {
  const code = source.charCodeAt(pos);
  const ascii = code < 0x80;
  // Only ASCII letters, digits, `_` and `$` start a word below U+0080.
  if (
    ascii &&
    !(
      (code >= 0x30 && code <= 0x39) ||
      ((code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a) ||
      code === 0x5f ||
      code === 0x24
    )
  ) {
    return null;
  }
  WORD_RE.lastIndex = pos;
  return WORD_RE.exec(source);
}

/** Index of the first match of a global `re` at or after `from`, or -1. */
function searchFrom(re: RegExp, text: string, from: number): number {
  re.lastIndex = from;
  const m = re.exec(text);
  return m === null ? -1 : m.index;
}

/**
 * Where a string literal that opens at `pos` ends, or, if it doesn't close on its line, where
 * the scan stopped. A string with the same quote that starts before that stop, inside this one,
 * doesn't close either.
 */
function endOfJavaScriptString(source: string, pos: number): { end: number | undefined; stop: number } {
  const quote = source.charAt(pos);
  let i = pos + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === quote) {
      return { end: i + 1, stop: i };
    }
    if (ch === '\n' || ch === '\r') {
      return { end: undefined, stop: i };
    }
    if (ch === '\\') {
      // A backslash before a line break continues the string; `\r\n` is one line break.
      i += source.startsWith('\r\n', i + 1) ? 3 : 2;
    } else {
      i += 1;
    }
  }
  return { end: undefined, stop: source.length };
}

/**
 * Where a regular expression literal that opens at `pos` ends, flags included, or, if none
 * closes on the line, where the line ends. A `/` before that is then read as a division.
 */
function endOfRegularExpression(source: string, pos: number): { end: number | undefined; stop: number } {
  let inClass = false;
  let i = pos + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (LINE_TERMINATORS.includes(ch)) {
      return { end: undefined, stop: i };
    }
    if (ch === '\\') {
      const escaped = source.charAt(i + 1);
      if (escaped === '' || LINE_TERMINATORS.includes(escaped)) {
        return { end: undefined, stop: i + 1 };
      }
      i += 2;
      continue;
    }
    if (ch === '[') {
      inClass = true;
    } else if (ch === ']') {
      inClass = false;
    } else if (ch === '/' && !inClass) {
      WORD_RE.lastIndex = i + 1;
      const flags = WORD_RE.exec(source);
      return { end: i + 1 + (flags === null ? 0 : flags[0].length), stop: i };
    }
    i += 1;
  }
  return { end: undefined, stop: source.length };
}

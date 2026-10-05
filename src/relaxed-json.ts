/**
 * A parser for the object literal a Twine 2 `format.js` passes to `window.storyFormat()`.
 *
 * The story formats spec does not require that object to be strict JSON, and Twine 2 runs
 * `format.js` as JavaScript. This parser accepts JSON plus the JavaScript literal syntax formats
 * use in practice: single-quoted strings, unquoted (identifier) and numeric keys, trailing commas,
 * comments, JavaScript string escapes, and hexadecimal, octal and binary numbers.
 *
 * It reads string literals token by token, so their contents come back exactly as JavaScript
 * evaluation gives them: text that only looks like structure (`a, }`, `word:`, an apostrophe) is
 * never touched. Anything outside that subset, such as a function or a variable, is a syntax error.
 */

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const NUMBER = /[+-]?(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
const IDENTIFIER_PART = /[\w$]/;
const WHITESPACE = /[\s﻿]/;
const HEX = /^[0-9a-fA-F]+$/;

/** Simple single-character escapes and the characters they stand for. */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

/**
 * Parse a JavaScript object, array or primitive literal: all of `text`, or the part from `start` to
 * `end`. Error positions count from the start of `text`, so they point into the file it came from.
 *
 * @throws SyntaxError naming the line and column of the first thing it cannot parse.
 */
export function parseRelaxedJSON(text: string, start = 0, end = text.length): unknown {
  let pos = start;

  function fail(message: string, at = pos): never {
    const before = text.slice(0, at);
    const line = before.split('\n').length;
    const column = at - before.lastIndexOf('\n');
    throw new SyntaxError(`${message} at line ${line}, column ${column}`);
  }

  /** The character at `pos`, or '' at the end of the input. */
  const peek = (): string => (pos < end ? (text[pos] ?? '') : '');

  const describeChar = (at: number): string => (at >= end ? 'end of input' : JSON.stringify(text[at]));

  /** Skip whitespace and comments. */
  const skipTrivia = (): void => {
    while (pos < end) {
      const ch = peek();
      if (WHITESPACE.test(ch)) {
        pos++;
      } else if (text.startsWith('//', pos)) {
        const lineEnd = text.slice(pos, end).search(/[\n\r\u2028\u2029]/);
        pos = lineEnd === -1 ? end : pos + lineEnd;
      } else if (text.startsWith('/*', pos)) {
        const commentEnd = text.indexOf('*/', pos + 2);
        if (commentEnd === -1 || commentEnd + 2 > end) fail('Unterminated comment');
        pos = commentEnd + 2;
      } else {
        return;
      }
    }
  };

  const consume = (ch: string): void => {
    skipTrivia();
    if (peek() !== ch) fail(`Expected ${JSON.stringify(ch)} but found ${describeChar(pos)}`);
    pos++;
  };

  /** Read exactly `count` hex digits and return their value. */
  const readHex = (count: number): number => {
    const digits = text.slice(pos, Math.min(pos + count, end));
    if (digits.length !== count || !HEX.test(digits)) fail('Invalid hexadecimal escape sequence');
    pos += count;
    return parseInt(digits, 16);
  };

  /** Decode the escape sequence after a backslash; `pos` is just past the backslash. */
  const readEscape = (): string => {
    const ch = peek();
    const simple = SIMPLE_ESCAPES[ch];
    if (simple !== undefined) {
      pos++;
      return simple;
    }
    switch (ch) {
      case '':
        return fail('Unterminated string');
      case 'x':
        pos++;
        return String.fromCharCode(readHex(2));
      case 'u': {
        pos++;
        if (peek() !== '{') return String.fromCharCode(readHex(4));
        const close = text.indexOf('}', pos);
        if (close === -1 || close >= end) fail('Invalid Unicode escape sequence');
        pos++;
        const codePoint = readHex(close - pos);
        if (codePoint > 0x10ffff) fail('Undefined Unicode code-point');
        pos = close + 1;
        return String.fromCodePoint(codePoint);
      }
      case '\r':
        // A line continuation: the escaped line break is dropped.
        pos += text[pos + 1] === '\n' ? 2 : 1;
        return '';
      case '\n':
      case '\u2028':
      case '\u2029':
        pos++;
        return '';
      case '0':
        if (/[0-9]/.test(text[pos + 1] ?? '')) fail('Octal escape sequences are not supported');
        pos++;
        return '\0';
      default:
        if (/[1-9]/.test(ch)) fail('Octal escape sequences are not supported');
        // Any other escaped character stands for itself (\' \" \\ \/ …).
        pos++;
        return ch;
    }
  };

  const readString = (): string => {
    const quote = peek();
    pos++;
    let out = '';
    let chunkStart = pos;
    for (;;) {
      if (pos >= end) fail('Unterminated string');
      const ch = peek();
      if (ch === quote) {
        out += text.slice(chunkStart, pos);
        pos++;
        return out;
      }
      if (ch === '\n' || ch === '\r') fail('Unterminated string');
      if (ch === '\\') {
        out += text.slice(chunkStart, pos);
        pos++;
        out += readEscape();
        chunkStart = pos;
      } else {
        pos++;
      }
    }
  };

  /** Read a match of a sticky regular expression at `pos`, or return undefined. */
  const readToken = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = pos;
    const m = pattern.exec(text);
    if (!m || pattern.lastIndex > end) return undefined;
    pos = pattern.lastIndex;
    return m[0];
  };

  const readNumber = (): number | undefined => {
    const tokenStart = pos;
    const token = readToken(NUMBER);
    if (token === undefined) return undefined;
    if (IDENTIFIER_PART.test(peek())) fail('Invalid number', tokenStart);
    const sign = token.startsWith('-') ? -1 : 1;
    return sign * Number(/^[+-]/.test(token) ? token.slice(1) : token);
  };

  const readKey = (): string => {
    skipTrivia();
    const ch = peek();
    if (ch === '"' || ch === "'") return readString();
    const identifier = readToken(IDENTIFIER);
    if (identifier !== undefined) return identifier;
    const number = readNumber();
    if (number !== undefined) return String(number);
    return fail(`Expected a property name but found ${describeChar(pos)}`);
  };

  const readObject = (): Record<string, unknown> => {
    pos++; // {
    // Properties are defined, not assigned, so a "__proto__" key stays an ordinary property.
    const out: Record<string, unknown> = {};
    for (;;) {
      skipTrivia();
      if (peek() === '}') {
        pos++;
        return out;
      }
      const key = readKey();
      consume(':');
      Object.defineProperty(out, key, { value: readValue(), enumerable: true, writable: true, configurable: true });
      skipTrivia();
      if (peek() === ',') pos++;
      else if (peek() !== '}') fail(`Expected "," or "}" but found ${describeChar(pos)}`);
    }
  };

  const readArray = (): unknown[] => {
    pos++; // [
    const out: unknown[] = [];
    for (;;) {
      skipTrivia();
      if (peek() === ']') {
        pos++;
        return out;
      }
      out.push(readValue());
      skipTrivia();
      if (peek() === ',') pos++;
      else if (peek() !== ']') fail(`Expected "," or "]" but found ${describeChar(pos)}`);
    }
  };

  function readValue(): unknown {
    skipTrivia();
    const ch = peek();
    if (ch === '{') return readObject();
    if (ch === '[') return readArray();
    if (ch === '"' || ch === "'") return readString();
    const tokenStart = pos;
    const identifier = readToken(IDENTIFIER);
    if (identifier !== undefined) {
      if (identifier === 'true') return true;
      if (identifier === 'false') return false;
      if (identifier === 'null') return null;
      return fail(`Unexpected identifier ${JSON.stringify(identifier)}`, tokenStart);
    }
    const number = readNumber();
    if (number !== undefined) return number;
    return fail(`Unexpected ${describeChar(pos)}`);
  }

  const value = readValue();
  skipTrivia();
  if (pos < end) fail(`Unexpected ${describeChar(pos)} after the value`);
  return value;
}

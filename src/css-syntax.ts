/** Shared CSS Syntax Level 3 tokenizer (section 4), used for import rules and insertion contexts. */
export type CssTokenType =
  | 'eof'
  | 'comment'
  | 'ws'
  | 'ident'
  | 'function'
  | 'atkeyword'
  | 'hash'
  | 'string'
  | 'badstring'
  | 'url'
  | 'badurl'
  | 'delim'
  | 'number'
  | 'percentage'
  | 'dimension'
  | 'cdo'
  | 'cdc'
  | 'colon'
  | 'semicolon'
  | 'comma'
  | 'lbracket'
  | 'rbracket'
  | 'lparen'
  | 'rparen'
  | 'lbrace'
  | 'rbrace';

/**
 * A token: its type, half-open source range, and value: a name lower-cased (and cut at MAX_NAME, which no name
 * the rules compare it with reaches), a delimiter's character, `id` for a hash that is an ID.
 */
export interface CssToken {
  readonly type: CssTokenType;
  readonly end: number;
  readonly start: number;
  readonly value: string;
}

const EOF: CssToken = { type: 'eof', start: -1, end: -1, value: '' };

/** The longest name kept: longer than any at-rule name, function name or keyword the rules compare it with. */
const MAX_NAME = 64;

/** The characters a character class admits; the empty string (the end of the input) is in none. */
const isOneOf = (ch: string, set: string): boolean => ch !== '' && set.includes(ch);
const isWhitespace = (ch: string): boolean => isOneOf(ch, ' \t\n\r\f');
const isNewline = (ch: string): boolean => isOneOf(ch, '\n\r\f');
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isHexDigit = (ch: string): boolean => isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
const isNameStart = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch >= '\u0080';
const isNameChar = (ch: string): boolean => isNameStart(ch) || isDigit(ch) || ch === '-';
/** A code point a url token may not hold unescaped: controls other than tab, line feed, form feed and CR. */
const isNonPrintable = (ch: string): boolean =>
  ch !== '' && (ch <= '\b' || ch === '\v' || ch === '\x7f' || (ch >= '\x0e' && ch <= '\x1f'));

/** Whether a backslash at `i` and the code point after it are a valid escape (the end of the input is one). */
const validEscape = (css: string, i: number): boolean => css.charAt(i) === '\\' && !isNewline(css.charAt(i + 1));

/** Whether an identifier starts at `i`. */
function wouldStartIdent(css: string, i: number): boolean {
  const ch = css.charAt(i);
  if (ch === '-') {
    const next = css.charAt(i + 1);
    return isNameStart(next) || next === '-' || validEscape(css, i + 1);
  }
  return isNameStart(ch) || validEscape(css, i);
}

/** Whether a number starts at `i`. */
function wouldStartNumber(css: string, i: number): boolean {
  const ch = css.charAt(i);
  if (ch === '+' || ch === '-') {
    return isDigit(css.charAt(i + 1)) || (css.charAt(i + 1) === '.' && isDigit(css.charAt(i + 2)));
  }
  if (ch === '.') return isDigit(css.charAt(i + 1));
  return isDigit(ch);
}

/** The character a hex escape spells; a number that is no character reads as U+FFFD. */
function codePointName(code: number): string {
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
}

/** The escape after the backslash that ends at `i`: the character it spells and where it ends. */
function consumeEscape(css: string, i: number): { readonly text: string; readonly end: number } {
  const ch = css.charAt(i);
  if (ch === '') return { text: '�', end: i };
  if (!isHexDigit(ch)) return { text: ch, end: i + 1 };
  let end = i;
  while (end - i < 6 && isHexDigit(css.charAt(end))) end += 1;
  const code = Number.parseInt(css.slice(i, end), 16);
  // One whitespace character after a hex escape belongs to it; a CR LF pair counts as one.
  if (css.startsWith('\r\n', end)) end += 2;
  else if (isWhitespace(css.charAt(end))) end += 1;
  return { text: codePointName(code), end };
}

/** An identifier sequence that starts at `i`: its value with the escapes decoded (cut at MAX_NAME), and where it ends. */
function consumeIdentSequence(css: string, i: number): { readonly value: string; readonly end: number } {
  let value = '';
  let end = i;
  for (;;) {
    const ch = css.charAt(end);
    if (isNameChar(ch)) {
      if (value.length < MAX_NAME) value += ch;
      end += 1;
    } else if (validEscape(css, end)) {
      const escape = consumeEscape(css, end + 1);
      if (value.length < MAX_NAME) value += escape.text;
      end = escape.end;
    } else {
      return { value, end };
    }
  }
}

/** Where the number that starts at `i` ends. */
function consumeNumber(css: string, i: number): number {
  let end = i;
  if (css.charAt(end) === '+' || css.charAt(end) === '-') end += 1;
  while (isDigit(css.charAt(end))) end += 1;
  if (css.charAt(end) === '.' && isDigit(css.charAt(end + 1))) {
    end += 1;
    while (isDigit(css.charAt(end))) end += 1;
  }
  if (css.charAt(end) === 'e' || css.charAt(end) === 'E') {
    const sign = css.charAt(end + 1) === '+' || css.charAt(end + 1) === '-' ? 1 : 0;
    if (isDigit(css.charAt(end + 1 + sign))) {
      end += 1 + sign;
      while (isDigit(css.charAt(end))) end += 1;
    }
  }
  return end;
}

/** The string that opens at `i`: a string token, or a bad string (ended by a newline), and where it ends. */
function consumeString(css: string, i: number): { readonly type: 'string' | 'badstring'; readonly end: number } {
  const quote = css.charAt(i);
  let end = i + 1;
  for (;;) {
    const ch = css.charAt(end);
    if (ch === quote) return { type: 'string', end: end + 1 };
    if (ch === '') return { type: 'string', end };
    if (isNewline(ch)) return { type: 'badstring', end };
    if (ch !== '\\') {
      end += 1;
    } else if (css.charAt(end + 1) === '') {
      end += 1;
    } else if (isNewline(css.charAt(end + 1))) {
      // A backslash and a newline continue the string; a CR LF pair is one newline.
      end += css.startsWith('\r\n', end + 1) ? 3 : 2;
    } else {
      end = consumeEscape(css, end + 1).end;
    }
  }
}

/** Where the rest of a bad url ends: after the `)` that closes it, or at the end of the input. */
function consumeBadUrlRemnants(css: string, i: number): number {
  let end = i;
  for (;;) {
    const ch = css.charAt(end);
    if (ch === ')') return end + 1;
    if (ch === '') return end;
    end = validEscape(css, end) ? consumeEscape(css, end + 1).end : end + 1;
  }
}

/** The url token whose contents start at `i` (after `url(`): a url, or a bad url, and where it ends. */
function consumeUrl(css: string, i: number): { readonly type: 'url' | 'badurl'; readonly end: number } {
  let end = i;
  while (isWhitespace(css.charAt(end))) end += 1;
  for (;;) {
    const ch = css.charAt(end);
    if (ch === ')') return { type: 'url', end: end + 1 };
    if (ch === '') return { type: 'url', end };
    if (isWhitespace(ch)) {
      while (isWhitespace(css.charAt(end))) end += 1;
      const next = css.charAt(end);
      if (next === ')') return { type: 'url', end: end + 1 };
      if (next === '') return { type: 'url', end };
      return { type: 'badurl', end: consumeBadUrlRemnants(css, end) };
    }
    if (ch === '"' || ch === "'" || ch === '(' || isNonPrintable(ch)) {
      return { type: 'badurl', end: consumeBadUrlRemnants(css, end) };
    }
    if (ch !== '\\') {
      end += 1;
    } else if (validEscape(css, end)) {
      end = consumeEscape(css, end + 1).end;
    } else {
      return { type: 'badurl', end: consumeBadUrlRemnants(css, end) };
    }
  }
}

/** The identifier, function, url or bad url that starts at `i` (an identifier sequence starts there). */
function consumeIdentLike(css: string, i: number): { readonly token: CssToken; readonly end: number } {
  const { value, end } = consumeIdentSequence(css, i);
  const name = value.toLowerCase();
  if (css.charAt(end) !== '(') return { token: { type: 'ident', start: i, end, value: name }, end };
  if (name !== 'url') return { token: { type: 'function', start: i, end: end + 1, value: name }, end: end + 1 };
  // `url(` followed by a quote (after any whitespace) is a function whose argument is a string; else a url token.
  let after = end + 1;
  while (isWhitespace(css.charAt(after)) && isWhitespace(css.charAt(after + 1))) after += 1;
  const quoted = css.charAt(after);
  if (quoted === '"' || quoted === "'" || (isWhitespace(quoted) && ['"', "'"].includes(css.charAt(after + 1)))) {
    return { token: { type: 'function', start: i, end: end + 1, value: name }, end: end + 1 };
  }
  const url = consumeUrl(css, end + 1);
  return { token: { type: url.type, start: i, end: url.end, value: '' }, end: url.end };
}

const PUNCTUATION: ReadonlyMap<string, CssTokenType> = new Map([
  ['(', 'lparen'],
  [')', 'rparen'],
  [',', 'comma'],
  [':', 'colon'],
  [';', 'semicolon'],
  ['[', 'lbracket'],
  [']', 'rbracket'],
  ['{', 'lbrace'],
  ['}', 'rbrace'],
]);

/**
 * The tokens of `css` (CSS Syntax Level 3, section 4), one for each call, comments left out unless `includeComments`.
 * The end of the input is the `eof` token, over and over.
 */
export function createCssTokenizer(css: string, includeComments = false): () => CssToken {
  let i = 0;
  const emit = (type: CssTokenType, start: number, end: number, value = ''): CssToken => {
    i = end;
    return { type, start, end, value };
  };
  return (): CssToken => {
    for (;;) {
      if (i >= css.length) return EOF;
      const ch = css.charAt(i);
      const next = css.charAt(i + 1);
      const punctuation = PUNCTUATION.get(ch);
      if (ch === '/' && next === '*') {
        const close = css.indexOf('*/', i + 2);
        const end = close === -1 ? css.length : close + 2;
        if (includeComments) return emit('comment', i, end);
        i = end;
      } else if (isWhitespace(ch)) {
        let end = i + 1;
        while (isWhitespace(css.charAt(end))) end += 1;
        return emit('ws', i, end);
      } else if (ch === '"' || ch === "'") {
        const string = consumeString(css, i);
        return emit(string.type, i, string.end);
      } else if (ch === '#' && (isNameChar(next) || validEscape(css, i + 1))) {
        // A hash is an ID when an identifier starts after it; otherwise it can not be an ID selector.
        return emit('hash', i, consumeIdentSequence(css, i + 1).end, wouldStartIdent(css, i + 1) ? 'id' : '');
      } else if (punctuation !== undefined) {
        return emit(punctuation, i, i + 1);
      } else if (wouldStartNumber(css, i)) {
        const numberEnd = consumeNumber(css, i);
        if (wouldStartIdent(css, numberEnd)) return emit('dimension', i, consumeIdentSequence(css, numberEnd).end);
        if (css.charAt(numberEnd) === '%') return emit('percentage', i, numberEnd + 1);
        return emit('number', i, numberEnd);
      } else if (css.startsWith('<!--', i)) {
        return emit('cdo', i, i + 4);
      } else if (css.startsWith('-->', i)) {
        return emit('cdc', i, i + 3);
      } else if (ch === '@' && wouldStartIdent(css, i + 1)) {
        const name = consumeIdentSequence(css, i + 1);
        return emit('atkeyword', i, name.end, name.value.toLowerCase());
      } else if (wouldStartIdent(css, i)) {
        const identLike = consumeIdentLike(css, i);
        i = identLike.end;
        return identLike.token;
      } else {
        return emit('delim', i, i + 1, ch);
      }
    }
  };
}

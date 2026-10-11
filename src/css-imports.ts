/**
 * Which `@import` rules of the story stylesheet a browser ignores. CSS Cascade accepts an `@import` only before every
 * other valid at-rule and style rule, ignoring `@layer` statements; an `@import` anywhere else is invalid and dropped,
 * and the stylesheet is not told. The story's stylesheet passages and `.css` files are joined into one stylesheet, so
 * an import that opens a later source comes after the rules of the earlier ones, and a construct a source leaves open
 * (an unclosed comment, block or `url(`, a missing `;`) swallows the start of the next. Tweego joins them the same
 * way, so twee-ts keeps the text and reports the import instead.
 *
 * The joined stylesheet, exactly as the output joins it, is read as CSS Syntax Level 3 reads it: section 4 turns it
 * into tokens (comments, strings, escapes, `url()` and the rest) and section 5.4.1 consumes the list of rules. A rule
 * ends the place for imports when a browser would keep it:
 *
 * - a style rule with a block and a prelude that can be a selector (one holding a `;`, a stray `)`, `]` or `}`, an
 *   at-keyword, a string, a url or a number, or no prelude, or no block, is dropped and ends nothing);
 * - `@namespace` with a name and a url, `@layer` with a block (and at most one name) and every at-rule some browser
 *   supports, with its block (the list is KNOWN_AT_RULES);
 * - an `@layer` statement after an `@import`, which browsers take for the end of the imports though the specification
 *   ignores it; layer statements belong before the first import.
 *
 * An at-rule no browser knows, `@charset` wherever it stands (CSS Syntax treats it as an unknown at-rule; the
 * encoding is read from the bytes), `@import` without a url or string, and `@layer` or `@namespace` that is not
 * valid are dropped and end nothing. A selector this does not check (that `a !` is not one) counts as a rule.
 *
 * Each `@import` the sources write at their own top level, read on its own, that the joined stylesheet does not keep
 * as an import rule is reported with its source.
 */
import type { Diagnostic } from './types.js';

/** A stylesheet source of the story, with the name its diagnostics call it by. */
export interface StylesheetSource {
  readonly label: string;
  readonly text: string;
}

/** The stylesheet an output writes: the sources joined, and where each source's text starts in it. */
export interface JoinedStylesheet {
  readonly text: string;
  readonly parts: readonly { readonly start: number }[];
}

/** The sources joined with a line feed between them, as JSON output joins its `style`. */
export function joinWithLineFeeds(sources: readonly StylesheetSource[]): JoinedStylesheet {
  const parts: { start: number }[] = [];
  let text = '';
  for (const source of sources) {
    if (parts.length > 0) text += '\n';
    parts.push({ start: text.length });
    text += source.text;
  }
  return { text, parts };
}

type TokenType =
  | 'eof'
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

/** A token: its type, where it starts, and its value (a name lower-cased, a delimiter's character). */
interface Token {
  readonly type: TokenType;
  readonly start: number;
  readonly value: string;
}

const EOF: Token = { type: 'eof', start: -1, value: '' };

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
  if (ch === '+' || ch === '-')
    return isDigit(css.charAt(i + 1)) || (css.charAt(i + 1) === '.' && isDigit(css.charAt(i + 2)));
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

/** An identifier sequence that starts at `i`: its value with the escapes decoded, and where it ends. */
function consumeIdentSequence(css: string, i: number): { readonly value: string; readonly end: number } {
  let value = '';
  let end = i;
  for (;;) {
    const ch = css.charAt(end);
    if (isNameChar(ch)) {
      value += ch;
      end += 1;
    } else if (validEscape(css, end)) {
      const escape = consumeEscape(css, end + 1);
      value += escape.text;
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
function consumeIdentLike(css: string, i: number): { readonly token: Token; readonly end: number } {
  const { value, end } = consumeIdentSequence(css, i);
  const name = value.toLowerCase();
  if (css.charAt(end) !== '(') return { token: { type: 'ident', start: i, value: name }, end };
  if (name !== 'url') return { token: { type: 'function', start: i, value: name }, end: end + 1 };
  // `url(` followed by a quote (after any whitespace) is a function whose argument is a string; else a url token.
  let after = end + 1;
  while (isWhitespace(css.charAt(after)) && isWhitespace(css.charAt(after + 1))) after += 1;
  const quoted = css.charAt(after);
  if (quoted === '"' || quoted === "'" || (isWhitespace(quoted) && ['"', "'"].includes(css.charAt(after + 1)))) {
    return { token: { type: 'function', start: i, value: name }, end: end + 1 };
  }
  const url = consumeUrl(css, end + 1);
  return { token: { type: url.type, start: i, value: '' }, end: url.end };
}

const PUNCTUATION: ReadonlyMap<string, TokenType> = new Map([
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

/** The tokens of `css` (CSS Syntax Level 3, section 4), comments left out. */
function tokenize(css: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (type: TokenType, start: number, end: number, value = ''): void => {
    tokens.push({ type, start, value });
    i = end;
  };
  while (i < css.length) {
    const ch = css.charAt(i);
    const next = css.charAt(i + 1);
    const punctuation = PUNCTUATION.get(ch);
    if (ch === '/' && next === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? css.length : close + 2;
    } else if (isWhitespace(ch)) {
      let end = i + 1;
      while (isWhitespace(css.charAt(end))) end += 1;
      push('ws', i, end);
    } else if (ch === '"' || ch === "'") {
      const string = consumeString(css, i);
      push(string.type, i, string.end);
    } else if (ch === '#' && (isNameChar(next) || validEscape(css, i + 1))) {
      push('hash', i, consumeIdentSequence(css, i + 1).end);
    } else if (punctuation !== undefined) {
      push(punctuation, i, i + 1);
    } else if (wouldStartNumber(css, i)) {
      const numberEnd = consumeNumber(css, i);
      if (wouldStartIdent(css, numberEnd)) push('dimension', i, consumeIdentSequence(css, numberEnd).end);
      else if (css.charAt(numberEnd) === '%') push('percentage', i, numberEnd + 1);
      else push('number', i, numberEnd);
    } else if (css.startsWith('<!--', i)) {
      push('cdo', i, i + 4);
    } else if (css.startsWith('-->', i)) {
      push('cdc', i, i + 3);
    } else if (ch === '@' && wouldStartIdent(css, i + 1)) {
      const name = consumeIdentSequence(css, i + 1);
      push('atkeyword', i, name.end, name.value.toLowerCase());
    } else if (wouldStartIdent(css, i)) {
      const identLike = consumeIdentLike(css, i);
      tokens.push(identLike.token);
      i = identLike.end;
    } else {
      push('delim', i, i + 1, ch);
    }
  }
  return tokens;
}

/** The type that closes the block an opening token starts. */
const MIRROR: ReadonlyMap<TokenType, TokenType> = new Map([
  ['lparen', 'rparen'],
  ['function', 'rparen'],
  ['lbracket', 'rbracket'],
  ['lbrace', 'rbrace'],
]);

/** A token of the prelude of a rule, with its place among the tokens. */
interface Component {
  readonly token: Token;
  readonly index: number;
}

/** The prelude of a rule and what ended it. */
interface Prelude {
  readonly components: readonly Component[];
  readonly hasBlock: boolean;
  /** Where the next rule starts. */
  readonly next: number;
}

/**
 * The names of the at-rules some browser supports, which end the place for imports (with their block). An at-rule
 * no browser knows is dropped.
 */
const KNOWN_AT_RULES: ReadonlySet<string> = new Set([
  'media',
  'supports',
  'font-face',
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
  '-o-keyframes',
  'page',
  'property',
  'container',
  'scope',
  'counter-style',
  'starting-style',
  'font-palette-values',
  'font-feature-values',
  'view-transition',
  'position-try',
  'color-profile',
  'function',
  'document',
  '-moz-document',
  'viewport',
  '-ms-viewport',
]);

/** Token types a selector never holds at the top level of a prelude. */
const NOT_IN_A_SELECTOR: ReadonlySet<TokenType> = new Set([
  'semicolon',
  'rparen',
  'rbracket',
  'rbrace',
  'atkeyword',
  'string',
  'badstring',
  'url',
  'badurl',
  'number',
  'percentage',
  'dimension',
  'cdo',
  'cdc',
]);

/** What the list of rules reads from a stylesheet. */
interface Rules {
  /** Where the `@import` rules that a browser keeps start. */
  readonly kept: ReadonlySet<number>;
  /**
   * Where the `@import` rules written at the stylesheet's top level start, whether kept or not, and the `@import`
   * at-keywords inside the preludes of other rules, which those rules swallow. An `@import` that is no import rule
   * by itself (no url or string, or a block) is not among them.
   */
  readonly written: readonly number[];
}

/** The rules of a stylesheet (CSS Syntax Level 3, section 5.4.1), as far as `@import` is concerned. */
function consumeRules(css: string): Rules {
  const tokens = tokenize(css);
  const tokenAt = (index: number): Token => tokens[index] ?? EOF;
  const kept = new Set<number>();
  const written: number[] = [];

  /** The index after the block that the token at `index` opens. */
  const skipBlock = (index: number): number => {
    const closers: TokenType[] = [];
    let at = index;
    do {
      const { type } = tokenAt(at);
      if (type === 'eof') return at;
      if (type === closers.at(-1)) closers.pop();
      else {
        const mirror = MIRROR.get(type);
        if (mirror !== undefined) closers.push(mirror);
      }
      at += 1;
    } while (closers.length > 0);
    return at;
  };

  /** The prelude from `from` to the block that ends it, to a `;` when `statement`, or to the end. */
  const consumePrelude = (from: number, statement: boolean): Prelude => {
    const components: Component[] = [];
    let at = from;
    for (;;) {
      const token = tokenAt(at);
      if (token.type === 'eof') return { components, hasBlock: false, next: at };
      if (token.type === 'lbrace') return { components, hasBlock: true, next: skipBlock(at) };
      if (statement && token.type === 'semicolon') return { components, hasBlock: false, next: at + 1 };
      if (token.type === 'atkeyword' && token.value === 'import') written.push(token.start);
      if (token.type !== 'ws') components.push({ token, index: at });
      at = MIRROR.has(token.type) ? skipBlock(at) : at + 1;
    }
  };

  let ruleSeen = false;
  let importSeen = false;
  let at = 0;
  for (;;) {
    const token = tokenAt(at);
    if (token.type === 'eof') break;
    if (token.type === 'ws' || token.type === 'cdo' || token.type === 'cdc') {
      at += 1;
    } else if (token.type !== 'atkeyword') {
      const prelude = consumePrelude(at, false);
      at = prelude.next;
      if (prelude.hasBlock && isSelectorPrelude(prelude.components)) ruleSeen = true;
    } else {
      const prelude = consumePrelude(at + 1, true);
      at = prelude.next;
      const kind = classifyAtRule(token.value, prelude);
      if (kind === 'import') {
        written.push(token.start);
        if (!ruleSeen) {
          kept.add(token.start);
          importSeen = true;
        }
      } else if (kind === 'rule' || (kind === 'layer-statement' && importSeen)) {
        ruleSeen = true;
      }
    }
  }
  return { kept, written };
}

/** Whether the prelude can be a selector, as far as its top-level tokens tell. */
function isSelectorPrelude(components: readonly Component[]): boolean {
  return components.length > 0 && components.every((c) => !NOT_IN_A_SELECTOR.has(c.token.type));
}

/** Whether a component is a url or a string, the argument `@import` and `@namespace` take. */
const isUrlOrString = ({ token }: Component): boolean =>
  token.type === 'string' || token.type === 'url' || (token.type === 'function' && token.value === 'url');

/**
 * How many layer names the prelude lists, if it is a list of layer names (`a`, `a.b`, separated by commas), else
 * undefined.
 */
function layerNames(components: readonly Component[]): number | undefined {
  if (components.length === 0) return 0;
  const indexAt = (at: number): number => Number(components[at]?.index);
  let at = 0;
  let count = 0;
  for (;;) {
    if (components[at]?.token.type !== 'ident') return undefined;
    at += 1;
    // A dot joins two names with nothing between.
    while (
      components[at]?.token.type === 'delim' &&
      components[at]?.token.value === '.' &&
      components[at + 1]?.token.type === 'ident' &&
      indexAt(at) === indexAt(at - 1) + 1 &&
      indexAt(at + 1) === indexAt(at) + 1
    ) {
      at += 2;
    }
    count += 1;
    if (at >= components.length) return count;
    if (components[at]?.token.type !== 'comma') return undefined;
    at += 1;
  }
}

/** What an at-rule is, as far as the position of `@import` is concerned. */
type AtRuleKind = 'import' | 'layer-statement' | 'rule' | 'dropped';

function classifyAtRule(name: string, prelude: Prelude): AtRuleKind {
  const [first, ...rest] = prelude.components;
  switch (name) {
    case 'import':
      return !prelude.hasBlock && first !== undefined && isUrlOrString(first) ? 'import' : 'dropped';
    case 'layer': {
      const names = layerNames(prelude.components);
      if (names === undefined) return 'dropped';
      if (prelude.hasBlock) return names <= 1 ? 'rule' : 'dropped';
      return names > 0 ? 'layer-statement' : 'dropped';
    }
    case 'namespace': {
      const argument = first?.token.type === 'ident' ? rest : prelude.components;
      return !prelude.hasBlock && argument.length === 1 && argument.every(isUrlOrString) ? 'rule' : 'dropped';
    }
    default:
      return prelude.hasBlock && KNOWN_AT_RULES.has(name) ? 'rule' : 'dropped';
  }
}

/**
 * A warning for each source whose `@import` rules a browser ignores in the stylesheet the output writes (`joined`,
 * made of the sources): those that come after a rule of the stylesheet, and those that an earlier construct swallows.
 * The imported stylesheet is never requested.
 */
export function ineffectiveImportDiagnostics(
  sources: readonly StylesheetSource[],
  joined: JoinedStylesheet,
): Diagnostic[] {
  const { kept } = consumeRules(joined.text);
  return sources.flatMap(({ label, text }, index): Diagnostic[] => {
    const start = Number(joined.parts[index]?.start);
    // The imports the source writes at its own top level, read on its own, that the stylesheet does not keep.
    const count = consumeRules(text).written.filter((at) => !kept.has(start + at)).length;
    if (count === 0) return [];
    return [
      {
        level: 'warning',
        message:
          `${label} has ${count === 1 ? 'an @import rule' : `${count} @import rules`} that browsers ignore in the ` +
          `story stylesheet: ${count === 1 ? 'it comes' : 'they come'} after other rules, or ` +
          `${count === 1 ? 'is' : 'are'} part of a rule that is not finished (a ";" or "}" is missing before or ` +
          'after), so the imported stylesheet is never loaded. ' +
          'Only @layer statements may come before an @import. ' +
          'Move the import to the start of the first stylesheet, or add the file as a head module.',
      },
    ];
  });
}

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
 * - a style rule with a block and a prelude that can be a selector (a prelude holding a token no selector holds, such
 *   as `;`, `!`, `/`, a stray `)`, `]` or `}`, an at-keyword, a string, a url, a number or an unrestricted hash, or no
 *   prelude, or no block, is dropped and ends nothing);
 * - `@namespace` with a name and a url, `@layer` with a block (and at most one name) and every at-rule some browser
 *   supports (the names are in KNOWN_AT_RULES), with its block and a prelude of the shape that at-rule takes;
 * - an `@layer` statement after an `@import`, which browsers take for the end of the imports though the specification
 *   ignores it; layer statements belong before the first import.
 *
 * An at-rule no browser knows, `@charset` wherever it stands (CSS Syntax treats it as an unknown at-rule; the
 * encoding is read from the bytes), `@import` without a url or string, and a rule whose prelude is not of the shape
 * its at-rule takes are dropped and end nothing. What this does not check counts as a rule: a selector that is
 * invalid by its meaning (a namespace prefix that is not declared), the descriptors in the block of `@property`, and
 * the prelude of `@media`, `@container` and `@scope`, which browsers read leniently or by their own grammar.
 *
 * Each `@import` the sources write at their own top level, read on its own, that the joined stylesheet does not keep
 * as an import rule is reported with its source.
 *
 * The input is read as a stream of tokens, one at a time, so the memory it takes does not grow with the input but
 * with how deep it nests (a byte for each open bracket) and with the number of `@import` rules it holds.
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

/**
 * A token: its type, where it starts, and its value: a name lower-cased (and cut at MAX_NAME characters, which no name
 * the rules compare it with reaches), a delimiter's character, `id` for a hash that is an ID.
 */
interface Token {
  readonly type: TokenType;
  readonly start: number;
  readonly value: string;
}

const EOF: Token = { type: 'eof', start: -1, value: '' };

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

/**
 * The tokens of `css` (CSS Syntax Level 3, section 4), comments left out, one for each call; the end of the input
 * is the `eof` token, over and over.
 */
function createTokenizer(css: string): () => Token {
  let i = 0;
  const emit = (type: TokenType, start: number, end: number, value = ''): Token => {
    i = end;
    return { type, start, value };
  };
  return (): Token => {
    for (;;) {
      if (i >= css.length) return EOF;
      const ch = css.charAt(i);
      const next = css.charAt(i + 1);
      const punctuation = PUNCTUATION.get(ch);
      if (ch === '/' && next === '*') {
        const close = css.indexOf('*/', i + 2);
        i = close === -1 ? css.length : close + 2;
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

/** The codes of the brackets a token opens and closes, for the stack of open blocks. */
const OPENS: ReadonlyMap<TokenType, number> = new Map([
  ['lparen', 1],
  ['function', 1],
  ['lbracket', 2],
  ['lbrace', 3],
]);
const CLOSES: ReadonlyMap<TokenType, number> = new Map([
  ['rparen', 1],
  ['rbracket', 2],
  ['rbrace', 3],
]);

/** A stack of bytes that grows as it is used: a byte for each block that is open. */
class ByteStack {
  private bytes = new Uint8Array(64);
  size = 0;

  push(code: number): void {
    if (this.size === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.size] = code;
    this.size += 1;
  }

  /** The code on top. */
  top(): number {
    return Number(this.bytes[this.size - 1]);
  }

  pop(): void {
    this.size -= 1;
  }
}

/** The delimiters a selector holds outside brackets: universal, class, combinators, namespace and nesting. */
const SELECTOR_DELIMS = '*.>+~|&';

/** Whether a token can be at the top level of a selector (it is not whitespace). */
function inSelector(token: Token): boolean {
  switch (token.type) {
    case 'ident':
    case 'function':
    case 'colon':
    case 'comma':
    case 'lbracket':
      return true;
    case 'hash':
      return token.value === 'id';
    case 'delim':
      return SELECTOR_DELIMS.includes(token.value);
    default:
      return false;
  }
}

/** Where a prelude is in a list of layer names, `a`, `a.b`, separated by commas. */
type LayerState = 'name' | 'after-name' | 'after-dot' | 'bad';

/**
 * What the prelude of a rule is, kept as it is read: the tokens of the prelude are not kept, since a prelude may be
 * as long as the input. Whitespace and comments are no components.
 */
class Prelude {
  /** The number of components, up to 3. */
  count = 0;
  first: Token = EOF;
  /** Whether a whitespace separates the last component from the one before. */
  private gap = false;
  /** Whether every component is one a selector holds. */
  selectorOk = true;
  /** Whether every component is an identifier or a colon, as in the prelude of `@page`. */
  pageOk = true;
  private layerState: LayerState = 'name';
  /** The number of layer names, up to 2. */
  layerNames = 0;
  /** Whether the first and second components are as a `@namespace` prelude has them: a url or a string last. */
  private namespaceShape: 'start' | 'name' | 'done' | 'bad' = 'start';

  add(token: Token): void {
    if (token.type === 'ws') {
      this.gap = true;
      return;
    }
    const adjacent = !this.gap;
    this.gap = false;
    if (this.count < 3) this.count += 1;
    if (this.count === 1) this.first = token;
    if (!inSelector(token)) this.selectorOk = false;
    if (token.type !== 'ident' && token.type !== 'colon') this.pageOk = false;
    this.layerState = this.nextLayerState(token, adjacent);
    this.namespaceShape = this.nextNamespaceShape(token);
  }

  private nextLayerState(token: Token, adjacent: boolean): LayerState {
    switch (this.layerState) {
      case 'name':
        if (token.type !== 'ident') return 'bad';
        this.layerNames = Math.min(this.layerNames + 1, 2);
        return 'after-name';
      case 'after-name':
        if (token.type === 'comma') return 'name';
        return token.type === 'delim' && token.value === '.' && adjacent ? 'after-dot' : 'bad';
      case 'after-dot':
        return token.type === 'ident' && adjacent ? 'after-name' : 'bad';
      case 'bad':
        return 'bad';
    }
  }

  private nextNamespaceShape(token: Token): 'start' | 'name' | 'done' | 'bad' {
    switch (this.namespaceShape) {
      case 'start':
        if (token.type === 'ident') return 'name';
        return isUrlOrString(token) ? 'done' : 'bad';
      case 'name':
        return isUrlOrString(token) ? 'done' : 'bad';
      case 'done':
      case 'bad':
        return 'bad';
    }
  }

  /** Whether the components are a list of layer names (none at all included). */
  get layerNamesOk(): boolean {
    return this.count === 0 || this.layerState === 'after-name';
  }

  /** Whether the components are the name (optional) and the url or string that `@namespace` takes. */
  get namespaceOk(): boolean {
    return this.namespaceShape === 'done';
  }

  /** Whether the components can be a selector. */
  get isSelector(): boolean {
    return this.count > 0 && this.selectorOk;
  }

  /** Whether the only component is an identifier. */
  get isOneIdent(): boolean {
    return this.count === 1 && this.first.type === 'ident';
  }

  /** Whether the only component is an identifier that starts with two dashes. */
  get isOneDashedIdent(): boolean {
    return this.isOneIdent && this.first.value.startsWith('--');
  }
}

/** Whether a token is a url or a string, the argument `@import` and `@namespace` take. */
const isUrlOrString = (token: Token): boolean =>
  token.type === 'string' || token.type === 'url' || (token.type === 'function' && token.value === 'url');

/** Whether the prelude is a keyframes name: one identifier or string. */
const keyframesName = (p: Prelude): boolean => p.count === 1 && (p.first.type === 'ident' || p.first.type === 'string');

/**
 * The names of the at-rules some browser supports, which end the place for imports (with their block), and what
 * their prelude must be for a browser to keep the rule. An at-rule no browser knows is dropped. A rule without a check
 * is kept with any prelude.
 */
const KNOWN_AT_RULES: ReadonlyMap<string, ((prelude: Prelude) => boolean) | undefined> = new Map<
  string,
  ((prelude: Prelude) => boolean) | undefined
>([
  ['media', undefined],
  [
    'supports',
    (p) => ['lparen', 'function'].includes(p.first.type) || (p.first.type === 'ident' && p.first.value === 'not'),
  ],
  ['font-face', (p) => p.count === 0],
  ['keyframes', keyframesName],
  ['-webkit-keyframes', keyframesName],
  ['-moz-keyframes', keyframesName],
  ['page', (p) => p.pageOk],
  ['property', (p) => p.isOneDashedIdent],
  ['container', (p) => p.count > 0],
  ['scope', undefined],
  ['counter-style', (p) => p.isOneIdent],
  ['starting-style', (p) => p.count === 0],
  ['font-palette-values', (p) => p.isOneDashedIdent],
  ['font-feature-values', undefined],
  ['view-transition', (p) => p.count === 0],
  ['position-try', (p) => p.isOneDashedIdent],
  ['function', undefined],
]);

/** What an at-rule is, as far as the position of `@import` is concerned. */
type AtRuleKind = 'import' | 'layer-statement' | 'rule' | 'dropped';

function classifyAtRule(name: string, prelude: Prelude, hasBlock: boolean): AtRuleKind {
  switch (name) {
    case 'import':
      return !hasBlock && isUrlOrString(prelude.first) ? 'import' : 'dropped';
    case 'layer':
      if (!prelude.layerNamesOk) return 'dropped';
      if (hasBlock) return prelude.layerNames <= 1 ? 'rule' : 'dropped';
      return prelude.layerNames > 0 ? 'layer-statement' : 'dropped';
    case 'namespace':
      return !hasBlock && prelude.namespaceOk ? 'rule' : 'dropped';
    default: {
      const check = KNOWN_AT_RULES.get(name);
      return hasBlock && KNOWN_AT_RULES.has(name) && (check === undefined || check(prelude)) ? 'rule' : 'dropped';
    }
  }
}

/** What the list of rules reads from a stylesheet. */
interface Rules {
  /** Where the `@import` rules that a browser keeps start, in order. */
  readonly kept: readonly number[];
  /**
   * Where the `@import` rules written at the stylesheet's top level start, whether kept or not, and the `@import`
   * at-keywords inside the preludes of other rules, which those rules swallow, in order. An `@import` that is no
   * import rule by itself (no url or string, or a block) is not among them. Left empty unless asked for.
   */
  readonly written: readonly number[];
}

/**
 * The rules of a stylesheet (CSS Syntax Level 3, section 5.4.1), as far as `@import` is concerned, read token by
 * token.
 */
function consumeRules(css: string, collectWritten: boolean): Rules {
  const nextToken = createTokenizer(css);
  let token = nextToken();
  const kept: number[] = [];
  const written: number[] = [];
  const closers = new ByteStack();

  /** Skips the block that the current token opens; the current token is then the first after it. */
  const skipBlock = (): void => {
    closers.size = 0;
    do {
      const closes = CLOSES.get(token.type);
      const opens = OPENS.get(token.type);
      if (token.type === 'eof') return;
      if (closes !== undefined && closes === closers.top()) closers.pop();
      else if (opens !== undefined) closers.push(opens);
      token = nextToken();
    } while (closers.size > 0);
  };

  /** Reads the prelude from the current token to the block that ends it, to a `;` when `statement`, or to the end. */
  const consumePrelude = (statement: boolean): { readonly prelude: Prelude; readonly hasBlock: boolean } => {
    const prelude = new Prelude();
    for (;;) {
      if (token.type === 'eof') return { prelude, hasBlock: false };
      if (token.type === 'lbrace') {
        skipBlock();
        return { prelude, hasBlock: true };
      }
      if (statement && token.type === 'semicolon') {
        token = nextToken();
        return { prelude, hasBlock: false };
      }
      if (collectWritten && token.type === 'atkeyword' && token.value === 'import') written.push(token.start);
      prelude.add(token);
      if (OPENS.has(token.type)) skipBlock();
      else token = nextToken();
    }
  };

  let ruleSeen = false;
  let importSeen = false;
  for (;;) {
    if (token.type === 'eof') break;
    if (token.type === 'ws' || token.type === 'cdo' || token.type === 'cdc') {
      token = nextToken();
    } else if (token.type !== 'atkeyword') {
      const { prelude, hasBlock } = consumePrelude(false);
      if (hasBlock && prelude.isSelector) ruleSeen = true;
    } else {
      const { value: name, start } = token;
      token = nextToken();
      const mark = written.length;
      const { prelude, hasBlock } = consumePrelude(true);
      const kind = classifyAtRule(name, prelude, hasBlock);
      if (kind === 'import') {
        // Before the at-keywords its prelude swallowed, to keep the positions in order.
        if (collectWritten) written.splice(mark, 0, start);
        if (!ruleSeen) {
          kept.push(start);
          importSeen = true;
        }
      } else if (kind === 'rule' || (kind === 'layer-statement' && importSeen)) {
        ruleSeen = true;
      }
    }
  }
  return { kept, written };
}

/** Whether `target` is in the ascending list. */
function includesSorted(list: readonly number[], target: number): boolean {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (Number(list[middle]) < target) low = middle + 1;
    else high = middle;
  }
  return Number(list[low]) === target;
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
  // A single source is the whole stylesheet, so one reading serves both.
  const single = sources.length === 1 && joined.parts[0]?.start === 0 && joined.text === sources[0]?.text;
  const { kept, written: writtenBySingle } = consumeRules(joined.text, single);
  return sources.flatMap(({ label, text }, index): Diagnostic[] => {
    const start = Number(joined.parts[index]?.start);
    // The imports the source writes at its own top level, read on its own, that the stylesheet does not keep.
    const written = single ? writtenBySingle : consumeRules(text, true).written;
    const count = written.filter((at) => !includesSorted(kept, start + at)).length;
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

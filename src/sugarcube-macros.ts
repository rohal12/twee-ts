/**
 * Reads SugarCube 2 macro calls the way SugarCube 2.37.3 does, so the link check sees the same
 * passage names that `<<link>>` and `<<goto>>` use when the story plays.
 *
 * Each step follows a part of SugarCube's macro parser:
 * - `findMacroTags` finds where a tag starts and ends (the parser's `lookahead` pattern);
 * - `parseMacroArgs` splits the text after the macro name into arguments (`parseArgs`);
 * - quoted arguments are evaluated as strict-mode JavaScript strings (`evalStringLiteral`).
 *
 * Of the rest of the wikifier, only comments, `<script>` elements and `<<script>>` bodies are
 * told apart; other markup, such as verbatim text, is read as markup (see
 * `findMacroPassageLinks`).
 */
import { SUBSTITUTION, evalStringLiteral, javaScriptStrings } from './javascript-strings.js';

/** A macro tag: `<<name args>>`, or a closing tag `<</name>>`. */
export interface MacroTag {
  /** The macro name, with a leading `/` for a closing tag. */
  readonly name: string;
  /** The text between the name (and the spaces after it) and the closing `>>`. */
  readonly args: string;
  /** Index of the opening `<<`. */
  readonly start: number;
  /** Index just past the closing `>>`. */
  readonly end: number;
}

/** What a macro argument evaluates to, as far as that is known without playing the story. */
export type MacroArg =
  /** A quoted string, or a bare word SugarCube keeps as text. */
  | { readonly type: 'string'; readonly value: string }
  /** A bare word SugarCube converts to a number. */
  | { readonly type: 'number'; readonly value: number }
  /** Link or image markup: `[[…]]` or `[img[…]]`. */
  | { readonly type: 'markup' }
  | { readonly type: 'null' }
  /** A variable, an expression, `setup`/`settings`, a boolean or `undefined`. */
  | { readonly type: 'other' };

/** A passage named by a `<<link>>` or `<<goto>>` call. */
export interface MacroPassageLink {
  readonly macro: 'goto' | 'link';
  readonly passage: string;
}

/** An argument as SugarCube's lexer splits it, before its value is worked out. */
type LexedArg =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'expression'; readonly code: string }
  | { readonly kind: 'markup' }
  | { readonly kind: 'word'; readonly text: string };

/** A tag, and where a `<<link` or `<<goto` first appears unquoted in its arguments, if it does. */
interface ScannedTag {
  readonly tag: MacroTag;
  readonly innerCall: number | undefined;
}

// SugarCube's `Patterns.macroName`, preceded by the optional `/` of a closing tag.
const NAME_RE = /\/?[A-Za-z][\w-]*|[=-]/y;
const SPACES_RE = /\s*/y;
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/g;
const SQUARE_BRACKET_OPEN_RE = /\[(?:[<>]?[Ii][Mm][Gg])?\[/y;

// SugarCube's `Patterns.space` and `Patterns.notSpace`: JavaScript's `\s` plus U+180E, which
// `\s` no longer matches.
const SPACE_RE = /[\s\u180e]/g;
const NOT_SPACE_RE = /[^\s\u180e]/g;
const VARIABLE_RE = /^[$_][$A-Z_a-z][$0-9A-Z_a-z]*/;
const SETTINGS_OR_SETUP_RE = /^(?:settings|setup)[.[]/;
const IMAGE_MARKUP_CHARS = '<>IiMmGg';

/**
 * Macros that SugarCube doesn't split into arguments (`skipArgs` in 2.37.3), with their child
 * tags that do the same: `<<elseif>>` and `<<else>>` of `<<if>>`, and `<<optionsfrom>>` of
 * `<<cycle>>` and `<<listbox>>`. Their argument text is TwineScript, or for `<<capture>>`,
 * `<<unset>>` and `<<for>>` a syntax of their own; either way its strings are JavaScript strings.
 */
const RAW_ARGUMENT_MACROS: ReadonlySet<string> = new Set([
  'break',
  'capture',
  'continue',
  'done',
  'else',
  'elseif',
  'for',
  'if',
  'nobr',
  'optionsfrom',
  'print',
  '=',
  '-',
  'run',
  'set',
  'silent',
  'silently',
  'stop',
  'switch',
  'unset',
  'waitforaudio',
]);

/**
 * How deep strings inside macro arguments are read for further calls. Stories nest two or three
 * levels; the limit keeps the work linear in the size of the text on any input.
 */
const MAX_STRING_DEPTH = 10;

/**
 * What one reading of a passage carries down into the strings it reads: how deep it is, and how
 * much the `<<script>>` closer search has left to read (see `scriptBodyCloser`).
 */
interface ReadContext {
  readonly depth: number;
  readonly budget: { left: number };
}

/** A context for reading `text`: the closer search may read four times it, plus an allowance. */
function readContext(text: string): ReadContext {
  return { depth: 0, budget: { left: 4 * text.length + 100_000 } };
}

function deeper(context: ReadContext): ReadContext {
  return { depth: context.depth + 1, budget: context.budget };
}

/** Index of the first match of a global `re` at or after `from`, or -1. */
function searchFrom(re: RegExp, text: string, from: number): number {
  re.lastIndex = from;
  const m = re.exec(text);
  return m === null ? -1 : m.index;
}

/**
 * Finds the macro tags in text, in order, trying a tag at every `<<` as SugarCube's macro
 * parser does. A tag that doesn't parse is skipped, and the search goes on after its `<<`.
 *
 * Gives the same tags as SugarCube's pattern, without its backtracking: that pattern takes
 * exponential time when no `>>` follows a `<<name`, which a script passage can contain (`1<<n`).
 */
export function findMacroTags(text: string): MacroTag[] {
  return scanTags(text).map((scanned) => scanned.tag);
}

function scanTags(text: string): ScannedTag[] {
  const matchTagAt = tagMatcher(text);
  const tags: ScannedTag[] = [];
  let start = text.indexOf('<<');
  while (start !== -1) {
    const scanned = matchTagAt(start);
    if (scanned === undefined) {
      start = text.indexOf('<<', start + 2);
    } else {
      tags.push(scanned);
      start = text.indexOf('<<', scanned.tag.end);
    }
  }
  return tags;
}

/** A kind of argument part in which a `>>` doesn't end the tag, named by how it opens. */
type ArgumentPartKind = '/*' | '//' | '`' | '"' | "'" | '[';

/** How far an argument part reaches. */
interface ArgumentPartScan {
  /** Index just past the part, or `undefined` if it is never closed. */
  readonly end: number | undefined;
  /**
   * Where the scan stopped: at the part's closing quote, `*` + `/`, line end or `]]`, or where
   * it failed. A part of the same kind that starts inside this one, before this index, ends or
   * fails no earlier.
   */
  readonly stop: number;
}

/**
 * Returns a function that matches a tag at a `<<` in `text`. It must be called for positions in
 * increasing order.
 *
 * The arguments may contain comments, backquoted expressions, quoted strings and link markup,
 * whose `>>` doesn't end the tag. SugarCube's pattern treats such a part as a unit only if a
 * `>>` still follows it, and otherwise as plain characters; `lastClose`, the last `>>` in the
 * text, answers that in constant time. Once a part is read as plain characters, a part of the
 * same kind that starts inside it can't end before `lastClose` either, in this tag or a later
 * one, so it isn't scanned again: `scanFrom` records where each kind may next be scanned. This
 * keeps the search linear.
 */
function tagMatcher(
  text: string,
  lastClose = text.lastIndexOf('>>'),
  onWork: (characters: number) => void = () => {},
): (start: number) => ScannedTag | undefined {
  const scanFrom = new Map<ArgumentPartKind, number>();
  return (start) => {
    NAME_RE.lastIndex = start + 2;
    const nameMatch = NAME_RE.exec(text);
    if (nameMatch === null) {
      onWork(2);
      return undefined;
    }
    SPACES_RE.lastIndex = NAME_RE.lastIndex;
    SPACES_RE.exec(text);
    const argsStart = SPACES_RE.lastIndex;
    onWork(argsStart - start);

    let innerCall: number | undefined;
    let pos = argsStart;
    while (pos <= lastClose) {
      if (text.startsWith('>>', pos)) {
        const tag = { name: nameMatch[0], args: text.slice(argsStart, pos), start, end: pos + 2 };
        return { tag, innerCall };
      }
      const kind = argumentPartKindAt(text, pos);
      const from = kind === undefined ? undefined : scanFrom.get(kind);
      if (kind !== undefined && (from === undefined || pos >= from)) {
        const part = scanArgumentPart(text, pos, kind);
        onWork(part.stop - pos);
        if (part.end !== undefined && part.end <= lastClose) {
          pos = part.end;
          continue;
        }
        scanFrom.set(kind, part.stop);
      }
      if (innerCall === undefined && startsPassageLinkCall(text, pos)) {
        innerCall = pos;
      }
      onWork(1);
      pos += 1;
    }
    return undefined;
  };
}

/** Whether a `<<link` or `<<goto` tag, and not a longer macro name, starts at `pos`. */
function startsPassageLinkCall(text: string, pos: number): boolean {
  if (!text.startsWith('<<', pos)) {
    return false;
  }
  NAME_RE.lastIndex = pos + 2;
  const name = NAME_RE.exec(text)?.[0];
  return name === 'link' || name === 'goto';
}

/** The kind of argument part that opens at `pos`, if one does. */
function argumentPartKindAt(text: string, pos: number): ArgumentPartKind | undefined {
  const ch = text[pos];
  switch (ch) {
    case '/': {
      const next = text[pos + 1];
      return next === '*' ? '/*' : next === '/' ? '//' : undefined;
    }
    case '`':
    case '"':
    case "'":
    case '[':
      return ch;
    default:
      return undefined;
  }
}

function scanArgumentPart(text: string, pos: number, kind: ArgumentPartKind): ArgumentPartScan {
  switch (kind) {
    case '/*': {
      const close = text.indexOf('*/', pos + 2);
      return close === -1 ? { end: undefined, stop: text.length } : { end: close + 2, stop: close };
    }
    case '//': {
      // `//.*\n`: the comment must end at a line feed, not at any other line terminator.
      const lineEnd = searchFrom(LINE_TERMINATOR_RE, text, pos + 2);
      if (lineEnd === -1) {
        return { end: undefined, stop: text.length };
      }
      return { end: text[lineEnd] === '\n' ? lineEnd + 1 : undefined, stop: lineEnd };
    }
    case '`':
    case '"':
    case "'":
      return scanQuoted(text, pos, kind);
    case '[':
      return scanSquareBracketed(text, pos);
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled argument part: ${String(_exhaustive)}`);
    }
  }
}

/** A quoted part of a tag: a backslash escapes any character except a line terminator. */
function scanQuoted(text: string, pos: number, quote: string): ArgumentPartScan {
  let i = pos + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) {
      return { end: i + 1, stop: i };
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined || '\n\r\u2028\u2029'.includes(next)) {
        return { end: undefined, stop: i };
      }
      i += 2;
    } else {
      i += 1;
    }
  }
  return { end: undefined, stop: text.length };
}

/** Link or image markup in a tag: up to the first `]]` on the same line, plus any further `]`. */
function scanSquareBracketed(text: string, pos: number): ArgumentPartScan {
  SQUARE_BRACKET_OPEN_RE.lastIndex = pos;
  if (!SQUARE_BRACKET_OPEN_RE.test(text)) {
    return { end: undefined, stop: pos + 1 };
  }
  for (let i = SQUARE_BRACKET_OPEN_RE.lastIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      return { end: undefined, stop: i };
    }
    if (ch === ']' && text[i + 1] === ']') {
      let end = i + 2;
      while (text[end] === ']') {
        end += 1;
      }
      return { end, stop: i };
    }
  }
  return { end: undefined, stop: text.length };
}

/**
 * Splits a tag's argument text into arguments, as SugarCube's `parseArgs` does. Returns
 * `undefined` where SugarCube throws while splitting the text or reading a string, so the macro
 * call does nothing. (SugarCube also parses link markup a second time and rejects some that it
 * split without trouble, such as `[["x]]`; that is still returned as markup here.)
 */
export function parseMacroArgs(raw: string): MacroArg[] | undefined {
  return lexMacroArgs(raw)?.map(argValue);
}

function lexMacroArgs(raw: string): LexedArg[] | undefined {
  const args: LexedArg[] = [];
  let pos = searchFrom(NOT_SPACE_RE, raw, 0);
  while (pos !== -1) {
    const lexed = lexArgument(raw, pos);
    if (lexed === undefined) {
      return undefined;
    }
    args.push(lexed.arg);
    pos = searchFrom(NOT_SPACE_RE, raw, lexed.end);
  }
  return args;
}

function lexArgument(raw: string, pos: number): { arg: LexedArg; end: number } | undefined {
  const first = raw[pos];
  switch (first) {
    case '`': {
      const end = slurpQuote(raw, pos + 1, '`');
      return end === undefined ? undefined : { arg: { kind: 'expression', code: raw.slice(pos + 1, end - 1) }, end };
    }
    case '"':
    case "'": {
      const end = slurpQuote(raw, pos + 1, first);
      if (end === undefined) {
        return undefined;
      }
      const value = evalStringLiteral(raw.slice(pos, end));
      return value === undefined ? undefined : { arg: { kind: 'string', value }, end };
    }
    case '[': {
      const end = lexSquareBracketed(raw, pos + 1);
      return end === undefined ? undefined : { arg: { kind: 'markup' }, end };
    }
    default: {
      const space = searchFrom(SPACE_RE, raw, pos + 1);
      const end = space === -1 ? raw.length : space;
      return { arg: { kind: 'word', text: raw.slice(pos, end) }, end };
    }
  }
}

/**
 * Reads a quoted argument from just after its opening quote. A newline, or a backslash before a
 * newline, ends it unterminated. Returns the index after the closing quote.
 */
function slurpQuote(raw: string, from: number, endQuote: string): number | undefined {
  let i = from;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === endQuote) {
      return i + 1;
    }
    if (ch === '\n') {
      return undefined;
    }
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === undefined || next === '\n') {
        return undefined;
      }
      i += 2;
    } else {
      i += 1;
    }
  }
  return undefined;
}

/**
 * Reads link or image markup from just after its first `[`, counting nested brackets.
 * Returns the index after the closing `]]`.
 */
function lexSquareBracketed(raw: string, from: number): number | undefined {
  let i = from;
  while (i < raw.length && IMAGE_MARKUP_CHARS.includes(raw.charAt(i))) {
    i += 1;
  }
  if (raw[i] !== '[') {
    return undefined;
  }
  i += 1;
  let depth = 2;
  while (i < raw.length) {
    const ch = raw[i];
    i += 1;
    switch (ch) {
      case '\\': {
        const next = raw[i];
        if (next === undefined || next === '\n') {
          return undefined;
        }
        i += 1;
        break;
      }
      case '\n':
        return undefined;
      case '[':
        depth += 1;
        break;
      case ']':
        depth -= 1;
        if (depth < 0) {
          return undefined;
        }
        if (depth === 1 && raw[i] === ']') {
          return i + 1;
        }
        break;
      default:
        break;
    }
  }
  return undefined;
}

/** An argument's value, following SugarCube's conversions. */
function argValue(arg: LexedArg): MacroArg {
  switch (arg.kind) {
    case 'string':
      return { type: 'string', value: arg.value };
    case 'expression':
      // Its value is known only in play.
      return { type: 'other' };
    case 'markup':
      return { type: 'markup' };
    case 'word':
      return bareWord(arg.text);
    default: {
      const _exhaustive: never = arg;
      throw new Error(`unhandled macro argument: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** A bare word's value, following SugarCube's conversions. */
function bareWord(word: string): MacroArg {
  if (VARIABLE_RE.test(word) || SETTINGS_OR_SETUP_RE.test(word)) {
    return { type: 'other' };
  }
  switch (word) {
    case 'null':
      return { type: 'null' };
    case 'undefined':
    case 'true':
    case 'false':
      return { type: 'other' };
    case 'NaN':
      return { type: 'number', value: NaN };
    default: {
      const value = Number(word);
      return Number.isNaN(value) ? { type: 'string', value: word } : { type: 'number', value };
    }
  }
}

/** The passage name an argument gives, if it can be known without playing the story. */
function passageName(arg: MacroArg): string | undefined {
  switch (arg.type) {
    case 'string':
      // A template literal's `${…}` makes the name known only in play.
      return arg.value.includes(SUBSTITUTION) ? undefined : arg.value;
    case 'number':
      // SugarCube looks a number up as a passage name by its string form.
      return String(arg.value);
    case 'markup':
    // Markup names its passage in `[[…]]`, which the link check reads on its own.
    case 'null':
    case 'other':
      return undefined;
    default: {
      const _exhaustive: never = arg;
      throw new Error(`unhandled macro argument: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * The argument that names the passage in a `<<link>>` or `<<goto>>` call:
 * - `<<link linkText [passageName]>>`, unless the first argument is link or image markup, which
 *   then names the passage itself and any further argument is ignored;
 * - `<<goto passageName>>`.
 *
 * In text built from a template literal, a bare word with a `${…}` in it may become several
 * words in play, so no argument after it is known.
 */
function passageArgument(macro: MacroPassageLink['macro'], lexed: readonly LexedArg[]): MacroArg | undefined {
  const index = macro === 'link' ? 1 : 0;
  if (lexed.slice(0, index + 1).some((arg) => arg.kind === 'word' && arg.text.includes(SUBSTITUTION))) {
    return undefined;
  }
  const args = lexed.map(argValue);
  switch (macro) {
    case 'link': {
      const [label, passage] = args;
      // A `null` label makes SugarCube throw, as it reads `null` as markup.
      return label === undefined || label.type === 'markup' || label.type === 'null' ? undefined : passage;
    }
    case 'goto':
      return args[0];
    default: {
      const _exhaustive: never = macro;
      throw new Error(`unhandled macro: ${String(_exhaustive)}`);
    }
  }
}

function isPassageLinkMacro(name: string): name is MacroPassageLink['macro'] {
  return name === 'goto' || name === 'link';
}

/** The passage a `<<link>>` or `<<goto>>` tag names itself, if it can be known before play. */
function ownPassageLink(tag: MacroTag, lexed: readonly LexedArg[]): MacroPassageLink | undefined {
  if (!isPassageLinkMacro(tag.name)) {
    return undefined;
  }
  const arg = passageArgument(tag.name, lexed);
  const passage = arg === undefined ? undefined : passageName(arg);
  return passage === undefined ? undefined : { macro: tag.name, passage };
}

/**
 * The passages a tag names: its own, if it is a `<<link>>` or `<<goto>>` call, then those of the
 * calls inside the strings of its arguments, which the macro may print or pass on
 * (`<<set _out to '<<link "Go" "Room">><</link>>'>>`). The arguments of the macros SugarCube
 * doesn't split are read as JavaScript; in others, a backquoted expression is.
 */
function tagPassageLinks(tag: MacroTag, context: ReadContext): MacroPassageLink[] {
  if (RAW_ARGUMENT_MACROS.has(tag.name)) {
    return javaScriptPassageLinks(tag.args, context);
  }
  const lexed = lexMacroArgs(tag.args);
  if (lexed === undefined) {
    // SugarCube throws, so the call does nothing.
    return [];
  }
  const own = ownPassageLink(tag, lexed);
  const inner = lexed.flatMap((arg): MacroPassageLink[] => {
    switch (arg.kind) {
      case 'string':
        return markupPassageLinks(arg.value, deeper(context));
      case 'expression':
        return javaScriptPassageLinks(arg.code, context);
      case 'markup':
      case 'word':
        return [];
      default: {
        const _exhaustive: never = arg;
        throw new Error(`unhandled macro argument: ${JSON.stringify(_exhaustive)}`);
      }
    }
  });
  return own === undefined ? inner : [own, ...inner];
}

/**
 * The passage named by a `<<link>>` or `<<goto>>` that appears unquoted inside another tag's
 * arguments, at `start`. SugarCube never sees such an outer "tag" when its `<<` lies in text it
 * reads as something else, such as link markup (`[[<<-- Back|Prev]]`); the call inside it then
 * runs. The call ends where the outer tag ends.
 */
function innerPassageLink(
  matchTagAt: (start: number) => ScannedTag | undefined,
  start: number,
): MacroPassageLink | undefined {
  const inner = matchTagAt(start)?.tag;
  const lexed = inner === undefined ? undefined : lexMacroArgs(inner.args);
  return inner === undefined || lexed === undefined ? undefined : ownPassageLink(inner, lexed);
}

// Where a comment, a `<script>` element or italics can start: the other markup whose text holds
// no call. `//` is here only because it comes first, as in SugarCube: `//*` is italics.
const REGION_OPEN_RE = /\/\/|\/\*|\/%|<!--|<[Ss][Cc][Rr][Ii][Pp][Tt]/g;
const HAS_SCRIPT_OPEN_RE = /<[Ss][Cc][Rr][Ii][Pp][Tt]/;
// SugarCube's `(?:.|\n)*?` doesn't cross the other line terminators.
const SCRIPT_CLOSE_RE = /<\/[Ss][Cc][Rr][Ii][Pp][Tt]>|[\r\u2028\u2029]/g;
const COMMENT_CLOSE_RES: Readonly<Record<CommentKind, RegExp>> = {
  '/*': /\*\/|[\r\u2028\u2029]/g,
  '/%': /%\/|[\r\u2028\u2029]/g,
  '<!--': /-->|[\r\u2028\u2029]/g,
};
type CommentKind = '/*' | '/%' | '<!--';

/**
 * Returns a function that finds where a comment that opens at `start` ends, as SugarCube's
 * `commentByBlock` parser reads it, or `undefined` if it isn't closed. Calls of one kind must come
 * in increasing order: a search that fails stops at a line terminator or the end, and a later one
 * of the same kind that starts before that stop fails too, so it isn't made.
 */
function commentReader(text: string): (kind: CommentKind, start: number) => number | undefined {
  const failedUntil = new Map<CommentKind, number>();
  return (kind, start) => {
    if (start < (failedUntil.get(kind) ?? -1)) {
      return undefined;
    }
    const re = COMMENT_CLOSE_RES[kind];
    re.lastIndex = start + kind.length;
    const m = re.exec(text);
    if (m !== null && m[0].length > 1) {
      return m.index + m[0].length;
    }
    failedUntil.set(kind, m === null ? text.length : m.index);
    return undefined;
  };
}

/** Where a `<script>` element's opener ends and its content ends, if it is complete. */
interface ScriptElementScan {
  /** Index just past the opener's `>`, or `undefined` if no `>` follows. */
  readonly openerEnd: number | undefined;
  /** Index of the closing `</script>`, or `undefined` if the element isn't closed. */
  readonly close: number | undefined;
}

/**
 * Returns a function that reads a `<script>` element whose opener starts at a position, as
 * SugarCube's `verbatimScriptTag` parser reads it: the opener up to its `>`, then the content
 * up to the first `</script>`. Calls must come in increasing order; each part of the text is
 * searched once.
 */
function scriptElementReader(text: string): (start: number) => ScriptElementScan {
  let angle = -1;
  let noAngleAfter = Infinity;
  let failedBefore = -1;
  let noCloseAfter = Infinity;
  return (start) => {
    if (start + 7 >= noAngleAfter) {
      return { openerEnd: undefined, close: undefined };
    }
    if (angle < start + 7) {
      angle = text.indexOf('>', start + 7);
      if (angle === -1) {
        noAngleAfter = start + 7;
        return { openerEnd: undefined, close: undefined };
      }
    }
    const openerEnd = angle + 1;
    if (openerEnd < failedBefore || openerEnd >= noCloseAfter) {
      // The content would run into the line terminator where an earlier element failed.
      return { openerEnd, close: undefined };
    }
    SCRIPT_CLOSE_RE.lastIndex = openerEnd;
    const m = SCRIPT_CLOSE_RE.exec(text);
    if (m === null) {
      noCloseAfter = openerEnd;
      return { openerEnd, close: undefined };
    }
    if (m[0].length === 1) {
      failedBefore = m.index;
      return { openerEnd, close: undefined };
    }
    return { openerEnd, close: m.index };
  };
}

/**
 * Returns a function that finds the tag closing the `<<script>>` body that `opener` opens, as
 * SugarCube's `parseBody` finds it: scanning tags from every `<<` after the opener, without
 * skipping anything, for the first `<</script>>` or `<<endscript>>` that isn't matched by a
 * later `<<script>>`. (It doesn't reproduce parseBody's rejection of a closing tag with
 * arguments, nor its resuming inside the arguments of a tag whose name starts with `/` or
 * `end`.)
 *
 * The tags found from the start of the text are those parseBody finds from any opener among
 * them, so for such an opener the answer takes constant time. An opener the walk reached after
 * a comment may not be among them, when a tag that starts in the comment runs over it; then the
 * scan starts at the body and goes on until it finds the closer or reaches a tag of that list,
 * whose answers it then uses. All such scans in one reading of a passage, strings included, stop
 * once they have read four times as many characters as the passage has, plus a fixed allowance
 * (`budget`, see `readContext`); on input built to make them read more, the openers after that
 * are taken as unclosed. That keeps the time linear.
 */
function scriptBodyCloser(text: string, budget: { left: number }): (opener: MacroTag) => MacroTag | undefined {
  const tags = findMacroTags(text);
  const indexByStart = new Map(tags.map((tag, index) => [tag.start, index]));
  const lastClose = text.lastIndexOf('>>');
  const spend = (characters: number): void => {
    budget.left -= characters;
  };
  const step = (tag: MacroTag): number =>
    tag.name === 'script' ? 1 : tag.name === '/script' || tag.name === 'endscript' ? -1 : 0;
  // balance[k]: openers minus closers among the first k tags.
  const balance: number[] = [0];
  tags.forEach((tag, k) => balance.push((balance[k] ?? 0) + step(tag)));
  // firstBelow[k]: the first j > k with balance[j] < balance[k], if any.
  const firstBelow: (number | undefined)[] = [];
  const candidates: number[] = [];
  for (let k = balance.length - 1; k >= 0; k--) {
    const here = balance[k] ?? 0;
    let top = candidates[candidates.length - 1];
    while (top !== undefined && (balance[top] ?? 0) >= here) {
      candidates.pop();
      top = candidates[candidates.length - 1];
    }
    firstBelow[k] = top;
    candidates.push(k);
  }
  /**
   * The closer when `open` bodies are open just before `tags[index]`: each hop to
   * `firstBelow` closes one. `open` is at most one more than the openers scanned to get here.
   */
  const closeFrom = (index: number, open: number): MacroTag | undefined => {
    let k: number | undefined = index;
    for (let left = open; left > 0 && k !== undefined; left--) {
      k = firstBelow[k];
    }
    return k === undefined ? undefined : tags[k - 1];
  };
  return (opener) => {
    const index = indexByStart.get(opener.start);
    if (index !== undefined) {
      return closeFrom(index + 1, 1);
    }
    const matchTagAt = tagMatcher(text, lastClose, spend);
    let open = 1;
    let from = opener.end;
    while (budget.left >= 0) {
      const start = text.indexOf('<<', from);
      spend((start === -1 ? text.length : start) - from);
      if (start === -1) {
        return undefined;
      }
      const known = indexByStart.get(start);
      if (known !== undefined) {
        return closeFrom(known, open);
      }
      const tag = matchTagAt(start)?.tag;
      if (tag === undefined) {
        from = start + 2;
        continue;
      }
      open += step(tag);
      if (open === 0) {
        return tag;
      }
      from = tag.end;
    }
    return undefined;
  };
}

/** Adds `more` to the end of `links`, without spreading, which fails for very long lists. */
function append(links: MacroPassageLink[], more: readonly MacroPassageLink[]): void {
  for (const link of more) {
    links.push(link);
  }
}

/**
 * The passages that `<<link>>` and `<<goto>>` calls in passage markup name. Calls whose passage
 * is known only in play (a variable or an expression) are left out. A tag's own passage comes
 * before those of the calls inside its arguments' strings.
 *
 * The markup is walked in order, as SugarCube's wikifier walks it, with a tag tried at each
 * `<<` the walk reaches. Of the wikifier's other parsers, only those whose text holds no call
 * are told apart: comments (`/* … *` + `/`, `/% … %/`, `<!-- … -->`), whose calls never run,
 * and `<script>` elements and `<<script>>` bodies, which are JavaScript: only the calls in their
 * strings are read (see `findJavaScriptPassageLinks`). Everything else, verbatim text included,
 * is read as markup.
 *
 * Where this differs from SugarCube:
 * - a comment or a `<<script>>` body is skipped whole, even where `parseBody` ends a container
 *   such as `<<if>>` at a closing tag inside it and the rest then runs;
 * - a `/*`, `<!--` or `<script` inside other markup that holds no call, such as link markup or a
 *   `<style>` element, still starts a comment or an element;
 * - a `<<` in such other markup still starts a tag. When that tag runs over a `<<link` or
 *   `<<goto` outside the parts of its arguments that the tag pattern reads as units, that call
 *   is still read (see `innerPassageLink`), even where the tag's arguments would be JavaScript,
 *   as the check always read it. One that such a part covers is lost: a quoted string, or a `//`
 *   part up to a line feed (italics, a URL) when a `>>` follows later; and a `<<script>>` body
 *   the tag runs over is read as markup. The same recovery also reads a call inside a stray tag
 *   that SugarCube does see, and rejects as an unknown macro (`<<Back <<goto R>>`);
 * - a `<<script>>` body's end is found as `parseBody` finds it, except that parseBody rejects a
 *   closing tag with arguments, and resumes inside the arguments of a tag whose name starts with
 *   `/` or `end`;
 * - the lines of a `<<nobr>>` body, and of every passage when a story sets
 *   `Config.passages.nobr`, are not joined before they are read (see `storyInspect` for passages
 *   tagged `nobr`).
 */
export function findMacroPassageLinks(text: string): MacroPassageLink[] {
  return markupPassageLinks(text, readContext(text));
}

function markupPassageLinks(text: string, context: ReadContext): MacroPassageLink[] {
  if (context.depth > MAX_STRING_DEPTH || (!text.includes('<<') && !HAS_SCRIPT_OPEN_RE.test(text))) {
    return [];
  }
  const matchTagAt = tagMatcher(text);
  // For the calls inside tags' arguments, which also come in increasing order.
  const matchInnerTagAt = tagMatcher(text);
  const readComment = commentReader(text);
  const readScriptElement = scriptElementReader(text);
  let findScriptCloser: ((opener: MacroTag) => MacroTag | undefined) | undefined;
  const links: MacroPassageLink[] = [];

  /** Reads the region `opener` opens, adding the calls in a `<script>` element; returns where the walk goes on. */
  const regionEnd = (opener: RegExpExecArray): number => {
    const start = opener.index;
    const kind = opener[0];
    switch (kind) {
      case '//':
        // Italics, whose text is read on; `//*` is not a comment.
        return start + 2;
      case '/*':
      case '/%':
      case '<!--':
        return readComment(kind, start) ?? start + kind.length;
      default: {
        const element = readScriptElement(start);
        if (element.openerEnd === undefined) {
          // Not an opener SugarCube reads.
          return start + 1;
        }
        if (element.close === undefined) {
          // SugarCube reads the opener and nothing more; the content is markup.
          return element.openerEnd;
        }
        append(links, javaScriptPassageLinks(text.slice(element.openerEnd, element.close), context));
        return element.close + 9;
      }
    }
  };

  // The next `<<` and region opener at or after `pos`, searched again only once `pos` passes them.
  let macro = -2;
  let region: RegExpExecArray | null | undefined;
  let pos = 0;
  for (;;) {
    if (macro !== -1 && macro < pos) {
      macro = text.indexOf('<<', pos);
    }
    if (region !== null && (region === undefined || region.index < pos)) {
      REGION_OPEN_RE.lastIndex = pos;
      region = REGION_OPEN_RE.exec(text);
    }
    if (region !== null && (macro === -1 || region.index < macro)) {
      pos = regionEnd(region);
      continue;
    }
    if (macro === -1) {
      return links;
    }
    const scanned = matchTagAt(macro);
    if (scanned === undefined) {
      pos = macro + 2;
      continue;
    }
    const { tag, innerCall } = scanned;
    append(links, tagPassageLinks(tag, context));
    if (innerCall !== undefined) {
      const inner = innerPassageLink(matchInnerTagAt, innerCall);
      if (inner !== undefined) {
        links.push(inner);
      }
    }
    pos = tag.end;
    if (tag.name === 'script') {
      findScriptCloser ??= scriptBodyCloser(text, context.budget);
      const closer = findScriptCloser(tag);
      if (closer !== undefined) {
        append(links, javaScriptPassageLinks(text.slice(tag.end, closer.start), context));
        pos = closer.end;
      }
    }
  }
}

/**
 * The passages that `<<link>>` and `<<goto>>` calls in the strings of JavaScript source name,
 * such as a script passage or a `<<script>>` body: `$.wiki('<<goto "Room">>')`. Code outside
 * the strings isn't markup, so a call put together while the story plays, such as
 * `'<<goto "' + target + '">>'`, names no passage here.
 */
export function findJavaScriptPassageLinks(source: string): MacroPassageLink[] {
  return javaScriptPassageLinks(source, readContext(source));
}

function javaScriptPassageLinks(source: string, context: ReadContext): MacroPassageLink[] {
  if (context.depth >= MAX_STRING_DEPTH || (!source.includes('<<') && !source.includes('\\'))) {
    // No string in it can hold a macro: its text has no `<<`, and no escape could make one.
    return [];
  }
  const inner = deeper(context);
  const links: MacroPassageLink[] = [];
  for (const value of javaScriptStrings(source)) {
    append(links, markupPassageLinks(value, inner));
  }
  return links;
}

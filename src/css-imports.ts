/**
 * Which `@import` rules of the story stylesheet a browser ignores. CSS Cascade accepts an `@import` only before every
 * other valid rule. The only things that may come before it are other `@import` rules, `@layer` statements (an
 * `@layer` rule with no block) and an `@charset` at the very start of the stylesheet, which is not a rule but the
 * bytes that name the encoding. Anything else ends the place for imports: a style rule, `@namespace` and every other
 * at-rule, an `@layer` block, and an `@charset` anywhere but the start (an at-rule no browser knows there). Chromium
 * also ends it with an `@layer` statement that follows an `@import`, which the specification ignores, so the scan does
 * the same. The story's stylesheet passages and `.css` files are joined into one stylesheet, so an import that opens a
 * later source comes after the rules of the earlier ones. Tweego joins them the same way, so twee-ts keeps the text
 * and reports the import instead.
 *
 * The scan reads the sources as the one stylesheet they make, as CSS Syntax Level 3 tokenizes and parses it: comments,
 * strings, escapes, `url()` and bracketed blocks hide the characters inside them, a name written with escapes
 * (`@\69 mport`) is the name it spells, and a statement ends at a `;` (an at-rule) or at the `}` that closes its block.
 * A statement that is not an at-rule is a qualified rule, which reads on to its block: a stray `;`, `}` or declaration
 * swallows what follows it, `@import` rules included, and so does an at-rule that is not closed at the end of a
 * source, since the next source continues it. Those imports are ignored too, and reported.
 *
 * A rule no browser can parse (a prelude with a stray `;`, `)`, `]`, `}`, string or url, no prelude, or no block) is
 * dropped and ends nothing, whereas what a browser may not know, an unknown at-rule or an `@charset` away from the
 * start, is counted as a rule: some browsers end the place for imports with it. A selector this does not check (that
 * `a !` is not one) is counted as a rule as well. An unterminated `url(` ends with its source, where a browser reads
 * on to the next `)`, however far; what follows is reported as swallowed.
 */
import type { Diagnostic } from './types.js';

/** A stylesheet source of the story, with the name its diagnostics call it by. */
export interface StylesheetSource {
  readonly label: string;
  readonly text: string;
}

/**
 * What a top-level statement is, as far as the position of `@import` is concerned. `lost` is an `@import` that the
 * text before it swallows, so it is ignored wherever it stands.
 */
type Statement = 'import' | 'prelude' | 'rule' | 'lost' | 'dropped';

/** A statement and where it starts in the joined stylesheet. */
interface Located {
  readonly kind: Statement;
  readonly at: number;
}

/** The statement being read at the top level: an at-rule with its name, or a qualified rule. */
interface Open {
  readonly name: string | undefined;
  readonly at: number;
  hasBlock: boolean;
  /** Whether no selector or at-rule prelude can be this text, so the rule is dropped and ends nothing. */
  invalid: boolean;
  /** Where `@import` at-keywords stand inside it, which it swallows. */
  readonly swallowed: number[];
}

/** What the output puts between two sources: a line end, and a comment that names the next source. */
const JOINER = '\n/**/\n';
/** The opening brackets and, at the same index, the brackets that close them. */
const OPENERS = '{([';
const CLOSERS = '})]';
const HEX = /[0-9a-fA-F]/;
const NEWLINE = '\n\r\f';
const NAME_CHAR = /[-\w]|[^\0-\x7f]/;
/** An `@charset` rule as the encoding detection reads it: those bytes, at the very start. */
const CHARSET_AT_START = /^@charset "[^"\n\r\f]*";/;

/** Whether an escape starts at `i` (a backslash that is not followed by a newline). */
function startsEscape(css: string, i: number): boolean {
  return css.charAt(i) === '\\' && i + 1 < css.length && !NEWLINE.includes(css.charAt(i + 1));
}

/** Whether an identifier starts at `i`. */
function startsIdent(css: string, i: number): boolean {
  const ch = css.charAt(i);
  if (ch === '-') {
    const next = css.charAt(i + 1);
    return next === '-' || (next !== '' && /[A-Za-z_]|[^\0-\x7f]/.test(next)) || startsEscape(css, i + 1);
  }
  return (ch !== '' && /[A-Za-z_]|[^\0-\x7f]/.test(ch)) || startsEscape(css, i);
}

/** Where the escape at `i` (a backslash, then not a newline) ends. */
function escapeEnd(css: string, i: number): number {
  let j = i + 1;
  if (!HEX.test(css.charAt(j))) return j + 1;
  let digits = 0;
  while (digits < 6 && HEX.test(css.charAt(j))) {
    j += 1;
    digits += 1;
  }
  // One whitespace character after a hex escape belongs to it; a CR LF pair counts as one.
  if (css.startsWith('\r\n', j)) return j + 2;
  return /[ \t\n\r\f]/.test(css.charAt(j)) ? j + 1 : j;
}

/** The character a hex escape spells; a number that is no character reads as U+FFFD. */
function codePointName(code: number): string {
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code);
}

/** The name the escapes and characters of an identifier spell, lower-cased, and where it ends. */
function readIdent(css: string, start: number): { readonly name: string; readonly end: number } {
  let name = '';
  let i = start;
  while (i < css.length) {
    const ch = css.charAt(i);
    if (NAME_CHAR.test(ch)) {
      name += ch;
      i += 1;
    } else if (startsEscape(css, i)) {
      const end = escapeEnd(css, i);
      const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(i + 1, end))?.[0];
      name += hex === undefined ? css.slice(i + 1, end) : codePointName(Number.parseInt(hex, 16));
      i = end;
    } else {
      break;
    }
  }
  return { name: name.toLowerCase(), end: i };
}

/** Where the string that opens at `i` ends: after its closing quote, or at the newline that ends it as bad. */
function stringEnd(css: string, i: number): number {
  const quote = css.charAt(i);
  let j = i + 1;
  while (j < css.length && css.charAt(j) !== quote && !NEWLINE.includes(css.charAt(j)))
    j += css.charAt(j) === '\\' ? 2 : 1;
  return css.charAt(j) === quote ? j + 1 : Math.min(j, css.length);
}

/** Whether the `(` at `i` opens an unquoted `url(`, whose contents are one token that nothing inside ends. */
function opensRawUrl(css: string, i: number): boolean {
  if (!/(?:^|[^-\w\\]|[^\0-\x7f])url$/i.test(css.slice(Math.max(0, i - 4), i))) return false;
  const whitespace = /[ \t\n\r\f]*/y;
  whitespace.lastIndex = i + 1;
  whitespace.test(css);
  const after = css.charAt(whitespace.lastIndex);
  return after !== '"' && after !== "'";
}

/**
 * Where the unquoted url contents that start at `i` end: after the `)` that closes them, or at `limit` when there is
 * none (a url left open runs to the end of the stylesheet; here it ends with its source, so the statement it is in
 * stays open for the next source to continue, and what the next source starts is reported as swallowed).
 */
function rawUrlEnd(css: string, i: number, limit: number): number {
  let j = i;
  while (j < limit && css.charAt(j) !== ')') j += css.charAt(j) === '\\' ? 2 : 1;
  return Math.min(j + 1, limit);
}

/**
 * How the finished statement counts for the `@import` that follows it. A browser drops what it cannot parse, and a
 * dropped rule ends nothing: a qualified rule with a stray `;`, `)`, `]`, `}` or at-keyword in its prelude, with no
 * prelude, or with no block, is not a style rule in any browser; an `@import` with a block is no import, and a
 * block-less at-rule that swallowed an `@import` is not what it was written as. What a browser may or may not know,
 * an unknown at-rule or an `@charset` away from the start, is counted as a rule: some browsers end the place for
 * imports with it.
 */
function classify(open: Open, css: string): Statement {
  if (open.name === undefined) return open.invalid || !open.hasBlock ? 'dropped' : 'rule';
  switch (open.name) {
    case 'import':
      return open.hasBlock ? 'lost' : 'import';
    case 'layer':
      return open.hasBlock ? 'rule' : open.swallowed.length > 0 ? 'dropped' : 'prelude';
    case 'charset':
      return !open.hasBlock && open.at === 0 && CHARSET_AT_START.test(css) ? 'prelude' : 'rule';
    default:
      return !open.hasBlock && open.swallowed.length > 0 ? 'dropped' : 'rule';
  }
}

/**
 * The statements at the top level of `css`, in order, with the `@import` rules that an earlier statement swallows.
 * `sourceStarts` are the offsets at which each source starts: a block that opens in one source and is still open when
 * a later one starts swallows that source's imports.
 */
function topLevelStatements(css: string, sourceStarts: readonly number[]): Located[] {
  const found: Located[] = [];
  const sourceAt = (offset: number): number => sourceStarts.findLastIndex((start) => start <= offset);
  const sourceEnd = (offset: number): number => {
    const next = sourceStarts[sourceAt(offset) + 1];
    return next === undefined ? css.length : next - JOINER.length;
  };
  /** The expected closing brackets of the blocks that are open. */
  const closers: string[] = [];
  let outerOpenedIn = 0;
  let open: Open | undefined;
  const finish = (): void => {
    if (open === undefined) return;
    found.push({ kind: classify(open, css), at: open.at });
    for (const at of open.swallowed) found.push({ kind: 'lost', at });
    open = undefined;
  };
  const begin = (at: number, name: string | undefined): void => {
    open ??= { name, at, hasBlock: false, invalid: false, swallowed: [] };
  };
  /** A token no selector holds (a string, a url, a stray `;`, `)`, `]` or `}`) at the top level: it starts or joins a rule. */
  const beginInvalid = (at: number): void => {
    if (closers.length > 0) return;
    begin(at, undefined);
    if (open !== undefined && open.name === undefined) open.invalid = true;
  };
  let i = 0;
  while (i < css.length) {
    const ch = css.charAt(i);
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? css.length : close + 2;
    } else if (/[ \t\n\r\f]/.test(ch)) {
      i += 1;
    } else if (closers.length === 0 && open === undefined && (css.startsWith('<!--', i) || css.startsWith('-->', i))) {
      // CDO and CDC tokens between top-level rules are skipped.
      i += css.startsWith('<!--', i) ? 4 : 3;
    } else if (ch === '@' && startsIdent(css, i + 1)) {
      const { name, end } = readIdent(css, i + 1);
      if (closers.length === 0) {
        if (open === undefined) begin(i, name);
        else {
          if (name === 'import') open.swallowed.push(i);
          if (open.name === undefined) open.invalid = true;
        }
      } else if (name === 'import' && sourceAt(i) > outerOpenedIn) {
        found.push({ kind: 'lost', at: i });
      }
      i = end;
    } else if (ch === '"' || ch === "'") {
      beginInvalid(i);
      i = stringEnd(css, i);
    } else if (ch === '\\') {
      if (closers.length === 0) begin(i, undefined);
      i = startsEscape(css, i) ? escapeEnd(css, i) : i + 1;
    } else if (ch === '(' && opensRawUrl(css, i)) {
      beginInvalid(i);
      i = rawUrlEnd(css, i + 1, sourceEnd(i));
    } else if (OPENERS.includes(ch)) {
      if (closers.length === 0) {
        // A block with no prelude before it belongs to no rule.
        begin(i, undefined);
        outerOpenedIn = sourceAt(i);
        if (ch === '{' && open !== undefined) {
          open.invalid ||= open.at === i;
          open.hasBlock = true;
        }
      }
      closers.push(CLOSERS.charAt(OPENERS.indexOf(ch)));
      i += 1;
    } else if (ch === closers.at(-1)) {
      closers.pop();
      // A block closed at the top level ends a qualified rule or an at-rule.
      if (closers.length === 0 && ch === '}') finish();
      i += 1;
    } else if (closers.length === 0 && ch === ';' && open?.name !== undefined) {
      // An at-rule without a block ends here.
      finish();
      i += 1;
    } else {
      // Any other token, a stray `;`, `}`, `)` or `]` included, starts a qualified rule when none is open.
      if (';)]}'.includes(ch)) beginInvalid(i);
      else if (closers.length === 0) begin(i, undefined);
      i += 1;
    }
  }
  finish();
  return found;
}

/**
 * A warning for each source whose `@import` rules a browser ignores in the joined story stylesheet: those that come
 * after a rule of the stylesheet, and those that an earlier statement swallows. The imported stylesheet is never
 * requested.
 */
export function ineffectiveImportDiagnostics(sources: readonly StylesheetSource[]): Diagnostic[] {
  // The sources are joined as the output joins them: each ends its line and then a comment names the next one.
  const starts: number[] = [];
  let css = '';
  for (const { text } of sources) {
    if (starts.length > 0) css += JOINER;
    starts.push(css.length);
    css += text;
  }
  const ignored: number[] = [];
  let ruleSeen = false;
  let importSeen = false;
  for (const { kind, at } of topLevelStatements(css, starts)) {
    // Chromium takes an `@layer` statement after an `@import` for the end of the imports, as it does a rule, though
    // the specification ignores the statement there: layer statements belong before the first import.
    if (kind === 'rule' || (kind === 'prelude' && importSeen)) ruleSeen = true;
    else if (kind === 'lost' || (kind === 'import' && ruleSeen)) {
      ignored.push(starts.findLastIndex((start) => start <= at));
    }
    if (kind === 'import') importSeen = true;
  }
  return sources.flatMap(({ label }, index): Diagnostic[] => {
    const count = ignored.filter((i) => i === index).length;
    if (count === 0) return [];
    return [
      {
        level: 'warning',
        message:
          `${label} has ${count === 1 ? 'an @import rule' : `${count} @import rules`} that browsers ignore in the ` +
          `story stylesheet: ${count === 1 ? 'it comes' : 'they come'} after other rules, or ` +
          `${count === 1 ? 'is' : 'are'} part of a rule that is not finished (a ";" or "}" is missing before or ` +
          'after), so the imported stylesheet is never loaded. ' +
          'Only an @charset at the very start and @layer statements may come before an @import. ' +
          'Move the import to the start of the first stylesheet, or add the file as a head module.',
      },
    ];
  });
}

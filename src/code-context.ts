/**
 * The lexical context of a position in JavaScript or CSS source: inside a string literal, a template literal, a
 * comment, or code. The template filler uses it to escape a placeholder written into a script or style element, and
 * the script and style escapers use it to tell whether `<\/script` keeps the value of what it escapes.
 *
 * JavaScript is parsed with acorn (bundled), which establishes regular expressions, divisions and template tags
 * from the grammar. JSON string tokens are read after RFC 8259 validation. CSS needs only strings and comments,
 * which CSS Syntax Level 3 tokenizes without context.
 */
import { tokTypes } from 'acorn';
import { AcornParser, SCRIPT_OPTIONS, javaScriptNodes, parseScript } from './js-syntax.js';
import { parseJSON } from './json-decode.js';

/** Where a range of JavaScript source lies. */
export type JavaScriptContext =
  | { readonly kind: 'string'; readonly quote: '"' | "'"; readonly whole: boolean }
  | { readonly kind: 'template'; readonly tagged: boolean }
  | { readonly kind: 'regexp'; readonly flags: string }
  | { readonly kind: 'block-comment' }
  /** A single-line comment: `//`, or one of the HTML-like comments of classic scripts, which `start` with `<!--`. */
  | { readonly kind: 'line-comment'; readonly start: number }
  | { readonly kind: 'code' }
  /** acorn could not read the source or establish a template's syntax; `reason` says why. */
  | { readonly kind: 'unparsable'; readonly reason: string };

/** Where a range of CSS source lies. */
export type CssContext =
  { readonly kind: 'string'; readonly quote: '"' | "'" } | { readonly kind: 'comment' } | { readonly kind: 'code' };

/** A half-open range of offsets into a source text. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

interface JavaScriptPiece extends SourceRange {
  readonly context: JavaScriptContext;
}

/** A range and the context it lies in. */
export interface InContext<R, C> {
  readonly range: R;
  readonly context: C;
}

/**
 * The JavaScript context of each of `ranges` in `source`, a classic script or (with `module`) a module script. A
 * range that lies inside one string, template piece, regular expression or comment gets that context (`whole` tells
 * whether a string literal is exactly the range, quotes included); any other range is `code`.
 */
export function javaScriptContexts<R extends SourceRange>(
  source: string,
  ranges: readonly R[],
  module = false,
): InContext<R, JavaScriptContext>[] {
  return contextsInPieces(javaScriptPieces(source, module), ranges);
}

/**
 * JSON has no regexp/division ambiguity. Validate with the iterative JSON parser, then read string tokens without
 * imposing JavaScript's object-literal semantics or recursive parser stack limit on JSON data blocks.
 */
export function jsonContexts<R extends SourceRange>(
  source: string,
  ranges: readonly R[],
): InContext<R, JavaScriptContext>[] {
  if (!parseJSON(source).ok) return javaScriptContexts(source, ranges);
  const pieces: JavaScriptPiece[] = [];
  for (const { type, start, end } of AcornParser.tokenizer(source, SCRIPT_OPTIONS)) {
    if (type === tokTypes.string) {
      pieces.push({ start, end, context: { kind: 'string', quote: '"', whole: false } });
    }
  }
  return contextsInPieces(pieces, ranges);
}

/** Classify ranges against non-overlapping literal/comment pieces, keeping each caller's range identity. */
function contextsInPieces<R extends SourceRange>(
  pieces: readonly JavaScriptPiece[],
  ranges: readonly R[],
): InContext<R, JavaScriptContext>[] {
  return ranges.map((range) => {
    const piece = enclosingPiece(pieces, range);
    if (piece === undefined) return { range, context: { kind: 'code' } };
    const { context } = piece;
    const whole = piece.start === range.start && piece.end === range.end;
    return { range, context: context.kind === 'string' ? { ...context, whole } : context };
  });
}

/**
 * The first of `pieces` that contains `range`. `pieces` are in source order and do not overlap, so their ends do not
 * decrease: a binary search finds the first piece that ends at or after the range, and only pieces starting at or
 * before the range can contain it (several only when empty pieces share an offset).
 */
function enclosingPiece<P extends SourceRange>(pieces: readonly P[], range: SourceRange): P | undefined {
  let low = 0;
  let high = pieces.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((pieces[mid]?.end ?? Infinity) < range.end) low = mid + 1;
    else high = mid;
  }
  for (let piece = pieces[low]; piece !== undefined && piece.start <= range.start; piece = pieces[++low]) {
    if (piece.end >= range.end) return piece;
  }
  return undefined;
}

/**
 * The literals and comments of JavaScript source, in source order, read as a classic script (see `js-syntax.ts`) or
 * a module, allowing `return` outside functions as story formats do around story code. Only tokens consumed by
 * the parser establish contexts: standalone tokenization guesses incorrectly at some regexp/division boundaries.
 * On failure, keep the confirmed prefix and report the unread remainder and uncertain template tags conservatively.
 */
function javaScriptPieces(source: string, module: boolean): JavaScriptPiece[] {
  const pieces: JavaScriptPiece[] = [];
  let readEnd = 0;
  const parsed = parseScript(source, {
    ...SCRIPT_OPTIONS,
    sourceType: module ? 'module' : 'script',
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    onComment: (block, _text, start, end) => {
      pieces.push({ start, end, context: block ? { kind: 'block-comment' } : { kind: 'line-comment', start } });
    },
    onToken: ({ type, start, end }) => {
      readEnd = end;
      if (type === tokTypes.string) {
        const quote = source[start] === "'" ? "'" : '"';
        pieces.push({ start, end, context: { kind: 'string', quote, whole: false } });
      } else if (type === tokTypes.regexp) {
        const raw = source.slice(start, end);
        pieces.push({ start, end, context: { kind: 'regexp', flags: raw.slice(raw.lastIndexOf('/') + 1) } });
      } else if (type === tokTypes.template || type === tokTypes.invalidTemplate) {
        pieces.push({ start, end, context: { kind: 'template', tagged: false } });
      }
    },
  });
  const tagged = new Set<number>();
  if (parsed.ok) {
    for (const node of javaScriptNodes(parsed.value)) {
      if (node.type === 'TaggedTemplateExpression') {
        for (const quasi of node.quasi.quasis) tagged.add(quasi.start);
      }
    }
  }
  const confirmed = parsed.ok ? pieces : pieces.filter((piece) => piece.end <= readEnd);
  if (!parsed.ok) {
    confirmed.push({
      start: readEnd,
      end: source.length,
      context: { kind: 'unparsable', reason: parsed.error.message },
    });
  }
  return confirmed
    .map<JavaScriptPiece>((piece) => {
      if (piece.context.kind !== 'template') return piece;
      return {
        ...piece,
        context: parsed.ok
          ? { kind: 'template', tagged: tagged.has(piece.start) }
          : { kind: 'unparsable', reason: parsed.error.message },
      };
    })
    .sort((a, b) => a.start - b.start);
}

/**
 * The CSS context of each of `ranges` in `source`, tokenized as CSS Syntax Level 3 does: a comment runs from `/*` to
 * the next `*\/`; a string from a quote to the same unescaped quote or an unescaped line break (a bad string); a
 * backslash escapes the next character.
 */
export function cssContexts<R extends SourceRange>(source: string, ranges: readonly R[]): InContext<R, CssContext>[] {
  const pieces = cssPieces(source);
  return ranges.map((range) => {
    const piece = enclosingPiece(pieces, range);
    return { range, context: piece === undefined ? { kind: 'code' } : piece.context };
  });
}

interface CssPiece extends SourceRange {
  readonly context: CssContext;
}

function cssPieces(source: string): CssPiece[] {
  const pieces: CssPiece[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      pieces.push({ start: i, end, context: { kind: 'comment' } });
      i = end;
    } else if (ch === '"' || ch === "'") {
      const end = cssStringEnd(source, i + 1, ch);
      pieces.push({ start: i, end, context: { kind: 'string', quote: ch } });
      i = end;
    } else if (ch === '\\') {
      i += 2;
    } else {
      i += 1;
    }
  }
  return pieces;
}

/** The offset after a CSS string whose content starts at `from`. */
function cssStringEnd(source: string, from: number, quote: string): number {
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === quote) return i + 1;
    // An unescaped line break ends a bad string before it.
    if (ch === '\n' || ch === '\r' || ch === '\f') return i;
    // CSS input preprocessing treats CRLF as one newline; an escaped pair continues the same string.
    i += ch === '\\' ? (source[i + 1] === '\r' && source[i + 2] === '\n' ? 3 : 2) : 1;
  }
  return source.length;
}

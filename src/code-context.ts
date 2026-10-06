/**
 * The lexical context of a position in JavaScript or CSS source: inside a string literal, a template literal, a
 * comment, or code. The template filler uses it to escape a placeholder written into a script or style element, and
 * the script and style escapers use it to tell whether `<\/script` keeps the value of what it escapes.
 *
 * JavaScript is tokenized with acorn (bundled), which tells a regular expression literal from a division the way a
 * parser does. CSS needs only strings and comments, which CSS Syntax Level 3 tokenizes without context.
 */
import { tokTypes } from 'acorn';
import type { Token } from 'acorn';
import { AcornParser, SCRIPT_OPTIONS, trySyntax } from './js-syntax.js';

/** Where a range of JavaScript source lies. */
export type JavaScriptContext =
  | { readonly kind: 'string'; readonly quote: '"' | "'"; readonly whole: boolean }
  | { readonly kind: 'template'; readonly tagged: boolean }
  | { readonly kind: 'regexp'; readonly flags: string }
  | { readonly kind: 'block-comment' }
  /** A single-line comment: `//`, or one of the HTML-like comments of classic scripts, which `start` with `<!--`. */
  | { readonly kind: 'line-comment'; readonly start: number }
  | { readonly kind: 'code' }
  /** acorn could not tokenize the source; `reason` says why. */
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
  const read = trySyntax(() => javaScriptPieces(source, module));
  if (!read.ok) return ranges.map((range) => ({ range, context: { kind: 'unparsable', reason: read.error.message } }));
  const pieces = read.value;
  return ranges.map((range) => {
    const piece = pieces.find((p) => p.start <= range.start && range.end <= p.end);
    if (piece === undefined) return { range, context: { kind: 'code' } };
    const { context } = piece;
    const whole = piece.start === range.start && piece.end === range.end;
    return { range, context: context.kind === 'string' ? { ...context, whole } : context };
  });
}

/**
 * The literals and comments of JavaScript source, in source order, read as a classic script (see `js-syntax.ts`) or
 * a module, allowing what story formats allow around story code (`return` and `await` outside functions). Throws a
 * `JsSyntaxError` when acorn cannot tokenize it.
 */
function javaScriptPieces(source: string, module: boolean): JavaScriptPiece[] {
  const pieces: JavaScriptPiece[] = [];
  const tokens = AcornParser.tokenizer(source, {
    ...SCRIPT_OPTIONS,
    sourceType: module ? 'module' : 'script',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    onComment: (block, _text, start, end) => {
      pieces.push({ start, end, context: block ? { kind: 'block-comment' } : { kind: 'line-comment', start } });
    },
  });
  // A template literal is tagged when an expression ends right before its opening backquote.
  const openTemplates: boolean[] = [];
  let previous: Token | undefined;
  for (const token of tokens) {
    const { type, start, end } = token;
    if (type === tokTypes.string) {
      const quote = source[start] === "'" ? "'" : '"';
      pieces.push({ start, end, context: { kind: 'string', quote, whole: false } });
    } else if (type === tokTypes.regexp) {
      const raw = source.slice(start, end);
      pieces.push({ start, end, context: { kind: 'regexp', flags: raw.slice(raw.lastIndexOf('/') + 1) } });
    } else if (type === tokTypes.backQuote) {
      if (previous?.type === tokTypes.template || previous?.type === tokTypes.invalidTemplate) {
        openTemplates.pop();
      } else {
        openTemplates.push(previous !== undefined && endsExpression(previous));
      }
    } else if (type === tokTypes.template || type === tokTypes.invalidTemplate) {
      const tagged = openTemplates[openTemplates.length - 1] === true;
      pieces.push({ start, end, context: { kind: 'template', tagged } });
    }
    previous = token;
  }
  return pieces.sort((a, b) => a.start - b.start);
}

/** Whether `token` can end an expression, so that a template literal after it is a tagged template. */
function endsExpression(token: Token): boolean {
  const { type } = token;
  return (
    type === tokTypes.name ||
    type === tokTypes.parenR ||
    type === tokTypes.bracketR ||
    type === tokTypes.backQuote ||
    type === tokTypes._this ||
    type === tokTypes._super ||
    type === tokTypes.privateId
  );
}

/**
 * The CSS context of each of `ranges` in `source`, tokenized as CSS Syntax Level 3 does: a comment runs from `/*` to
 * the next `*\/`; a string from a quote to the same unescaped quote or an unescaped line break (a bad string); a
 * backslash escapes the next character.
 */
export function cssContexts<R extends SourceRange>(source: string, ranges: readonly R[]): InContext<R, CssContext>[] {
  const pieces = cssPieces(source);
  return ranges.map((range) => {
    const piece = pieces.find((p) => p.start <= range.start && range.end <= p.end);
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
    i += ch === '\\' ? 2 : 1;
  }
  return source.length;
}

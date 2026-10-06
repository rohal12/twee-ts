/**
 * The ECMAScript character classes the JavaScript and SugarCube readers share, so that every
 * reader agrees on what ends a line and how positions are counted (ECMA-262 §12.2–12.3).
 *
 * - LineTerminator: LF, CR, LS (U+2028) and PS (U+2029); CR LF is one line break.
 * - WhiteSpace: JavaScript's `\s` is exactly WhiteSpace plus LineTerminator, U+FEFF and every Zs
 *   character included, so readers that mean JavaScript's white space use `\s`.
 * - Identifier characters (ID_Start, ID_Continue, `$`, `_`, ZWNJ, ZWJ and `\u` escapes) are read by
 *   acorn, which every JavaScript reader here goes through.
 */

/** The four ECMAScript line terminators: LF, CR, LS and PS. */
export const LINE_TERMINATORS = '\n\r\u2028\u2029';

/** A line break: CR LF counts as one, as ECMAScript and acorn count lines. */
const LINE_BREAK_RE = /\r\n?|[\n\u2028\u2029]/g;

/** Whether `ch` is one of the four ECMAScript line terminators. */
export function isLineTerminator(ch: string | undefined): boolean {
  return ch?.length === 1 && LINE_TERMINATORS.includes(ch);
}

/** The index of the first line terminator at or after `from` in `text`, or `text.length`. */
export function lineEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (isLineTerminator(text[i])) return i;
  }
  return text.length;
}

/** A 1-based line and column, the column counted in UTF-16 code units. */
export interface LineColumn {
  readonly line: number;
  readonly column: number;
}

/**
 * Returns a function that gives the line and column of an offset in `text`, counting every
 * ECMAScript line break. The line starts are found once, on the first call, so each later call
 * takes logarithmic time.
 */
export function lineColumnFinder(text: string): (offset: number) => LineColumn {
  let starts: number[] | undefined;
  return (offset) => {
    starts ??= [0, ...Array.from(text.matchAll(LINE_BREAK_RE), (m) => m.index + m[0].length)];
    // The last line start at or before `offset`.
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (Number(starts[mid]) <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - Number(starts[low]) + 1 };
  };
}

/** `line L, column C` for an offset in `text`. */
export function describePosition(where: LineColumn): string {
  return `line ${where.line}, column ${where.column}`;
}

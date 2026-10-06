/**
 * The rules of Twee notation that more than one part of twee-ts needs: what whitespace is, how names and tags
 * are escaped, which line is a passage header, and how source text is normalized before it is read. The
 * reader (`lexer.ts`, `parser.ts`) and the writer (`output-twee.ts`, which checks its output by reading it
 * back with the reader) both use only these, so the two cannot disagree.
 *
 * Twee semantics follow Tweego (Go): whitespace is Go's `unicode.IsSpace`, trimming is `bytes.TrimSpace` and
 * splitting tags is `strings.Fields`. The intended differences from Tweego are listed in
 * docs/tweego-differences.md.
 */

// --- Whitespace ---

/**
 * Whether a UTF-16 code unit is white space as Go's `unicode.IsSpace` defines it: tab, line feed, vertical
 * tab, form feed, carriage return, space, U+0085 (NEL), U+00A0 (NBSP), and the other Unicode White_Space
 * characters (U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000). All of them are in the Basic
 * Multilingual Plane, so a surrogate is never white space.
 *
 * This differs from JavaScript's `\s` and `String.prototype.trim()`, which include U+FEFF and leave out
 * U+0085.
 */
export function isTweeSpace(unit: number): boolean {
  if (unit <= 0xff) {
    return (unit >= 0x09 && unit <= 0x0d) || unit === 0x20 || unit === 0x85 || unit === 0xa0;
  }
  return (
    unit === 0x1680 ||
    (unit >= 0x2000 && unit <= 0x200a) ||
    unit === 0x2028 ||
    unit === 0x2029 ||
    unit === 0x202f ||
    unit === 0x205f ||
    unit === 0x3000
  );
}

/** `s` without white space (see `isTweeSpace`) at either end, as Go's `bytes.TrimSpace`. */
export function trimTweeSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isTweeSpace(s.charCodeAt(start))) start++;
  while (end > start && isTweeSpace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/** The runs of non-white-space characters in `s` (see `isTweeSpace`), as Go's `strings.Fields`. */
export function splitTweeFields(s: string): string[] {
  const fields: string[] = [];
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const space = i === s.length || isTweeSpace(s.charCodeAt(i));
    if (space && start !== -1) {
      fields.push(s.slice(start, i));
      start = -1;
    } else if (!space && start === -1) {
      start = i;
    }
  }
  return fields;
}

// --- Escaping in passage headers ---

/**
 * Escape a passage name or tag list for a Twee 3 header: a backslash goes before each `\`, `[`, `]`, `{` and
 * `}` (Tweego's `tweeEscapeString`).
 */
export function tweeEscape(s: string): string {
  return s.replace(/[\\[\]{}]/g, (ch) => '\\' + ch);
}

export interface Unescaped {
  readonly text: string;
  /** Whether `s` ended in a backslash that escapes nothing; it is dropped, as in Tweego. */
  readonly danglingBackslash: boolean;
}

/**
 * Unescape a passage name or tag list from a Twee header: a backslash yields the character after it, whatever
 * it is (the Twee 3 specification: `\q` yields `q`). A backslash at the very end escapes nothing and is
 * dropped, as Tweego's `tweeUnescapeBytes` drops it; `danglingBackslash` says so, so the caller can warn.
 */
export function tweeUnescape(s: string): Unescaped {
  let text = '';
  let chunk = 0;
  for (let i = s.indexOf('\\'); i !== -1; i = s.indexOf('\\', i + 2)) {
    text += s.slice(chunk, i);
    if (i + 1 >= s.length) return { text, danglingBackslash: true };
    chunk = i + 1;
  }
  return { text: text + s.slice(chunk), danglingBackslash: false };
}

// --- Passage headers and source text ---

/** The delimiter that starts a passage header line. */
const HEADER_DELIMITER = '::';

/** Byte order marks at the start of the text, or at the start of a line directly before a header's `::`. */
const BOMS_TO_REMOVE = /^\ufeff+|(?<=\n)\ufeff+(?=::)/g;

/**
 * Normalize Twee source text before it is read: CRLF and CR line endings become LF, the byte order marks at
 * the start of the text are removed, and so are those at the start of a later line that are directly followed
 * by `::`. Concatenating files (`cat a.tw b.tw`) leaves the BOM of every later file in front of its first
 * passage header, which would otherwise not be read as a header. (Tweego removes only the BOM at the start of
 * a file; this is an intended difference.) A U+FEFF anywhere else is passage text and kept. Idempotent.
 */
export function normalizeTweeSource(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(BOMS_TO_REMOVE, '');
}

/** The lines of `text`, split at LF, CRLF and CR, as normalization ends them. */
export function sourceLines(text: string): string[] {
  return text.split(/\r\n?|\n/);
}

/**
 * Whether a line of source text reads as a passage header: it starts with `::`, after any byte order marks
 * (which normalization removes there; see `normalizeTweeSource`).
 */
export function isHeaderLine(line: string): boolean {
  let i = 0;
  while (line.charCodeAt(i) === 0xfeff) i++;
  return line.startsWith(HEADER_DELIMITER, i);
}

/**
 * Remove the trailing blank lines of passage content, which the Twee 3 specification requires a reader to drop
 * even when it does not trim: the lines after the last line that holds anything but white space (see
 * `isTweeSpace`). Content that is all white space becomes empty. Leading white space and the white space at
 * the end of the last line with content are kept. Linear time.
 */
export function stripTrailingBlankLines(text: string): string {
  let last = text.length - 1;
  while (last >= 0 && isTweeSpace(text.charCodeAt(last))) last--;
  if (last < 0) return '';
  const lineEnd = text.indexOf('\n', last);
  return lineEnd === -1 ? text : text.slice(0, lineEnd);
}

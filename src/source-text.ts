/**
 * Source text normalization shared by every input path (files, in-memory sources, `parseTwee`).
 */

/**
 * Strip a leading UTF-8 byte order mark and convert CRLF and bare CR line endings to LF.
 * Idempotent, so text that is already normalized passes through unchanged.
 */
export function normalizeSourceText(text: string): string {
  const withoutBOM = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBOM.replace(/\r\n?/g, '\n');
}

/** Byte order marks at the start of a line, directly before a passage header's `::`. */
const BOMS_BEFORE_HEADER = /(?<=^|\n)\uFEFF+(?=::)/g;

/**
 * Normalize Twee source text: {@link normalizeSourceText}, and also remove byte order marks at the start of
 * a line that are directly followed by `::`. Concatenating files (`cat a.tw b.tw`) leaves the BOM of every
 * later file in front of its first passage header, which would otherwise not be recognised as a header.
 * A U+FEFF anywhere else is passage text and kept. Idempotent.
 */
export function normalizeTweeSourceText(text: string): string {
  return normalizeSourceText(text).replace(BOMS_BEFORE_HEADER, '');
}

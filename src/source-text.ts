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

/**
 * Source text normalization shared by every input path (files, in-memory sources, `parseTwee`), and the quoting of
 * source characters in diagnostics.
 */

/**
 * Strip a leading UTF-8 byte order mark and convert CRLF and bare CR line endings to LF.
 * Idempotent, so text that is already normalized passes through unchanged.
 */
export function normalizeSourceText(text: string): string {
  const withoutBOM = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBOM.replace(/\r\n?/g, '\n');
}

/**
 * The character of `text` at the UTF-16 index `index`, for quoting in a diagnostic: the whole code point where a
 * surrogate pair starts there, and a lone surrogate written as `\uXXXX`, so that the message stays a well-formed
 * string. Empty past the end of `text`.
 */
export function quotableCharacterAt(text: string, index: number): string {
  const cp = text.codePointAt(index);
  return cp === undefined ? '' : escapeLoneSurrogates(String.fromCodePoint(cp));
}

/** A surrogate that is not part of a pair. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `text` with each lone surrogate written as `\uXXXX`: a well-formed string for a diagnostic. */
export function escapeLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, (unit) => `\\u${unit.charCodeAt(0).toString(16).toUpperCase()}`);
}

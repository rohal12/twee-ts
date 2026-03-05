/**
 * HTML, attribute, tiddler, and twee escaping/unescaping utilities.
 * Ported from escaping.go.
 */

/** Escape the minimum characters required for HTML attribute values. */
export function attrEscape(s: string): string {
  if (s.length === 0) return s;
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escape for HTML attribute values including < and > (for spec-compliant output). */
export function fullAttrEscape(s: string): string {
  if (s.length === 0) return s;
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape the minimum characters required for general HTML content. */
export function htmlEscape(s: string): string {
  if (s.length === 0) return s;
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for Twine 1 tiddler format. */
export function tiddlerEscape(s: string): string {
  if (s.length === 0) return s;
  return s
    .replace(/\\/g, '\\s')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n');
}

/** Unescape from Twine 1 tiddler format. */
export function tiddlerUnescape(s: string): string {
  if (s.length === 0) return s;
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\s/g, '\\');
}

/** Escape characters that are special in Twee passage names/tags. */
export function tweeEscape(s: string): string {
  if (s.length === 0) return s;
  return s.replace(/[\\[\]{}]/g, (ch) => '\\' + ch);
}

/** Escape a string for safe inclusion in a JavaScript string literal. */
export function jsStringEscape(s: string): string {
  if (s.length === 0) return s;
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Sanitize a string for safe inclusion in a CSS or JS block comment. */
export function commentSanitize(s: string): string {
  return s.replace(/\*\//g, '* /');
}

/** Sanitize a string for safe inclusion in an HTML comment. */
export function htmlCommentSanitize(s: string): string {
  return s.replace(/-->/g, '-- >');
}

/** Apply ROT13 encoding to a string (only affects [A-Za-z]). */
export function rot13(s: string): string {
  if (s.length === 0) return s;
  return s.replace(/[A-Za-z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/** Unescape backslash-escaped Twee characters. */
export function tweeUnescape(s: string): string {
  if (s.length === 0) return s;
  let result = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      if (i >= s.length) {
        result += '\\';
        break;
      }
    }
    result += s[i];
  }
  return result;
}

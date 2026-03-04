/**
 * HTML, attribute, tiddler, and twee escaping/unescaping utilities.
 * Ported from escaping.go.
 */

/** Escape the minimum characters required for HTML attribute values. */
export function attrEscape(s: string): string {
  if (s.length === 0) return s;
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

/** Unescape backslash-escaped Twee characters. */
export function tweeUnescape(s: string): string {
  if (s.length === 0) return s;
  let result = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      if (i >= s.length) break;
    }
    result += s[i];
  }
  return result;
}

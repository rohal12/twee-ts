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

const JS_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '<': '\\x3C',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * Escape a string for the inside of a single- or double-quoted JavaScript string literal, including one written
 * into an HTML `<script>` element. Besides backslashes, quotes and line breaks (with U+2028 and U+2029, which end
 * a string literal in JavaScript before ES2019), every `<` becomes `\x3C`, so the literal holds no `</script`
 * that would end the element and no `<!--` or `<script` that would change where it ends. The string's value is
 * unchanged.
 */
export function jsStringEscape(s: string): string {
  if (s.length === 0) return s;
  return s.replace(/[\\"'\n\r\t<\u2028\u2029]/g, (ch) => JS_STRING_ESCAPES[ch] ?? ch);
}

/**
 * Escape a string for the inside of a double-quoted CSS string (such as a `font-family` name): `\` and `"` get
 * a backslash, and line breaks and other control characters become hex escapes followed by a space (`\a ` for a
 * line feed), since a raw line break ends a CSS string and a backslash before one is a line continuation.
 */
export function cssStringEscape(s: string): string {
  if (s.length === 0) return s;
  return s.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) =>
    ch === '\\' || ch === '"' ? `\\${ch}` : `\\${ch.charCodeAt(0).toString(16)} `,
  );
}

/** Sanitize a string for safe inclusion in a CSS or JS block comment. */
export function commentSanitize(s: string): string {
  return s.replace(/\*\//g, '* /');
}

/** Sanitize a string for safe inclusion in an HTML comment: break up `-->` and `--!>`, which both end one. */
export function htmlCommentSanitize(s: string): string {
  return s.replace(/--(!?)>/g, '--$1 >');
}

/**
 * Escape JavaScript for the content of an HTML `<script>` element, so that the HTML parser reads all of it as
 * the element's text and ends the element at the end tag written after it.
 *
 * - Every `</script` (in any letter case) becomes `<\/script`. HTML ends a script element at the first
 *   `</script` followed by whitespace, `/` or `>`, wherever it is in the JavaScript, even inside a string.
 * - Every `<!--` becomes `<\!--`, but only if the text would otherwise end in the HTML tokenizer's "script
 *   data double escaped" state: after a `<!--` and then a `<script` start tag with no `-->` between them, the
 *   end tag after the text would not end the element.
 *
 * Inserting a backslash after `<` keeps the value of every string, template, and regular expression literal
 * and every comment where these sequences can be written (`\/` and `\!` are identity escapes; a backslash
 * already before the `<` escapes the `<`, as it did before); `<\/script` is also how minifiers such as Terser
 * write inline scripts. It only changes code that uses them outside literals (`a </script/ b`, an HTML-like `<!--`
 * comment that is escaped because of a later `<script`), the raw text of a tagged template, and a `<!--` in a
 * regular expression with the `u` or `v` flag. The result is unchanged by escaping it again.
 */
export function scriptContentEscape(s: string): string {
  const escaped = s.replace(/<(?=\/script)/gi, '<\\');
  return endsDoubleEscaped(escaped) ? escaped.replace(/<(?=!--)/g, '<\\') : escaped;
}

/**
 * Whether the HTML tokenizer, reading `s` as script element content with no `</script` in it, ends in the
 * "script data double escaped" state, where an end tag after `s` would not end the element.
 * See https://html.spec.whatwg.org/multipage/parsing.html#script-data-escaped-state.
 */
function endsDoubleEscaped(s: string): boolean {
  const scriptStartTag = /<script[\t\n\f\r />]/gi;
  let pos = 0;
  for (;;) {
    // Script data: a `<!--` enters the escaped state.
    const open = s.indexOf('<!--', pos);
    if (open === -1) return false;
    // Escaped: a `-->` leaves it (the dashes of `<!--` count, so `<!-->` leaves at once); a `<script` start
    // tag enters the double escaped state.
    const escapedFrom = open + 2;
    const close = s.indexOf('-->', escapedFrom);
    scriptStartTag.lastIndex = escapedFrom;
    const start = scriptStartTag.exec(s);
    if (start === null || (close !== -1 && close < start.index)) {
      if (close === -1) return false;
      pos = close + 3;
      continue;
    }
    // Double escaped: only a `</script` (none are left) or a `-->` leaves it.
    const end = s.indexOf('-->', start.index + start[0].length);
    if (end === -1) return true;
    pos = end + 3;
  }
}

/**
 * Escape CSS for the content of an HTML `<style>` element: every `</style` (in any letter case) becomes
 * `<\/style`, since HTML ends a style element at the first `</style` followed by whitespace, `/` or `>`.
 * `\/` stands for `/` in CSS strings and URLs, and comments don't matter; `</style` anywhere else isn't valid
 * CSS anyway.
 */
export function styleContentEscape(s: string): string {
  return s.replace(/<(?=\/style)/gi, '<\\');
}

/** Apply ROT13 encoding to a string (only affects [A-Za-z]). */
export function rot13(s: string): string {
  if (s.length === 0) return s;
  return s.replace(/[A-Za-z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}

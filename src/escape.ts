/**
 * HTML, attribute, tiddler, and twee escaping/unescaping utilities.
 * Ported from escaping.go.
 *
 * The HTML escapers also write a carriage return as the character reference `&#13;`: the HTML parser turns a raw
 * CR (and CRLF) into a line feed before tokenizing, but keeps the CR of a reference, in text and attribute values.
 */
import type { CssContext, JavaScriptContext } from './code-context.js';
import { pushAll } from './util.js';

/** The character references the HTML escapers write; any other character is written as a numeric reference. */
const HTML_REFERENCES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function reference(ch: string): string {
  return HTML_REFERENCES[ch] ?? `&#${ch.charCodeAt(0)};`;
}

/** Escape the minimum characters required for HTML attribute values. */
export function attrEscape(s: string): string {
  return s.replace(/[&"'\r]/g, reference);
}

/** Escape for HTML attribute values including < and > (for spec-compliant output). */
export function fullAttrEscape(s: string): string {
  return htmlEscape(s);
}

/** Escape the minimum characters required for general HTML content. */
export function htmlEscape(s: string): string {
  return s.replace(/[&<>"'\r]/g, reference);
}

/** The escapes of the Twine 1 tiddler format, before the HTML escaping of the rest. */
const TIDDLER_ESCAPES: Readonly<Record<string, string>> = { '\\': '\\s', '\t': '\\t', '\n': '\\n' };

/** Escape for Twine 1 tiddler format. */
export function tiddlerEscape(s: string): string {
  return s.replace(/[\\\t\n&<>"\r]/g, (ch) => TIDDLER_ESCAPES[ch] ?? reference(ch));
}

/**
 * Where a value is written into an HTML document, as parse5 reports it for the place it is written (see
 * `html-structure.ts`). The escaper for each context keeps the value the document's reader gets there.
 */
export type InsertionContext =
  /**
   * Text whose character references are decoded: element text, RCDATA (`title`, `textarea`), and the fallback
   * content of `noscript`, `iframe`, `noembed` and `noframes`, shown as HTML where the feature is off.
   * `dropsLeadingNewline` for the start of a `pre`, `listing` or `textarea` element, where the parser drops a line
   * feed (even one written as a character reference).
   */
  | { readonly kind: 'text'; readonly dropsLeadingNewline: boolean }
  /** An attribute value. `url` for an attribute whose value is a URL (`href`, `src`, …). */
  | { readonly kind: 'attribute'; readonly quote: '"' | "'" | ''; readonly url: boolean }
  | { readonly kind: 'comment' }
  /**
   * The text of a JavaScript `script` element (`module` for a module script). `escapable` when the script text
   * before the value holds a `<!--`, so that the HTML tokenizer may be in a script data escaped state there.
   */
  | { readonly kind: 'script'; readonly module: boolean; readonly js: JavaScriptContext; readonly escapable: boolean }
  /** The text of a JSON data block (`<script type="application/json">` and other `+json` types). */
  | { readonly kind: 'json'; readonly js: JavaScriptContext; readonly escapable: boolean }
  /** The text of a `style` element. */
  | { readonly kind: 'style'; readonly css: CssContext }
  /**
   * Text that is neither decoded nor read by anything twee-ts can escape for: another data block (`script` of a
   * non-JavaScript type), `xmp`, `plaintext`, and CDATA sections in SVG or MathML.
   */
  | { readonly kind: 'raw-text'; readonly element: string }
  /** Inside a tag (a tag or attribute name) or a doctype, or in a token the parser drops. */
  | { readonly kind: 'markup' };

/**
 * Escape `value` for `context`, so that the reader of that place gets `value`, or `undefined` for a context where no
 * escaping can do that. In a comment the value is not readable, so it is only kept from ending the comment.
 *
 * - text and quoted attribute values: `htmlEscape()` (the escaping Twine 2 gives the story name everywhere);
 *   unquoted attribute values also escape whitespace, `=` and `` ` ``, and must not be empty; a URL attribute
 *   value is percent-encoded first (`encodeURIComponent()`), so that it stays one URL component.
 * - JavaScript strings and template literals: the Twine 2 HTML escaping is kept (SugarCube reads the story name
 *   back with `Util.unescape()`), and `\`, line breaks, U+2028 and U+2029 (and `` ` `` and `$` in a template) are
 *   escaped for JavaScript, so the literal is still valid and holds the HTML-escaped value.
 * - JSON strings and CSS strings: escaped for JSON or CSS only (nothing there decodes HTML references), with `<`
 *   escaped so that no `</script` or `</style` can end the element.
 */
export function escapeForContext(value: string, context: InsertionContext): string | undefined {
  switch (context.kind) {
    case 'text':
      return htmlEscape(value);
    case 'attribute': {
      const text = context.url ? encodeURIComponent(value.toWellFormed()) : value;
      if (context.quote !== '') return htmlEscape(text);
      return text.length === 0 ? undefined : unquotedAttrEscape(text);
    }
    case 'comment':
      return htmlCommentTextEscape(value);
    case 'script':
      return escapeForJavaScript(value, context.js);
    case 'json':
      return context.js.kind === 'string' && context.js.quote === '"' ? jsonStringEscape(value) : undefined;
    case 'style':
      // In CSS code outside a string or comment, no escaping keeps the value.
      if (context.css.kind === 'string')
        return cssStringEscape(value).replace(/['<]/g, (ch) => (ch === '<' ? '\\3c ' : "\\'"));
      return context.css.kind === 'comment' ? htmlEscape(value).replace(/\*\//g, '* /') : undefined;
    case 'raw-text':
    case 'markup':
      return undefined;
    default: {
      const _exhaustive: never = context;
      throw new Error(`Unhandled insertion context: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Escape for a JavaScript string, template literal or comment. In a regular expression, in code outside literals, or
 * in source acorn cannot read, no escaping keeps the value.
 */
function escapeForJavaScript(value: string, context: JavaScriptContext): string | undefined {
  if (context.kind === 'string') return htmlEscape(javaScriptStringBodyEscape(value));
  if (context.kind === 'template') return htmlEscape(javaScriptStringBodyEscape(value).replace(/[`$]/g, '\\$&'));
  if (context.kind === 'block-comment') return htmlEscape(value).replace(/\*\//g, '* /');
  return context.kind === 'line-comment' ? htmlEscape(value).replace(/[\n\r\u2028\u2029]/g, ' ') : undefined;
}

/**
 * Escape `\`, line breaks, U+2028 and U+2029 for the inside of a JavaScript string or template literal, as `\uXXXX`
 * (which every literal reads the same way).
 */
function javaScriptStringBodyEscape(s: string): string {
  return s.replace(/[\\\n\r\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Escape for an unquoted attribute value: `htmlEscape()`, and whitespace, `=` and `` ` `` as references. */
function unquotedAttrEscape(s: string): string {
  return htmlEscape(s).replace(/[\t\n\f =`]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Escape text for the inside of an HTML comment: `htmlEscape()`, so it holds no `>` that could end the comment, and
 * `-` as `&#45;` where it starts or ends the text or is followed by another, so it forms no `--` with the text
 * around it.
 */
function htmlCommentTextEscape(s: string): string {
  return htmlEscape(s).replace(/^-|-(?=-)|-$/g, '&#45;');
}

/** Escape for the inside of a double-quoted JSON string written into a `script` element. */
function jsonStringEscape(s: string): string {
  return JSON.stringify(s)
    .slice(1, -1)
    .replace(/[<\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
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

/** A place where `scriptContentEscape()` or `styleContentEscape()` writes a backslash after a `<`. */
export interface EscapeSite {
  /** The offset of the `<` in the unescaped text. */
  readonly offset: number;
  /** The sequence escaped there: `</script`, `</style` (in any letter case) or `<!--`. */
  readonly sequence: string;
}

/** The places where `scriptContentEscape(s)` writes a backslash, in order. */
export function scriptEscapeSites(s: string): EscapeSite[] {
  const sites = [...s.matchAll(/<\/script/gi)].map((m) => ({ offset: m.index, sequence: m[0] }));
  if (endsDoubleEscaped(s.replace(/<(?=\/script)/gi, '<\\'))) {
    pushAll(
      sites,
      [...s.matchAll(/<!--/g)].map((m) => ({ offset: m.index, sequence: m[0] })),
    );
  }
  return sites.sort((a, b) => a.offset - b.offset);
}

/** The places where `styleContentEscape(s)` writes a backslash, in order. */
export function styleEscapeSites(s: string): EscapeSite[] {
  return [...s.matchAll(/<\/style/gi)].map((m) => ({ offset: m.index, sequence: m[0] }));
}

/**
 * Whether the HTML tokenizer, reading `s` as script element content with no `</script` in it, ends in the
 * "script data double escaped" state, where an end tag after `s` would not end the element.
 * See https://html.spec.whatwg.org/multipage/parsing.html#script-data-escaped-state.
 */
function endsDoubleEscaped(s: string): boolean {
  const scriptStartTag = /<script[\t\n\f\r />]/gi;
  // The first `<script` start tag at or after an offset. Offsets only grow, so a match found from an earlier offset
  // is still the first one while it lies at or after the new one, and no match stays no match: each part of `s` is
  // searched once, which keeps the whole walk linear.
  let found: RegExpExecArray | null | undefined;
  const scriptStartFrom = (from: number): RegExpExecArray | null => {
    if (found === null || (found !== undefined && found.index >= from)) return found;
    scriptStartTag.lastIndex = from;
    found = scriptStartTag.exec(s);
    return found;
  };
  let pos = 0;
  for (;;) {
    // Script data: a `<!--` enters the escaped state.
    const open = s.indexOf('<!--', pos);
    if (open === -1) return false;
    // Escaped: a `-->` leaves it (the dashes of `<!--` count, so `<!-->` leaves at once); a `<script` start
    // tag enters the double escaped state.
    const escapedFrom = open + 2;
    const close = s.indexOf('-->', escapedFrom);
    const start = scriptStartFrom(escapedFrom);
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

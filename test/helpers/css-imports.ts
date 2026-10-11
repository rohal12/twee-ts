/**
 * What may come before an `@import` (#352): the table behind the tests of the scanner (css-imports.test.ts), of every
 * entry point that reports it, and of the browser check (css-imports-browser.test.ts), where Chromium decides.
 */

/** The import every case ends with, and the source that holds it. */
export const IMPORT = '@import url("https://fonts.example/i.css");';

/** The joiner between stylesheet sources: a line end, and a comment that names the next source. */
export const JOINER = '\n/**/\n';

export interface Predecessor {
  readonly name: string;
  /** What comes before the import. */
  readonly css: string;
  /** Whether the import after it is ignored (CSS Cascade, "@import"; CSS Syntax for stray tokens). */
  readonly blocks: boolean;
  /**
   * `sources` when the case is only meaningful with the import in a source of its own: a block, statement or at-rule
   * that stays open at the end of the first source swallows the start of the next, whereas in one source the import
   * is simply inside the block (invalid by itself, whatever precedes it).
   */
  readonly where?: 'sources';
  /** `varies` when the browsers differ (an unknown rule, an `@charset` away from the start), so no browser decides. */
  readonly engines?: 'varies';
}

const allowed = (name: string, css: string, extra: Partial<Predecessor> = {}): Predecessor => ({
  name,
  css,
  blocks: false,
  ...extra,
});
const blocking = (name: string, css: string, extra: Partial<Predecessor> = {}): Predecessor => ({
  name,
  css,
  blocks: true,
  ...extra,
});

/** Every kind of rule and token that can stand before an import, with what a browser does with the import. */
export const PREDECESSORS: readonly Predecessor[] = [
  // Nothing, or something that is not a rule.
  allowed('nothing', ''),
  allowed('whitespace', ' \n\t'),
  allowed('a comment holding a rule', '/* a { } @namespace x url(y); */'),
  allowed('an unclosed comment (the next source’s header closes it)', '/* a {', { where: 'sources' }),
  allowed('CDO and CDC', '<!-- -->'),
  allowed('a string in a comment', '/* " */'),
  // The two things that may come first.
  allowed('@charset at the very start', '@charset "utf-8";'),
  allowed('@charset at the very start and a line end', '@charset "utf-8";\n'),
  allowed('@charset and a layer statement', '@charset "utf-8";\n@layer a, b;'),
  allowed('a layer statement', '@layer a;'),
  allowed('a layer statement of several names', '@layer a, b.c, d;'),
  allowed('a layer statement in capitals', '@LAYER a;'),
  allowed('a layer statement written with an escape', '@\\6c ayer a;'),
  allowed('layer statements around a comment', '@layer a;/* x */@layer b;'),
  allowed('another import', '@import url("data:text/css,a%7B%7D");'),
  allowed('an import with a media query', '@import "a.css" screen;'),
  allowed('an import with a layer', '@import "a.css" layer(x) supports(display: grid) screen;'),
  allowed('an import in capitals', '@IMPORT "a.css";'),
  allowed('an import with escaped letters', '@im\\port "a.css";'),
  allowed('an import written with an escape and a CRLF', '@\\69\r\nmport "a.css";'),
  allowed('an import written with an escape', '@\\69 mport "a.css";'),
  allowed('a layer statement, an import and another import', '@layer a;@import "a.css";@import "b.css";'),
  // A rule no browser can parse is dropped, and ends nothing.
  allowed('a rule with a stray parenthesis in its selector', 'a b c ) {}'),
  allowed('a rule with a semicolon in its selector, ending at its block', 'a; b {}'),
  allowed('a rule with no selector', '{}'),
  allowed('a rule with a string in its selector', '"x" {}'),
  allowed('a rule with a url in its selector', 'url(x) {}'),
  allowed('a stray declaration that ends at a block', 'color: red; @font-face { font-family: x }'),
  // Anything else is a rule that ends the place for imports.
  blocking('a namespace rule', '@namespace svg url("http://www.w3.org/2000/svg");'),
  blocking('a namespace rule with an escaped quote in a string', '@namespace x "a\\"b";'),
  blocking('a default namespace rule', '@namespace url(http://www.w3.org/1999/xhtml);'),
  blocking('a namespace rule in capitals', '@NAMESPACE svg url(http://www.w3.org/2000/svg);'),
  blocking('a namespace rule written with an escape', '@\\6e amespace svg url(http://www.w3.org/2000/svg);'),
  blocking('an import, then a namespace rule', '@import "a.css";@namespace svg url(http://www.w3.org/2000/svg);'),
  blocking('a style rule', 'body { margin: 0; }'),
  blocking('an empty style rule', 'a {}'),
  blocking('a style rule with a semicolon in a string', 'a::after { content: ";" }'),
  blocking('a style rule with a nested block', 'a { b { c: d } }'),
  blocking('a media rule', '@media print { a { b: c } }'),
  blocking('an empty media rule', '@media print {}'),
  blocking('a supports rule', '@supports (display: grid) {}'),
  blocking('a font-face rule', '@font-face { font-family: x }'),
  blocking('a keyframes rule', '@keyframes k {}'),
  blocking('a page rule', '@page {}'),
  blocking('a property rule', '@property --x { syntax: "*"; inherits: false }'),
  blocking('a container rule', '@container (min-width: 1px) {}'),
  blocking('a scope rule', '@scope (a) {}'),
  blocking('a counter-style rule', '@counter-style x { system: cyclic; symbols: "a" }'),
  blocking('a starting-style rule', '@starting-style {}'),
  blocking('a font-palette-values rule', '@font-palette-values --x {}'),
  blocking('a view-transition rule', '@view-transition { navigation: auto }'),
  blocking('a layer block', '@layer a { p {} }'),
  blocking('an empty layer block', '@layer a {}'),
  blocking('an anonymous layer block', '@layer { p {} }'),
  // The specification ignores a layer statement here; Chromium ends the place for imports with it.
  blocking('an import, then a layer statement', '@import "a.css";@layer a;'),
  blocking('a layer statement, then a rule', '@layer a;a{}'),
  blocking('a charset, a namespace rule', '@charset "utf-8";@namespace x url(y);'),
  blocking('a rule hiding an import in a string', 'a { content: "@import" }'),
  // Tokens that start a qualified rule, which reads on to its block and swallows the import.
  blocking('a stray semicolon', ';'),
  blocking('a stray semicolon after an import', '@import "a.css";;'),
  blocking('a semicolon after a rule', 'a {};'),
  blocking('a stray closing brace', '}'),
  blocking('a stray closing parenthesis', ')'),
  blocking('a stray closing bracket', ']'),
  blocking('a declaration', 'color: red;'),
  blocking('a selector and a semicolon', 'a;'),
  blocking('a stray string', '"x";'),
  blocking('a stray escape', '\\@ x;'),
  blocking('a stray backslash before a line end', '\\'),
  blocking('a style rule with an escape and a url with an escaped parenthesis', 'a { b\\; c: url(a\\)b) }'),
  // Left open at the end of a source, which the next source continues.
  blocking('an import without its semicolon', '@import "a.css"', { where: 'sources' }),
  blocking('a layer statement without its semicolon', '@layer a', { where: 'sources' }),
  blocking('a namespace rule without its semicolon', '@namespace x url(y)', { where: 'sources' }),
  blocking('an unclosed style rule', 'a { color: red;', { where: 'sources' }),
  blocking('an unclosed media rule', '@media print {', { where: 'sources' }),
  blocking('an unclosed parenthesis', '@media (min-width: 1px', { where: 'sources' }),
  blocking('an unclosed string in a block', 'a { content: "x }', { where: 'sources' }),
  blocking('an unclosed url in a block', 'a { background: url(x', { where: 'sources' }),
  blocking('a block that holds a url with braces', 'a { b: url(a{b) ', { where: 'sources' }),
  blocking('a style rule with braces in an unquoted url', 'a { b: url(a{b) }'),
  // What the browsers differ about: an at-rule or a rule they drop, and a charset away from the start. They are
  // reported, since a browser may take them for the rule that ends the place for imports.
  blocking('an unknown at-rule with a block', '@foo bar {}', { engines: 'varies' }),
  blocking('an unknown at-rule without a block', '@foo bar;', { engines: 'varies' }),
  blocking('an at-rule named by a dash', '@-x;', { engines: 'varies' }),
  blocking('an at-rule named by two dashes', '@--x;', { engines: 'varies' }),
  blocking('an at-rule named by a dash and an escape', '@-\\61  x;', { engines: 'varies' }),
  blocking('an at-rule named by an escape of zero', '@\\0 x;', { engines: 'varies' }),
  blocking('an at-rule named by an escape beyond Unicode', '@\\110000 x;', { engines: 'varies' }),
  blocking('an at-rule named by an escape of a surrogate', '@\\d800 x;', { engines: 'varies' }),
  blocking('a charset after a rule', 'a{}\n@charset "utf-8";'),
  blocking('a charset in single quotes', "@charset 'utf-8';", { engines: 'varies' }),
  blocking('a charset after a comment', '/* c */@charset "utf-8";', { engines: 'varies' }),
  blocking('a charset in capitals', '@CHARSET "utf-8";', { engines: 'varies' }),
  blocking('a charset written with an escape', '@\\63harset "utf-8";', { engines: 'varies' }),
  blocking('a second charset', '@charset "utf-8";@charset "utf-8";', { engines: 'varies' }),
  blocking('a charset with a block', '@charset "utf-8" {}', { engines: 'varies' }),
];

/** The sources of a case: the predecessor and the import together, or in a source each. */
export function sourcesOf(css: string, split: boolean): string[] {
  return split ? [css, IMPORT] : [`${css}\n${IMPORT}`];
}

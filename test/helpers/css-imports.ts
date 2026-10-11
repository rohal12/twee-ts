/**
 * What may come before an `@import` (#352): the table behind the tests of the scanner (css-imports.test.ts), of every
 * entry point that reports it, and of the browser check (css-imports-browser.test.ts), where Chromium decides.
 */

/** The import every case ends with, and the source that holds it. */
export const IMPORT = '@import url("i.css");';

export interface Predecessor {
  readonly name: string;
  /** What comes before the import. */
  readonly css: string;
  /** Whether the import after it is ignored (CSS Cascade, "@import"; CSS Syntax for stray tokens). */
  readonly blocks: boolean;
  /**
   * Whether it is ignored in JSON output and lint, when that differs: JSON output joins the stylesheets with a line
   * feed only, where HTML and archive output put a comment between them, which closes a comment the stylesheet before
   * it left open.
   */
  readonly jsonBlocks?: boolean;
  /**
   * `sources` when the case is only meaningful with the import in a source of its own: a block, statement or at-rule
   * that stays open at the end of the first source swallows the start of the next, whereas in one source the import
   * is simply inside the block (invalid by itself, whatever precedes it).
   */
  readonly where?: 'sources';
  /**
   * `some` when only some browsers know the at-rule, so a browser that does not keeps the import: the compiler warns
   * (a browser that knows it ignores the import), and a browser may only disagree by keeping it.
   */
  readonly engines?: 'some';
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
  allowed('an unclosed comment (HTML output’s header closes it, JSON output’s line feed does not)', '/* note', {
    where: 'sources',
    jsonBlocks: true,
  }),
  allowed('CDO and CDC', '<!-- -->'),
  allowed('a string in a comment', '/* " */'),
  // The two things that may come first.
  allowed('@charset at the very start', '@charset "utf-8";'),
  allowed('@charset at the very start and a line end', '@charset "utf-8";\n'),
  allowed('@charset and a layer statement', '@charset "utf-8";\n@layer a, b;'),
  allowed('an import, then a charset', '@import "a.css";\n@charset "UTF-8";'),
  allowed('a layer statement, then a charset', '@layer a;@charset "UTF-8";'),
  allowed('a layer statement', '@layer a;'),
  allowed('a layer statement of several names', '@layer a, b.c, d;'),
  allowed('a layer statement in capitals', '@LAYER a;'),
  allowed('a layer statement written with an escape', '@\\6c ayer a;'),
  allowed('layer statements around a comment', '@layer a;/* x */@layer b;'),
  allowed('another import', '@import url("b.css");'),
  allowed('an import with a media query', '@import "a.css" screen;'),
  allowed('an import with a layer', '@import "a.css" layer(x) supports(display: grid) screen;'),
  allowed('an import in capitals', '@IMPORT "a.css";'),
  allowed('an import with escaped letters', '@im\\port "a.css";'),
  allowed('an import written with an escape and a CRLF', '@\\69\r\nmport "a.css";'),
  allowed('an import written with an escape', '@\\69 mport "a.css";'),
  allowed('an import whose url is written with an escape', '@import \\75 rl(a{b.css);'),
  allowed('an import whose url is written with an escaped first letter', '@import \\url(a{b.css);'),
  allowed('an import with a url that holds a brace', '@import url(a{b.css);'),
  allowed('an import of a url with spaces', '@import url(  a.css  );'),
  allowed('an import of a function url', '@import url( "a.css" );'),
  allowed('a layer statement, an import and another import', '@layer a;@import "a.css";@import "b.css";'),
  // A rule no browser can parse is dropped, and ends nothing.
  allowed('a rule with a stray parenthesis in its selector', 'a b c ) {}'),
  allowed('a rule with a semicolon in its selector, ending at its block', 'a; b {}'),
  allowed('a rule with no selector', '{}'),
  allowed('a rule with a string in its selector', '"x" {}'),
  allowed('a rule with a url in its selector', 'url(x) {}'),
  allowed('an import without a url or a string, then a layer statement', '@import;@layer a;'),
  allowed('an import of a name, then a layer statement', '@import foo;@layer a;'),
  allowed('an import of a bad url, then a layer statement', '@import url(a"b);@layer a;'),
  allowed('a layer block listing two names', '@layer a, b { p {} }'),
  allowed('a layer block with a bad name', '@layer 1 { p {} }'),
  allowed('a layer statement with a bad name', '@layer a..b;'),
  allowed('a layer statement without a name', '@layer;'),
  allowed('a namespace rule without a url', '@namespace;'),
  allowed('a namespace rule with a bad url', '@namespace x url(a b);'),
  allowed('a rule with a number for a selector', '1.5e3 {}'),
  allowed('a rule with a signed number for a selector', '+.5 {}'),
  allowed('a rule with a percentage for a selector', '50% {}'),
  allowed('a rule with a dimension for a selector', '2px {}'),
  // A rule whose selector holds a token no selector holds is dropped; every browser keeps the import.
  allowed('a rule with a bang in its selector', 'a ! {}'),
  allowed('a rule with a slash in its selector', '/ a {}'),
  allowed('a comment end that is no comment, then a rule', '*/\na {}'),
  allowed('a rule with an at sign in its selector', 'a @ b {}'),
  allowed('a rule with a percent sign in its selector', 'a % {}'),
  allowed('a rule with an equals sign in its selector', 'a = b {}'),
  allowed('a rule with a caret in its selector', 'a ^ b {}'),
  allowed('a rule with a question mark in its selector', 'a ? {}'),
  allowed('a rule with a dollar sign in its selector', 'a $ {}'),
  allowed('a rule with a less-than sign in its selector', 'a < b {}'),
  allowed('a rule with a parenthesis block in its selector', '(a) {}'),
  allowed('a rule with a hash that is no ID', '#1a {}'),
  // An at-rule that some browser knows, with a prelude it does not take, is dropped.
  allowed('a keyframes rule without a name', '@keyframes {}'),
  allowed('a keyframes rule named by a number', '@keyframes 1 {}'),
  allowed('a keyframes rule with two names', '@keyframes a b {}'),
  allowed('a property rule named by a name that is not dashed', '@property x {}'),
  allowed('a property rule without a name', '@property {}'),
  allowed('a property rule with two names', '@property --x --y {}'),
  allowed('a supports rule with a bare word', '@supports foo {}'),
  allowed('a supports rule without a condition', '@supports {}'),
  allowed('a counter-style rule without a name', '@counter-style {}'),
  allowed('a counter-style rule with two names', '@counter-style x y {}'),
  allowed('a counter-style rule named by a number', '@counter-style 1 {}'),
  allowed('a font-palette-values rule without a name', '@font-palette-values {}'),
  allowed('a font-palette-values rule with a name that is not dashed', '@font-palette-values x {}'),
  allowed('a font-face rule with a prelude', '@font-face foo {}'),
  allowed('a starting-style rule with a prelude', '@starting-style foo {}'),
  allowed('a view-transition rule with a prelude', '@view-transition foo {}'),
  allowed('a position-try rule without a name', '@position-try {}'),
  allowed('a page rule with a number', '@page 1 {}'),
  allowed('a container rule without a condition', '@container {}'),
  // At-rules no current browser supports are dropped.
  allowed('an -o-keyframes rule', '@-o-keyframes k {}'),
  allowed('a color-profile rule', '@color-profile --x { src: url(x) }'),
  allowed('a document rule', '@document url(x) {}'),
  allowed('a -moz-document rule', '@-moz-document url(x) {}'),
  allowed('a viewport rule', '@viewport {}'),
  allowed('an -ms-viewport rule', '@-ms-viewport {}'),
  allowed('a stray declaration that ends at a block', 'color: red; @font-face { font-family: x }'),
  // Anything else is a rule that ends the place for imports.
  blocking('a namespace rule with a function url', '@namespace x url( "y" );'),
  blocking('a namespace rule with a url with an escape', '@namespace x url(a\\62 c);'),
  blocking('a namespace rule', '@namespace svg url("http://www.w3.org/2000/svg");'),
  blocking('a namespace rule with an escaped quote in a string', '@namespace x "a\\"b";'),
  blocking('a default namespace rule', '@namespace url(http://www.w3.org/1999/xhtml);'),
  blocking('a namespace rule in capitals', '@NAMESPACE svg url(http://www.w3.org/2000/svg);'),
  blocking('a namespace rule written with an escape', '@\\6e amespace svg url(http://www.w3.org/2000/svg);'),
  blocking('an import, then a namespace rule', '@import "a.css";@namespace svg url(http://www.w3.org/2000/svg);'),
  blocking('a rule with a hash selector', '#a {}'),
  blocking('a rule with an ID hash that starts with an escape', '#\\31 23 {}'),
  blocking('a rule with a universal selector', '* {}'),
  blocking('a rule with a namespace-free type selector', '|b {}'),
  blocking('a rule with a selector list', 'a , b {}'),
  blocking('a rule with a class selector', '.a {}'),
  blocking('a rule with an attribute selector', '[a] {}'),
  blocking('a keyframes rule named by a string', '@keyframes "k" {}'),
  blocking('a -webkit-keyframes rule', '@-webkit-keyframes k {}'),
  blocking('a -moz-keyframes rule', '@-moz-keyframes k {}', { engines: 'some' }),
  blocking('a function rule', '@function --f() { result: 1 }', { engines: 'some' }),
  blocking('a position-try rule', '@position-try --a {}'),
  blocking('a supports rule with not', '@supports not (a: b) {}'),
  blocking('a supports rule with a function', '@supports foo() {}'),
  blocking('a supports rule with a selector function', '@supports selector(a) {}'),
  blocking('a page rule with a name', '@page foo {}'),
  blocking('a page rule with a pseudo-class', '@page :first {}'),
  blocking('a scope rule without a prelude', '@scope {}'),
  blocking('a media rule without a prelude', '@media {}'),
  blocking('a media rule with a bare word', '@media foo {}'),
  blocking('a font-face rule without a prelude', '@font-face {}'),
  blocking('a rule with an escaped hash selector', '#\\61  {}'),
  blocking('a rule with a function selector', ':is(a, b) {}'),
  blocking('a rule with an attribute selector holding a brace', 'a[b="}"] {}'),
  blocking('a rule with a dash in front of an escape', '-\\61  {}'),
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
  blocking('a view-transition rule', '@view-transition { navigation: auto }', { engines: 'some' }),
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
  // Rules no browser knows, and `@charset` (CSS Syntax: an unknown at-rule; the encoding is read from the bytes), are
  // dropped, whatever they are named and wherever they stand.
  allowed('an unknown at-rule with a block', '@foo bar {}'),
  allowed('an unknown at-rule without a block', '@foo bar;'),
  allowed('an at-rule named by a dash', '@-x;'),
  allowed('an at-rule named by two dashes', '@--x;'),
  allowed('an at-rule named by a dash and an escape', '@-\\61  x;'),
  allowed('an at-rule named by an escape of zero', '@\\0 x;'),
  allowed('an at-rule named by an escape beyond Unicode', '@\\110000 x;'),
  allowed('an at-rule named by an escape of a surrogate', '@\\d800 x;'),
  allowed('a known at-rule without its block', '@media print;'),
  allowed('a charset in single quotes', "@charset 'utf-8';"),
  allowed('a charset after a comment', '/* c */@charset "utf-8";'),
  allowed('a charset after whitespace', ' @charset "utf-8";'),
  allowed('a charset in capitals', '@CHARSET "utf-8";'),
  allowed('a charset written with an escape', '@\\63harset "utf-8";'),
  allowed('a second charset', '@charset "utf-8";@charset "utf-8";'),
  allowed('a charset with a block', '@charset "utf-8" {}'),
  blocking('a charset after a rule', 'a{}\n@charset "utf-8";'),
  // A url or a comment that is not closed runs on, into the sources after it.
  blocking('a url that is not closed', 'url(', { where: 'sources' }),
  blocking('a url that is not closed, then a selector with a quoted brace', 'url(\na[b="}"] {}', { where: 'sources' }),
  blocking('a hash and a block that is not closed', '#url({) {}', { where: 'sources' }),
  blocking('a bad url in a block that is not closed', 'a { b: url(a"b) ', { where: 'sources' }),
];

/** The sources of a case: the predecessor and the import together, or in a source each. */
export function sourcesOf(css: string, split: boolean): string[] {
  return split ? [css, IMPORT] : [`${css}\n${IMPORT}`];
}

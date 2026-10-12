import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTreeAdapter, html as htmlSpec, parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { countNormalizationSegments, countTextWords, countTextWordsChecked, stripComments } from '../src/word-count.js';
import { splitTweeFields } from '../src/twee-syntax.js';
import { MAX_HTML_DEPTH, htmlText } from '../src/html-structure.js';
import { compile, lint } from '../src/index.js';
import { growth, LINEAR_GROWTH } from './helpers/growth.js';

/**
 * Tweego's comment expression, `(?s:/%.*?%/|/\*.*?\*\/|<!--.*?-->)`, as a JavaScript expression. Both engines
 * choose the leftmost-first match, so it is an oracle on short inputs; it backtracks, so not on long ones.
 */
const TWEEGO_COMMENTS = /\/%[\s\S]*?%\/|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g;

/** The markup expressions the 'whitespace' method was first written with, as an oracle on short inputs. */
function whitespaceOracle(text: string): number {
  return text
    .replace(TWEEGO_COMMENTS, '')
    .replace(/<<[^>]*>>/g, '')
    .replace(/\[\[([^\]|]*?)(?:\|[^\]]*?)?\]\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .split(/\p{White_Space}+/u)
    .filter((t) => t.length > 0).length;
}

const MARKUP = fc.constantFrom(
  '/',
  '%',
  '*',
  '<',
  '!',
  '-',
  '>',
  ']',
  '|',
  'a',
  ' ',
  '\n',
  '<<',
  '>>',
  '[[',
  ']]',
  '/*',
  '*/',
  '<!--',
  '-->',
);
const markup = fc.array(MARKUP, { maxLength: 16 }).map((t) => t.join(''));
/** Markup the old expressions and SugarCube's link grammar read alike: no arrows, setters, line ends or nested brackets in links. */
const sharedGrammar = markup.filter((s) => !/->|<-|\]\[|\n|\[\[[^\]]*\[/.test(s));

describe('stripComments', () => {
  it('removes comments as Tweego does (differential against its expression)', () => {
    fc.assert(
      fc.property(markup, (s) => {
        expect(stripComments(s)).toBe(s.replace(TWEEGO_COMMENTS, ''));
      }),
      { numRuns: 20_000 },
    );
  });
});

describe("countTextWords 'tweego'", () => {
  it('counts the words Tweego counts for comments (T-10)', () => {
    expect(countTextWords('/**/', 'tweego')).toBe(0);
    expect(countTextWords('<!----> abcd', 'tweego')).toBe(1);
    expect(countTextWords('/**/ abcde */', 'tweego')).toBe(2);
    expect(countTextWords('/%%/abcde', 'tweego')).toBe(1);
  });

  it('counts a letter and its accents as one character, as Go norm.Iter segments (T-10)', () => {
    expect(countTextWords('ééééé', 'tweego')).toBe(1);
    expect(countTextWords('e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301', 'tweego')).toBe(2);
    expect(countNormalizationSegments('é')).toBe(1);
    expect(countNormalizationSegments('한국어')).toBe(3);
    expect(countNormalizationSegments('ﬁ')).toBe(2);
    expect(countNormalizationSegments('\u0301a')).toBe(2);
    expect(countNormalizationSegments('a\u0301\u0302\u0303')).toBe(1);
    expect(countNormalizationSegments('\u0b47\u0b3e')).toBe(1);
    expect(countNormalizationSegments('😀x')).toBe(2);
    expect(countNormalizationSegments('')).toBe(0);
  });

  it('ends a reordered segment at a starter that combines backward, as Tweego does (#367)', () => {
    // Tweego 2.1.1 prints `Words: 2` for this passage text.
    expect(countTextWords('́াাaaaa', 'tweego')).toBe(2);
    expect(countNormalizationSegments('́াা')).toBe(2);
    expect(countNormalizationSegments('́া'.repeat(12))).toBe(7);
    // Go reads the text as written: the same marks in canonical order give one segment, out of order two.
    expect(countNormalizationSegments('x̖́া')).toBe(1);
    expect(countNormalizationSegments('x̖́া')).toBe(2);
  });

  it("counts the segments Go's norm.Iter yields (differential against go-norm-segments.json)", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures/word-count/go-norm-segments.json'), 'utf-8'),
    ) as {
      readonly cases: readonly (readonly [string, number])[];
    };
    const text = (hex: string): string => String.fromCodePoint(...hex.split(' ').map((cp) => parseInt(cp, 16)));
    const differ = fixture.cases.filter(([hex, segments]) => countNormalizationSegments(text(hex)) !== segments);
    expect(fixture.cases.length).toBeGreaterThan(3000);
    expect(differ).toEqual([]);
  });

  it('starts a new segment after 30 combining marks, as Go stream-safe text does', () => {
    expect(countNormalizationSegments('a' + '\u0301'.repeat(30))).toBe(1);
    expect(countNormalizationSegments('a' + '\u0301'.repeat(31))).toBe(2);
    expect(countNormalizationSegments('a' + '\u0301'.repeat(61))).toBe(3);
  });

  it('removes line feeds before comments, so a comment may span lines', () => {
    expect(countTextWords('/*a\nb*/abcde', 'tweego')).toBe(1);
    expect(countTextWords('abcde\nfghij', 'tweego')).toBe(2);
  });
});

/**
 * Prose words with `<` and `>` that are text to SugarCube and to an HTML parser: no `<` before a letter, `/`, `!` or
 * `?`, and no `<<` before a macro name.
 */
const PROSE_WORD = fc.constantFrom(
  'Well',
  'done!',
  '<3',
  '<',
  '>',
  '>=',
  '<=',
  '=>',
  '<-',
  '->',
  'a>b',
  '1<2',
  'x<=y',
  '<<',
  '>>',
  '&',
  '&&',
  '"q"',
  "'s'",
  '10',
);

/**
 * Text inside quotes: anything but the quote itself and a line break, `<<` and link markup included: a tag is read
 * before what is in it.
 */
const quotedText = (quote: string): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom('a', ' ', '>', '>>', '>=', '<', '<<b', '[[x]]', '=', '/', '"', "'", '`', '<b>'), {
      maxLength: 6,
    })
    .map((parts) => parts.join('').replaceAll(quote, ''));

/** A SugarCube macro argument, as SugarCube's macro parser reads it; `>` alone or before `=` never ends the tag. */
const MACRO_ARG = fc.oneof(
  fc.constantFrom('$score', '_i', '10', '>', '>=', '<', '<=', 'gt', 'to', '?', ':', '[[A>B]]', '[[x>>y|Room]]'),
  quotedText('"').map((s) => `"${s}"`),
  quotedText("'").map((s) => `'${s}'`),
  quotedText('`').map((s) => `\`${s}\``),
);

/** A SugarCube macro tag: an opening tag with arguments (the last never ending in `>`), or a closing tag. */
const MACRO = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('if', 'elseif', 'set', 'print', '=', '-', 'link', 'run', 'my-widget'),
      fc.array(MACRO_ARG, { maxLength: 5 }),
    )
    .map(([name, args]) => `<<${name}${args.map((arg) => ` ${arg}`).join('')} >>`),
  fc.constantFrom('<</if>>', '<</link>>', '<<else>>', '<<if $score >= 10>>', '<<set $label to "A > B">>'),
);

/** An HTML attribute: double-quoted, single-quoted (either holding `>`), unquoted, or bare. */
const ATTRIBUTE = fc.oneof(
  fc.tuple(fc.constantFrom('title', 'class', 'data-x', 'href'), quotedText('"')).map(([n, v]) => ` ${n}="${v}"`),
  fc.tuple(fc.constantFrom('title', 'class', 'data-x', 'href'), quotedText("'")).map(([n, v]) => ` ${n}='${v}'`),
  fc.constantFrom(' id=main', ' hidden', ' a = b'),
);

const SEPARATOR = fc.constantFrom(' ', '\n', '\t', '  ');

/** A prose word in markup that shows it: an element, or after a void element, a macro tag or a comment. */
const MARKED_UP_WORD = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('span', 'b', 'i', 'em', 'div', 'p', 'a', 'my-el', 'SPAN'),
      fc.array(ATTRIBUTE, { maxLength: 3 }),
      PROSE_WORD,
      SEPARATOR,
    )
    .map(([name, attributes, word, sep]) => `<${name}${attributes.join('')}>${sep}${word}${sep}</${name}>`),
  fc
    .tuple(
      fc.oneof(
        MACRO,
        fc
          .tuple(fc.constantFrom('br', 'img', 'hr', 'span'), fc.array(ATTRIBUTE, { maxLength: 3 }))
          .map(([name, attributes]) => `<${name}${attributes.join('')}${name === 'span' ? '/' : ''}>`),
        fc.constantFrom('<!-- a > b -->', '<!---->', '/* c > d */', '/% e %/'),
      ),
      PROSE_WORD,
      SEPARATOR,
    )
    .map(([markup, word, sep]) => `${markup}${sep}${word}`),
);

/** Prose words with markup around them, each piece set apart by white space. */
const proseWithMarkup = fc
  .array(fc.oneof(PROSE_WORD, MARKED_UP_WORD), { maxLength: 12 })
  .map((pieces) => ({ words: pieces.length, text: pieces.join(' ') }));

/** Elements whose text a browser doesn't show. */
const UNSHOWN = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'script', 'style', 'title']);

/**
 * The text a browser shows of `html` read as the content of a `div` element, from parse5's tree (the differential
 * oracle): text outside the elements above and template contents, with a space for each `br`.
 */
function htmlTreeText(html: string): string {
  const context = defaultTreeAdapter.createElement('div', htmlSpec.NS.HTML, []);
  const fragment = parseFragment(context, html, { scriptingEnabled: true });
  const text: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (node.nodeName === '#text' && 'value' in node) text.push(node.value);
    if (node.nodeName === 'br') text.push(' ');
    if (UNSHOWN.has(node.nodeName)) return;
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(fragment);
  return text.join('');
}

/**
 * Characters and names that make tags, comments, character references, hidden elements, tables and their text. SVG
 * and MathML, whose text shows by rules of their own, are compared with a browser (word-count-sugarcube.test.ts).
 */
const HTML_ALPHABET = fc.constantFrom(
  '<',
  '>',
  '/',
  '!',
  '-',
  '"',
  "'",
  '=',
  '&',
  ';',
  'a',
  'b',
  'p',
  '3',
  ' ',
  '\n',
  'amp',
  'lt',
  'script',
  'style',
  'title',
  'template',
  'noscript',
  'textarea',
  'br',
  'table',
  'td',
  'i',
);

describe('htmlText', () => {
  it('gives the text a browser shows of HTML (differential against the parse5 tree)', () => {
    fc.assert(
      fc.property(fc.array(HTML_ALPHABET, { maxLength: 24 }), (parts) => {
        const s = parts.join('');
        expect(splitTweeFields(htmlText(s))).toEqual(splitTweeFields(htmlTreeText(s)));
      }),
      { numRuns: 20_000 },
    );
  });
});

describe("countTextWords 'whitespace'", () => {
  it('counts the prose around SugarCube macros and HTML markup, however their arguments use > (#421, #422)', () => {
    fc.assert(
      fc.property(proseWithMarkup, ({ words, text }) => {
        expect(countTextWords(text, 'whitespace')).toBe(words);
      }),
      { numRuns: 5_000 },
    );
  });

  it('counts what the markup expressions leave for prose without tags or comments (differential)', () => {
    fc.assert(
      fc.property(
        sharedGrammar.filter((s) => !/[<>/]/.test(s)),
        (s) => {
          expect(countTextWords(s, 'whitespace')).toBe(whitespaceOracle(s));
        },
      ),
      { numRuns: 20_000 },
    );
  });

  // The counts SugarCube 2.37.3 gives in Chromium (see word-count-sugarcube.test.ts), with a condition that holds.
  it.each([
    ['no macro', 'Well done!', 2],
    ['a < condition', '<<if 1 < 10>>\nWell done!\n<</if>>', 2],
    ['a > condition', '<<if 11 > 10>>\nWell done!\n<</if>>', 2],
    ['a >= condition', '<<if 10 >= 10>>\nWell done!\n<</if>>', 2],
    ['a quoted > argument', '<<set $label to "A > B">>Well done!', 2],
    ['a single-quoted >> argument', "<<set $label to 'A >> B'>>Well done!", 2],
    ['a backquoted > argument', '<<set $x to `${1 > 0}`>> Well done!', 2],
    ['nested macro text in a string', '<<set $x to "<<goto Room>>">> Well done!', 2],
    ['a >> that ends the tag early', '<<set $x to 1 >> 2>> Well done!', 3],
    ['text that is no macro', '<< Well done! >>', 4],
    ['an unclosed macro, which SugarCube shows', '<<if $score > 10 Well done!', 6],
  ])('counts the prose around a macro with %s (#421)', (_label, text, words) => {
    expect(countTextWords(text, 'whitespace')).toBe(words);
  });

  it.each([
    ['a double-quoted > in an attribute', '<span title="Use score > 10 points">Well done!</span>', 2],
    ['a single-quoted > in an attribute', "<span title='Use score > 10 points'>Well done!</span>", 2],
    ['a character reference in an attribute', '<span title="Use score &gt; 10 points">Well done!</span>', 2],
    ['an emoticon', 'I <3 you. <b>Always</b>', 4],
    ['comparisons in prose', 'A < B and C > D', 7],
    ['plain text', 'Well done!', 2],
    ['a valid tag', 'I love you. <b>Always</b>', 4],
    ['an end tag no start tag opened, which SugarCube shows', 'Well </b > done!', 4],
    ['end tags that close in turn', '<b><i>x</b></i> y', 2],
    ['an end tag of an outer element inside an inner one', '<text> <math> </text> <!-- open </math> a b', 2],
    ['a self-closing tag', 'Well<br/> done!', 2],
    ['a line break between words', 'two<br>words', 2],
    ['words joined by a tag', 'a<b>b</b>', 1],
    ['a no-break space reference', 'Well&nbsp;done!', 2],
    ['an escaped tag', '&lt;b&gt; Well', 2],
    ['an upper-case tag', '<SPAN CLASS="x > y">Well</SPAN> done!', 2],
    ['markup SugarCube shows as text', 'Well <!x> <?y> </3> done!', 5],
    ['a tag split by a line break', '<span\ntitle="a > b"\n>Well done!</span>', 2],
    ['textarea text', '<textarea><b>Well</b> done!</textarea>', 2],
    ['text a table moves before itself', '<table>Well <tr><td>done!</td></tr></table>', 2],
    ['a tag left open at the end', 'Well done! <span title="a > b"', 6],
    ['a start tag left open at the end', 'Well done <b', 3],
    ['a frameset tag', '<frameset>Well done!</frameset>', 2],
    ['end tags of the page around the passage', 'Well</div> done!</body></html> again', 3],
    ['a script element', '<script>var a = 1;</script>Well done!', 2],
    ['a style element', '<style>p { color: red }</style>Well done!', 2],
    ['a noscript element', '<noscript>no js here</noscript>Well done!', 2],
    ['a template', '<template>hidden words</template>Well done!', 2],
    ['a title element', '<title>t t</title> x', 1],
    ['a << in an attribute value', '<a title="<<b">Well done and many words</a>. <<set $y to 2>>', 5],
  ])('counts the text around HTML with %s (#422)', (_label, text, words) => {
    expect(countTextWords(text, 'whitespace')).toBe(words);
  });

  // Elements whose reading depends on the context around a tag, and foreign content (#435): SugarCube makes each
  // element from its own start tag, so a table part outside a table gives no element, a list or table takes no line
  // break, and nothing in MathML but its own elements shows (counts from SugarCube 2.37.3 in Chromium).
  it.each([
    ['a table', '<table>Well\ndone!</table>', 1],
    ['text after a table', '<table>Well\n</table>done!', 1],
    ['a list', '<ul>y\n</ul>done!', 1],
    ['list items, which take line breaks again', '<ul>a\n<li>x\ny</li>\nb</ul>', 2],
    ['list items on lines of their own', '<ul><li>a</li>\n<li>b</li>\n</ul>', 1],
    ['table cells, which take line breaks again', '<table><tr><td>a\nb</td></tr></table>', 2],
    ['a table row', '<table><tr>a\nb</tr></table>', 1],
    ['a description list', '<dl>a\nb</dl>', 1],
    ['a span in a list', '<ul><span>a\nb</span>\nc</ul>', 2],
    ['link text in a list', '<ul>[[a\nb|Start]]</ul>', 1],
    ['two line feeds in a list', '<ul>a\n\nb</ul>', 1],
    ['a carriage return and a line feed in a list', '<ul>a\r\nb</ul>', 2],
    ['a table row outside a table', '<tr><td>x</td></tr>', 1],
    ['table cells outside a table', '<td>x</td> <td>y</td>', 2],
    ['a table row in a list', '<ul><tr>x</tr></ul>', 1],
    ['a table with cells', '<table><tr><td>a</td><td>b</td></tr></table>', 1],
    ['list items outside a list', '<li>a</li><li>b</li>', 1],
    ['an HTML element in MathML', '<math><b>bold</b></math>', 0],
    ['text and a token element in MathML', '<math>t<mi>x</mi></math>', 0],
    ['white space between MathML elements', '<math><mi>x</mi> <mi>y</mi></math>', 0],
    ['a table in MathML', '<math><table>x</table></math>', 0],
    ['MathML in a table', '<table><math>q r</math></table>', 0],
    ['white space in MathML', '<math>  </math>a', 1],
    ['an svg element in MathML', '<math><svg><text>x</text></svg></math>', 0],
    ['a table row in verbatim HTML', '<html><tr>x</tr></html>', 0],
    ['a table cell and text in verbatim HTML', '<html><td></td>bold</html>', 0],
    ['text before a table row in verbatim HTML', '<html>a <tr>x</tr></html>', 0],
    ['a table cell in verbatim HTML', '<html><td>x</td></html>', 1],
    ['a column in verbatim HTML', '<html><col>a b</html>', 0],
    ['an element a table moves before itself, in verbatim HTML', '<html><table>\n<ul>&amp;</html></td>', 2],
    ['text a table moves, in verbatim HTML', '<html><table>  <mrow>y</html>*/', 2],
    ['white space in MathML in verbatim HTML', '<html><math><mi>x</mi>  </html>&', 2],
    ['verbatim HTML in MathML', '<math><html><math><mi>y</math></html>', 1],
    ['an svg element left in MathML by verbatim HTML', '<math><html></math></html><svg><text>drawn</svg>', 0],
    ['an element SVG does not define in an svg element', '<svg><svg-x><text>drawn</text></svg-x></svg>', 0],
    ['white space in a group', '<svg><g> </g></svg>a', 1],
    ['a character reference without a semicolon', 'a &nbsp b', 3],
  ])('counts %s as SugarCube shows it (#435)', (_label, text, words) => {
    expect(countTextWords(text, 'whitespace')).toBe(words);
  });

  it.each([
    ['a comment left open', 'Intro <!-- TODO\nThe rest of a long passage that the reader sees.', 12],
    ['a block comment left open', 'a /* b c', 3],
    ['a SugarCube comment left open', 'a /% b c', 3],
    ['closed comments', 'a <!-- b --> c /* d */ e /% f %/ g', 4],
  ])('drops only the opener of %s, as SugarCube does', (_label, text, words) => {
    expect(countTextWords(text, 'whitespace')).toBe(words);
  });

  // SugarCube's styleTag, svgTag, verbatimHtml and verbatimText parsers: an element whose end they don't find loses
  // only its opener (counts from SugarCube 2.37.3 in Chromium).
  it.each([
    ['a style element left open', '<style>p {} done', 3],
    ['a style end tag left open', '<style>p{}</style', 1],
    ['an upper-case style element left open', '<STYLE media="x">a b', 2],
    ['a second style element left open', '<style>a</style><style>b c', 2],
    ['a style element', '<style>a b</style> c d', 2],
    ['a style opener ending at its first >', '<style title="a>b">x</style> y', 1],
    ['a style element across a line separator', '<style>a\u2028b</style> c', 3],
    ['an svg element left open', '<svg>a b', 2],
    ['an svg element', '<svg><text>a b</text></svg> c', 3],
    ['an svg element with one inside left open', '<svg><svg>x</svg> y', 1],
    ['nested svg elements', '<svg><svg>x</svg></svg> y z', 2],
    ['an upper-case svg element', '<SVG width="1"><text>q</text></SVG> r', 2],
    ['verbatim HTML', '<html>a <b>b</b></html> c', 3],
    ['verbatim HTML left open', '<html>a b', 2],
    ['verbatim HTML holding markup', '<html>a [[x]] <<set $y to 1>></html>', 3],
    ['verbatim text', '<nowiki>a <b>b</b> [[c]]</nowiki> d', 4],
    ['verbatim text left open', '<nowiki>a b', 2],
    ['text an svg element does not render', '<svg>left open  Well  <<set $x to "A > B">>  </svg>', 0],
    ['text directly in an svg element', '<svg>a b</svg> c', 1],
    ['a tspan outside a text element', '<svg><tspan>a</tspan></svg> b', 1],
    ['links and groups in a text element', '<svg><text><a>a</a> <g>g</g></text></svg> b', 2],
    ['a foreignObject', '<svg><foreignObject>a <b>b</b></foreignObject></svg> c', 3],
    ['HTML that leaves an svg element', '<svg>a<b>b</b> c</svg> d', 3],
    ['an animation element in a text element', '<svg><text>a<set>b</set></text></svg>', 1],
    ['text paths', '<svg><textPath>a</textPath><text><textPath>b</textPath></text></svg>', 1],
    ['definitions', '<svg><defs><text>a</text></defs></svg> b', 1],
    ['MathML in passage markup', '<math><mi>x</mi><mrow>y</mrow> z</math> w', 1],
    ['MathML in verbatim HTML', '<html><math><mi>x</mi><mrow>y</mrow></math></html> w', 2],
    ['verbatim HTML with a style element left open', '<html><style></html> a b c d', 4],
    ['verbatim HTML with a comment left open', '<html><!-- x</html> a b c d', 4],
    ['verbatim HTML with a title element left open', '<html><title></html> a b c d', 4],
    ['an svg element with a comment left open', '<svg><!-- x</svg> a b c d', 4],
    ['a tag name that only starts with style, read by styleTag', '<styles>a</style> b', 2],
    ['a custom element named after style, read by styleTag', '<style-x>a</style> b', 2],
    ['a tag name that only starts with svg, read by svgTag', '<svgx>a</svgx> b', 2],
    ['a custom element named after svg', '<svg-icon name="x"></svg-icon> word', 1],
    ['a custom element named after svg left open', '<svg-icon> a b c', 3],
    ['a custom element named after style left open', '<style-box> a b c', 3],
    ['an svgx opener alone', '<svgx>', 0],
    ['a styles opener alone', '<styles>', 0],
    // #441: a `<svg` or `</svg` inside a comment SugarCube skips has no `>` of its own to stop the search of an opener.
    ['an svg element after a comment holding <svg', '/* <svg */ <svg>hi there</svg>', 0],
    ['an svg element after a SugarCube comment holding <svg', '/% <svg %/ <svg>hi there</svg>', 0],
    ['an svg element after a comment holding </svg', '/* </svg */ <svg>hi there</svg>', 0],
    ['an svg element after comments holding <svg', '/* <svg */ /* </svg */ <svg>a b</svg> c', 1],
    ['an svg element left open after a comment holding <svg', '/* <svg */ <svg>a b', 2],
    ['two svg elements left open around a comment holding <svg', '<svg>a /* <svg */ <svg>b', 2],
    ['an svg element closed by a tag after a comment holding <svg', '<svg>a /* <svg */ <svg>b</svg></svg> c', 1],
    ['a style element after a comment holding <style', '/* <style */ <style>a b</style> c', 1],
    ['verbatim HTML after a comment holding <html', '/* <html */ <html>a b</html> c', 3],
    ['verbatim text after a comment holding <nowiki', '/* <nowiki */ <nowiki>a b</nowiki> c', 3],
    ['a tag name that only starts with html', '<htmlx>a</htmlx> b', 2],
    ['a tag name that only starts with nowiki', '<nowikix>a</nowikix> b', 2],
  ])('counts %s as SugarCube shows it', (_label, text, words) => {
    expect(countTextWords(text, 'whitespace')).toBe(words);
  });

  it('reads link text as text, not as HTML', () => {
    expect(countTextWords('[[a <b and c>|Room]] d', 'whitespace')).toBe(5);
    expect(countTextWords('[[I <3 you|Room]]', 'whitespace')).toBe(3);
  });

  it('counts the words of the text without tags when the HTML nests too deeply to read', () => {
    // SugarCube shows one span: an element opened in both branches of an <<if>>, as text, nests 520 deep.
    const branches = '<<if $a>><span class="a"><<else>><span class="b"><</if>>Text</span>\n'.repeat(520);
    expect(countTextWordsChecked(branches, 'whitespace')).toEqual({ words: 520, htmlTooDeep: true });
    expect(countTextWordsChecked('<div>'.repeat(MAX_HTML_DEPTH) + 'a b', 'whitespace')).toEqual({
      words: 2,
      htmlTooDeep: true,
    });
    expect(countTextWordsChecked('<div>'.repeat(10) + 'a b', 'whitespace')).toEqual({ words: 2, htmlTooDeep: false });
    // An <svg> element is read on its own, and gives no words when it nests too deeply.
    expect(countTextWordsChecked(`<svg>${'<g>'.repeat(MAX_HTML_DEPTH)}</svg> a b`, 'whitespace')).toEqual({
      words: 2,
      htmlTooDeep: true,
    });
  });

  it.each([
    '[[Continue|The Second Passage]]',
    '[[Continue->The Second Passage]]',
    '[[The Second Passage<-Continue]]',
    '[[Continue|The Second Passage][$score = 1]]',
    '[[Continue->The Second Passage][$score = 1]]',
    '[[The Second Passage<-Continue][$name to "a b" + [1, 2]]]',
  ])('counts only the label of %s', (link) => {
    expect(countTextWords(link, 'whitespace')).toBe(1);
    expect(countTextWords(`${link} Done`, 'whitespace')).toBe(2);
  });

  it('counts a bare link as its passage name and leaves malformed links alone', () => {
    expect(countTextWords('[[The Second Passage]]', 'whitespace')).toBe(3);
    expect(countTextWords('[[a b->c d', 'whitespace')).toBe(3);
    expect(countTextWords('[[a b->c d][$x', 'whitespace')).toBe(3);
  });

  it('keeps link text and drops macros and tags', () => {
    expect(countTextWords('Go [[to the garden|Garden]] <<set $x to 1>> <b>now</b>', 'whitespace')).toBe(5);
  });
});

// The time limit only ends a hang: what the test checks is how the time grows (see helpers/growth.ts). Each input is
// made of `n` units (each case was written at 100,000); the fastest readers start at a larger `n`, and growth()
// doubles it further on a runner where the smaller input is still too fast to time.
describe('word counts take linear time on adversarial text', () => {
  const half = (n: number): number => Math.floor(n / 2);
  const N = 50_000;
  const cases: readonly (readonly [string, (n: number) => string, number?])[] = [
    ['unclosed comments', (n) => '/*'.repeat(n) + '/%'.repeat(n) + '<!--'.repeat(half(n))],
    ['unclosed macros', (n) => '<<'.repeat(2 * n)],
    ['unclosed links', (n) => '[['.repeat(2 * n) + '|'.repeat(n / 100), 4 * N],
    ['unclosed tags', (n) => '<'.repeat(4 * n)],
    ['unclosed macros with comparisons', (n) => '<<if $a > 1</if> '.repeat(half(n))],
    ['top-level elements', (n) => '<span>x</span>'.repeat(half(n))],
    ['macros with comparisons', (n) => '<<if $a >= 1>>x'.repeat(half(n)), 4 * N],
    ['tags with quoted >', (n) => '<br title="a > b">'.repeat(half(n))],
    ['unclosed attribute quotes', (n) => '<b title="'.repeat(half(n))],
    ['prose comparisons', (n) => 'a < b > c <3 '.repeat(half(n))],
    ['unclosed style tags', (n) => '<style title="'.repeat(half(n))],
    ['many links and no tag', (n) => '[[x]] '.repeat(n)],
    ['stray end tags', (n) => '</b > '.repeat(n)],
    ['deep nesting', (n) => '<b>x '.repeat(n)],
    ['end tags far from their start tags', (n) => '<b>'.repeat(400) + 'x </i>'.repeat(n)],
    ['end tags no start tag opened, after many', (n) => '<b>'.repeat(n) + '</i>'.repeat(n)],
    ['end tags no start tag opened, after many spans', (n) => '<span>'.repeat(n) + 'x</i> '.repeat(n)],
    ['end tags closing many at once', (n) => ('<b>'.repeat(1000) + '<i></b>').repeat(n / 500)],
    [
      'unclosed own elements',
      (n) => '<style>a '.repeat(half(n)) + '<html>b '.repeat(half(n)) + '<nowiki>c '.repeat(half(n)),
    ],
    ['unbalanced svg elements', (n) => '<svg>a '.repeat(n) + '</svg>'.repeat(10)],
    ['svg openers without a >', (n) => '<svg '.repeat(n)],
    ['svg openers after comments holding <svg', (n) => '/* <svg */ <svg>'.repeat(half(n))],
    ['one svg element after comments holding <svg', (n) => '/* <svg */ '.repeat(half(n)) + '<svg>x</svg>'],
    ['svg elements after comments holding <svg', (n) => '/* <svg */ <svg>x</svg> '.repeat(half(n))],
    ['nested svg elements', (n) => '<svg>'.repeat(n) + '</svg>'.repeat(n)],
    ['end tags of an element opened among many', (n) => '<b><i>'.repeat(n) + '</b>'.repeat(n)],
    ['style openers without a >', (n) => '<style '.repeat(n)],
    ['combining marks', (n) => 'a' + '\u0301'.repeat(4 * n), 20 * N],
  ];
  it.each(cases.map(([label, make, n = N]) => ({ label, make, n })))('$label', { timeout: 120_000 }, ({ make, n }) => {
    for (const method of ['tweego', 'whitespace'] as const) {
      expect(
        growth(make, (text) => countTextWords(text, method), n),
        method,
      ).toBeLessThan(LINEAR_GROWTH);
    }
  });
});

describe('whitespace word counts through the public API (#421, #422)', () => {
  const story = (text: string): { filename: string; content: string }[] => [
    { filename: 'story.tw', content: `:: StoryTitle\nCount test\n\n:: Start\n${text}` },
  ];

  it.each([
    ['<<if $score >= 10>>\nWell done!\n<</if>>', 2],
    ['<<if $score > 10>>\nWell done!\n<</if>>', 2],
    ['<<set $label to "A > B">>Well done!', 2],
    ['<span title="Use score > 10 points">Well done!</span>', 2],
    ["<span title='Use score > 10 points'>Well done!</span>", 2],
    ['I <3 you. <b>Always</b>', 4],
    ['A < B and C > D', 7],
  ])('compile() and lint() count %j as %i words', async (text, words) => {
    const compiled = await compile({ sources: story(text), outputMode: 'json', wordCountMethod: 'whitespace' });
    expect(compiled.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(compiled.stats.words).toBe(words);
    const linted = await lint({ sources: story(text), wordCountMethod: 'whitespace' });
    expect(linted.stats.words).toBe(words);
  });

  it('warns about a passage whose HTML nests too deeply to read, counts its text and builds the story', async () => {
    const text = '<<if $a>><span class="a"><<else>><span class="b"><</if>>Text</span>\n'.repeat(520) + 'Done';
    const warning = {
      level: 'warning',
      message:
        'Passage "Start": its HTML nests more than 512 elements deep, so its words are counted without reading its HTML.',
      file: 'story.tw',
      line: 4,
    };
    const compiled = await compile({ sources: story(text), outputMode: 'json', wordCountMethod: 'whitespace' });
    expect(compiled.output).toContain('Done');
    expect(compiled.stats.words).toBe(521);
    expect(compiled.diagnostics).toContainEqual(warning);
    const linted = await lint({ sources: story(text), wordCountMethod: 'whitespace' });
    expect(linted.stats.words).toBe(521);
    expect(linted.diagnostics).toContainEqual(warning);
    // The default method reads no HTML, and doesn't warn.
    const tweego = await compile({ sources: story(text), outputMode: 'json' });
    expect(tweego.diagnostics.filter((d) => d.message.includes('nests'))).toEqual([]);
  });
});

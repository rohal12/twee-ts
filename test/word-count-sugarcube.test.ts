/**
 * The `whitespace` word count compared with SugarCube 2 itself (#421, #422): each passage is wikified by the real
 * format in Chromium, and the words the reader sees are counted (see `helpers/sugarcube-oracle.ts`).
 *
 * The browser is found as in vite-plugin-entry-browser.test.ts. Without one the tests are skipped, except in CI, where
 * they fail. The cases in test/word-count.test.ts hold the counts SugarCube gave, so they run without a browser too.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { countTextWords } from '../src/word-count.js';
import { openSugarCubeOracle } from './helpers/sugarcube-oracle.js';

const oracle = await openSugarCubeOracle();
afterAll(async () => {
  await oracle?.close();
});

/**
 * Prose that SugarCube shows as it is, with `<` and `>` that start no markup. Left out: a `>` at the start of a line
 * (a block quote), `//` (italics) and `<<` or `>>` next to other markup, which other wikifier parsers read.
 */
const WORD = fc.constantFrom(
  'Well',
  'done!',
  'I <3 you.',
  '1<2',
  'A < B and C > D',
  'x >= y',
  '&',
  '&amp;',
  'a&nbsp;b',
);

/** Text inside quotes: anything but the quote itself and a line break. */
const quoted = (quote: string): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom('a', ' ', '>', '>>', '>=', '<', '<<b', '[[x]]', '=', '/', '"', "'"), { maxLength: 5 })
    .map((parts) => parts.join('').replaceAll(quote, ''));

/** Markup that shows its own words, or none, whatever SugarCube's state: no condition is false, no macro prints. */
const leafMarkup = (word: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom('1 > 0', '2 >= 1', '"A > B"', "'x >> y'", '`a > b`').map((arg) => `<<set $x to ${arg}>>`),
    fc.constantFrom('<<run 1 > 2>>', '<!-- a > b -->', '/* c > d */', '/% e %/', '<!-- left open'),
    fc.constantFrom(
      '<script>var a = 1 > 0;</script>',
      '<style>p > b { color: red }</style>',
      '<noscript>no</noscript>',
    ),
    word.map((w) => `<<if 2 >= 1>>${w}<</if>>`),
    fc.tuple(quoted('"'), word).map(([title, w]) => `<span title="${title}">${w}</span>`),
    fc.tuple(quoted("'"), word).map(([title, w]) => `<b class='${title}'>${w}</b>`),
    word.map((w) => `[[${w}|Start]]`),
    fc.constantFrom('<br>', '<hr/>', '<template>hidden</template>', '<textarea>shown</textarea>'),
    fc.constantFrom(
      '<style>left open',
      '<svg><text>drawn</text></svg>',
      '<svg>left open',
      '</svg>',
      '<html><i>raw</i> html</html>',
      '<html>left open',
      '<nowiki>as <b>written</b></nowiki>',
      '<nowiki>left open',
      '<iframe>fallback</iframe>',
      '<svg><g>ungrouped text</g><text>drawn <tspan>span</tspan></text></svg>',
      '<svg><foreignObject>foreign <b>text</b></foreignObject></svg>',
      '<html><svg>raw text</svg> after</html>',
      '<html><math><mi>x</mi><mrow>y</mrow></math></html>',
      '<math><mi>x</mi> z</math>',
      '<html><style></html>',
      '<html><!-- open</html>',
      '<svg><!-- open</svg>',
      '<styles>not a style</style>',
      '<svg-x>left open',
      '<style-x>left open',
      '<svg-x><text>drawn</text></svg-x>',
    ),
  );

const SEPARATOR = fc.constantFrom(' ', '\n', '  ');

/** Markup, and elements around it that the markup depends on (see `structure`). */
const markup = (word: fc.Arbitrary<string>): fc.Arbitrary<string> => fc.oneof(leafMarkup(word), structure(word));

/**
 * The elements whose reading depends on the context around a tag (#435): list items and table parts, which a start tag
 * of their own gives no node outside their parent, and foreign content (`<math>`, `<html>`). Each is generated as a
 * start or end tag on its own, as a whole element around prose and other markup, left open, and closed in the wrong
 * order.
 */
const STRUCTURE = ['ul', 'li', 'table', 'tr', 'td', 'math', 'html'] as const;
const structure = (word: fc.Arbitrary<string>, depth = 2): fc.Arbitrary<string> => {
  const tag = fc.constantFrom(...STRUCTURE);
  const content = fc.oneof(
    word,
    leafMarkup(word),
    fc.constantFrom('<b>bold</b>', '<br>', '<mi>x</mi>', '<mrow>y</mrow>', '<<set $x to 1>>', '[[a|Start]]'),
    tag.map((name) => `<${name}>`),
    tag.map((name) => `</${name}>`),
    ...(depth > 0 ? [structure(word, depth - 1)] : []),
  );
  const inside = fc.array(content, { maxLength: 4 });
  return fc.oneof(
    tag.map((name) => `<${name}>`),
    tag.map((name) => `</${name}>`),
    fc.constantFrom(
      '<ul><li>a</li><li>b</li></ul>',
      '<table><tr><td>a</td><td>b</td></tr></table>',
      '<table><tr><td>a</td></tr><tr><td>b</td></tr></table>',
    ),
    fc.tuple(tag, inside, SEPARATOR).map(([name, parts, sep]) => `<${name}>${parts.join(sep)}</${name}>`),
    fc.tuple(tag, inside, SEPARATOR).map(([name, parts, sep]) => `<${name}>${parts.join(sep)}`),
    fc
      .tuple(tag, tag, inside, SEPARATOR)
      .map(([outer, nested, parts, sep]) => `<${outer}><${nested}>${parts.join(sep)}</${outer}></${nested}>`),
    fc
      .tuple(tag, tag, inside, SEPARATOR)
      .map(([outer, nested, parts, sep]) => `<${outer}><${nested}>${parts.join(sep)}</${nested}></${outer}>`),
  );
};

/**
 * How many passages the sampled comparison takes, and from which seed: fixed, so a run can be repeated. A run with
 * `WORD_COUNT_ORACLE_RUNS` and `WORD_COUNT_ORACLE_SEED` set compares more, or other, passages.
 */
const SAMPLES = Number(process.env['WORD_COUNT_ORACLE_RUNS'] ?? 500);
const SEED = Number(process.env['WORD_COUNT_ORACLE_SEED'] ?? 421_422);

/** A passage of words and markup, set apart by white space. */
const passage = fc
  .tuple(fc.array(fc.oneof(WORD, markup(WORD)), { maxLength: 10 }), SEPARATOR)
  .map(([pieces, sep]) => pieces.join(sep));

describe.runIf(oracle !== undefined || process.env['CI'] !== undefined)(
  'whitespace word counts compared with SugarCube 2 in Chromium',
  () => {
    const counts = async (texts: readonly string[]): Promise<(number | undefined)[]> => {
      if (oracle === undefined) throw new Error('No SugarCube oracle.');
      return oracle.count(texts);
    };

    it('count the words SugarCube shows for the cases of #421, #422 and their review', async () => {
      const cases = [
        '<<set $label to "A > B">>Well done!',
        '<<if 2 >= 1>>\nWell done!\n<</if>>',
        '<<if 2 > 1>>\nWell done!\n<</if>>',
        '<span title="Use score > 10 points">Well done!</span>',
        "<span title='Use score > 10 points'>Well done!</span>",
        'I <3 you. <b>Always</b>',
        'A < B and C > D',
        'Intro <!-- TODO\nThe rest of a long passage that the reader sees.',
        'a /* b c',
        '<script>var a = 1;</script>Well done!',
        '<style>p { color: red }</style>Well done!',
        '<noscript>no js here</noscript>Well done!',
        '<template>hidden words</template>Well done!',
        '<textarea>Well done!</textarea>',
        '<a title="<<b">Well done and many words</a>. <<set $y to 2>>',
        'Well done <b',
        'Well <!x> <?y> </3> done!',
        'Well </b > done!',
        '<b><i>x</b></i> y',
        '<< Well done! >>',
        '<<if $score > 10 Well done!',
        'two<br>words',
        '[[a <b and c>|Start]] d',
        '<title>t t</title> x',
        '<iframe>a b</iframe> c',
        '<style>p {} done',
        '<style>p{}</style',
        '<STYLE media="x">a b',
        '<style>a</style><style>b c',
        '<style title="a>b">x</style> y',
        '<svg>a b',
        '<svg><svg>x</svg> y',
        '<svg><svg>x</svg></svg> y z',
        '<SVG width="1"><text>q</text></SVG> r',
        '<html>a <b>b</b></html> c',
        '<html>a b',
        '<html>a [[x]] <<set $y to 1>></html>',
        '<nowiki>a <b>b</b> [[c]]</nowiki> d',
        '<nowiki>a b',
        // The third review: SVG and MathML text, own elements' content read on its own, tag name boundaries.
        '<svg>left open  Well  <<set $x to "A > B">>  </svg>',
        '<svg>a b</svg> c',
        '<svg><tspan>a</tspan></svg> b',
        '<svg><text><a>a</a> <g>g</g></text></svg> b',
        '<svg><foreignObject>a <b>b</b></foreignObject></svg> c',
        '<svg>a<b>b</b> c</svg> d',
        '<svg><text>a<set>b</set></text></svg>',
        '<svg><textPath>a</textPath><text><textPath>b</textPath></text></svg>',
        '<math><mi>x</mi><mrow>y</mrow> z</math> w',
        '<html><math><mi>x</mi><mrow>y</mrow></math></html> w',
        '<html><style></html> a b c d',
        '<html><!-- x</html> a b c d',
        '<html><title></html> a b c d',
        '<svg><!-- x</svg> a b c d',
        '<styles>a</style> b',
        '<style-x>a</style> b',
        '<svgx>a</svgx> b',
        '<svg-icon name="x"></svg-icon> word',
        '<svg-icon> a b c',
        '<style-box> a b c',
        '<svgx>',
        '<styles>',
        '<text> <math> </text> <!-- open </math>',
        '<text> <math> </text> <!-- open </math> a b',
        // The fourth review (#435): elements that depend on their context, lists, tables and foreign content.
        '<table>Well\ndone!</table>',
        '<table>Well\n</table>done!',
        '<ul>y\n</ul>done!',
        '<ul>a\n<li>x\ny</li>\nb</ul>',
        '<ul><li>a</li>\n<li>b</li>\n</ul>',
        '<table><tr><td>a\nb</td></tr></table>',
        '<table><tr>a\nb</tr></table>',
        '<dl>a\nb</dl>',
        '<ul><span>a\nb</span>\nc</ul>',
        '<ul>[[a\nb|Start]]</ul>',
        '<ul>a\n\nb</ul>',
        '<ul>a\r\nb</ul>',
        '<tr><td>x</td></tr>',
        '<td>x</td> <td>y</td>',
        '<ul><tr>x</tr></ul>',
        '<table><tr><td>a</td><td>b</td></tr></table>',
        '<li>a</li><li>b</li>',
        '<math><b>bold</b></math>',
        '<math>t<mi>x</mi></math>',
        '<math><mi>x</mi> <mi>y</mi></math>',
        '<math><table>x</table></math>',
        '<table><math>q r</math></table>',
        '<math>  </math>a',
        '<math><svg><text>x</text></svg></math>',
        '<html><tr>x</tr></html>',
        '<html><td></td>bold</html>',
        '<html>a <tr>x</tr></html>',
        '<html><td>x</td></html>',
        '<html><col>a b</html>',
        '<html><table>\n<ul>&amp;</html></td>',
        '<html><table>  <mrow>y</html>*/',
        '<html><math><mi>x</mi>  </html>&',
        '<math><html><math><mi>y</math></html>',
        '<math><html></math></html><svg><text>drawn</svg>',
        '<svg><svg-x><text>drawn</text></svg-x></svg>',
        '<svg><g> </g></svg>a',
        'a &nbsp b',
      ];
      const shown = await counts(cases);
      expect(cases.map((text) => countTextWords(text, 'whitespace'))).toEqual(shown);
    });

    it('count the words SugarCube shows for generated passages', async () => {
      const texts = fc.sample(passage, { numRuns: SAMPLES, seed: SEED });
      const shown = await counts(texts);
      // SugarCube shows an error, or throws, for some of them (an element with no end tag): they have no count.
      const compared = texts.flatMap((text, i) => {
        const sugarCube = shown[i];
        return sugarCube === undefined ? [] : [{ text, sugarCube }];
      });
      const differ = compared.flatMap(({ text, sugarCube }) => {
        const words = countTextWords(text, 'whitespace');
        return words === sugarCube ? [] : [{ text, words, sugarCube }];
      });
      expect(differ).toEqual([]);
      expect(compared.length).toBeGreaterThan(texts.length / 2);
    }, 600_000);
  },
);

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTreeAdapter, html as htmlSpec, parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { countNormalizationSegments, countTextWords, stripComments } from '../src/word-count.js';
import { findMacroTags } from '../src/sugarcube-macros.js';
import { splitTweeFields } from '../src/twee-syntax.js';
import { HtmlNestingError, MAX_HTML_DEPTH } from '../src/html-structure.js';
import { compile, lint } from '../src/index.js';

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
 * Text inside quotes: anything but the quote itself and a line break. No `<<`: macro tags are found before HTML is
 * read, so one in an attribute value is a macro tag (see docs/configuration.md).
 */
const quotedText = (quote: string): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom('a', ' ', '>', '>>', '>=', '<', '=', '/', '"', "'", '`', '<b>'), { maxLength: 6 })
    .map((parts) => parts.join('').replaceAll(quote, ''))
    .filter((text) => !text.includes('<<'));

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

/** An HTML start tag (perhaps self-closing), end tag or comment, as an HTML parser reads them. */
const HTML_MARKUP = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('span', 'b', 'i', 'em', 'div', 'p', 'a', 'my-el', 'br', 'img', 'hr', 'SPAN'),
      fc.array(ATTRIBUTE, { maxLength: 3 }),
      fc.constantFrom('', '/', ' /'),
    )
    .map(([name, attributes, close]) => `<${name}${attributes.join('')}${close}>`),
  fc.constantFrom('span', 'b', 'div', 'p', 'a', 'my-el', 'SPAN').map((name) => `</${name}>`),
  fc.constantFrom('<!-- a > b -->', '<!---->', '</ b >'),
);

const SEPARATOR = fc.constantFrom(' ', '\n', '\t', '  ');

/** Prose words with markup between them, each piece set apart by white space. */
const proseWithMarkup = fc
  .array(fc.tuple(fc.array(fc.oneof(MACRO, HTML_MARKUP), { maxLength: 3 }), PROSE_WORD, SEPARATOR), {
    maxLength: 12,
  })
  .map((pieces) => ({
    words: pieces.length,
    text: pieces.map(([markup, word, sep]) => [...markup, word].join(sep)).join(' '),
  }));

/** The text content of `html` read as the content of a `div` element, by parse5's tree (the differential oracle). */
function htmlTreeText(html: string): string {
  const context = defaultTreeAdapter.createElement('div', htmlSpec.NS.HTML, []);
  const fragment = parseFragment(context, html, { scriptingEnabled: true });
  const text: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (node.nodeName === '#text' && 'value' in node) text.push(node.value);
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(fragment);
  return text.join('');
}

/** Characters that make macros, tags, comments, character references and their text, but no links or tables. */
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
  '<<',
  '>>',
  'amp',
  'lt',
);

describe("countTextWords 'whitespace'", () => {
  it('counts the prose between SugarCube macros and HTML markup, however their arguments use > (#421, #422)', () => {
    fc.assert(
      fc.property(proseWithMarkup, ({ words, text }) => {
        expect(countTextWords(text, 'whitespace')).toBe(words);
      }),
      { numRuns: 5_000 },
    );
  });

  it('counts the words of the text an HTML parser reads, after macros (differential against the parse5 tree)', () => {
    fc.assert(
      fc.property(fc.array(HTML_ALPHABET, { maxLength: 24 }), (parts) => {
        const s = parts.join('');
        const withoutMacros = findMacroTags(stripComments(s)).reduceRight(
          (rest, tag) => rest.slice(0, tag.start) + rest.slice(tag.end),
          stripComments(s),
        );
        expect(countTextWords(s, 'whitespace')).toBe(splitTweeFields(htmlTreeText(withoutMacros)).length);
      }),
      { numRuns: 20_000 },
    );
  });

  it('counts what the markup expressions leave for prose without markup characters (differential)', () => {
    fc.assert(
      fc.property(
        sharedGrammar.filter((s) => !/[<>]/.test(s)),
        (s) => {
          expect(countTextWords(s, 'whitespace')).toBe(whitespaceOracle(s));
        },
      ),
      { numRuns: 20_000 },
    );
  });

  it.each([
    ['no macro', 'Well done!', 2],
    ['a < condition', '<<if $score < 10>>\nWell done!\n<</if>>', 2],
    ['a > condition', '<<if $score > 10>>\nWell done!\n<</if>>', 2],
    ['a >= condition', '<<if $score >= 10>>\nWell done!\n<</if>>', 2],
    ['a quoted > argument', '<<set $label to "A > B">>Well done!', 2],
    ['a single-quoted >> argument', "<<set $label to 'A >> B'>>Well done!", 2],
    ['a backquoted > argument', '<<print `${$a > 1}`>> Well done!', 2],
    ['nested macro text in a string', '<<link "Go" "<<goto Room>>">> Well done! <</link>>', 2],
    ['link markup holding > in a macro', '<<link [[A>B|Room]]>>Well done!<</link>>', 2],
    ['a >> that ends the tag early', '<<set $x to 1 >> 2>> Well done!', 3],
    ['text that is no macro', '<< Well done! >>', 4],
    ['an unclosed macro, whose `<if $score >` is a tag', '<<if $score > 10 Well done!', 4],
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
    ['an end tag with spaces', 'Well </b > done!', 2],
    ['a self-closing tag', 'Well<br/> done!', 2],
    ['a no-break space reference', 'Well&nbsp;done!', 2],
    ['an escaped tag', '&lt;b&gt; Well', 2],
    ['an upper-case tag', '<SPAN CLASS="x > y">Well</SPAN> done!', 2],
    ['a bogus comment', 'Well <!x> <?y> </3> done!', 2],
    ['a tag split by a line break', '<span\ntitle="a > b"\n>Well done!</span>', 2],
    ['textarea text', '<textarea><b>Well</b> done!</textarea>', 2],
    ['text a table moves before itself', '<table>Well <tr><td>done!</td></tr></table>', 2],
    ['a tag left open at the end', 'Well done! <span title="a > b"', 2],
    ['a frameset tag', '<frameset>Well done!</frameset>', 2],
    ['a stray end tag of the element it is read in', 'Well</div> done!</body></html> again', 3],
  ])('counts the text around HTML with %s (#422)', (_label, text, words) => {
    expect(countTextWords(text, 'whitespace')).toBe(words);
  });

  it('reads link text as text, not as HTML', () => {
    expect(countTextWords('[[a <b and c>|Room]] d', 'whitespace')).toBe(5);
    expect(countTextWords('[[I <3 you|Room]]', 'whitespace')).toBe(3);
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

describe('word counts take linear time on adversarial text', () => {
  it.each([
    ['unclosed comments', '/*'.repeat(100_000) + '/%'.repeat(100_000) + '<!--'.repeat(50_000)],
    ['unclosed macros', '<<'.repeat(200_000)],
    ['unclosed links', '[['.repeat(200_000) + '|'.repeat(1000)],
    ['unclosed tags', '<'.repeat(400_000)],
    ['unclosed macros with comparisons', '<<if $a > 1</if> '.repeat(50_000)],
    ['top-level elements', '<span>x</span>'.repeat(50_000)],
    ['macros with comparisons', '<<if $a >= 1>>x'.repeat(50_000)],
    ['tags with quoted >', '<br title="a > b">'.repeat(50_000)],
    ['unclosed attribute quotes', '<b title="'.repeat(50_000)],
    ['prose comparisons', 'a < b > c <3 '.repeat(50_000)],
    ['combining marks', 'a' + '\u0301'.repeat(400_000)],
  ])('%s', (_label, text) => {
    for (const method of ['tweego', 'whitespace'] as const) {
      const started = performance.now();
      countTextWords(text, method);
      expect(performance.now() - started).toBeLessThan(3000);
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

  it('names the passage whose HTML nests too deeply to count', async () => {
    const text = '<div>'.repeat(MAX_HTML_DEPTH + 1);
    expect(() => countTextWords(text, 'whitespace')).toThrow(HtmlNestingError);
    await expect(compile({ sources: story(text), outputMode: 'json', wordCountMethod: 'whitespace' })).rejects.toThrow(
      /^story\.tw:4: Passage "Start": HTML nests more than 512 elements deep\.$/,
    );
    // The default method reads no HTML.
    const compiled = await compile({ sources: story(text), outputMode: 'json' });
    expect(compiled.stats.words).toBeGreaterThan(0);
  });
});

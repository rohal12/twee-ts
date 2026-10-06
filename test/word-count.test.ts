import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { countNormalizationSegments, countTextWords, stripComments } from '../src/word-count.js';

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
  '[',
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

describe("countTextWords 'whitespace'", () => {
  it('counts what the markup expressions leave (differential)', () => {
    fc.assert(
      fc.property(markup, (s) => {
        expect(countTextWords(s, 'whitespace')).toBe(whitespaceOracle(s));
      }),
      { numRuns: 20_000 },
    );
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
    ['combining marks', 'a' + '\u0301'.repeat(400_000)],
  ])('%s', (_label, text) => {
    for (const method of ['tweego', 'whitespace'] as const) {
      const started = performance.now();
      countTextWords(text, method);
      expect(performance.now() - started).toBeLessThan(3000);
    }
  });
});

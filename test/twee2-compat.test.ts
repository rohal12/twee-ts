import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { twee2ToV3 } from '../src/twee2-compat.js';
import { parseTwee } from '../src/parser.js';

/**
 * Tweego's three expressions (twee2compat.go), written as JavaScript expressions with Go's (RE2, Perl flags)
 * semantics: lines end only at LF, so `(?m)^` is `(?<=^|\n)` and `(?m)$` is `(?=\n|$)`; `.` is `[^\n]`; a
 * negated class such as `[^\[]` matches LF too (Go's ClassNL). Both engines choose the leftmost-first match,
 * so on short inputs these give exactly what Tweego gives. They backtrack, so they are an oracle for tests
 * only.
 */
const DETECT = /(?<=^|\n)::[ ]*[^[]*?(?:[ ]*\[[^\n]*?\])?[ ]*<([^\n]*?)>[ ]*(?=\n|$)/;
const HEADER = /(?<=^|\n)(::[ ]*[^[]*?)([ ]*\[[^\n]*?\])?(?:[ ]*<([^\n]*?)>)?[ ]*(?=\n|$)/g;
const BAD_POSITION = /(?<=^|\n)(::[^\n]*?)[ ]*\{"position":"[ ]*"\}(?=\n|$)/g;

function tweegoToV3(s: string): string {
  if (!DETECT.test(s)) return s;
  return s
    .replace(
      HEADER,
      (_m, p1: string, p2: string | undefined, p3: string | undefined) => `${p1}${p2 ?? ''} {"position":"${p3 ?? ''}"}`,
    )
    .replace(BAD_POSITION, '$1');
}

const TOKENS = fc.constantFrom(
  '::',
  ':',
  ' ',
  '  ',
  'a',
  'b c',
  '[',
  ']',
  '<',
  '>',
  '{',
  '}',
  '"',
  ',',
  '1,2',
  '\n',
  '\n::',
  '{"position":"',
  '"}',
  '\u2028',
  '\u2029',
  '\r',
  '\t',
);
const source = fc.array(TOKENS, { maxLength: 14 }).map((tokens) => tokens.join(''));

describe('twee2ToV3 gives what Tweego gives (differential against its expressions)', () => {
  it('on random headers and text', () => {
    fc.assert(
      fc.property(source, (s) => {
        expect(twee2ToV3(s)).toBe(tweegoToV3(s));
      }),
      { numRuns: 20_000 },
    );
  });

  it('on twee2 headers with tags and positions', () => {
    const header = fc
      .tuple(
        fc.constantFrom('::', ':: ', '::  '),
        fc.constantFrom('Name', 'Two words', 'a<b>c', ''),
        fc.constantFrom('', ' [t]', '[t u]', '  [a] [b]', ' [x'),
        fc.constantFrom('', ' <1,2>', '<3,4>', ' <>', ' < >', ' <5,6', ' <7,8> x'),
        fc.constantFrom('', ' ', '   '),
      )
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(
        fc.array(header, { minLength: 1, maxLength: 3 }),
        fc.array(source, { maxLength: 2 }),
        (headers, texts) => {
          const s = headers.map((h, i) => `${h}\n${texts[i] ?? ''}`).join('\n');
          expect(twee2ToV3(s)).toBe(tweegoToV3(s));
        },
      ),
      { numRuns: 5000 },
    );
  });
});

describe('twee2ToV3 examples', () => {
  it('converts position blocks and leaves the rest', () => {
    expect(twee2ToV3(':: Foo [bar] <1,2>\nText')).toBe(':: Foo [bar] {"position":"1,2"}\nText');
    expect(twee2ToV3(':: Foo <1,2>\n:: Bar [x]\n:: Baz   ')).toBe(':: Foo {"position":"1,2"}\n:: Bar [x]\n:: Baz');
    expect(twee2ToV3(':: Foo\nText')).toBe(':: Foo\nText');
  });

  it('ends lines only at LF, as Go does, not at U+2028 or U+2029 (T-08)', () => {
    // A content line holding U+2028 then "::" is not a header, and its text is kept.
    expect(twee2ToV3(':: A <1,2>\nsee\u2028:: a <<b>>')).toBe(':: A {"position":"1,2"}\nsee\u2028:: a <<b>>');
    // A header with U+2029 in its name is still converted.
    expect(twee2ToV3(':: Foo\u2029bar <1,2>\nx')).toBe(':: Foo\u2029bar {"position":"1,2"}\nx');
    expect(parseTwee(':: Foo\u2029bar <1,2>\nx', { twee2Compat: true }).passages[0]).toMatchObject({
      name: 'Foo\u2029bar',
      metadata: { position: '1,2' },
    });
  });

  it('detects a position block on a later line, as Go detection crosses lines', () => {
    // Go's `[^\[]*?` crosses line ends, so this text counts as Twee2 and its header lines are rewritten.
    expect(twee2ToV3(':: A  \nsome <b>')).toBe(':: A\nsome <b>');
    expect(twee2ToV3(':: A [t] \nsome <b>')).toBe(':: A [t] \nsome <b>');
  });

  it('runs in linear time on long lines', () => {
    for (const s of [
      ':: ' + ' '.repeat(200_000) + 'x <1>',
      ':: ' + ' '.repeat(200_000) + '[' + ']'.repeat(100_000) + ' y',
      ':: a' + ' <'.repeat(100_000) + '>',
      (':: A\n' + ' '.repeat(1000) + '<x\n').repeat(200),
      ':: a {"position":"' + ' '.repeat(200_000),
    ]) {
      const started = performance.now();
      twee2ToV3(s);
      expect(performance.now() - started).toBeLessThan(3000);
    }
  });
});

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  isHeaderLine,
  isTweeSpace,
  normalizeTweeSource,
  splitTweeFields,
  stripTrailingBlankLines,
  trimTweeSpace,
  tweeEscape,
  tweeUnescape,
} from '../src/twee-syntax.js';
import { tweeLexer } from '../src/lexer.js';
import { parseTwee } from '../src/parser.js';
import { ItemType } from '../src/types.js';

/**
 * Go's `unicode.IsSpace` is the Unicode White_Space property (its Latin-1 list is the same set), which
 * JavaScript exposes as `\p{White_Space}`. JavaScript's own `\s` differs: it has U+FEFF and lacks U+0085.
 */
const WHITE_SPACE = /^\p{White_Space}$/u;

/** Characters that tell the white space definitions apart, and ones that matter to Twee syntax. */
const TRICKY = fc.constantFrom(
  ' ',
  '\t',
  '\n',
  '\r',
  '\v',
  '\f',
  '\u0085',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u200b',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u3000',
  '\ufeff',
  '\u180e',
  'a',
  'é',
  '\\',
  '[',
  ']',
  '{',
  '}',
  ':',
  '\u0000',
  '😀',
);
const trickyString = fc.string({ unit: TRICKY, maxLength: 12 });

describe('isTweeSpace: Go unicode.IsSpace', () => {
  it('agrees with the Unicode White_Space property for every BMP code unit', () => {
    for (let unit = 0; unit <= 0xffff; unit++) {
      const expected = unit < 0xd800 || unit > 0xdfff ? WHITE_SPACE.test(String.fromCharCode(unit)) : false;
      if (isTweeSpace(unit) !== expected) throw new Error(`U+${unit.toString(16)}: expected ${String(expected)}`);
    }
    expect(isTweeSpace(0x85)).toBe(true);
    expect(isTweeSpace(0xfeff)).toBe(false);
  });
});

describe('trimTweeSpace and splitTweeFields: Go bytes.TrimSpace and strings.Fields', () => {
  it('trim exactly the White_Space characters at both ends', () => {
    fc.assert(
      fc.property(trickyString, (s) => {
        expect(trimTweeSpace(s)).toBe(s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ''));
      }),
      { numRuns: 2000 },
    );
  });

  it('split at runs of White_Space characters, dropping empty fields', () => {
    fc.assert(
      fc.property(trickyString, (s) => {
        expect(splitTweeFields(s)).toEqual(s.split(/\p{White_Space}+/u).filter((f) => f !== ''));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('tweeEscape and tweeUnescape', () => {
  it('escape the five Twee metacharacters, and unescape gives the text back', () => {
    expect(tweeEscape('a\\b[c]d{e}f')).toBe('a\\\\b\\[c\\]d\\{e\\}f');
    expect(tweeEscape('')).toBe('');
    fc.assert(
      fc.property(trickyString, (s) => {
        expect(tweeUnescape(tweeEscape(s))).toEqual({ text: s, danglingBackslash: false });
      }),
      { numRuns: 2000 },
    );
  });

  it('yield the character after any backslash, as the Twee 3 specification says (\\q gives q)', () => {
    fc.assert(
      fc.property(trickyString, (s) => {
        const reference = s.replace(/\\([\s\S])/gu, '$1');
        const { text, danglingBackslash } = tweeUnescape(s);
        expect(danglingBackslash ? text + '\\' : text).toBe(reference);
      }),
      { numRuns: 2000 },
    );
  });

  it('drop a backslash at the very end, as Tweego does, and say so (T-14)', () => {
    expect(tweeUnescape('foo\\')).toEqual({ text: 'foo', danglingBackslash: true });
    expect(tweeUnescape('foo\\\\')).toEqual({ text: 'foo\\', danglingBackslash: false });
    expect(tweeUnescape('\\')).toEqual({ text: '', danglingBackslash: true });
  });
});

describe('isHeaderLine and normalizeTweeSource', () => {
  it('read a line as a header when it starts with "::" after any byte order marks', () => {
    expect(['::', ':: A', '\ufeff::', '\ufeff\ufeff:: A'].map(isHeaderLine)).toEqual([true, true, true, true]);
    expect([' ::', ':', 'a::', '\u00a0::', '\u200b::'].map(isHeaderLine)).toEqual([false, false, false, false, false]);
  });

  it('normalize line endings and remove the BOMs before headers only', () => {
    expect(normalizeTweeSource('\ufeff:: A\r\na\rb\n\ufeff\ufeff:: B\n\ufeffkept\nx\ufeff::y')).toBe(
      ':: A\na\nb\n:: B\n\ufeffkept\nx\ufeff::y',
    );
  });

  it('is idempotent, and leaves no CR', () => {
    fc.assert(
      fc.property(trickyString, (s) => {
        const once = normalizeTweeSource(s);
        expect(normalizeTweeSource(once)).toBe(once);
        expect(once).not.toContain('\r');
      }),
      { numRuns: 1000 },
    );
  });

  it('turns every line that isHeaderLine accepts into a line the lexer reads as a header (and only those)', () => {
    const line = fc.string({ unit: fc.constantFrom('\ufeff', ':', ' ', 'a', '\u00a0'), maxLength: 5 });
    fc.assert(
      fc.property(fc.array(line, { maxLength: 4 }), (lines) => {
        const source = ['x', ...lines].join('\n');
        const headers = [...tweeLexer(normalizeTweeSource(source))].filter((item) => item.type === ItemType.Header);
        expect(headers.length).toBe(lines.filter(isHeaderLine).length);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('stripTrailingBlankLines', () => {
  /** The specification's rule, line by line: drop trailing lines that hold only white space. */
  function reference(text: string): string {
    const lines = text.split('\n');
    while (lines.length > 0 && trimTweeSpace(lines[lines.length - 1] ?? '') === '') lines.pop();
    return lines.join('\n');
  }

  it('drops the trailing lines that hold only white space and keeps everything else', () => {
    expect(stripTrailingBlankLines('  a  \n \t\n\n')).toBe('  a  ');
    expect(stripTrailingBlankLines('   \n')).toBe('');
    expect(stripTrailingBlankLines('a\u2028 ')).toBe('a\u2028 ');
    fc.assert(
      fc.property(trickyString, (s) => {
        expect(stripTrailingBlankLines(s)).toBe(reference(s));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('lexer and parser details shared with Tweego', () => {
  it('reports an unterminated tag block after an escaped line end on the header line, as Tweego (T-06)', () => {
    const errors = [...tweeLexer(':: A [tag\\\nbody\n')].filter((item) => item.type === ItemType.Error);
    expect(errors.map((e) => [e.line, e.val])).toEqual([[1, 'unterminated tag block']]);
    expect(parseTwee(':: A [tag\\\nbody\n').diagnostics.map((d) => d.line)).toEqual([1]);
    expect(parseTwee(':: A [tag\nbody\n').diagnostics.map((d) => d.line)).toEqual([1]);
    expect(parseTwee(':: A [tag\\').diagnostics.map((d) => d.line)).toEqual([1]);
  });

  it('trims names, splits tags and trims text at Go white space: U+0085 is space, U+FEFF is not (T-07)', () => {
    const [nel] = parseTwee(':: Start\u0085 [a\u0085b]\n\u0085hello\u0085').passages;
    expect(nel).toMatchObject({ name: 'Start', tags: ['a', 'b'], text: 'hello' });
    const [bom] = parseTwee(':: \ufeffStart [a\ufeffb]\n\ufeffhello\ufeff').passages;
    expect(bom).toMatchObject({ name: '\ufeffStart', tags: ['a\ufeffb'], text: '\ufeffhello\ufeff' });
  });

  it('drops a trailing lone backslash of a name with a warning, as Tweego drops it (T-14)', () => {
    const { passages, diagnostics } = parseTwee(':: foo\\\nbody', { filename: 'a.tw' });
    expect(passages[0]?.name).toBe('foo');
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message:
          'line 1: The passage name "foo" ends in a backslash that escapes nothing; it is dropped, as in Tweego. Write "\\\\" for a backslash.',
        file: 'a.tw',
        line: 1,
      },
    ]);
    expect(parseTwee(':: foo\\\\\nbody').passages[0]?.name).toBe('foo\\');
  });

  it('keeps text exactly with trim: false, but for its trailing blank lines (S-2)', () => {
    const text = (source: string): string | undefined => parseTwee(source, { trim: false }).passages[0]?.text;
    expect(text(':: A\n  a  \n \n\n:: B')).toBe('  a  ');
    expect(text(':: A\n   \n:: B')).toBe('');
    expect(text(':: A\n\n\nx')).toBe('\n\nx');
  });
});

describe('parsing takes linear time on adversarial input (T-11)', () => {
  const timed = (run: () => void): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it.each([
    ['blank lines', ':: A\n' + '\n'.repeat(200_000) + 'x\n'],
    ['spaces and line ends', ':: A\nx' + ' \n'.repeat(200_000) + 'y'],
    ['trailing white space', ':: A\nx' + ' \u0085\n\t'.repeat(100_000)],
    ['backslashes in a name', ':: ' + '\\a'.repeat(200_000) + '\nx'],
    ['spaces in a tag block', ':: A [' + ' '.repeat(200_000) + 'b]\nx'],
    ['many headers', ':: A\n'.repeat(100_000)],
  ])('%s', (_label, source) => {
    expect(timed(() => parseTwee(source, { trim: false }))).toBeLessThan(3000);
    expect(timed(() => parseTwee(source))).toBeLessThan(3000);
  });
});

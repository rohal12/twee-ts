import { describe, expect, it, vi } from 'vitest';
import { Parser } from 'acorn';
import { compile, storyInspect } from '../src/index.js';
import { decodeFormatJSON } from '../src/format-decode.js';
import { AcornParser, SCRIPT_OPTIONS, parseScript, trySyntax } from '../src/js-syntax.js';
import { STORY } from './helpers/plugins.js';

const pattern = (n: number): string => Array<string>(n).fill('(?<x>a)').join('|');
const MESSAGE = 'Regular expression exceeds the parser limit of 128 captures with the same name';

/** Observe Acorn's actual branch comparisons without replacing its validation. */
async function branchWork<T>(read: () => T | Promise<T>): Promise<{ value: T; work: number }> {
  let work = 0;
  interface Branch {
    separatedFrom: (other: unknown) => boolean;
  }
  const branches = new Map<Branch, Branch['separatedFrom']>();
  const parser = Parser.prototype as unknown as { regexp_groupSpecifier: (state: { branchID: object }) => void };
  const original = parser.regexp_groupSpecifier;
  parser.regexp_groupSpecifier = function (state): void {
    const branch = Object.getPrototypeOf(state.branchID) as Branch;
    if (!branches.has(branch)) {
      const compare = branch.separatedFrom;
      branches.set(branch, compare);
      branch.separatedFrom = function (other): boolean {
        work++;
        return compare.call(this, other);
      };
    }
    original.call(this, state);
  };
  try {
    return { value: await read(), work };
  } finally {
    parser.regexp_groupSpecifier = original;
    for (const [branch, compare] of branches) branch.separatedFrom = compare;
  }
}

for (const flags of ['', 'u', 'v']) {
  describe(`bounded named captures /${flags} (#571)`, () => {
    it.each([1000, 4000])(
      'rejects %s repeated names before unbounded comparisons or native construction',
      async (n) => {
        const native = vi.spyOn(globalThis, 'RegExp');
        try {
          const { value, work } = await branchWork(() => parseScript(`const r=/${pattern(n)}/${flags};`));
          expect(value.ok).toBe(false);
          expect(!value.ok && value.error.message).toBe(MESSAGE);
          expect(work).toBeGreaterThan(0);
          expect(work).toBeLessThan(17000);
          expect(native.mock.calls.some(([source]) => source === pattern(n))).toBe(false);
        } finally {
          native.mockRestore();
        }
      },
    );

    it('allows the limit, backreferences and fresh literals in the same parser', () => {
      const nested = Array<string>(128)
        .fill('('.repeat(10) + '(?<x>a)' + ')'.repeat(10))
        .join('|');
      const regex = `/${nested}\\k<x>/${flags}`;
      expect(parseScript(`const a=${regex}; const b=${regex};`).ok).toBe(true);
      expect(parseScript(`/${pattern(129)}/${flags}`).ok).toBe(false);
    });

    it('bounds direct module parsing and tokenizer use too', () => {
      const code = `/${pattern(1000)}/${flags};`;
      const parsed = trySyntax(() => AcornParser.parse(code, { ...SCRIPT_OPTIONS, sourceType: 'module' }));
      const tokenized = trySyntax(() => AcornParser.tokenizer(code, SCRIPT_OPTIONS).getToken());
      expect(!parsed.ok && parsed.error.message).toBe(MESSAGE);
      expect(!tokenized.ok && tokenized.error.message).toBe(MESSAGE);
    });
  });
}

describe('regular-expression controls and public paths (#571)', () => {
  it('bounds ancestor comparisons for repeated names in deeply nested disjoint branches', async () => {
    const source = Array<string>(64)
      .fill('('.repeat(100) + '(?<x>a)' + ')'.repeat(100))
      .join('|');
    const measured = await branchWork(() => parseScript(`/${source}/u;`));
    expect(!measured.value.ok && measured.value.error.message).toContain('parser validation work limit');
    expect(measured.work).toBeLessThan(200);
  });

  it('keeps many unique names and unnamed groups valid', () => {
    for (const flags of ['', 'u', 'v']) {
      for (const source of [
        Array.from({ length: 1000 }, (_, i) => `(?<x${String(i)}>a)`).join('|'),
        Array<string>(1000).fill('(a)').join('|'),
      ])
        expect(parseScript(`/${source}/${flags};`).ok).toBe(true);
    }
  });

  it.each([
    '(?<x>a)(?<x>b)',
    '(?<x>a)|(?<x>b)(?<x>c)',
    '(?<x>a)(?:(?<x>b)|c)',
    '(?<__proto__>a)(?<__proto__>b)',
    '(?<x>a)(?<\\u0078>b)',
  ])('keeps Acorn duplicate-name errors for %s', (source) => {
    const parsed = parseScript(`/${source}/u;`);
    expect(!parsed.ok && parsed.error.message).toContain('Duplicate capture group name');
  });

  it('counts escaped spellings as the same name and handles prototype-looking names', () => {
    for (const name of ['\\u0078', '__proto__', 'constructor']) {
      const code = `/${Array<string>(129).fill(`(?<${name}>a)`).join('|')}/;`;
      const parsed = parseScript(code);
      expect(!parsed.ok && parsed.error.message).toBe(MESSAGE);
    }
  });

  it('reports format decoding limits explicitly', async () => {
    const measured = await branchWork(() =>
      decodeFormatJSON(
        `const r=/${pattern(4000)}/;storyFormat({name:"Probe",version:"1.0.0",source:"{{STORY_DATA}}"});`,
      ),
    );
    expect(measured.value).toEqual({ ok: false, reason: expect.stringContaining(MESSAGE) });
    expect(measured.work).toBeLessThan(17000);
  });

  it('bounds compilation, inspection and recovery while retaining later links', async () => {
    const measured = await branchWork(async () => {
      const result = await compile({
        sources: [
          { filename: 'story.tw', content: STORY },
          { filename: 'code.js', content: `const r=/${pattern(4000)}/; const link="</script>[[Start]]";` },
        ],
        outputMode: 'twine2-archive',
      });
      expect(result.diagnostics.map((d) => d.message).join('\n')).toContain(MESSAGE);
      expect([...storyInspect(result.story).links.values()].flat()).toContain('Start');
    });
    // Compile's diagnostic pass plus inspection's parse and tolerant tokenizer.
    expect(measured.work).toBeLessThan(50000);
  });
});

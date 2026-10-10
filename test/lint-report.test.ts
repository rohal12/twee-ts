import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatLintReport } from '../src/lint.js';
import type { LintResult } from '../src/lint.js';

const BASE: LintResult = {
  diagnostics: [],
  stats: { passages: 1, storyPassages: 1, words: 1234, files: ['a.tw'] },
  formatName: '',
  formatVersion: '',
  start: 'Start',
  passages: 1,
  storyPassages: 1,
  infoPassages: 0,
  brokenLinks: [],
  deadEnds: [],
  orphans: [],
};

describe('formatLintReport diagnostics and format line', () => {
  it('lists errors before warnings, with their counts', () => {
    const report = formatLintReport({
      ...BASE,
      diagnostics: [
        { level: 'warning', message: 'careful' },
        { level: 'error', message: 'broken' },
      ],
    });

    expect(report).toContain('Diagnostics: 1 error(s), 1 warning(s)');
    expect(report).toContain('  error: broken');
    expect(report.indexOf('error: broken')).toBeLessThan(report.indexOf('warning: careful'));
  });

  it('names the format without a version when StoryData has none', () => {
    expect(formatLintReport({ ...BASE, formatName: 'SugarCube' })).toMatch(/^Format: SugarCube$/m);
  });

  it('calls the format unknown when StoryData names none', () => {
    expect(formatLintReport(BASE)).toMatch(/^Format: unknown$/m);
  });
});

describe('formatLintReport counts (#250 CLI-3)', () => {
  it.each([
    [0, [], '0 words, 0 files'],
    [1, ['a.tw'], '1 word, 1 file'],
    [2, ['a.tw', 'b.tw'], '2 words, 2 files'],
    [1234, ['a.tw'], '1,234 words, 1 file'],
    [241676, ['a.tw'], '241,676 words, 1 file'],
    [1000000, ['a.tw'], '1,000,000 words, 1 file'],
  ])('writes %d words and %j as "%s"', (words, files, expected) => {
    const report = formatLintReport({ ...BASE, stats: { ...BASE.stats, words, files } });
    expect(report).toContain(`info), ${expected}\n`);
  });

  it('groups digits as en-US does, whatever the system locale (#375)', () => {
    fc.assert(
      fc.property(fc.maxSafeNat(), (words) => {
        const report = formatLintReport({ ...BASE, stats: { ...BASE.stats, words } });
        expect(report).toContain(`info), ${words.toLocaleString('en-US')} word`);
      }),
    );
  });
});

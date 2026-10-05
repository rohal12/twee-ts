import { describe, it, expect } from 'vitest';
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

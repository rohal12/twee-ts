import { describe, expect, it } from 'vitest';
import {
  formatBaseline,
  parseBaseline,
  parseMutationReport,
  renderComparison,
  score,
  scores,
} from '../scripts/mutation-core.js';

const report = (files: Record<string, readonly string[]>): string =>
  JSON.stringify({
    schemaVersion: '2',
    files: Object.fromEntries(
      Object.entries(files).map(([path, statuses]) => [path, { mutants: statuses.map((status) => ({ status })) }]),
    ),
  });

describe('mutation report scores', () => {
  it('scores detected over detected plus undetected, leaving invalid mutants out', () => {
    const counts = parseMutationReport(
      report({
        'src/a.ts': ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored'],
        'src/b.ts': ['Killed'],
      }),
    );
    expect(counts.get('src/a.ts')).toEqual({ detected: 2, undetected: 2, invalid: 3 });
    expect(scores(counts)).toEqual({ 'src/a.ts': 50, 'src/b.ts': 100, total: 60 });
  });

  it('gives 100 for a file without valid mutants, as Stryker does', () => {
    expect(score({ detected: 0, undetected: 0, invalid: 4 })).toBe(100);
  });

  it.each([
    ['not an object', '[]'],
    ['no files', '{}'],
    ['a file without mutants', '{"files":{"a.ts":{}}}'],
    ['a mutant without status', '{"files":{"a.ts":{"mutants":[{}]}}}'],
  ])('rejects a report with %s', (_label, text) => {
    expect(() => parseMutationReport(text)).toThrow(/Not a mutation testing report/);
  });
});

describe('baseline comparison', () => {
  it('reads a baseline of numbers and rejects anything else', () => {
    expect(parseBaseline('{"src/a.ts": 80, "total": 75}')).toEqual({ 'src/a.ts': 80, total: 75 });
    expect(() => parseBaseline('[]')).toThrow(/object of scores/);
    expect(() => parseBaseline('{"src/a.ts": "80"}')).toThrow(/must be a number/);
  });

  it('marks the files that fell below the baseline, total last', () => {
    const text = renderComparison(
      { 'src/b.ts': 70, 'src/a.ts': 90, total: 80 },
      { 'src/a.ts': 85, 'src/b.ts': 75, total: 80 },
    );
    expect(text.split('\n').filter((line) => line.startsWith('| src') || line.startsWith('| total'))).toEqual([
      '| src/a.ts | 85.0 % | 90.0 % (above the baseline) |',
      '| src/b.ts | 75.0 % | 70.0 % ⚠️ lower |',
      '| total | 80.0 % | 80.0 % |',
    ]);
    expect(text).toContain('1 score(s) below the baseline: src/b.ts.');
  });

  it('says so when nothing fell, and shows files missing on either side', () => {
    const text = renderComparison({ 'src/new.ts': 50 }, { 'src/gone.ts': 60 });
    expect(text).toContain('| src/gone.ts | 60.0 % | – |');
    expect(text).toContain('| src/new.ts | – | 50.0 % |');
    expect(text).toContain('No file scores below the baseline.');
  });

  it('ignores a change within the tolerance, which timing alone can cause', () => {
    const text = renderComparison({ 'src/a.ts': 84.6, total: 80.4 }, { 'src/a.ts': 85, total: 80 });
    expect(text).toContain('| src/a.ts | 85.0 % | 84.6 % |');
    expect(text).toContain('No file scores below the baseline.');
  });

  it('writes the baseline with the paths in order and total last', () => {
    expect(formatBaseline({ total: 90, 'src/b.ts': 80, 'src/a.ts': 100 })).toBe(
      '{\n  "src/a.ts": 100,\n  "src/b.ts": 80,\n  "total": 90\n}\n',
    );
  });
});

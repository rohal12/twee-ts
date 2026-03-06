import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { lint, formatLintReport } from '../src/lint.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');

describe('lint', () => {
  it('reports stats for a clean story', async () => {
    const result = await lint({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
    });

    expect(result.passages).toBeGreaterThan(0);
    expect(result.storyPassages).toBeGreaterThan(0);
    expect(result.stats.words).toBeGreaterThan(0);
    expect(result.stats.files.length).toBe(1);
    expect(result.start).toBe('Start');
  });

  it('detects broken links', async () => {
    const result = await lint({
      sources: [
        {
          filename: 'broken.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n[[Go->MissingRoom]]\n\n:: Room\nSafe passage',
        },
      ],
    });

    expect(result.brokenLinks).toHaveLength(1);
    expect(result.brokenLinks[0]).toEqual({ from: 'Start', to: 'MissingRoom' });
  });

  it('detects dead ends and orphans', async () => {
    const result = await lint({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
    });

    expect(result.deadEnds).toContain('Secret Room');
    expect(result.deadEnds).toContain('Ending');
    expect(result.orphans).toContain('Secret Room');
    expect(result.orphans).toContain('Ending');
  });

  it('reads format info from StoryData', async () => {
    const result = await lint({
      sources: [
        {
          filename: 'format.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.37.3"}\n\n:: Start\nHello',
        },
      ],
    });

    expect(result.formatName).toBe('SugarCube');
    expect(result.formatVersion).toBe('2.37.3');
  });
});

describe('formatLintReport', () => {
  it('shows pass for clean story', async () => {
    const result = await lint({
      sources: [
        {
          filename: 'clean.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.37.3"}\n\n:: Start\n[[Room]]\n\n:: Room\n[[Start]]',
        },
      ],
    });

    const report = formatLintReport(result);
    expect(report).toContain('Format: SugarCube 2.37.3');
    expect(report).toContain('Lint passed.');
    expect(report).not.toContain('Broken links');
  });

  it('shows fail for broken links', async () => {
    const result = await lint({
      sources: [
        {
          filename: 'broken.tw',
          content: ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n[[Missing]]',
        },
      ],
    });

    const report = formatLintReport(result);
    expect(report).toContain('Broken links');
    expect(report).toContain('Start -> Missing');
    expect(report).toContain('Lint failed.');
  });

  it('shows dead ends and orphans', async () => {
    const result = await lint({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
    });

    const report = formatLintReport(result);
    expect(report).toContain('Dead ends');
    expect(report).toContain('Orphans');
  });
});

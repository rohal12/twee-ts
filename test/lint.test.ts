import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lint, formatLintReport } from '../src/lint.js';
import type { LintResult } from '../src/lint.js';

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

  it('reads reverse-arrow and setter links', async () => {
    const story = (start: string) => [
      {
        filename: 'links.tw',
        content: `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n${start}\n\n:: Room\nText.`,
      },
    ];
    const reverse = await lint({ sources: story('[[Room<-go]]') });
    expect(reverse.brokenLinks).toEqual([]);
    expect(reverse.orphans).not.toContain('Room');

    const setter = await lint({ sources: story('[[Room]] [[go->Missing][$flag = true]]') });
    expect(setter.brokenLinks).toEqual([{ from: 'Start', to: 'Missing' }]);
  });

  it('ignores links in comments', async () => {
    const result = await lint({
      sources: [
        {
          filename: 'comments.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n<!-- [[Ghost]] --> /% [[Ghost]] %/ /* [[Ghost]] */ [[Room]]\n\n:: Room\nText.',
        },
      ],
    });
    expect(result.brokenLinks).toEqual([]);
    expect(formatLintReport(result)).toContain('Lint passed.');
  });

  it('reads a link after unclosed link openers on short lines of their own', async () => {
    const text = '[[unfinished\n'.repeat(20) + 'ordinary prose '.repeat(1000) + '\n[[Missing]]';
    const source = `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n${text}`;
    const result = await lint({ sources: [{ filename: 'story.tw', content: source }] });
    expect(result.brokenLinks).toEqual([{ from: 'Start', to: 'Missing' }]);
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

describe('lint reads no links from stylesheets', () => {
  const STORY_DATA = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n';
  // Normal passage links and links in a script's strings, which must still be read.
  const STORY = `${STORY_DATA}:: Start\n[[Room]]\n\n:: Room\nText.\n\n:: Story JavaScript [script]\n$('#x').wiki('[[Missing]]');\n`;
  const CSS =
    'body::before { content: "[[Decorative]]"; }\n.x::after { content: "[[Room]]"; }\n.y::after { content: "[[Hall]]"; }';
  const HALL = ':: Hall\nText.';

  function expectNoStylesheetLinks(result: LintResult, stylesheet: string): void {
    expect(result.brokenLinks).toEqual([{ from: 'Story JavaScript', to: 'Missing' }]);
    // The stylesheet's [[Hall]] does not keep Hall from being an orphan.
    expect(result.orphans).toEqual(['Hall']);
    expect(formatLintReport(result)).not.toContain(stylesheet);
  }

  it('reads none from a passage tagged stylesheet', async () => {
    const result = await lint({
      sources: [{ filename: 'story.tw', content: `${STORY}\n:: Theme [stylesheet]\n${CSS}\n\n${HALL}` }],
    });
    expectNoStylesheetLinks(result, 'Theme');
  });

  it('reads none from a CSS source', async () => {
    const result = await lint({
      sources: [
        { filename: 'story.tw', content: `${STORY}\n${HALL}` },
        { filename: 'theme.css', content: CSS },
      ],
    });
    expectNoStylesheetLinks(result, 'theme.css');
  });

  it('reads none from a CSS file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-ts-lint-'));
    try {
      writeFileSync(join(dir, 'story.tw'), `${STORY}\n${HALL}`);
      writeFileSync(join(dir, 'theme.css'), CSS);
      const result = await lint({ sources: [dir] });
      expectNoStylesheetLinks(result, 'theme.css');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the CLI check for a story whose only bracketed text is in its stylesheet', async () => {
    const result = await lint({
      sources: [
        {
          filename: 'story.tw',
          content: `${STORY_DATA}:: Start\nHello\n\n:: Theme [stylesheet]\nbody::before { content: "[[Decorative]]"; }`,
        },
      ],
    });
    expect(result.brokenLinks).toEqual([]);
    expect(formatLintReport(result)).toContain('Lint passed.');
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

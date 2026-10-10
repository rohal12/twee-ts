import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { lint, formatLintReport } from '../src/lint.js';
import type { LintResult } from '../src/lint.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');

describe('lint', () => {
  const IFID = '{"ifid":"12345678-1234-4234-8234-123456789ABC"}';
  const titleErrors = (result: LintResult) =>
    result.diagnostics.filter((d) => d.level === 'error').map((d) => d.message);

  it.each([
    ['missing', `:: StoryData\n${IFID}\n\n:: Start\nHello.`, 'Special passage "StoryTitle" not found.'],
    [
      'empty',
      `:: StoryTitle\n\n:: StoryData\n${IFID}\n\n:: Start\nHello.`,
      'Special passage "StoryTitle" is empty, so the story has no name.',
    ],
  ])('reports a %s story title as an error', async (_name, content, message) => {
    const result = await lint({ sources: [{ filename: 'story.tw', content }] });

    expect(titleErrors(result)).toEqual([message]);
    expect(formatLintReport(result)).not.toContain('Lint passed.');
  });

  it('passes a story with a title', async () => {
    const content = `:: StoryTitle\nTitled\n\n:: StoryData\n${IFID}\n\n:: Start\nHello.`;
    const result = await lint({ sources: [{ filename: 'story.tw', content }] });

    expect(titleErrors(result)).toEqual([]);
  });

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
            ':: StoryTitle\nTitled\n\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n<!-- [[Ghost]] --> /% [[Ghost]] %/ /* [[Ghost]] */ [[Room]]\n\n:: Room\nText.',
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
  const STORY_DATA = ':: StoryTitle\nTitled\n\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n';
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

describe('lint checks link destinations against what Twine 2 output emits', () => {
  const STORY_DATA = ':: StoryTitle\nTitled\n\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n';
  const DESTINATIONS = [
    'Secret',
    'Logic',
    'Theme',
    'StoryData',
    'StoryTitle',
    'StorySettings',
    'StoryInit',
    'Widgets',
    'PassageHeader',
    'Notes',
    'Room',
    'Missing',
  ];
  const STORY =
    STORY_DATA +
    `:: Start\n${DESTINATIONS.map((name) => `[[${name}]]`).join(' ')}\n\n` +
    ':: Secret [Twine.private]\nHidden\n\n' +
    ':: Logic [script]\nwindow.x = 1;\n\n' +
    ':: Theme [stylesheet]\nbody { color: red; }\n\n' +
    ':: StorySettings\n\n' +
    ':: StoryInit\n<<set $x to 1>>\n\n' +
    ':: Widgets [widget]\n<<widget "w">>Hi<</widget>>\n\n' +
    ':: PassageHeader\nHeader\n\n' +
    ':: Notes [annotation]\nA note.\n\n' +
    ':: Room\n[[Start]]\n';

  it('reports links to passages that Twine 2 output leaves out, saying why', async () => {
    const result = await lint({ sources: [{ filename: 'story.tw', content: STORY }] });
    expect(result.brokenLinks).toEqual([
      { from: 'Start', to: 'Secret', omission: { kind: 'tag', tag: 'Twine.private' } },
      { from: 'Start', to: 'Logic', omission: { kind: 'tag', tag: 'script' } },
      { from: 'Start', to: 'Theme', omission: { kind: 'tag', tag: 'stylesheet' } },
      { from: 'Start', to: 'StoryData', omission: { kind: 'special-name', name: 'StoryData' } },
      { from: 'Start', to: 'StoryTitle', omission: { kind: 'special-name', name: 'StoryTitle' } },
      { from: 'Start', to: 'StorySettings', omission: { kind: 'empty-story-settings' } },
      { from: 'Start', to: 'Missing' },
    ]);
    // A missing passage carries no omission.
    expect(result.brokenLinks.at(-1)).not.toHaveProperty('omission');
  });

  it('accepts exactly the destinations that the Twine 2 archive holds as passages', async () => {
    const sources = [{ filename: 'story.tw', content: STORY }];
    const archive = (await compile({ sources, outputMode: 'twine2-archive' })).output;
    const emitted = new Set([...archive.matchAll(/<tw-passagedata [^>]*name="([^"]*)"/g)].map((m) => m[1]));
    const result = await lint({ sources });
    const reported = result.brokenLinks.map((link) => link.to);
    expect(reported).toEqual(DESTINATIONS.filter((name) => !emitted.has(name)));
    // Links to special passages that the output keeps stay valid.
    for (const kept of ['StoryInit', 'Widgets', 'PassageHeader', 'Notes', 'Room']) {
      expect(emitted.has(kept), kept).toBe(true);
    }
  });

  it('fails the report and explains why each destination cannot be used', async () => {
    const result = await lint({
      sources: [
        {
          filename: 'story.tw',
          content: `${STORY_DATA}:: Start\n[[Secret]] [[Logic]]\n\n:: Secret [Twine.private]\nHidden\n\n:: Logic [script]\nwindow.x = 1;`,
        },
      ],
    });
    const report = formatLintReport(result);
    expect(report).toContain('Broken links (2):');
    expect(report).toContain(
      'Start -> Secret (passage "Secret" is tagged "Twine.private", so it is left out of the story data)',
    );
    expect(report).toContain(
      'Start -> Logic (passage "Logic" is tagged "script", so it is left out of the story data)',
    );
    expect(report).toContain('Lint failed.');
  });

  it('reads no links from a Twine.private passage, so it reports no broken link from one', async () => {
    const content =
      `${STORY_DATA}:: Start\n[[Next]]\n\n:: Next\nThe end.\n\n` +
      ':: Notes [Twine.private]\nTODO: write [[Epilogue]] later.\n';
    const result = await lint({ sources: [{ filename: 'story.tw', content }] });
    expect(result.brokenLinks).toEqual([]);
    expect(result.deadEnds).toEqual(['Next']);
    expect(result.orphans).toEqual([]);
    expect(formatLintReport(result)).toContain('Lint passed.');
  });

  it('still lists a story passage as an orphan when only a Twine.private passage links to it', async () => {
    const content =
      `${STORY_DATA}:: Start\n[[Next]]\n\n:: Next\nThe end.\n\n:: Epilogue\nLater.\n\n` +
      ':: Notes [Twine.private]\nTODO: link [[Epilogue]] from Next.\n';
    const result = await lint({ sources: [{ filename: 'story.tw', content }] });
    expect(result.brokenLinks).toEqual([]);
    expect(result.orphans).toEqual(['Epilogue']);
  });

  it('reads no links from StoryTitle, which Twine 2 output leaves out', async () => {
    const content = `${STORY_DATA.replace(':: StoryTitle\nTitled\n\n', '')}:: StoryTitle\nThe [[Missing]] Story\n\n:: Start\nHello.\n`;
    const result = await lint({ sources: [{ filename: 'story.tw', content }] });
    expect(result.brokenLinks).toEqual([]);
  });

  it('keeps reading links from script passages, which Twine 2 output runs', async () => {
    const content =
      `${STORY_DATA}:: Start\nHello.\n\n:: Room\nA room.\n\n` +
      ':: Logic [script]\nwindow.links = "[[Room]] [[Missing]]";\n\n' +
      ':: Old Logic [script Twine.private]\nwindow.old = "[[Gone]]";\n';
    const result = await lint({ sources: [{ filename: 'story.tw', content }] });
    // The private script is left out entirely, so its links are not read.
    expect(result.brokenLinks).toEqual([{ from: 'Logic', to: 'Missing' }]);
    expect(result.orphans).toEqual([]);
  });

  it('keeps reporting a missing destination as missing', async () => {
    const result = await lint({ sources: [{ filename: 'story.tw', content: `${STORY_DATA}:: Start\n[[Missing]]` }] });
    expect(formatLintReport(result)).toContain('Start -> Missing (passage "Missing" does not exist)');
  });
});

describe('formatLintReport', () => {
  it('shows pass for clean story', async () => {
    const result = await lint({
      sources: [
        {
          filename: 'clean.tw',
          content:
            ':: StoryTitle\nTitled\n\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.37.3"}\n\n:: Start\n[[Room]]\n\n:: Room\n[[Start]]',
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

describe('lint: SugarCube info passages', () => {
  const STORY =
    ':: StoryTitle\nTest\n\n:: StoryData\n{"ifid":"12345678-1234-4234-8234-123456789ABC"}\n\n:: Start\nWelcome\n\n' +
    ':: StoryDisplayTitle\n[[About]]\n\n:: Boot [init]\n<<set $booted = true>>\n\n:: About\n[[Start]]';

  it('counts StoryDisplayTitle and init-tagged passages as info, and follows the title’s links', async () => {
    const result = await lint({ sources: [{ filename: 'story.tw', content: STORY }] });
    expect(result.orphans).toEqual([]);
    expect(result.deadEnds).toEqual(['Start']);
    expect(result.storyPassages).toBe(2);
    expect(result.infoPassages).toBe(4);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('output boundary: passage layout metadata', () => {
  const header = (meta: string): string =>
    `:: StoryData\n{"ifid":"12345678-1234-4234-8234-123456789ABC"}\n\n:: Start ${meta}\nHello`;
  const BAD = ['\\u0000', '\\ud800'];

  it.each(BAD.flatMap((bad) => (['position', 'size'] as const).map((field) => [bad, field] as const)))(
    'rejects %s in the %s of a Twine 2 passage',
    async (bad, field) => {
      const meta = field === 'position' ? `{"position":"1,${bad}2"}` : `{"size":"1,${bad}2"}`;
      const result = await compile({
        sources: [{ filename: 's.tw', content: header(meta) }],
        outputMode: 'twine2-archive',
      });
      expect(result.diagnostics.filter((d) => d.level === 'error').map((d) => d.message)).toEqual([
        expect.stringContaining(`The ${field} of passage "Start" contains`),
      ]);
    },
  );

  it('rejects the position of a Twine 1 passage but not its size, which Twine 1 does not write', async () => {
    const run = (meta: string) =>
      compile({ sources: [{ filename: 's.tw', content: header(meta) }], outputMode: 'twine1-archive' });
    expect((await run('{"position":"1,\\u00002"}')).diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('The position of passage "Start" contains U+0000'),
    ]);
    expect((await run('{"size":"1,\\u00002"}')).diagnostics).toEqual([]);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compile } from '../src/compiler.js';
import { lint, formatLintReport } from '../src/lint.js';
import type { CompileOptions, InlineSource } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');
const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

function storyData(extra = ''): string {
  return `:: StoryData\n{"ifid":"${IFID}"${extra}}\n\n`;
}

function source(content: string): InlineSource {
  return { filename: 'story.tw', content };
}

const htmlOptions = {
  formatId: 'test-format-1',
  formatPaths: [FORMAT_DIR],
  useTweegoPath: false,
  noRemote: true,
} satisfies Partial<CompileOptions>;

function startnode(output: string): string | undefined {
  return /startnode="([^"]*)"/.exec(output)?.[1];
}

function errors(diagnostics: readonly { level: string; message: string }[]): string[] {
  return diagnostics.filter((d) => d.level === 'error').map((d) => d.message);
}

describe('effective starting passage in JSON output and the returned story', () => {
  const twoRooms = ':: Start\nHello\n\n:: Begin\nWelcome';

  it('writes an explicit startPassage into JSON when StoryData has no start', async () => {
    const result = await compile({
      sources: [source(storyData() + twoRooms)],
      outputMode: 'json',
      startPassage: 'Begin',
    });
    expect(JSON.parse(result.output).start).toBe('Begin');
    expect(result.story.twine2.start).toBe('Begin');
  });

  it('lets an explicit startPassage override the StoryData start in JSON', async () => {
    const result = await compile({
      sources: [source(storyData(',"start":"Start"') + twoRooms)],
      outputMode: 'json',
      startPassage: 'Begin',
    });
    expect(JSON.parse(result.output).start).toBe('Begin');
    expect(result.story.twine2.start).toBe('Begin');
  });

  it('still omits start from JSON when neither StoryData nor an option sets it', async () => {
    const result = await compile({ sources: [source(storyData() + twoRooms)], outputMode: 'json' });
    expect(JSON.parse(result.output)).not.toHaveProperty('start');
    expect(result.story.twine2.start).toBe('');
  });

  it('keeps the HTML startnode and the returned story in agreement', async () => {
    const result = await compile({
      ...htmlOptions,
      sources: [source(storyData(',"start":"Start"') + twoRooms)],
      startPassage: 'Begin',
    });
    expect(startnode(result.output)).toBe('2');
    expect(result.story.twine2.start).toBe('Begin');
    expect(result.diagnostics).toEqual([]);
  });

  it('makes lint report the override and stop listing it as an orphan', async () => {
    const result = await lint({ sources: [source(storyData() + twoRooms)], startPassage: 'Begin' });
    expect(result.start).toBe('Begin');
    expect(result.orphans).not.toContain('Begin');
    expect(result.orphans).toContain('Start');
  });
});

describe('lint validates the starting passage', () => {
  it('reports a StoryData start that does not exist', async () => {
    const result = await lint({ sources: [source(storyData(',"start":"Missing"') + ':: Room\nroom')] });
    expect(result.start).toBe('Missing');
    expect(errors(result.diagnostics)).toEqual(['Starting passage "Missing" not found.']);
    const report = formatLintReport(result);
    expect(report).toContain('error: Starting passage "Missing" not found.');
    expect(report).toContain('Lint failed.');
    expect(report).not.toContain('Lint passed.');
  });

  it('reports a startPassage override that does not exist', async () => {
    const result = await lint({ sources: [source(storyData() + ':: Start\n[[Start]]')], startPassage: 'Missing' });
    expect(errors(result.diagnostics)).toEqual(['Starting passage "Missing" not found.']);
    expect(formatLintReport(result)).toContain('Lint failed.');
  });

  it('reports a missing default Start passage', async () => {
    const result = await lint({ sources: [source(storyData() + ':: Room\nroom')] });
    expect(result.start).toBe('Start');
    expect(errors(result.diagnostics)).toEqual(['Starting passage "Start" not found.']);
    expect(formatLintReport(result)).toContain('Lint failed.');
  });

  it('reports a starting passage that Twine 2 output leaves out', async () => {
    const result = await lint({ sources: [source(storyData() + ':: Start [script]\nconsole.log(1)')] });
    expect(errors(result.diagnostics)).toEqual([
      expect.stringContaining('Starting passage "Start" is tagged "script"'),
    ]);
  });

  it('needs no story format to do so', async () => {
    const result = await lint({
      sources: [source(storyData(',"format":"NoSuchFormat","format-version":"9.9.9"') + ':: Room\nroom')],
      noRemote: true,
      formatPaths: [],
      useTweegoPath: false,
    });
    expect(errors(result.diagnostics)).toEqual(['Starting passage "Start" not found.']);
  });

  it('passes a story whose starting passage exists', async () => {
    const result = await lint({ sources: [source(storyData() + ':: Start\n[[Start]]')] });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(formatLintReport(result)).toContain('Lint passed.');
  });
});

describe('Twine 2 HTML rejects a starting passage it does not emit', () => {
  const cases: readonly { readonly label: string; readonly content: string; readonly start?: string }[] = [
    { label: 'tagged script', content: ':: Start [script]\nconsole.log(1)' },
    { label: 'tagged stylesheet', content: ':: Start [stylesheet]\nbody {}' },
    { label: 'tagged Twine.private', content: ':: Start [Twine.private]\nsecret' },
    { label: 'named StoryData', content: ':: Room\nroom', start: 'StoryData' },
    { label: 'named StoryTitle', content: ':: StoryTitle\nTitle\n\n:: Room\nroom', start: 'StoryTitle' },
    { label: 'an empty StorySettings', content: ':: StorySettings\n\n:: Room\nroom', start: 'StorySettings' },
  ];

  for (const { label, content, start } of cases) {
    it(`reports a start passage ${label}`, async () => {
      const result = await compile({
        ...htmlOptions,
        sources: [source(storyData() + content)],
        ...(start === undefined ? {} : { startPassage: start }),
      });
      expect(startnode(result.output)).toBe('');
      expect(errors(result.diagnostics)).toEqual([
        expect.stringMatching(new RegExp(`^Starting passage "${start ?? 'Start'}" (is|has)`)),
      ]);
    });
  }

  it('says which tag removes the passage', async () => {
    const result = await compile({
      ...htmlOptions,
      sources: [source(storyData() + ':: Start [Twine.private]\nsecret')],
    });
    expect(errors(result.diagnostics)).toEqual([
      'Starting passage "Start" is tagged "Twine.private", so it is left out of the story data. Choose a story passage.',
    ]);
  });

  it('accepts a normal start passage', async () => {
    const result = await compile({
      ...htmlOptions,
      sources: [source(storyData() + ':: Story Init [script]\nconsole.log(1)\n\n:: Start\nHello')],
    });
    expect(startnode(result.output)).toBe('1');
    expect(result.diagnostics).toEqual([]);
  });

  it('still reports a start passage that does not exist', async () => {
    const result = await compile({ ...htmlOptions, sources: [source(storyData() + ':: Room\nroom')] });
    expect(errors(result.diagnostics)).toEqual(['Starting passage "Start" not found.']);
  });
});

describe('Twine 1 HTML rejects a starting passage it does not emit', () => {
  let formatDir: string;
  const twine1Options = (): Partial<CompileOptions> => ({
    formatId: 'twine1-test',
    formatPaths: [formatDir],
    useTweegoPath: false,
    noRemote: true,
  });

  beforeAll(() => {
    formatDir = mkdtempSync(join(tmpdir(), 'twee-ts-start-twine1-'));
    mkdirSync(join(formatDir, 'twine1-test'));
    writeFileSync(
      join(formatDir, 'twine1-test', 'header.html'),
      '<html><body>"START_AT"<div id="storeArea">"STORY"</div></body></html>',
    );
  });

  afterAll(() => rmSync(formatDir, { recursive: true, force: true }));

  it('reports a Twine.private start passage', async () => {
    const result = await compile({
      ...twine1Options(),
      sources: [source(storyData() + ':: StoryTitle\nTitle\n\n:: Start [Twine.private]\nsecret')],
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.stringContaining('Starting passage "Start" is tagged "Twine.private"'),
    ]);
  });

  it('accepts a script-tagged start passage, which Twine 1 output keeps', async () => {
    const result = await compile({
      ...twine1Options(),
      sources: [source(storyData() + ':: StoryTitle\nTitle\n\n:: Start [script]\nconsole.log(1)')],
    });
    expect(errors(result.diagnostics)).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';

describe('compile with a Twine 1 format', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-twine1-title-'));
    mkdirSync(join(dir, 'custom-1'));
    writeFileSync(
      join(dir, 'custom-1', 'header.html'),
      '<html><body><script>var start="START_AT";</script><div id="storeArea">"STORY"</div></body></html>',
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const options = () => ({
    formatId: 'custom-1',
    formatPaths: [dir],
    useTweegoPath: false,
    noRemote: true,
  });

  it('reports a story without a StoryTitle passage as an error', async () => {
    const result = await compile({ ...options(), sources: [{ filename: 'story.tw', content: ':: Start\nHi\n' }] });

    expect(result.diagnostics).toContainEqual({
      level: 'error',
      message: 'Special passage "StoryTitle" not found.',
    });
  });

  it('accepts a story that has one', async () => {
    const result = await compile({
      ...options(),
      sources: [{ filename: 'story.tw', content: ':: StoryTitle\nT\n\n:: Start\nHi\n' }],
    });

    expect(result.diagnostics.map((d) => d.message)).not.toContain('Special passage "StoryTitle" not found.');
  });

  it.each(['Twine.private', 'hidden'])('rejects an omitted title tagged %s (#351)', async (tag) => {
    const result = await compile({
      ...options(),
      tagAliases: { hidden: 'Twine.private' },
      sources: [{ filename: 'story.tw', content: `:: StoryTitle [${tag}]\nTitle\n:: Start\nHi` }],
    });
    expect(result.story.name).toBe('Title');
    expect(result.diagnostics).toContainEqual({
      level: 'error',
      message: 'Special passage "StoryTitle" is tagged "Twine.private", so it is left out of the story data.',
    });
  });

  it.each(['annotation', 'script', 'stylesheet'])('keeps a title tagged %s in Twine 1 data', async (tag) => {
    const result = await compile({
      ...options(),
      sources: [{ filename: 'story.tw', content: `:: StoryTitle [${tag}]\nTitle\n:: Start\nHi` }],
    });
    expect(result.diagnostics).toEqual([]);
    expect(decompileHTML(result.output).story.name).toBe('Title');
  });

  it.each(['twine1-archive', 'twine2-archive', 'twee3', 'json'] as const)(
    'keeps the title policy for %s output',
    async (outputMode) => {
      const result = await compile({
        outputMode,
        sources: [{ filename: 'story.tw', content: ':: StoryTitle [Twine.private]\nTitle\n:: Start\nHi' }],
      });
      expect(result.diagnostics.filter((d) => d.message.includes('StoryTitle'))).toEqual([]);
    },
  );

  it('uses the cached title in Twine 2 even when its passage is private', async () => {
    const result = await compile({
      ...options(),
      formatId: 'test-format-1',
      formatPaths: [join(__dirname, 'fixtures', 'storyformats')],
      sources: [
        {
          filename: 'story.tw',
          content:
            ':: StoryTitle [Twine.private]\nTitle\n:: StoryData\n{"ifid":"12345678-1234-4234-8234-123456789ABC"}\n:: Start\nHi',
        },
      ],
    });
    expect(result.diagnostics).toEqual([]);
    expect(decompileHTML(result.output).story.name).toBe('Title');
  });
});

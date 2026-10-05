import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { compile } from '../src/compiler.js';

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
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
});

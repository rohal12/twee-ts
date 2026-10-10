/**
 * Which outputs need an IFID (#370). As in Tweego, only the Twine 2 story data (HTML with a Twine 2 format, and the
 * Twine 2 archive) requires one; Twee, JSON (where `ifid` is optional) and the Twine 1 outputs are written without
 * one when the story has none.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import type { CompileOptions, OutputMode } from '../src/types.js';

const FORMAT_DIR = join(__dirname, 'fixtures', 'storyformats');
const LEGACY = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-ifid-modes-'));
  mkdirSync(join(dir, 'twine1-1'));
  writeFileSync(join(dir, 'twine1-1', 'header.html'), '<html><body><div id="storeArea">"STORY"</div></body></html>');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Case {
  readonly label: string;
  readonly outputMode: OutputMode;
  readonly requires: boolean;
  readonly format?: 'twine2' | 'twine1';
}

const CASES: readonly Case[] = [
  { label: 'Twine 2 HTML', outputMode: 'html', format: 'twine2', requires: true },
  { label: 'Twine 2 archive', outputMode: 'twine2-archive', requires: true },
  { label: 'Twine 1 HTML', outputMode: 'html', format: 'twine1', requires: false },
  { label: 'Twine 1 archive', outputMode: 'twine1-archive', requires: false },
  { label: 'Twee 3', outputMode: 'twee3', requires: false },
  { label: 'Twee 1', outputMode: 'twee1', requires: false },
  { label: 'JSON', outputMode: 'json', requires: false },
];

function options(c: Case, source: string): CompileOptions {
  const formats: Partial<CompileOptions> =
    c.format === 'twine1'
      ? { formatId: 'twine1-1', formatPaths: [dir] }
      : { formatId: 'test-format-1', formatPaths: [FORMAT_DIR] };
  return {
    sources: [{ filename: 'story.tw', content: source }],
    outputMode: c.outputMode,
    useTweegoPath: false,
    noRemote: true,
    ...formats,
  };
}

describe('a story with no IFID', () => {
  it.each(CASES)('$label: requires one: $requires', async (c) => {
    const result = await compile(options(c, ':: StoryTitle\nT\n\n:: Start\nHello\n'));
    const missing = result.diagnostics.filter((d) => d.message.startsWith('Story IFID not found'));
    expect(missing.map((d) => d.level)).toEqual(c.requires ? ['error'] : []);
    expect(result.diagnostics.filter((d) => d.level === 'error')).toHaveLength(c.requires ? 1 : 0);
    // Only an output that requires an IFID gets a generated one.
    expect(result.story.ifid === '').toBe(!c.requires);
    expect(result.output.includes('UUID://') || result.output.includes('"ifid"')).toBe(c.requires);
  });

  it.each(CASES)('$label: reuses the StorySettings IFID only where one is required', async (c) => {
    const result = await compile(options(c, `:: StoryTitle\nT\n\n:: StorySettings\nifid:${LEGACY}\n\n:: Start\nHi\n`));
    const reused = result.diagnostics.filter((d) => d.message.includes('reusing "ifid" entry'));
    expect(reused.map((d) => d.level)).toEqual(c.requires ? ['warning'] : []);
    expect(result.story.ifid).toBe(c.requires ? LEGACY : '');
  });
});

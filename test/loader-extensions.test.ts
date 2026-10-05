import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Diagnostic, FileCacheEntry } from '../src/types.js';
import { createStory } from '../src/story.js';
import { loadSources, loadInlineSources, loadSourcesCached } from '../src/loader.js';

/** Every extension the loader dispatches on, with the tag its passage gets. */
const BINARY_EXTENSIONS: readonly (readonly [string, string])[] = [
  ...['otf', 'ttf', 'woff', 'woff2'].map((e) => [e, 'stylesheet'] as const),
  ...['gif', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'].map((e) => [e, 'Twine.image'] as const),
  ...['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'wave', 'weba'].map((e) => [e, 'Twine.audio'] as const),
  ...['mp4', 'ogv', 'webm'].map((e) => [e, 'Twine.video'] as const),
  ['vtt', 'Twine.vtt'],
];

const HTML =
  '<tw-storydata name="N" startnode="1" creator="Twine" creator-version="2.6" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" format="SugarCube" format-version="2.37.3" options="" hidden>' +
  '<tw-passagedata pid="1" name="Start" tags="" position="0,0" size="100,100">Hi</tw-passagedata></tw-storydata>';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-loader-ext-'));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe.each([
  ['loadSources', 'full'],
  ['loadSourcesCached', 'cached'],
] as const)('%s dispatches by file extension', (_name, mode) => {
  function load(file: string, opts: { trim?: boolean } = { trim: true }) {
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    const processed = new Set<string>();
    if (mode === 'full') loadSources(story, [file], opts, diagnostics, processed);
    else loadSourcesCached(story, [file], opts, diagnostics, processed, new Map<string, FileCacheEntry>());
    return { story, diagnostics, processed };
  }

  it.each(BINARY_EXTENSIONS)('loads .%s as one passage tagged %s', (ext, tag) => {
    const file = join(tmpDir, `asset.${ext}`);
    writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    const { story, diagnostics } = load(file);
    expect(diagnostics).toEqual([]);
    expect(story.passages).toHaveLength(1);
    expect(story.passages[0]?.tags).toEqual([tag]);
    expect(story.passages[0]?.text).toContain('AQIDBA==');
  });

  it.each(['tw2', 'twee2'])('loads .%s with Twee2 syntax', (ext) => {
    const file = join(tmpDir, `story.${ext}`);
    writeFileSync(file, ':: Start\nHello\n');
    const { story } = load(file);
    expect(story.passages.map((p) => p.name)).toContain('Start');
  });

  it('loads .html files without options.trim set', () => {
    const file = join(tmpDir, 'story.html');
    writeFileSync(file, HTML);
    const { story } = load(file, {});
    expect(story.passages.map((p) => p.name)).toContain('Start');
  });

  it('skips a file of an unknown type', () => {
    const file = join(tmpDir, 'notes.xyz');
    writeFileSync(file, 'ignored');
    const { story, processed } = load(file);
    expect(story.passages).toEqual([]);
    expect(processed.has(file)).toBe(false);
  });
});

describe('loadSourcesCached', () => {
  it('warns about a file named twice and loads it once', () => {
    const file = join(tmpDir, 'a.tw');
    writeFileSync(file, ':: A\nOne\n');
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    loadSourcesCached(story, [file, file], { trim: true }, diagnostics, new Set(), new Map());
    expect(story.passages.filter((p) => p.name === 'A')).toHaveLength(1);
    expect(diagnostics).toContainEqual({ level: 'warning', message: `load ${file}: Skipping duplicate.` });
  });

  it('prepends a StoryTitle passage when the story has a name', () => {
    const file = join(tmpDir, 'a.tw');
    writeFileSync(file, ':: A\nOne\n');
    const story = createStory();
    story.name = 'My Story';
    loadSourcesCached(story, [file], { trim: true }, [], new Set(), new Map());
    expect(story.passages.find((p) => p.name === 'StoryTitle')?.text).toBe('My Story');
  });
});

describe('loadInlineSources', () => {
  it('reads a .tw2 inline source with Twee2 syntax', () => {
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    loadInlineSources(story, [{ filename: 'inline.tw2', content: ':: Start\nHello\n' }], { trim: true }, diagnostics);
    expect(story.passages.map((p) => p.name)).toContain('Start');
  });

  it('reads a .tw inline source with Twee2 syntax when twee2Compat is set', () => {
    const story = createStory();
    loadInlineSources(story, [{ filename: 'inline.tw', content: ':: Start\nHello\n' }], { twee2Compat: true }, []);
    expect(story.passages.map((p) => p.name)).toContain('Start');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Diagnostic, FileCacheEntry } from '../src/types.js';
import { createStory } from '../src/story.js';
import { loadSourcesCached } from '../src/loader.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'twee-ts-incremental-'));
}

function writeFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function setMtime(path: string, mtimeMs: number): void {
  const secs = mtimeMs / 1000;
  utimesSync(path, secs, secs);
}

const TWEE_CONTENT = `:: StoryData
{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}

:: StoryTitle
Test Story

:: Start
Hello, world!
`;

const opts = { trim: true, twee2Compat: false };

describe('incremental compilation cache', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  it('cache hit — second build reuses cache entry with same mtime', () => {
    const file = writeFile(dir, 'story.tw', TWEE_CONTENT);
    setMtime(file, 1000000);

    const cache = new Map<string, FileCacheEntry>();

    // First build
    const story1 = createStory();
    loadSourcesCached(story1, [file], opts, [], new Set(), cache);
    expect(story1.passages.length).toBeGreaterThan(0);
    expect(cache.size).toBe(1);
    const entry1 = cache.get(file);

    // Second build — cache should return the exact same entry object (same mtime)
    const story2 = createStory();
    loadSourcesCached(story2, [file], opts, [], new Set(), cache);
    expect(story2.passages.length).toBe(story1.passages.length);
    const entry2 = cache.get(file);
    expect(entry2).toBe(entry1); // Same reference = no re-parse
  });

  it('single file change — only changed file gets new cache entry', () => {
    const file1 = writeFile(dir, 'story.tw', TWEE_CONTENT);
    const file2 = writeFile(dir, 'extra.css', 'body { color: red; }');
    setMtime(file1, 1000000);
    setMtime(file2, 1000000);

    const cache = new Map<string, FileCacheEntry>();

    // First build
    const story1 = createStory();
    loadSourcesCached(story1, [file1, file2], opts, [], new Set(), cache);
    expect(cache.size).toBe(2);
    const entry1File1 = cache.get(file1);
    const entry1File2 = cache.get(file2);

    // Change only the CSS file mtime
    setMtime(file2, 2000000);

    const story2 = createStory();
    loadSourcesCached(story2, [file1, file2], opts, [], new Set(), cache);

    // file1 cache entry should be the same object (not re-parsed)
    expect(cache.get(file1)).toBe(entry1File1);
    // file2 cache entry should be a new object (re-parsed due to mtime change)
    expect(cache.get(file2)).not.toBe(entry1File2);
    expect(cache.get(file2)!.mtimeMs).toBe(2000000);
  });

  it('file deletion — passages from deleted file are gone', () => {
    const file1 = writeFile(dir, 'story.tw', TWEE_CONTENT);
    const file2 = writeFile(dir, 'extra.css', 'body { color: red; }');

    const cache = new Map<string, FileCacheEntry>();

    // First build with both files
    const story1 = createStory();
    loadSourcesCached(story1, [file1, file2], opts, [], new Set(), cache);
    expect(story1.passages.some((p) => p.name === 'extra.css')).toBe(true);
    expect(cache.size).toBe(2);

    // Second build without the CSS file (simulating deletion from getFilenames)
    const story2 = createStory();
    loadSourcesCached(story2, [file1], opts, [], new Set(), cache);
    expect(story2.passages.some((p) => p.name === 'extra.css')).toBe(false);
    expect(cache.size).toBe(1);
    expect(cache.has(file2)).toBe(false);
  });

  it('file addition — new file appears in output and cache', () => {
    const file1 = writeFile(dir, 'story.tw', TWEE_CONTENT);
    const cache = new Map<string, FileCacheEntry>();

    // First build
    const story1 = createStory();
    loadSourcesCached(story1, [file1], opts, [], new Set(), cache);
    expect(cache.size).toBe(1);

    // Add a new file
    const file2 = writeFile(dir, 'extra.js', 'console.log("hi");');

    const story2 = createStory();
    loadSourcesCached(story2, [file1, file2], opts, [], new Set(), cache);
    expect(story2.passages.some((p) => p.name === 'extra.js')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('StoryData change — metadata updates correctly', () => {
    const content1 = `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube"}\n\n:: StoryTitle\nTest\n\n:: Start\nHello`;
    const file = writeFile(dir, 'story.tw', content1);
    setMtime(file, 1000000);

    const cache = new Map<string, FileCacheEntry>();

    const story1 = createStory();
    loadSourcesCached(story1, [file], opts, [], new Set(), cache);
    expect(story1.twine2.format).toBe('SugarCube');

    // Update StoryData
    const content2 = `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Harlowe"}\n\n:: StoryTitle\nTest\n\n:: Start\nHello`;
    writeFileSync(file, content2, 'utf-8');
    setMtime(file, 2000000);

    const story2 = createStory();
    loadSourcesCached(story2, [file], opts, [], new Set(), cache);
    expect(story2.twine2.format).toBe('Harlowe');
  });

  it('passage dedup — last-seen-wins preserved', () => {
    const file1 = writeFile(dir, 'a.tw', ':: Start\nFirst version');
    const file2 = writeFile(dir, 'b.tw', ':: Start\nSecond version');

    const cache = new Map<string, FileCacheEntry>();
    const story = createStory();
    const diag: Diagnostic[] = [];
    loadSourcesCached(story, [file1, file2], opts, diag, new Set(), cache);

    const start = story.passages.find((p) => p.name === 'Start');
    expect(start?.text).toBe('Second version');
    expect(diag.some((d) => d.message.includes('Replacing existing passage'))).toBe(true);
  });

  it('diagnostics replay — cached diagnostics appear in output', () => {
    const file = writeFile(dir, 'broken.tw', ':: Test [unclosed\nContent');
    setMtime(file, 1000000);

    const cache = new Map<string, FileCacheEntry>();

    // First build
    const diag1: Diagnostic[] = [];
    const story1 = createStory();
    loadSourcesCached(story1, [file], opts, diag1, new Set(), cache);
    const diagCount = diag1.length;
    expect(diagCount).toBeGreaterThan(0);

    // Second build (from cache) — diagnostics should be replayed
    const diag2: Diagnostic[] = [];
    const story2 = createStory();
    loadSourcesCached(story2, [file], opts, diag2, new Set(), cache);
    expect(diag2.length).toBeGreaterThanOrEqual(diagCount);
  });

  it('CSS and JS files are cached correctly', () => {
    const cssFile = writeFile(dir, 'styles.css', 'body { margin: 0; }');
    const jsFile = writeFile(dir, 'script.js', 'window.init = true;');

    const cache = new Map<string, FileCacheEntry>();
    const story = createStory();
    loadSourcesCached(story, [cssFile, jsFile], opts, [], new Set(), cache);

    expect(cache.size).toBe(2);
    const cssEntry = cache.get(cssFile);
    expect(cssEntry?.passages.length).toBe(1);
    expect(cssEntry?.passages[0]?.tags).toContain('stylesheet');

    const jsEntry = cache.get(jsFile);
    expect(jsEntry?.passages.length).toBe(1);
    expect(jsEntry?.passages[0]?.tags).toContain('script');
  });

  it('changedFiles optimization — unchanged files skip stat and use cache directly', () => {
    const file1 = writeFile(dir, 'story.tw', TWEE_CONTENT);
    const file2 = writeFile(dir, 'extra.css', 'body { color: red; }');
    setMtime(file1, 1000000);
    setMtime(file2, 1000000);

    const cache = new Map<string, FileCacheEntry>();

    // First build
    const story1 = createStory();
    loadSourcesCached(story1, [file1, file2], opts, [], new Set(), cache);
    const entry1File1 = cache.get(file1);

    // Rebuild with changedFiles indicating only file2 changed
    // Bump file2 mtime so it actually gets re-parsed
    setMtime(file2, 2000000);
    const changedFiles = new Set([file2]);

    const story2 = createStory();
    loadSourcesCached(story2, [file1, file2], opts, [], new Set(), cache, changedFiles);

    // file1 should still be the same cache entry (unchanged, stat skipped)
    expect(cache.get(file1)).toBe(entry1File1);
    // file2 should have been re-parsed (new mtime)
    expect(cache.get(file2)!.mtimeMs).toBe(2000000);
    // Both files' passages should be in the output
    expect(story2.passages.some((p) => p.name === 'extra.css')).toBe(true);
    expect(story2.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('integration — cached build produces identical output to fresh build', () => {
    const tweeFile = writeFile(dir, 'story.tw', TWEE_CONTENT);
    const cssFile = writeFile(dir, 'styles.css', 'body { color: blue; }');
    const jsFile = writeFile(dir, 'app.js', 'window.init = true;');
    const filenames = [tweeFile, cssFile, jsFile];

    // Fresh build (populates cache)
    const story1 = createStory();
    const diag1: Diagnostic[] = [];
    const cache = new Map<string, FileCacheEntry>();
    loadSourcesCached(story1, filenames, opts, diag1, new Set(), cache);

    // Cached build
    const story2 = createStory();
    const diag2: Diagnostic[] = [];
    loadSourcesCached(story2, filenames, opts, diag2, new Set(), cache);

    // Passages should be identical
    expect(story2.passages.length).toBe(story1.passages.length);
    for (let i = 0; i < story1.passages.length; i++) {
      expect(story2.passages[i]?.name).toBe(story1.passages[i]?.name);
      expect(story2.passages[i]?.text).toBe(story1.passages[i]?.text);
      expect(story2.passages[i]?.tags).toEqual(story1.passages[i]?.tags);
    }
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { CompileResult, Diagnostic, FileCacheEntry, Story } from '../src/types.js';
import { createStory } from '../src/story.js';
import { loadSourcesCached } from '../src/loader.js';
import { compile, compileIncremental } from '../src/compiler.js';

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

describe('incremental cache and parse options', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  const SPACED = ':: Start\n  content with spaces  \n';
  const TWEE2 = ':: Start [tag] <10,20>\nHello\n';

  function load(
    file: string,
    loadOpts: { trim?: boolean; twee2Compat?: boolean },
    cache: Map<string, FileCacheEntry>,
    changedFiles?: ReadonlySet<string>,
  ): { start: string | undefined; position: string | undefined; diagnostics: Diagnostic[] } {
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    loadSourcesCached(story, [file], loadOpts, diagnostics, new Set(), cache, changedFiles);
    const start = story.passages.find((p) => p.name === 'Start');
    return { start: start?.text, position: start?.metadata?.position, diagnostics };
  }

  it('reparses an unchanged file when trim changes', () => {
    const file = writeFile(dir, 'story.tw', SPACED);
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>();

    expect(load(file, { trim: true }, cache).start).toBe('content with spaces');
    expect(load(file, { trim: false }, cache).start).toBe('  content with spaces  ');
    expect(load(file, { trim: true }, cache).start).toBe('content with spaces');
  });

  it('reparses an unchanged file when twee2Compat changes', () => {
    const file = writeFile(dir, 'story.tw', TWEE2);
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>();

    expect(load(file, { twee2Compat: true }, cache).position).toBe('10,20');
    const twee3 = load(file, { twee2Compat: false }, cache);
    expect(twee3.start).toBeUndefined();
    expect(twee3.diagnostics.some((d) => d.level === 'error')).toBe(true);
    expect(load(file, { twee2Compat: true }, cache).position).toBe('10,20');
  });

  it('reparses on an options change even when changedFiles says the file is unchanged', () => {
    const file = writeFile(dir, 'story.tw', SPACED);
    const cache = new Map<string, FileCacheEntry>();

    expect(load(file, { trim: true }, cache).start).toBe('content with spaces');
    expect(load(file, { trim: false }, cache, new Set()).start).toBe('  content with spaces  ');
  });

  it('still reuses the entry when the options are unchanged', () => {
    const file = writeFile(dir, 'story.tw', SPACED);
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>();

    load(file, { trim: false }, cache);
    const entry = cache.get(file);
    load(file, { trim: false, twee2Compat: false }, cache);
    expect(cache.get(file)).toBe(entry);
    load(file, { trim: false }, cache, new Set());
    expect(cache.get(file)).toBe(entry);
  });

  it('treats defaulted options the same as explicit defaults', () => {
    const file = writeFile(dir, 'story.tw', SPACED);
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>();

    load(file, {}, cache);
    const entry = cache.get(file);
    load(file, { trim: true, twee2Compat: false }, cache);
    expect(cache.get(file)).toBe(entry);
  });

  it('keeps .tw2 entries when only twee2Compat changes, since .tw2 files always use it', () => {
    const file = writeFile(dir, 'story.tw2', TWEE2);
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>();

    load(file, { twee2Compat: false }, cache);
    const entry = cache.get(file);
    expect(load(file, { twee2Compat: true }, cache).position).toBe('10,20');
    expect(cache.get(file)).toBe(entry);
  });

  it('reparses an unchanged Twine 2 HTML file when trim changes', () => {
    const file = writeFile(
      dir,
      'story.html',
      `<tw-storydata name="Spaced" startnode="1" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" hidden>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">  content with spaces  </tw-passagedata>
</tw-storydata>`,
    );
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>();

    expect(load(file, { trim: true }, cache).start).toBe('content with spaces');
    expect(load(file, { trim: false }, cache).start).toBe('  content with spaces  ');
    expect(load(file, { trim: true }, cache, new Set()).start).toBe('content with spaces');
  });

  it('keeps Twine 1 HTML entries when only twee2Compat changes', () => {
    const file = writeFile(
      dir,
      'story.html',
      '<div id="storeArea" hidden><div tiddler="Start" tags="">  content with spaces  </div></div>',
    );
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>();

    expect(load(file, { trim: false }, cache).start).toBe('  content with spaces  ');
    const entry = cache.get(file);
    load(file, { trim: false, twee2Compat: true }, cache);
    expect(cache.get(file)).toBe(entry);
  });

  it('keeps entries for files the parse options do not affect', () => {
    const file = writeFile(dir, 'styles.css', '  body { color: red; }  ');
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>();

    load(file, { trim: true }, cache);
    const entry = cache.get(file);
    load(file, { trim: false, twee2Compat: true }, cache);
    expect(cache.get(file)).toBe(entry);
  });

  it('treats an entry without a parse-options key as stale', () => {
    const file = writeFile(dir, 'story.tw', SPACED);
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>([
      [file, { mtimeMs: 1000000, passages: [{ name: 'Start', tags: [], text: 'stale' }], diagnostics: [] }],
    ]);

    expect(load(file, { trim: true }, cache).start).toBe('content with spaces');

    cache.set(file, { mtimeMs: 1000000, passages: [{ name: 'Start', tags: [], text: 'stale' }], diagnostics: [] });
    expect(load(file, { trim: true }, cache, new Set()).start).toBe('content with spaces');
  });
});

describe('incremental cache and Twine 2 HTML', () => {
  it('keeps the story name of a cached Twine 2 HTML file', () => {
    const dir = makeTmpDir();
    const file = writeFile(
      dir,
      'story.html',
      `<tw-storydata name="Review Story" startnode="1" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" hidden>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">Hello</tw-passagedata>
</tw-storydata>`,
    );
    setMtime(file, 1000000);
    const cache = new Map<string, FileCacheEntry>();

    const story1 = createStory();
    loadSourcesCached(story1, [file], opts, [], new Set(), cache);
    expect(story1.name).toBe('Review Story');

    const story2 = createStory();
    loadSourcesCached(story2, [file], opts, [], new Set(), cache);
    expect(story2.name).toBe('Review Story');
    expect(story2.passages.map((p) => p.name)).toEqual(['StoryTitle', 'StoryData', 'Start']);

    const story3 = createStory();
    loadSourcesCached(story3, [file], opts, [], new Set(), cache, new Set());
    expect(story3.name).toBe('Review Story');
  });
});

describe('incremental cache and explicitly changed files', () => {
  const STAMP_MS = 1_700_000_000_000;

  const twine2HTML = (text: string): string =>
    `<tw-storydata name="Story" startnode="1" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" hidden>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">${text}</tw-passagedata>
</tw-storydata>`;

  const decodeDataUrl = (text: string | undefined): string | undefined => {
    const base64 = text?.match(/base64,([A-Za-z0-9+/=]+)/)?.[1];
    return base64 === undefined ? undefined : Buffer.from(base64, 'base64').toString('utf-8');
  };

  const passageText = (story: Story, name: string): string | undefined =>
    story.passages.find((p) => p.name === name)?.text;

  // One file of each cached input kind: its content before and after a save, and where the content shows up.
  const kinds = [
    {
      kind: 'Twee',
      name: 'story.tw',
      content: (marker: string) => `:: Start\n${marker}`,
      text: (story: Story) => passageText(story, 'Start'),
    },
    {
      kind: 'Twine 2 HTML',
      name: 'story.html',
      content: twine2HTML,
      text: (story: Story) => passageText(story, 'Start'),
    },
    {
      kind: 'CSS',
      name: 'style.css',
      content: (marker: string) => `/* ${marker} */`,
      text: (story: Story) => passageText(story, 'style.css'),
    },
    {
      kind: 'JavaScript',
      name: 'app.js',
      content: (marker: string) => `// ${marker}`,
      text: (story: Story) => passageText(story, 'app.js'),
    },
    {
      kind: 'media',
      name: 'scene.svg',
      content: (marker: string) => `<svg>${marker}</svg>`,
      text: (story: Story) => decodeDataUrl(passageText(story, 'scene')),
    },
    {
      kind: 'font',
      name: 'Face.woff2',
      content: (marker: string) => marker,
      text: (story: Story) => decodeDataUrl(passageText(story, 'Face.woff2')),
    },
  ] as const;

  it.each(kinds)('reparses a changed $kind file whose modification time did not change', ({ name, content, text }) => {
    const dir = makeTmpDir();
    const file = writeFile(dir, name, content('ORIGINAL_CONTENT'));
    setMtime(file, STAMP_MS);
    const cache = new Map<string, FileCacheEntry>();

    const story1 = createStory();
    loadSourcesCached(story1, [file], opts, [], new Set(), cache);
    expect(text(story1)).toContain('ORIGINAL_CONTENT');

    // A timestamp-preserving save: new content, the old modification time.
    writeFile(dir, name, content('UPDATED_CONTENT'));
    setMtime(file, STAMP_MS);

    const story2 = createStory();
    loadSourcesCached(story2, [file], opts, [], new Set(), cache, new Set([file]));
    expect(text(story2)).toContain('UPDATED_CONTENT');
    expect(text(story2)).not.toContain('ORIGINAL_CONTENT');
  });

  it('still reuses the entry of a file that changedFiles does not name', () => {
    const dir = makeTmpDir();
    const file = writeFile(dir, 'story.tw', ':: Start\nORIGINAL_CONTENT');
    const other = writeFile(dir, 'other.tw', ':: Other\nOther.');
    const cache = new Map<string, FileCacheEntry>();
    loadSourcesCached(createStory(), [file, other], opts, [], new Set(), cache);
    const entry = cache.get(file);

    loadSourcesCached(createStory(), [file, other], opts, [], new Set(), cache, new Set([other]));
    expect(cache.get(file)).toBe(entry);
  });

  it('compileIncremental() reparses a file in changedFiles whose modification time did not change', async () => {
    const dir = makeTmpDir();
    const source = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nORIGINAL_CONTENT';
    const file = writeFile(dir, 'story.tw', source);
    setMtime(file, STAMP_MS);
    const cache = new Map<string, FileCacheEntry>();
    const options = { sources: [file], outputMode: 'json' as const };
    await compileIncremental(options, cache);

    writeFile(dir, 'story.tw', source.replace('ORIGINAL_CONTENT', 'UPDATED_CONTENT'));
    setMtime(file, STAMP_MS);
    // changedFiles names a file by the path source discovery gives it: relative to the working directory.
    const incremental = await compileIncremental(options, cache, new Set([relative(process.cwd(), file)]));
    const fresh = await compile(options);

    const start = (result: CompileResult): string | undefined => passageText(result.story, 'Start');
    expect(start(fresh)).toBe('UPDATED_CONTENT');
    expect(start(incremental)).toBe('UPDATED_CONTENT');
  });

  describe('compileIncremental() matches changedFiles to the cached files however a path is written', () => {
    const source = (text: string): string =>
      `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n${text}`;
    const forms: readonly { readonly form: string; readonly path: (file: string) => string }[] = [
      { form: 'an absolute path', path: (file) => resolve(file) },
      { form: 'a ./-prefixed relative path', path: (file) => `.${sep}${relative(process.cwd(), file)}` },
      { form: 'the path relative to the working directory', path: (file) => relative(process.cwd(), file) },
    ];

    it.each(forms)('reparses a file named by $form', async ({ path }) => {
      const dir = makeTmpDir();
      const file = writeFile(dir, 'story.tw', source('ORIGINAL_CONTENT'));
      setMtime(file, STAMP_MS);
      const cache = new Map<string, FileCacheEntry>();
      const options = { sources: [dir], outputMode: 'json' as const };
      await compileIncremental(options, cache);

      writeFile(dir, 'story.tw', source('UPDATED_CONTENT'));
      setMtime(file, STAMP_MS);
      const result = await compileIncremental(options, cache, new Set([path(file)]));
      expect(passageText(result.story, 'Start')).toBe('UPDATED_CONTENT');
    });
  });
});

describe('incremental cache and a file that fails to load', () => {
  const passageText = (story: Story, name: string): string | undefined =>
    story.passages.find((p) => p.name === name)?.text;
  const errors = (diagnostics: readonly Diagnostic[]): string[] =>
    diagnostics.filter((d) => d.level === 'error').map((d) => d.message);

  it('drops the entry of a changed file it cannot read, so later builds neither replay nor hide it', () => {
    const dir = makeTmpDir();
    const a = writeFile(dir, 'a.tw', ':: A\nOLD_A');
    const b = writeFile(dir, 'b.tw', ':: B\nb1');
    const cache = new Map<string, FileCacheEntry>();
    loadSourcesCached(createStory(), [a, b], opts, [], new Set(), cache);

    // a.tw becomes unreadable: reading a folder fails as an unreadable or locked file does.
    rmSync(a);
    mkdirSync(a);
    const story2 = createStory();
    const diag2: Diagnostic[] = [];
    loadSourcesCached(story2, [a, b], opts, diag2, new Set(), cache, new Set([a]));
    expect(passageText(story2, 'A')).toBeUndefined();
    expect(errors(diag2)).toEqual([expect.stringMatching(/^load .*a\.tw: EISDIR/)]);
    expect(cache.has(a)).toBe(false);

    // A build for another file's change tries a.tw again rather than replaying its old passages.
    writeFile(dir, 'b.tw', ':: B\nb2');
    const story3 = createStory();
    const diag3: Diagnostic[] = [];
    loadSourcesCached(story3, [a, b], opts, diag3, new Set(), cache, new Set([b]));
    expect(passageText(story3, 'A')).toBeUndefined();
    expect(passageText(story3, 'B')).toBe('b2');
    expect(errors(diag3)).toEqual([expect.stringMatching(/^load .*a\.tw: EISDIR/)]);
  });

  it('drops the entry of a changed file that is gone, so its old passages are not replayed when it is back', () => {
    const dir = makeTmpDir();
    const a = writeFile(dir, 'a.tw', ':: A\nOLD_A');
    const b = writeFile(dir, 'b.tw', ':: B\nb1');
    const cache = new Map<string, FileCacheEntry>();
    loadSourcesCached(createStory(), [a, b], opts, [], new Set(), cache);

    // Deleted after source discovery listed it.
    rmSync(a);
    loadSourcesCached(createStory(), [a, b], opts, [], new Set(), cache, new Set([a]));
    expect(cache.has(a)).toBe(false);

    writeFile(dir, 'a.tw', ':: A\nNEW_A');
    const story = createStory();
    loadSourcesCached(story, [a, b], opts, [], new Set(), cache, new Set([b]));
    expect(passageText(story, 'A')).toBe('NEW_A');
  });
});

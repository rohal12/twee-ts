/**
 * Regressions of #247 and #245 (JS-8) that have no better home: each failed before the fix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { compile, compileIncremental, compileToFile } from '../src/compiler.js';
import { loadConfigFile, validateConfig } from '../src/config.js';
import { loadSources } from '../src/loader.js';
import { createStory } from '../src/story.js';
import type { Diagnostic, FileCacheEntry } from '../src/types.js';
import { getFilenames } from '../src/filesystem.js';

const STORY_DATA = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-regress-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A glob for `pattern` inside the temporary folder, which lies outside the working directory. */
const inDir = (pattern: string): string => `${relative(process.cwd(), dir).replace(/\\/g, '/')}/${pattern}`;

it('keeps a __proto__ metadata key in JSON output (JS-8)', async () => {
  const result = await compile({
    sources: [{ filename: 'a.tw', content: `${STORY_DATA}:: Start {"__proto__":"kept","position":"10,10"}\nHello\n` }],
    outputMode: 'json',
  });
  expect(result.output).toContain('"metadata": {\n        "__proto__": "kept",\n        "position": "10,10"\n      }');
});

describe('exclude globs and the file extension (FS-14)', () => {
  it('leaves out Photo.PNG for a *.png glob, as the loader reads it as a PNG', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.tw'), `${STORY_DATA}:: Start\nx\n`);
    writeFileSync(join(dir, 'src', 'Photo.PNG'), 'png');
    const result = await compile({ sources: [join(dir, 'src')], outputMode: 'json', exclude: [inDir('src/**/*.png')] });
    expect(result.stats.files.map((f) => f.split(/[\\/]/).pop())).toEqual(['a.tw']);
    expect(result.output).not.toContain('Photo');
  });
});

describe('source order is the same on every OS (U1)', () => {
  it('walks folder entries in code-point order', () => {
    for (const name of ['b.tw', 'B.tw', 'a.tw', '_.tw', 'é.tw', 'z.tw', '😀.tw']) {
      writeFileSync(join(dir, name), '');
    }
    const names = getFilenames([dir]).filenames.map((f) => f.split(/[\\/]/).pop() ?? '');
    const byCodePoint = [...names].sort((x, y) => (x < y ? -1 : 1));
    // UTF-8 byte order is code-point order; for these names it is also UTF-16 order.
    expect(names).toEqual(byCodePoint);
    expect(names.indexOf('B.tw')).toBeLessThan(names.indexOf('_.tw'));
  });
});

describe('the same file under two spellings', () => {
  it.skipIf(process.platform === 'win32')('is loaded once, the second named in the warning', () => {
    writeFileSync(join(dir, 'a.tw'), ':: A\nx\n');
    symlinkSync(join(dir, 'a.tw'), join(dir, 'b.tw'));
    const diagnostics: Diagnostic[] = [];
    const files = new Set<string>();
    loadSources(createStory(), [join(dir, 'a.tw'), join(dir, 'b.tw')], {}, diagnostics, files);
    expect([...files]).toEqual([join(dir, 'a.tw')]);
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message: `load ${join(dir, 'b.tw')}: Skipping duplicate (the same file as ${join(dir, 'a.tw')}).`,
      },
    ]);
  });
});

const POSIX_USER = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('what a walk can meet', () => {
  it.skipIf(!POSIX_USER)(
    'reports an entry it can list but not look at as an error (a folder without x permission)',
    () => {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.tw'), ':: A\nx\n');
      chmodSync(join(dir, 'src'), 0o444);
      try {
        const { filenames, diagnostics } = getFilenames([join(dir, 'src')]);
        expect(filenames).toEqual([]);
        expect(diagnostics).toEqual([
          expect.objectContaining({ level: 'error', message: expect.stringMatching(/^load .*a\.tw: EACCES/) }),
        ]);
      } finally {
        chmodSync(join(dir, 'src'), 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32')('skips a FIFO found in a folder without a word', () => {
    writeFileSync(join(dir, 'a.tw'), ':: A\nx\n');
    if (spawnSync('mkfifo', [join(dir, 'p.tw')]).status !== 0) return;
    const { filenames, diagnostics } = getFilenames([dir]);
    expect(filenames.map((f) => f.split(/[\\/]/).pop())).toEqual(['a.tw']);
    expect(diagnostics).toEqual([]);
  });

  it.skipIf(!POSIX_USER)('refuses an unreadable author file in a source folder as the output (FS-07)', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.tw'), `${STORY_DATA}:: Start\nx\n`);
    const out = join(dir, 'src', 'locked.tw');
    writeFileSync(out, ':: Mine\n');
    chmodSync(out, 0o000);
    try {
      await expect(compileToFile({ sources: [join(dir, 'src')], outputMode: 'twee3', outFile: out })).rejects.toThrow(
        /not an earlier build/,
      );
    } finally {
      chmodSync(out, 0o644);
    }
  });
});

describe('loading under the input policy', () => {
  it('knows the files a build loaded before this group, under any spelling', () => {
    writeFileSync(join(dir, 'a.tw'), ':: A\nx\n');
    const diagnostics: Diagnostic[] = [];
    const files = new Set([join(dir, 'a.tw')]);
    loadSources(createStory(), [join(dir, '.', 'x', '..', 'a.tw')], {}, diagnostics, files);
    expect(diagnostics).toEqual([expect.objectContaining({ message: expect.stringMatching(/Skipping duplicate/) })]);
  });

  it('warns about a named file of an unsupported type in an incremental build too', async () => {
    writeFileSync(join(dir, 'a.tw'), `${STORY_DATA}:: Start\nx\n`);
    writeFileSync(join(dir, 'b.twe'), ':: B\nx\n');
    const result = await compileIncremental(
      { sources: [join(dir, 'a.tw'), join(dir, 'b.twe')], outputMode: 'json' },
      new Map(),
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: 'warning',
        message: expect.stringMatching(/b\.twe: Not a supported source file type/),
      }),
    ]);
  });
});

describe('the incremental cache and a file replaced in place', () => {
  it('reparses a file replaced by another of the same size and modification time (the watch.test flake)', async () => {
    const file = join(dir, 'a.tw');
    writeFileSync(file, `${STORY_DATA}:: Start\nV1\n`);
    const cache = new Map<string, FileCacheEntry>();
    const options = { sources: [dir], outputMode: 'json' as const };
    expect((await compileIncremental(options, cache)).output).toContain('V1');
    const { mtime } = statSync(file);
    // A folder renamed away and replaced: a new file at the same path, as fast as the clock allows.
    renameSync(file, join(dir, 'old.tw.bak'));
    writeFileSync(file, `${STORY_DATA}:: Start\nV2\n`);
    utimesSync(file, mtime, mtime);
    expect((await compileIncremental(options, cache)).output).toContain('V2');
  });
});

describe('config files read as strict JSON', () => {
  it('warns about a key given twice, using the last', () => {
    const file = join(dir, 'c.json');
    writeFileSync(file, '{"outputMode":"json","outputMode":"twee3"}');
    const diagnostics: Diagnostic[] = [];
    expect(loadConfigFile(file, diagnostics)).toEqual({ outputMode: 'twee3' });
    expect(diagnostics).toEqual([
      { level: 'warning', message: `${file}: $.outputMode is given more than once; the last one is used.`, file },
    ]);
  });

  it('names the line and column of a syntax error', () => {
    const file = join(dir, 'c.json');
    writeFileSync(file, '{\n  "trim": tru\n}');
    expect(() => loadConfigFile(file)).toThrow(/^Invalid JSON in .*c\.json: .* at line 2, column \d+/);
  });

  it('checks values JSON cannot hold as it checks null', () => {
    expect(validateConfig({ output: undefined, trim: () => true })).toEqual([
      '"output" must be a string.',
      '"trim" must be a boolean.',
    ]);
  });
});

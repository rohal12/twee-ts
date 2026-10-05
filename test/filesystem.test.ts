import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { basename, join, relative } from 'node:path';
import { chmodSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { getFilenames, isExcluded } from '../src/filesystem.js';

const TMP_DIR = join(__dirname, '__tmp_fs__');

describe('getFilenames', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('collects files from a directory', () => {
    writeFileSync(join(TMP_DIR, 'a.tw'), '');
    writeFileSync(join(TMP_DIR, 'b.css'), '');
    const result = getFilenames([TMP_DIR]).filenames;
    expect(result).toHaveLength(2);
    expect(result.some((f) => f.endsWith('a.tw'))).toBe(true);
    expect(result.some((f) => f.endsWith('b.css'))).toBe(true);
  });

  it('collects files recursively', () => {
    const sub = join(TMP_DIR, 'sub');
    mkdirSync(sub);
    writeFileSync(join(TMP_DIR, 'root.tw'), '');
    writeFileSync(join(sub, 'nested.tw'), '');
    const result = getFilenames([TMP_DIR]).filenames;
    expect(result).toHaveLength(2);
    expect(result.some((f) => f.includes('nested.tw'))).toBe(true);
  });

  it('accepts individual file paths', () => {
    const file = join(TMP_DIR, 'single.tw');
    writeFileSync(file, '');
    const result = getFilenames([file]).filenames;
    expect(result).toHaveLength(1);
  });

  it('excludes the output file', () => {
    const outFile = join(TMP_DIR, 'output.html');
    writeFileSync(join(TMP_DIR, 'story.tw'), '');
    writeFileSync(outFile, '');
    const result = getFilenames([TMP_DIR], outFile).filenames;
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('story.tw');
  });

  it('reports a non-existent path as a warning, like Tweego', () => {
    const missing = join(TMP_DIR, 'nonexistent');
    const { filenames, diagnostics } = getFilenames([missing]);
    expect(filenames).toEqual([]);
    expect(diagnostics).toEqual([
      { level: 'warning', message: expect.stringContaining(`path ${missing}: ENOENT: no such file or directory`) },
    ]);
  });

  it('keeps collecting the other paths after a missing one', () => {
    const file = join(TMP_DIR, 'story.tw');
    writeFileSync(file, '');
    const { filenames, diagnostics } = getFilenames([join(TMP_DIR, 'nonexistent'), file]);
    expect(filenames).toHaveLength(1);
    expect(filenames[0]).toContain('story.tw');
    expect(diagnostics).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable directory as a warning',
    () => {
      const locked = join(TMP_DIR, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        const { filenames, diagnostics } = getFilenames([locked]);
        expect(filenames).toEqual([]);
        expect(diagnostics).toEqual([{ level: 'warning', message: expect.stringContaining(`path ${locked}: EACCES`) }]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it('handles empty input', () => {
    expect(getFilenames([])).toEqual({ filenames: [], diagnostics: [] });
  });

  describe('with exclude globs', () => {
    /** TMP_DIR relative to the working directory, with forward slashes, as a pattern spells it. */
    const tmpPattern = relative(process.cwd(), TMP_DIR).replace(/\\/g, '/');
    const names = (filenames: string[]): string[] => filenames.map((f) => basename(f)).sort();

    beforeEach(() => {
      mkdirSync(join(TMP_DIR, 'art'));
      writeFileSync(join(TMP_DIR, 'story.tw'), '');
      writeFileSync(join(TMP_DIR, 'cover.png'), '');
      writeFileSync(join(TMP_DIR, 'art', 'scene.png'), '');
      writeFileSync(join(TMP_DIR, 'art', 'notes.tw'), '');
    });

    it('leaves out the files that match', () => {
      const { filenames, diagnostics } = getFilenames([TMP_DIR], undefined, ['**/*.png']);
      expect(names(filenames)).toEqual(['notes.tw', 'story.tw']);
      expect(diagnostics).toEqual([]);
    });

    it('matches against the path relative to the working directory', () => {
      const { filenames } = getFilenames([TMP_DIR], undefined, [`${tmpPattern}/art/**`]);
      expect(names(filenames)).toEqual(['cover.png', 'story.tw']);
    });

    it('leaves out a file listed directly when it matches', () => {
      expect(getFilenames([join(TMP_DIR, 'cover.png')], undefined, ['**/*.png']).filenames).toEqual([]);
    });

    it('keeps every file when no pattern matches', () => {
      expect(getFilenames([TMP_DIR], undefined, ['**/*.mp3']).filenames).toHaveLength(4);
    });
  });
});

describe('isExcluded', () => {
  it('matches a path relative to the working directory', () => {
    expect(isExcluded(join('src', 'art', 'scene.png'), ['src/art/**'])).toBe(true);
    expect(isExcluded(join('src', 'story', 'start.tw'), ['src/art/**'])).toBe(false);
  });

  it('matches an absolute path by its path relative to the working directory', () => {
    expect(isExcluded(join(process.cwd(), 'src', 'art', 'scene.png'), ['src/art/**'])).toBe(true);
    expect(isExcluded(join(process.cwd(), 'src', 'art', 'scene.png'), ['art/**'])).toBe(false);
  });

  it('keeps * within one folder and lets ** cross folders', () => {
    expect(isExcluded(join('src', 'art', 'scene.png'), ['src/*.png'])).toBe(false);
    expect(isExcluded(join('src', 'art', 'scene.png'), ['src/**/*.png'])).toBe(true);
    expect(isExcluded('cover.png', ['**/*.png'])).toBe(true);
  });

  it('matches when any one pattern matches', () => {
    expect(isExcluded(join('src', 'clip.mp4'), ['**/*.png', '**/*.mp4'])).toBe(true);
  });

  it('reads a leading ./ in a pattern as the working directory', () => {
    expect(isExcluded(join('src', 'art', 'scene.png'), ['./src/art/**'])).toBe(true);
  });

  it('excludes nothing without patterns', () => {
    expect(isExcluded('cover.png', [])).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { chmodSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { getFilenames } from '../src/filesystem.js';

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
});

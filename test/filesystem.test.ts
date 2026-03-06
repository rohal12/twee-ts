import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { getFilenames } from '../src/filesystem.js';

const TMP_DIR = join(__dirname, '__tmp_fs__');

describe('getFilenames', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('collects files from a directory', () => {
    writeFileSync(join(TMP_DIR, 'a.tw'), '');
    writeFileSync(join(TMP_DIR, 'b.css'), '');
    const result = getFilenames([TMP_DIR]);
    expect(result).toHaveLength(2);
    expect(result.some((f) => f.endsWith('a.tw'))).toBe(true);
    expect(result.some((f) => f.endsWith('b.css'))).toBe(true);
  });

  it('collects files recursively', () => {
    const sub = join(TMP_DIR, 'sub');
    mkdirSync(sub);
    writeFileSync(join(TMP_DIR, 'root.tw'), '');
    writeFileSync(join(sub, 'nested.tw'), '');
    const result = getFilenames([TMP_DIR]);
    expect(result).toHaveLength(2);
    expect(result.some((f) => f.includes('nested.tw'))).toBe(true);
  });

  it('accepts individual file paths', () => {
    const file = join(TMP_DIR, 'single.tw');
    writeFileSync(file, '');
    const result = getFilenames([file]);
    expect(result).toHaveLength(1);
  });

  it('excludes the output file', () => {
    const outFile = join(TMP_DIR, 'output.html');
    writeFileSync(join(TMP_DIR, 'story.tw'), '');
    writeFileSync(outFile, '');
    const result = getFilenames([TMP_DIR], outFile);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('story.tw');
  });

  it('silently ignores non-existent paths', () => {
    const result = getFilenames([join(TMP_DIR, 'nonexistent')]);
    expect(result).toHaveLength(0);
  });

  it('handles empty input', () => {
    expect(getFilenames([])).toEqual([]);
  });
});

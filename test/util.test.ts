import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { readUTF8, readBase64, baseNameWithoutExt } from '../src/util.js';

const TMP_DIR = join(__dirname, '__tmp_util__');

describe('readUTF8', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('reads a plain UTF-8 file', () => {
    const file = join(TMP_DIR, 'plain.txt');
    writeFileSync(file, 'hello world');
    expect(readUTF8(file)).toBe('hello world');
  });

  it('strips UTF-8 BOM', () => {
    const file = join(TMP_DIR, 'bom.txt');
    writeFileSync(file, '\uFEFFhello');
    expect(readUTF8(file)).toBe('hello');
  });

  it('normalizes CRLF to LF', () => {
    const file = join(TMP_DIR, 'crlf.txt');
    writeFileSync(file, 'line1\r\nline2\r\nline3');
    expect(readUTF8(file)).toBe('line1\nline2\nline3');
  });

  it('normalizes standalone CR to LF', () => {
    const file = join(TMP_DIR, 'cr.txt');
    writeFileSync(file, 'line1\rline2');
    expect(readUTF8(file)).toBe('line1\nline2');
  });
});

describe('readBase64', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('reads a file as base64', () => {
    const file = join(TMP_DIR, 'data.bin');
    writeFileSync(file, Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    expect(readBase64(file)).toBe('SGVsbG8=');
  });
});

describe('baseNameWithoutExt', () => {
  it('returns filename without extension', () => {
    expect(baseNameWithoutExt('path/to/file.txt')).toBe('file');
    expect(baseNameWithoutExt('style.css')).toBe('style');
  });

  it('returns name for dotfiles', () => {
    expect(baseNameWithoutExt('.gitignore')).toBe('.gitignore');
  });

  it('handles files with multiple dots', () => {
    expect(baseNameWithoutExt('archive.tar.gz')).toBe('archive.tar');
  });

  it('handles files without extension', () => {
    expect(baseNameWithoutExt('Makefile')).toBe('Makefile');
  });
});

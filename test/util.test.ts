import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import type { Diagnostic } from '../src/types.js';
import { readUTF8, readBase64, baseNameWithoutExt, decodeText } from '../src/util.js';

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

describe('readUTF8 with text that is not UTF-8', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  // "café €“x”" and CRLF in Windows-1252: é = E9, € = 80, “ = 93, ” = 94.
  const WINDOWS_1252 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x93, 0x78, 0x94, 0x0d, 0x0a]);

  it('reads a Windows-1252 file as Windows-1252 and warns, naming the file', () => {
    const file = join(TMP_DIR, 'legacy.tw');
    writeFileSync(file, WINDOWS_1252);
    const diagnostics: Diagnostic[] = [];
    expect(readUTF8(file, diagnostics)).toBe('café €“x”\n');
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message: `read ${file}: Invalid UTF-8; assuming charset is windows-1252.`,
        file,
      },
    ]);
  });

  it('decodes the same way without a diagnostics array', () => {
    const file = join(TMP_DIR, 'legacy.css');
    writeFileSync(file, WINDOWS_1252);
    expect(readUTF8(file)).toBe('café €“x”\n');
  });

  it('reports nothing for valid UTF-8 with non-ASCII characters', () => {
    const file = join(TMP_DIR, 'utf8.tw');
    writeFileSync(file, '\uFEFFcafé €“x” \u{1F600}');
    const diagnostics: Diagnostic[] = [];
    expect(readUTF8(file, diagnostics)).toBe('café €“x” \u{1F600}');
    expect(diagnostics).toEqual([]);
  });
});

describe('decodeText', () => {
  it('maps the Windows-1252 bytes 0x80 to 0x9F as the WHATWG Encoding Standard does', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
    const { text, diagnostics } = decodeText(bytes, 'x.tw');
    expect([...text].map((c) => c.codePointAt(0))).toEqual([
      0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d,
      0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d,
      0x17e, 0x178,
    ]);
    expect(diagnostics).toHaveLength(1);
  });

  it('maps the bytes 0xA0 to 0xFF to the same code points', () => {
    const bytes = Uint8Array.from({ length: 96 }, (_, i) => 0xa0 + i);
    expect([...decodeText(bytes, 'x.tw').text].map((c) => c.codePointAt(0))).toEqual([...bytes]);
  });

  it('keeps a leading BOM for normalizeSourceText to strip, as a plain utf-8 read did', () => {
    const { text, diagnostics } = decodeText(Buffer.from('\uFEFFhi'), 'x.tw');
    expect(text).toBe('\uFEFFhi');
    expect(diagnostics).toEqual([]);
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

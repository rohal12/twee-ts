import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  describeFormatRequest,
  discoverAllFormats,
  makeFormatId,
  readFormatSource,
  selectFormat,
} from '../src/formats.js';
import { decodeFormatJSON } from '../src/format-decode.js';
import type { Diagnostic, StoryFormatInfo } from '../src/types.js';

// Mode bits cannot make a file or folder unreadable to root, nor on Windows, where chmod only
// sets or clears the read-only attribute (which does not stop reading, listing or creating files
// in a folder). The tests that need an unreadable path cannot set one up there.
const cannotLockFiles = process.platform === 'win32' || process.getuid?.() === 0;
const temps: string[] = [];
const locked: string[] = [];

afterEach(() => {
  for (const file of locked.splice(0)) chmodSync(file, 0o644);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-formats-cov-'));
  temps.push(dir);
  return dir;
}

describe('format.js with unterminated comments', () => {
  it('finds no format object in a file that is only a line comment without a newline', () => {
    expect(decodeFormatJSON('// nothing to see').ok).toBe(false);
  });

  it('finds no format object in a file that is only an unterminated block comment', () => {
    expect(decodeFormatJSON('/* never closed').ok).toBe(false);
  });

  it('reads a format followed by a line comment at the end of the file', () => {
    const result = decodeFormatJSON('window.storyFormat({"version":"1.0.0","source":"s"}); // end');
    expect(result.ok).toBe(true);
  });
});

describe('format IDs and request descriptions', () => {
  it('uses major version 0 for a version that is not SemVer', () => {
    expect(makeFormatId('My Format', 'unknown')).toBe('my-format-0');
  });

  it('describes a name request without a version by name only', () => {
    expect(describeFormatRequest({ kind: 'name', name: 'Harlowe', version: '' })).toBe('"Harlowe"');
  });
});

describe('selecting among candidates', () => {
  it('skips candidates whose version is not SemVer', () => {
    const candidates = ['banana', '1.2.0'].map((version) => ({
      name: 'Mock',
      version,
      isTwine2: true,
      source: 'url' as const,
      rank: 1,
    }));
    const picked = selectFormat({ kind: 'name', name: 'Mock', version: '1.0.0' }, candidates);
    expect(picked?.choice.version).toBe('1.2.0');
  });
});

describe('format folders that cannot be used', () => {
  it.skipIf(cannotLockFiles)('warns about a format.js that cannot be read', () => {
    const root = tempDir();
    mkdirSync(join(root, 'mock-1'));
    const file = join(root, 'mock-1', 'format.js');
    writeFileSync(file, 'window.storyFormat({"version":"1.0.0","source":"s"});');
    chmodSync(file, 0o000);
    locked.push(file);

    const diagnostics: Diagnostic[] = [];
    expect(discoverAllFormats([root], diagnostics).size).toBe(0);
    expect(diagnostics.map((d) => d.message).join('\n')).toContain('Could not read');
  });
});

describe('reading format source', () => {
  it('throws when the format file no longer holds a usable format', () => {
    const root = tempDir();
    const file = join(root, 'format.js');
    writeFileSync(file, 'no format in here');
    const format: StoryFormatInfo = {
      id: 'mock-1',
      filename: file,
      isTwine2: true,
      name: 'Mock',
      version: '1.0.0',
      proofing: false,
    };
    expect(() => readFormatSource(format)).toThrow('Cannot parse format mock-1 JSON');
    expect(() => readFormatSource(format)).toThrow(
      expect.objectContaining({ name: 'TweeTsError', code: 'FORMAT_UNAVAILABLE' }),
    );
  });
});

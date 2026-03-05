import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getCacheDir, findEntry, verifySHA256, clearIndexCache, discoverCachedFormats } from '../src/remote-formats.js';
import type { SFAIndex, SFAIndexEntry } from '../src/types.js';

// Minimal format.js content for testing
const MOCK_FORMAT_SOURCE = `window.storyFormat({"name":"MockFormat","version":"2.1.0","proofing":false,"source":"<html><body>{{STORY_DATA}}</body></html>"});`;

function makeSFAIndex(entries: SFAIndexEntry[]): SFAIndex {
  return { twine1: [], twine2: entries };
}

describe('getCacheDir', () => {
  it('returns a path containing twee-ts/storyformats', () => {
    const dir = getCacheDir();
    expect(dir).toContain('twee-ts');
    expect(dir).toContain('storyformats');
  });

  it('respects XDG_CACHE_HOME', () => {
    const orig = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = '/tmp/xdg-test';
    try {
      const dir = getCacheDir();
      expect(dir).toBe('/tmp/xdg-test/twee-ts/storyformats');
    } finally {
      if (orig !== undefined) {
        process.env['XDG_CACHE_HOME'] = orig;
      } else {
        delete process.env['XDG_CACHE_HOME'];
      }
    }
  });
});

describe('findEntry', () => {
  const entries: SFAIndexEntry[] = [
    { name: 'SugarCube', version: '2.36.1', proofing: false, files: ['format.js'], checksums: {} },
    { name: 'SugarCube', version: '2.37.3', proofing: false, files: ['format.js'], checksums: {} },
    { name: 'SugarCube', version: '2.38.0', proofing: false, files: ['format.js'], checksums: {} },
    { name: 'SugarCube', version: '1.0.0', proofing: false, files: ['format.js'], checksums: {} },
    { name: 'Harlowe', version: '3.3.9', proofing: false, files: ['format.js'], checksums: {} },
  ];
  const index = makeSFAIndex(entries);

  it('finds exact version match', () => {
    const result = findEntry(index, 'SugarCube', '2.37.3');
    expect(result?.entry.version).toBe('2.37.3');
    expect(result?.formatType).toBe('twine2');
  });

  it('finds highest same-major version when exact not available', () => {
    const result = findEntry(index, 'SugarCube', '2.35.0');
    expect(result?.entry.version).toBe('2.38.0');
  });

  it('does not cross major versions', () => {
    const result = findEntry(index, 'SugarCube', '3.0.0');
    expect(result).toBeUndefined();
  });

  it('is case-insensitive on name', () => {
    const result = findEntry(index, 'sugarcube', '2.37.3');
    expect(result?.entry.version).toBe('2.37.3');
  });

  it('returns undefined for unknown format', () => {
    const result = findEntry(index, 'Unknown', '1.0.0');
    expect(result).toBeUndefined();
  });

  it('finds Harlowe', () => {
    const result = findEntry(index, 'Harlowe', '3.3.9');
    expect(result?.entry.version).toBe('3.3.9');
  });
});

describe('verifySHA256', () => {
  it('verifies correct checksum', async () => {
    const data = new TextEncoder().encode('hello world');
    // SHA-256 of "hello world"
    const expected = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
    const result = await verifySHA256(data, expected);
    expect(result).toBe(true);
  });

  it('rejects incorrect checksum', async () => {
    const data = new TextEncoder().encode('hello world');
    const result = await verifySHA256(data, '0000000000000000000000000000000000000000000000000000000000000000');
    expect(result).toBe(false);
  });

  it('is case-insensitive on expected hex', async () => {
    const data = new TextEncoder().encode('hello world');
    const expected = 'B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9';
    const result = await verifySHA256(data, expected);
    expect(result).toBe(true);
  });
});

describe('clearIndexCache', () => {
  it('does not throw', () => {
    expect(() => clearIndexCache()).not.toThrow();
  });
});

describe('discoverCachedFormats', () => {
  const TMP_CACHE = join(__dirname, '.tmp-cache-test');

  beforeEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
  });

  it('discovers formats in cache directory', () => {
    // Set XDG_CACHE_HOME to our tmp dir so getCacheDir uses it
    const orig = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = TMP_CACHE;
    try {
      const cacheDir = getCacheDir();
      const formatDir = join(cacheDir, 'MockFormat', '2.1.0');
      mkdirSync(formatDir, { recursive: true });
      writeFileSync(join(formatDir, 'format.js'), MOCK_FORMAT_SOURCE);

      const formats = discoverCachedFormats();
      expect(formats.size).toBeGreaterThanOrEqual(1);

      const values = [...formats.values()];
      const mock = values.find((f) => f.name === 'MockFormat');
      expect(mock).toBeDefined();
      expect(mock!.version).toBe('2.1.0');
    } finally {
      if (orig !== undefined) {
        process.env['XDG_CACHE_HOME'] = orig;
      } else {
        delete process.env['XDG_CACHE_HOME'];
      }
    }
  });

  it('returns empty map when cache dir does not exist', () => {
    const orig = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = join(TMP_CACHE, 'nonexistent');
    try {
      const formats = discoverCachedFormats();
      expect(formats.size).toBe(0);
    } finally {
      if (orig !== undefined) {
        process.env['XDG_CACHE_HOME'] = orig;
      } else {
        delete process.env['XDG_CACHE_HOME'];
      }
    }
  });
});

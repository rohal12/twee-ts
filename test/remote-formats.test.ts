import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getCacheDir,
  findEntry,
  verifySHA256,
  clearIndexCache,
  discoverCachedFormats,
  listCachedFormats,
  clearCachedFormats,
  getCacheSize,
  fetchAndCacheFormat,
  fetchDirectFormat,
  resolveRemoteFormat,
  resolveRemoteFormatRequest,
} from '../src/remote-formats.js';
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

/** Helper: set XDG_CACHE_HOME for a test, restore afterward. */
function withCacheHome(tmpDir: string, fn: () => void): void {
  const orig = process.env['XDG_CACHE_HOME'];
  process.env['XDG_CACHE_HOME'] = tmpDir;
  try {
    fn();
  } finally {
    if (orig !== undefined) {
      process.env['XDG_CACHE_HOME'] = orig;
    } else {
      delete process.env['XDG_CACHE_HOME'];
    }
  }
}

describe('listCachedFormats', () => {
  const TMP_CACHE = join(__dirname, '.tmp-cache-list');

  beforeEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
  });

  it('lists cached formats with size and date', () => {
    withCacheHome(TMP_CACHE, () => {
      const cacheDir = getCacheDir();
      const formatDir = join(cacheDir, 'MockFormat', '2.1.0');
      mkdirSync(formatDir, { recursive: true });
      writeFileSync(join(formatDir, 'format.js'), MOCK_FORMAT_SOURCE);

      const entries = listCachedFormats();
      expect(entries.length).toBe(1);
      expect(entries[0]!.name).toBe('MockFormat');
      expect(entries[0]!.version).toBe('2.1.0');
      expect(entries[0]!.sizeBytes).toBeGreaterThan(0);
      expect(entries[0]!.modifiedAt).toBeInstanceOf(Date);
    });
  });

  it('returns empty array when cache does not exist', () => {
    withCacheHome(join(TMP_CACHE, 'nonexistent'), () => {
      expect(listCachedFormats()).toEqual([]);
    });
  });

  it('lists multiple formats', () => {
    withCacheHome(TMP_CACHE, () => {
      const cacheDir = getCacheDir();
      for (const [name, version] of [
        ['FormatA', '1.0.0'],
        ['FormatB', '3.2.1'],
      ] as const) {
        const dir = join(cacheDir, name, version);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'format.js'),
          `window.storyFormat({"name":"${name}","version":"${version}","proofing":false,"source":"<html></html>"});`,
        );
      }

      const entries = listCachedFormats();
      expect(entries.length).toBe(2);
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['FormatA', 'FormatB']);
    });
  });
});

describe('clearCachedFormats', () => {
  const TMP_CACHE = join(__dirname, '.tmp-cache-clear');

  beforeEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
  });

  it('clears all cached formats', () => {
    withCacheHome(TMP_CACHE, () => {
      const cacheDir = getCacheDir();
      const dir = join(cacheDir, 'MockFormat', '2.1.0');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'format.js'), MOCK_FORMAT_SOURCE);

      const count = clearCachedFormats();
      expect(count).toBe(1);
      expect(listCachedFormats()).toEqual([]);
    });
  });

  it('clears formats by name', () => {
    withCacheHome(TMP_CACHE, () => {
      const cacheDir = getCacheDir();
      for (const [name, version] of [
        ['FormatA', '1.0.0'],
        ['FormatB', '3.2.1'],
      ] as const) {
        const dir = join(cacheDir, name, version);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'format.js'),
          `window.storyFormat({"name":"${name}","version":"${version}","proofing":false,"source":"<html></html>"});`,
        );
      }

      const count = clearCachedFormats('FormatA');
      expect(count).toBe(1);

      const remaining = listCachedFormats();
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.name).toBe('FormatB');
    });
  });

  it('returns 0 when cache does not exist', () => {
    withCacheHome(join(TMP_CACHE, 'nonexistent'), () => {
      expect(clearCachedFormats()).toBe(0);
    });
  });

  it('returns 0 when name does not match', () => {
    withCacheHome(TMP_CACHE, () => {
      const cacheDir = getCacheDir();
      const dir = join(cacheDir, 'MockFormat', '2.1.0');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'format.js'), MOCK_FORMAT_SOURCE);

      expect(clearCachedFormats('NonExistent')).toBe(0);
      expect(listCachedFormats().length).toBe(1);
    });
  });
});

describe('getCacheSize', () => {
  const TMP_CACHE = join(__dirname, '.tmp-cache-size');

  beforeEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
  });

  it('returns total size and count', () => {
    withCacheHome(TMP_CACHE, () => {
      const cacheDir = getCacheDir();
      const dir = join(cacheDir, 'MockFormat', '2.1.0');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'format.js'), MOCK_FORMAT_SOURCE);

      const { totalBytes, count } = getCacheSize();
      expect(count).toBe(1);
      expect(totalBytes).toBe(MOCK_FORMAT_SOURCE.length);
    });
  });

  it('returns zero for empty cache', () => {
    withCacheHome(join(TMP_CACHE, 'nonexistent'), () => {
      const { totalBytes, count } = getCacheSize();
      expect(totalBytes).toBe(0);
      expect(count).toBe(0);
    });
  });
});

// --- Network-free helpers for the remote resolution tests ---

const OFFICIAL_INDEX = 'https://videlais.github.io/story-formats-archive/official/index.json';
const OFFICIAL_BASE = 'https://videlais.github.io/story-formats-archive/official';
const UNOFFICIAL_INDEX = 'https://videlais.github.io/story-formats-archive/unofficial/index.json';
const HARLOWE_FIXTURE = join(__dirname, 'fixtures', 'storyformats-harlowe', 'harlowe-3', 'format.js');

function formatJs(name: string, version: string): string {
  return `window.storyFormat(${JSON.stringify({ name, version, proofing: false, source: '<html>{{STORY_DATA}}</html>' })});`;
}

function sfaEntry(name: string, version: string): SFAIndexEntry {
  return { name, version, proofing: false, files: ['format.js'], checksums: {} };
}

/** Stub `fetch` with a URL → body table; unknown URLs answer 404. Returns the list of requested URLs. */
function stubFetch(routes: Readonly<Record<string, string>>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const body = routes[url];
      return body === undefined
        ? new Response('missing', { status: 404, statusText: 'Not Found' })
        : new Response(body);
    }),
  );
  return calls;
}

/** Stub `fetch` so every request fails as if the machine were offline. */
function stubOffline(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    }),
  );
}

/** Give each test its own XDG cache root under the OS temp dir. */
function useTempCacheHome(): { readonly root: () => string } {
  let root = '';
  let orig: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'twee-ts-cache-'));
    orig = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = root;
    clearIndexCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (orig !== undefined) process.env['XDG_CACHE_HOME'] = orig;
    else delete process.env['XDG_CACHE_HOME'];
    rmSync(root, { recursive: true, force: true });
  });
  return { root: () => root };
}

describe('clearCachedFormats containment', () => {
  const tmp = useTempCacheHome();

  function populate(): void {
    const dir = join(getCacheDir(), 'MockFormat', '2.1.0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'format.js'), MOCK_FORMAT_SOURCE);
    // Siblings of the storyformats directory that must survive any named clear.
    writeFileSync(join(tmp.root(), 'twee-ts', 'keep.txt'), 'keep');
    writeFileSync(join(tmp.root(), 'outside.txt'), 'keep');
  }

  it.each(['..', '../..', '.', 'MockFormat/..', 'MockFormat/2.1.0', '../twee-ts', 'a\\..\\..', '/'])(
    'rejects %j without deleting anything',
    (name) => {
      populate();
      expect(() => clearCachedFormats(name)).toThrow(/not a cached format name/);
      expect(existsSync(join(tmp.root(), 'twee-ts', 'keep.txt'))).toBe(true);
      expect(existsSync(join(tmp.root(), 'outside.txt'))).toBe(true);
      expect(listCachedFormats()).toHaveLength(1);
    },
  );

  it('does not follow a symlinked entry out of the cache', () => {
    populate();
    const outside = join(tmp.root(), 'elsewhere');
    mkdirSync(join(outside, '1.0.0'), { recursive: true });
    writeFileSync(join(outside, '1.0.0', 'format.js'), MOCK_FORMAT_SOURCE);
    symlinkSync(outside, join(getCacheDir(), 'Linked'), 'dir');

    expect(clearCachedFormats('Linked')).toBe(0);
    expect(existsSync(join(outside, '1.0.0', 'format.js'))).toBe(true);
  });

  it('still clears a plain named entry', () => {
    populate();
    expect(clearCachedFormats('MockFormat')).toBe(1);
    expect(listCachedFormats()).toEqual([]);
    expect(existsSync(join(tmp.root(), 'twee-ts', 'keep.txt'))).toBe(true);
  });
});

describe('downloaded format metadata containment', () => {
  const tmp = useTempCacheHome();

  it.each([
    ['a traversal name', '../../escaped', '1.0.0'],
    ['a separator in the name', 'nested/escaped', '1.0.0'],
    ['a traversal suffix on the version', 'Escaper', '1.0.0/../../../escaped'],
  ])('fetchDirectFormat rejects %s', async (_label, name, version) => {
    stubFetch({ 'https://example.test/format.js': formatJs(name, version) });
    // A version with a path suffix is not a SemVer version, so it may already fail to parse.
    await expect(fetchDirectFormat('https://example.test/format.js')).rejects.toThrow(/unsafe|parse/);
    expect(existsSync(join(tmp.root(), 'escaped'))).toBe(false);
    expect(existsSync(join(tmp.root(), 'twee-ts', 'escaped'))).toBe(false);
    expect(existsSync(join(getCacheDir(), 'nested'))).toBe(false);
  });

  it('fetchAndCacheFormat rejects an unsafe index entry before downloading', async () => {
    const calls = stubFetch({ 'https://example.test/format.js': formatJs('Escaper', '1.0.0') });
    await expect(
      fetchAndCacheFormat(sfaEntry('../../escaped', '1.0.0'), 'https://example.test/format.js'),
    ).rejects.toThrow(/unsafe/);
    expect(calls).toEqual([]);
    expect(existsSync(join(tmp.root(), 'escaped'))).toBe(false);
  });

  it('resolveRemoteFormat writes nothing outside the cache for a malicious index entry', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [sfaEntry('../../escaped', '1.0.0')] }),
      [UNOFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [] }),
      [`${OFFICIAL_BASE}/twine2/../../escaped/1.0.0/format.js`]: formatJs('Escaper', '1.0.0'),
    });
    await expect(resolveRemoteFormat('../../escaped', '1.0.0')).rejects.toThrow(/unsafe/);
    expect(existsSync(join(tmp.root(), 'escaped'))).toBe(false);
  });

  it('refuses to write through a symlink planted in the cache', async () => {
    const outside = join(tmp.root(), 'elsewhere');
    mkdirSync(outside, { recursive: true });
    mkdirSync(getCacheDir(), { recursive: true });
    symlinkSync(outside, join(getCacheDir(), 'Linked'), 'dir');
    stubFetch({ 'https://example.test/format.js': formatJs('Linked', '1.0.0') });

    await expect(fetchDirectFormat('https://example.test/format.js')).rejects.toThrow(/outside/);
    expect(existsSync(join(outside, '1.0.0', 'format.js'))).toBe(false);
  });

  it('caches a well-formed direct download under name/version', async () => {
    stubFetch({ 'https://example.test/format.js': formatJs('Good Format', '1.2.3') });
    const info = await fetchDirectFormat('https://example.test/format.js');
    expect(info.filename).toBe(join(getCacheDir(), 'Good Format', '1.2.3', 'format.js'));
    expect(info.id).toBe('good-format-1');
  });
});

describe('fetchDirectFormat with a Harlowe setup function', () => {
  useTempCacheHome();

  it('parses a format whose setup property is a real function', async () => {
    stubFetch({ 'https://example.test/harlowe.js': readFileSync(HARLOWE_FIXTURE, 'utf-8') });
    const info = await fetchDirectFormat('https://example.test/harlowe.js');
    expect(info.name).toBe('Harlowe');
    expect(info.version).toBe('3.3.9');
    expect(info.id).toBe('harlowe-3');
  });
});

describe('resolveRemoteFormatRequest with format IDs', () => {
  useTempCacheHome();

  it('resolves a directory-style ID against index names', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: JSON.stringify({
        twine1: [],
        twine2: [sfaEntry('SugarCube', '2.36.1'), sfaEntry('SugarCube', '2.37.3'), sfaEntry('Harlowe', '3.3.9')],
      }),
      [`${OFFICIAL_BASE}/twine2/SugarCube/2.37.3/format.js`]: formatJs('SugarCube', '2.37.3'),
    });
    const info = await resolveRemoteFormatRequest({ kind: 'id', id: 'sugarcube-2' });
    expect(info?.name).toBe('SugarCube');
    expect(info?.version).toBe('2.37.3');
  });

  it('does not cross major versions for an ID', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [sfaEntry('SugarCube', '1.0.35')] }),
      [UNOFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [] }),
    });
    await expect(resolveRemoteFormatRequest({ kind: 'id', id: 'sugarcube-2' })).resolves.toBeUndefined();
  });

  it('matches a direct URL by ID', async () => {
    stubFetch({ 'https://example.test/format.js': formatJs('SugarCube', '2.37.3') });
    const info = await resolveRemoteFormatRequest(
      { kind: 'id', id: 'sugarcube-2' },
      [],
      ['https://example.test/format.js'],
    );
    expect(info?.version).toBe('2.37.3');
  });
});

describe('resolveRemoteFormat with a download cache and no network', () => {
  useTempCacheHome();

  async function cacheSugarCube(): Promise<void> {
    stubFetch({
      [OFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [sfaEntry('SugarCube', '2.37.3')] }),
      [`${OFFICIAL_BASE}/twine2/SugarCube/2.37.3/format.js`]: formatJs('SugarCube', '2.37.3'),
    });
    const first = await resolveRemoteFormat('SugarCube', '2.37.3');
    expect(first !== undefined && existsSync(first.filename)).toBe(true);
    clearIndexCache();
    vi.unstubAllGlobals();
  }

  it('uses an exactly matching cached format without fetching', async () => {
    await cacheSugarCube();
    stubOffline();
    const info = await resolveRemoteFormat('SugarCube', '2.37.3');
    expect(info?.version).toBe('2.37.3');
  });

  it('falls back to a compatible cached format when the network fails', async () => {
    await cacheSugarCube();
    stubOffline();
    const byName = await resolveRemoteFormat('SugarCube', '2.30.0');
    expect(byName?.version).toBe('2.37.3');
    const byId = await resolveRemoteFormatRequest({ kind: 'id', id: 'sugarcube-2' });
    expect(byId?.version).toBe('2.37.3');
  });

  it('still reports the network error when nothing is cached', async () => {
    stubOffline();
    await expect(resolveRemoteFormat('SugarCube', '2.37.3')).rejects.toThrow('offline');
  });
});

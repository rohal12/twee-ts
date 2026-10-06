import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
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
  fetchIndex,
} from '../src/remote-formats.js';
import { compile } from '../src/compiler.js';
import { parseFormatJSON } from '../src/format-decode.js';
import type { CompileResult, SFAIndex, SFAIndexEntry } from '../src/types.js';
import type * as NodeFs from 'node:fs';

// lstatSync and writeFileSync pass through to the real ones unless a test stands in for
// another process that acts between two steps of a cache write.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

const realFs = await vi.importActual<typeof NodeFs>('node:fs');
import { textOf } from './helpers/text.js';
const mockedLstatSync = vi.mocked(fs.lstatSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

afterEach(() => {
  mockedLstatSync.mockReset();
  mockedLstatSync.mockImplementation(realFs.lstatSync);
  mockedWriteFileSync.mockReset();
  mockedWriteFileSync.mockImplementation(realFs.writeFileSync);
});

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
    expect(() => {
      clearIndexCache();
    }).not.toThrow();
  });
});

describe('discoverCachedFormats', () => {
  let cacheHome: string;

  beforeEach(() => {
    cacheHome = mkdtempSync(join(tmpdir(), 'twee-ts-cache-test-'));
  });

  afterEach(() => {
    rmSync(cacheHome, { recursive: true, force: true });
  });

  it('discovers formats in cache directory', () => {
    // Set XDG_CACHE_HOME to our tmp dir so getCacheDir uses it
    const orig = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = cacheHome;
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
    process.env['XDG_CACHE_HOME'] = join(cacheHome, 'nonexistent');
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
  let cacheHome: string;

  beforeEach(() => {
    cacheHome = mkdtempSync(join(tmpdir(), 'twee-ts-cache-list-'));
  });

  afterEach(() => {
    rmSync(cacheHome, { recursive: true, force: true });
  });

  it('lists cached formats with size and date', () => {
    withCacheHome(cacheHome, () => {
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
    withCacheHome(join(cacheHome, 'nonexistent'), () => {
      expect(listCachedFormats()).toEqual([]);
    });
  });

  it('lists multiple formats', () => {
    withCacheHome(cacheHome, () => {
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
  let cacheHome: string;

  beforeEach(() => {
    cacheHome = mkdtempSync(join(tmpdir(), 'twee-ts-cache-clear-'));
  });

  afterEach(() => {
    rmSync(cacheHome, { recursive: true, force: true });
  });

  it('clears all cached formats', () => {
    withCacheHome(cacheHome, () => {
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
    withCacheHome(cacheHome, () => {
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
    withCacheHome(join(cacheHome, 'nonexistent'), () => {
      expect(clearCachedFormats()).toBe(0);
    });
  });

  it('returns 0 when name does not match', () => {
    withCacheHome(cacheHome, () => {
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
  let cacheHome: string;

  beforeEach(() => {
    cacheHome = mkdtempSync(join(tmpdir(), 'twee-ts-cache-size-'));
  });

  afterEach(() => {
    rmSync(cacheHome, { recursive: true, force: true });
  });

  it('returns total size and count', () => {
    withCacheHome(cacheHome, () => {
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
    withCacheHome(join(cacheHome, 'nonexistent'), () => {
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
    vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const body = routes[url];
      return Promise.resolve(
        body === undefined ? new Response('missing', { status: 404, statusText: 'Not Found' }) : new Response(body),
      );
    }),
  );
  return calls;
}

/** Stub `fetch` so every request fails as if the machine were offline. */
function stubOffline(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('offline'))),
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

    await expect(fetchAndCacheFormat(sfaEntry('Linked', '1.0.0'), 'https://example.test/format.js')).rejects.toThrow(
      /outside/,
    );
    expect(existsSync(join(outside, '1.0.0', 'format.js'))).toBe(false);
  });

  it('caches a direct download by its URL, apart from the downloads shared by name and version', async () => {
    stubFetch({ 'https://example.test/format.js': formatJs('Good Format', '1.2.3') });
    const info = await fetchDirectFormat('https://example.test/format.js');
    expect(info.id).toBe('good-format-1');
    expect(readFileSync(info.filename, 'utf-8')).toBe(formatJs('Good Format', '1.2.3'));
    expect(info.filename.startsWith(getCacheDir())).toBe(false);
    expect(discoverCachedFormats().size).toBe(0);
    expect(existsSync(join(getCacheDir(), 'Good Format'))).toBe(false);
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

describe('fetchDirectFormat with wrapper comments (#221)', () => {
  useTempCacheHome();

  it('reads a format wrapped in comments that contain braces', async () => {
    const wrapped = `/* Copyright {license} */\n${formatJs('Wrapped', '1.0.0')}\n// {notice}`;
    stubFetch({ 'https://example.test/wrapped.js': wrapped });
    const info = await fetchDirectFormat('https://example.test/wrapped.js');
    expect(info.name).toBe('Wrapped');
    expect(info.version).toBe('1.0.0');
    expect(parseFormatJSON(readFileSync(info.filename, 'utf-8'))?.source).toBe('<html>{{STORY_DATA}}</html>');
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

// --- Concurrent downloads, per-URL cache entries, cancellation ---

const INLINE_STORY = [
  { filename: 's.tw', content: ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHi\n' },
];
const SUGARCUBE_URL = `${OFFICIAL_BASE}/twine2/SugarCube/2.37.3/format.js`;
const FORK_URL = 'https://example.test/my-patched-sugarcube/format.js';

/** A SugarCube 2.37.3 format.js whose page title tells the copies apart. */
function taggedSugarCube(tag: string): string {
  return `window.storyFormat(${JSON.stringify({
    name: 'SugarCube',
    version: '2.37.3',
    source: `<html><head><title>${tag}</title></head><body>{{STORY_DATA}}</body></html>`,
  })});`;
}

const OFFICIAL_ROUTES: Readonly<Record<string, string>> = {
  [OFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [sfaEntry('SugarCube', '2.37.3')] }),
  [UNOFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [] }),
  [SUGARCUBE_URL]: taggedSugarCube('OFFICIAL'),
};

/** Compiles the inline story with no local formats, so only the download cache and the network can answer. */
function compileStory(options: { formatUrls?: string[]; noRemote?: boolean; signal?: AbortSignal } = {}) {
  return compile({ sources: INLINE_STORY, useTweegoPath: false, ...options });
}

const titleOf = (result: CompileResult): string | undefined => /<title>(.*?)<\/title>/.exec(result.output)?.[1];

interface StalledRequest {
  readonly url: string;
  readonly signal: AbortSignal | undefined;
  /** Answers the request with `body`. */
  readonly answer: (body: string) => void;
}

/**
 * Stubs `fetch` so every request waits until the test answers it, or until its signal aborts, when it
 * rejects with the signal's reason (as the real fetch does). `next()` resolves with each request in order.
 */
function stubStalledFetch() {
  const requests: StalledRequest[] = [];
  const waiting: ((request: StalledRequest) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal ?? undefined;
          const request: StalledRequest = {
            url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
            signal,
            answer: (body) => {
              resolve(new Response(body));
            },
          };
          if (signal?.aborted) {
            const reason: unknown = signal.reason;
            reject(reason);
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              const reason: unknown = signal.reason;
              reject(reason);
            },
            { once: true },
          );
          const waiter = waiting.shift();
          if (waiter) waiter(request);
          else requests.push(request);
        }),
    ),
  );
  return {
    next(): Promise<StalledRequest> {
      const request = requests.shift();
      return request ? Promise.resolve(request) : new Promise((done) => waiting.push(done));
    },
  };
}

/** Resolves once `signal` aborts. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return Promise.reject(new Error('the request has no signal'));
  if (signal.aborted) return Promise.resolve();
  return new Promise((done) => {
    signal.addEventListener(
      'abort',
      () => {
        done();
      },
      { once: true },
    );
  });
}

/** Every file under `root`, relative to it. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

/** A temporary cache and home folder per test, so no format installed on the machine can answer. */
function useTempHome(): { readonly root: () => string } {
  const tmp = useTempCacheHome();
  let origHome: string | undefined;
  beforeEach(() => {
    origHome = process.env['HOME'];
    process.env['HOME'] = tmp.root();
  });
  afterEach(() => {
    if (origHome !== undefined) process.env['HOME'] = origHome;
    else delete process.env['HOME'];
  });
  return tmp;
}

describe('format cache writes racing another process', () => {
  useTempCacheHome();

  it('accepts a format folder another process creates between its check and its mkdir', async () => {
    const raced = join(getCacheDir(), 'SugarCube');
    mockedLstatSync.mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
      const stat = realFs.lstatSync(path, options);
      if (stat === undefined && String(path) === raced) mkdirSync(raced, { recursive: true });
      return stat;
    });
    stubFetch({ [SUGARCUBE_URL]: formatJs('SugarCube', '2.37.3') });

    const info = await fetchAndCacheFormat(sfaEntry('SugarCube', '2.37.3'), SUGARCUBE_URL);
    expect(readFileSync(info.filename, 'utf-8')).toBe(formatJs('SugarCube', '2.37.3'));
  });

  it('still refuses a symlink another process puts there instead', async () => {
    const raced = join(getCacheDir(), 'SugarCube');
    const outside = mkdtempSync(join(tmpdir(), 'twee-ts-outside-'));
    try {
      mockedLstatSync.mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
        const stat = realFs.lstatSync(path, options);
        if (stat === undefined && String(path) === raced) symlinkSync(outside, raced, 'dir');
        return stat;
      });
      mkdirSync(getCacheDir(), { recursive: true });
      stubFetch({ [SUGARCUBE_URL]: formatJs('SugarCube', '2.37.3') });

      await expect(fetchAndCacheFormat(sfaEntry('SugarCube', '2.37.3'), SUGARCUBE_URL)).rejects.toThrow(/outside/);
      expect(filesUnder(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never shows a reader a partial format.js while it rewrites a cache entry', async () => {
    stubFetch({ [SUGARCUBE_URL]: taggedSugarCube('FIRST') });
    const first = await fetchAndCacheFormat(sfaEntry('SugarCube', '2.37.3'), SUGARCUBE_URL);

    // Another process reads the entry while this one is part way through writing the new copy.
    const seen: unknown[] = [];
    mockedWriteFileSync.mockImplementationOnce((file, data) => {
      realFs.writeFileSync(file, textOf(data).slice(0, 40));
      seen.push(parseFormatJSON(readFileSync(first.filename, 'utf-8'))?.source);
      realFs.writeFileSync(file, data);
    });
    vi.unstubAllGlobals();
    stubFetch({ [SUGARCUBE_URL]: taggedSugarCube('SECOND') });
    const second = await fetchAndCacheFormat(sfaEntry('SugarCube', '2.37.3'), SUGARCUBE_URL);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('FIRST');
    expect(readFileSync(second.filename, 'utf-8')).toBe(taggedSugarCube('SECOND'));
    expect(filesUnder(getCacheDir())).toEqual([join('SugarCube', '2.37.3', 'format.js')]);
  });
});

describe('concurrent lookups in one process', () => {
  useTempHome();

  it('share one index request and one download', async () => {
    const calls = stubFetch(OFFICIAL_ROUTES);
    const [a, b] = await Promise.all([compileStory(), compileStory()]);
    expect(titleOf(a)).toBe('OFFICIAL');
    expect(titleOf(b)).toBe('OFFICIAL');
    expect(calls).toEqual([OFFICIAL_INDEX, SUGARCUBE_URL]);
  });

  it('share one download of a format URL', async () => {
    const calls = stubFetch({ [FORK_URL]: taggedSugarCube('FORK') });
    const results = await Promise.all([
      compileStory({ formatUrls: [FORK_URL] }),
      compileStory({ formatUrls: [FORK_URL] }),
    ]);
    expect(results.map(titleOf)).toEqual(['FORK', 'FORK']);
    expect(calls).toEqual([FORK_URL]);
  });
});

describe('downloads from format URLs and the shared download cache', () => {
  const tmp = useTempHome();

  it('never give another project the copy downloaded from a format URL', async () => {
    const calls = stubFetch({ ...OFFICIAL_ROUTES, [FORK_URL]: taggedSugarCube('FORK') });
    expect(titleOf(await compileStory({ formatUrls: [FORK_URL] }))).toBe('FORK');
    calls.length = 0;

    expect(titleOf(await compileStory())).toBe('OFFICIAL');
    expect(calls).toContain(SUGARCUBE_URL);
  });

  it('give a project its format URL’s copy, even when the same name and version is cached', async () => {
    const calls = stubFetch({ ...OFFICIAL_ROUTES, [FORK_URL]: taggedSugarCube('FORK') });
    expect(titleOf(await compileStory())).toBe('OFFICIAL');
    calls.length = 0;

    expect(titleOf(await compileStory({ formatUrls: [FORK_URL] }))).toBe('FORK');
    expect(calls).toEqual([FORK_URL]);
  });

  it('reuse the cached copy of a format URL without the network, and with remote fetching off', async () => {
    stubFetch({ [FORK_URL]: taggedSugarCube('FORK') });
    await compileStory({ formatUrls: [FORK_URL] });
    vi.unstubAllGlobals();
    stubOffline();

    const offline = await compileStory({ formatUrls: [FORK_URL] });
    expect(titleOf(offline)).toBe('FORK');
    expect(offline.diagnostics).toEqual([]);
    expect(titleOf(await compileStory({ formatUrls: [FORK_URL], noRemote: true }))).toBe('FORK');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('keep each URL’s copy apart from every other URL’s', async () => {
    const OTHER_URL = 'https://example.test/other-fork/format.js';
    stubFetch({ [FORK_URL]: taggedSugarCube('FORK'), [OTHER_URL]: taggedSugarCube('OTHER') });
    expect(titleOf(await compileStory({ formatUrls: [FORK_URL] }))).toBe('FORK');
    expect(titleOf(await compileStory({ formatUrls: [OTHER_URL] }))).toBe('OTHER');
    expect(titleOf(await compileStory({ formatUrls: [FORK_URL] }))).toBe('FORK');
  });

  it('are all removed by clearing the cache', async () => {
    stubFetch({ ...OFFICIAL_ROUTES, [FORK_URL]: taggedSugarCube('FORK') });
    await compileStory({ formatUrls: [FORK_URL] });
    await compileStory();
    expect(clearCachedFormats()).toBe(2);
    expect(filesUnder(join(tmp.root(), 'twee-ts'))).toEqual([]);
  });
});

describe('same-major older fallback from format URLs', () => {
  useTempHome();

  const storyFor = (version: string) => [
    {
      filename: 's.tw',
      content: `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"${version}"}\n\n:: Start\nHi\n`,
    },
  ];
  const compileFor = (version: string, options: { formatUrls?: string[]; noRemote?: boolean } = {}) =>
    compile({ sources: storyFor(version), useTweegoPath: false, ...options });
  const taggedVersion = (tag: string, version: string): string =>
    taggedSugarCube(tag).replace('"2.37.3"', JSON.stringify(version));
  const olderWarnings = (result: CompileResult): string[] =>
    result.diagnostics.filter((d) => d.message.includes('is not available; using')).map((d) => d.message);

  it('uses the older copy from a first online download, with a warning', async () => {
    const calls = stubFetch({ [FORK_URL]: taggedSugarCube('FORK') });
    const result = await compileFor('2.38.0', { formatUrls: [FORK_URL], noRemote: false });
    expect(titleOf(result)).toBe('FORK');
    expect(olderWarnings(result)).toHaveLength(1);
    expect(calls).toContain(FORK_URL);
  });

  it('uses the primed copy offline, with the same warning as a local older format', async () => {
    stubFetch({ [FORK_URL]: taggedSugarCube('FORK') });
    await fetchDirectFormat(FORK_URL);
    vi.unstubAllGlobals();
    stubOffline();
    const result = await compileFor('2.38.0', { formatUrls: [FORK_URL], noRemote: true });
    expect(titleOf(result)).toBe('FORK');
    expect(olderWarnings(result)).toEqual([expect.stringContaining('using SugarCube 2.37.3 instead')]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('downloads nothing when remote fetching is off and the URL is not cached', async () => {
    const calls = stubFetch({ [FORK_URL]: taggedSugarCube('FORK') });
    await expect(compileFor('2.38.0', { formatUrls: [FORK_URL], noRemote: true })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('rejects an older copy of another major version', async () => {
    stubFetch({ [FORK_URL]: taggedVersion('FORK', '1.0.0') });
    await expect(compileFor('2.38.0', { formatUrls: [FORK_URL] })).rejects.toThrow();
  });

  it('does not warn for an exact or newer copy', async () => {
    stubFetch({ [FORK_URL]: taggedSugarCube('FORK') });
    for (const wanted of ['2.37.3', '2.36.0']) {
      const result = await compileFor(wanted, { formatUrls: [FORK_URL] });
      expect(titleOf(result)).toBe('FORK');
      expect(olderWarnings(result)).toEqual([]);
    }
  });

  it('prefers an at-or-above copy from the index over an older copy from a format URL', async () => {
    stubFetch({ ...OFFICIAL_ROUTES, [FORK_URL]: taggedVersion('FORK', '2.36.0') });
    const result = await compileFor('2.37.0', { formatUrls: [FORK_URL] });
    expect(titleOf(result)).toBe('OFFICIAL');
    expect(olderWarnings(result)).toEqual([]);
  });

  it('never uses another project’s copy of the same name and version from the URL cache', async () => {
    stubFetch({ [FORK_URL]: taggedSugarCube('FORK') });
    await fetchDirectFormat(FORK_URL);
    const calls = stubFetch({});
    await expect(compileFor('2.38.0', { formatUrls: ['https://example.test/other/format.js'] })).rejects.toThrow();
    expect(calls).toContain('https://example.test/other/format.js');
  });
});

describe('cancelling and timing out format downloads', () => {
  const tmp = useTempHome();

  it('stops the request and rejects with the reason when the signal aborts', async () => {
    const network = stubStalledFetch();
    const controller = new AbortController();
    const pending = fetchDirectFormat(FORK_URL, { signal: controller.signal });
    const request = await network.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await aborted(request.signal);
    expect(filesUnder(join(tmp.root(), 'twee-ts'))).toEqual([]);
  });

  it('writes nothing to the cache when the signal aborts after the download', async () => {
    const network = stubStalledFetch();
    const controller = new AbortController();
    const pending = fetchAndCacheFormat(sfaEntry('SugarCube', '2.37.3'), SUGARCUBE_URL, { signal: controller.signal });
    const request = await network.next();
    // The body arrives, and the caller gives up before it is written.
    request.answer(taggedSugarCube('LATE'));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(filesUnder(join(tmp.root(), 'twee-ts'))).toEqual([]);
  });

  it('tries no further source after the signal aborts', async () => {
    const network = stubStalledFetch();
    const controller = new AbortController();
    const pending = resolveRemoteFormatRequest({ kind: 'id', id: 'sugarcube-2' }, [], [FORK_URL], {
      signal: controller.signal,
    });
    await network.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('rejects at once for a signal that has already aborted', async () => {
    stubStalledFetch();
    await expect(fetchIndex(OFFICIAL_INDEX, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('keeps a shared download going for the callers that still wait on it', async () => {
    const network = stubStalledFetch();
    const quitter = new AbortController();
    const first = fetchDirectFormat(FORK_URL, { signal: quitter.signal });
    const second = fetchDirectFormat(FORK_URL, { signal: new AbortController().signal });
    const request = await network.next();
    quitter.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    expect(request.signal?.aborted).toBe(false);
    request.answer(taggedSugarCube('FORK'));
    expect((await second).version).toBe('2.37.3');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('stops a shared download once every caller has aborted', async () => {
    const network = stubStalledFetch();
    const a = new AbortController();
    const b = new AbortController();
    const first = fetchDirectFormat(FORK_URL, { signal: a.signal });
    const second = fetchDirectFormat(FORK_URL, { signal: b.signal });
    const request = await network.next();
    a.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.signal?.aborted).toBe(false);
    b.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await aborted(request.signal);
  });

  it('fails a request that takes longer than the timeout, naming the URL', async () => {
    stubStalledFetch();
    await expect(fetchIndex(OFFICIAL_INDEX, { timeout: 20 })).rejects.toThrow(
      `Failed to fetch format index from ${OFFICIAL_INDEX}: timed out after 20 ms`,
    );
  });

  it('moves on to the next source after a request times out', async () => {
    const network = stubStalledFetch();
    const pending = resolveRemoteFormatRequest({ kind: 'id', id: 'sugarcube-2' }, [], [FORK_URL], { timeout: 20 });
    await network.next(); // the format URL, which never answers
    const index = await network.next(); // its timeout has passed: on to the official index
    expect(index.url).toBe(OFFICIAL_INDEX);
    index.answer(OFFICIAL_ROUTES[OFFICIAL_INDEX] ?? '');
    (await network.next()).answer(taggedSugarCube('OFFICIAL'));
    expect((await pending)?.version).toBe('2.37.3');
  });

  it('rejects a compile with the reason when its signal aborts during a download', async () => {
    const network = stubStalledFetch();
    const controller = new AbortController();
    const pending = compileStory({ signal: controller.signal });
    const request = await network.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await aborted(request.signal);
  });

  it('rejects a compile at once for a signal that has already aborted', async () => {
    stubStalledFetch();
    await expect(compileStory({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('rejects a timeout that is not a non-negative number of milliseconds', async () => {
    stubStalledFetch();
    await expect(compile({ sources: INLINE_STORY, formatFetchTimeout: -1 })).rejects.toThrow(/formatFetchTimeout/);
    await expect(compile({ sources: INLINE_STORY, formatFetchTimeout: Number.NaN })).rejects.toThrow(
      /formatFetchTimeout/,
    );
  });
});

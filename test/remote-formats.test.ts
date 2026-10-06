import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  getCacheDir,
  clearIndexCache,
  discoverCachedFormats,
  listCachedFormats,
  clearCachedFormats,
  getCacheSize,
  fetchDirectFormat,
  fetchIndex,
} from '../src/remote-formats.js';
import { cacheKey, readRecord } from '../src/format-cache.js';
import { resolveRemoteFormat, resolveStoryFormat } from '../src/format-resolution.js';
import { useCachedRecord } from '../src/remote-formats.js';
import { compile } from '../src/compiler.js';
import { parseFormatJSON } from '../src/format-decode.js';
import type { CompileResult, Diagnostic, FormatRequest, SFAIndexEntry, StoryFormatInfo } from '../src/types.js';
import type * as NodeFs from 'node:fs';
import { seedIndexDownload } from './helpers/format-cache.js';

// writeFileSync passes through to the real one unless a test stands in for another process that
// reads the cache between two steps of a cache write.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const realFs = await vi.importActual<typeof NodeFs>('node:fs');
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

afterEach(() => {
  mockedWriteFileSync.mockReset();
  mockedWriteFileSync.mockImplementation(realFs.writeFileSync);
});

// Minimal format.js content for testing
const MOCK_FORMAT_SOURCE = `window.storyFormat({"name":"MockFormat","version":"2.1.0","proofing":false,"source":"<html><body>{{STORY_DATA}}</body></html>"});`;

function mockFormat(name: string, version: string): string {
  return `window.storyFormat({"name":"${name}","version":"${version}","proofing":false,"source":"<html></html>"});`;
}

describe('getCacheDir', () => {
  it('returns a path containing twee-ts/storyformats', () => {
    const dir = getCacheDir();
    expect(dir).toContain('twee-ts');
    expect(dir).toContain('storyformats');
  });

  it('respects XDG_CACHE_HOME', () => {
    const orig = process.env['XDG_CACHE_HOME'];
    const xdg = join(tmpdir(), 'xdg-test');
    process.env['XDG_CACHE_HOME'] = xdg;
    try {
      expect(getCacheDir()).toBe(join(xdg, 'twee-ts', 'storyformats'));
    } finally {
      if (orig !== undefined) process.env['XDG_CACHE_HOME'] = orig;
      else delete process.env['XDG_CACHE_HOME'];
    }
  });

  it.each(['', 'relative-cache', './cache'])('ignores an XDG_CACHE_HOME of %j (F18)', (value) => {
    const orig = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = value;
    try {
      expect(getCacheDir()).toBe(join(homedir(), '.cache', 'twee-ts', 'storyformats'));
    } finally {
      if (orig !== undefined) process.env['XDG_CACHE_HOME'] = orig;
      else delete process.env['XDG_CACHE_HOME'];
    }
  });
});

describe('clearIndexCache', () => {
  it('does not throw', () => {
    expect(() => {
      clearIndexCache();
    }).not.toThrow();
  });
});

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

describe('discoverCachedFormats', () => {
  const tmp = useTempCacheHome();

  it('discovers formats in cache directory', () => {
    seedIndexDownload('MockFormat', '2.1.0', MOCK_FORMAT_SOURCE);
    const mock = [...discoverCachedFormats().values()].find((f) => f.name === 'MockFormat');
    expect(mock?.version).toBe('2.1.0');
  });

  it('returns empty map when cache dir does not exist', () => {
    process.env['XDG_CACHE_HOME'] = join(tmp.root(), 'nonexistent');
    expect(discoverCachedFormats().size).toBe(0);
  });
});

describe('listCachedFormats', () => {
  const tmp = useTempCacheHome();

  it('lists cached formats with size, date and origin', () => {
    seedIndexDownload('MockFormat', '2.1.0', MOCK_FORMAT_SOURCE);
    const entries = listCachedFormats();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'MockFormat',
      version: '2.1.0',
      source: 'index',
      sizeBytes: MOCK_FORMAT_SOURCE.length,
    });
    expect(entries[0]?.modifiedAt).toBeInstanceOf(Date);
  });

  it('returns empty array when cache does not exist', () => {
    process.env['XDG_CACHE_HOME'] = join(tmp.root(), 'nonexistent');
    expect(listCachedFormats()).toEqual([]);
  });

  it('lists multiple formats', () => {
    seedIndexDownload('FormatA', '1.0.0', mockFormat('FormatA', '1.0.0'));
    seedIndexDownload('FormatB', '3.2.1', mockFormat('FormatB', '3.2.1'));
    expect(
      listCachedFormats()
        .map((e) => e.name)
        .sort(),
    ).toEqual(['FormatA', 'FormatB']);
  });
});

describe('clearCachedFormats', () => {
  const tmp = useTempCacheHome();

  it('clears all cached formats', () => {
    seedIndexDownload('MockFormat', '2.1.0', MOCK_FORMAT_SOURCE);
    expect(clearCachedFormats()).toBe(1);
    expect(listCachedFormats()).toEqual([]);
  });

  it('clears formats by name, without regard to letter case (F10)', () => {
    seedIndexDownload('FormatA', '1.0.0', mockFormat('FormatA', '1.0.0'));
    seedIndexDownload('FormatB', '3.2.1', mockFormat('FormatB', '3.2.1'));
    expect(clearCachedFormats('formata')).toBe(1);
    expect(listCachedFormats().map((e) => e.name)).toEqual(['FormatB']);
  });

  it('returns 0 when cache does not exist', () => {
    process.env['XDG_CACHE_HOME'] = join(tmp.root(), 'nonexistent');
    expect(clearCachedFormats()).toBe(0);
  });

  it('returns 0 when name does not match', () => {
    seedIndexDownload('MockFormat', '2.1.0', MOCK_FORMAT_SOURCE);
    expect(clearCachedFormats('NonExistent')).toBe(0);
    expect(listCachedFormats()).toHaveLength(1);
  });
});

describe('getCacheSize', () => {
  const tmp = useTempCacheHome();

  it('returns total size and count', () => {
    seedIndexDownload('MockFormat', '2.1.0', MOCK_FORMAT_SOURCE);
    expect(getCacheSize()).toEqual({ totalBytes: MOCK_FORMAT_SOURCE.length, count: 1 });
  });

  it('returns zero for empty cache', () => {
    process.env['XDG_CACHE_HOME'] = join(tmp.root(), 'nonexistent');
    expect(getCacheSize()).toEqual({ totalBytes: 0, count: 0 });
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

/** Every file under `root`, relative to it. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

describe('clearing the cache by name never leaves the cache (F10)', () => {
  const tmp = useTempCacheHome();

  function populate(): void {
    seedIndexDownload('MockFormat', '2.1.0', MOCK_FORMAT_SOURCE);
    // Siblings of the storyformats directory that must survive any named clear.
    realFs.writeFileSync(join(tmp.root(), 'twee-ts', 'keep.txt'), 'keep');
    realFs.writeFileSync(join(tmp.root(), 'outside.txt'), 'keep');
  }

  it.each(['..', '../..', '.', 'MockFormat/..', 'MockFormat/2.1.0', '../twee-ts', 'a\\..\\..', '/'])(
    'treats %j as a name that matches nothing, and deletes nothing',
    (name) => {
      populate();
      expect(clearCachedFormats(name)).toBe(0);
      expect(existsSync(join(tmp.root(), 'twee-ts', 'keep.txt'))).toBe(true);
      expect(existsSync(join(tmp.root(), 'outside.txt'))).toBe(true);
      expect(listCachedFormats()).toHaveLength(1);
    },
  );

  it('does not follow a symlinked entry out of the cache', () => {
    populate();
    const outside = join(tmp.root(), 'elsewhere');
    const linked = seedIndexDownload('Linked', '1.0.0', mockFormat('Linked', '1.0.0'));
    // Replace the entry's folder with a link to a copy elsewhere.
    const entryDir = join(linked, '..', '..');
    realFs.cpSync(entryDir, outside, { recursive: true });
    rmSync(entryDir, { recursive: true });
    symlinkSync(outside, entryDir, 'dir');

    expect(listCachedFormats().map((e) => e.name)).toEqual(['MockFormat']);
    expect(clearCachedFormats('Linked')).toBe(0);
    expect(filesUnder(outside)).not.toEqual([]);
  });

  it('still clears a plain named entry', () => {
    populate();
    expect(clearCachedFormats('MockFormat')).toBe(1);
    expect(listCachedFormats()).toEqual([]);
    expect(existsSync(join(tmp.root(), 'twee-ts', 'keep.txt'))).toBe(true);
  });
});

describe('downloaded format metadata never names a cache path (F15, #238)', () => {
  const tmp = useTempCacheHome();

  it.each([
    ['a traversal name', '../../escaped'],
    ['a separator in the name', 'nested/escaped'],
    ['a name only unsafe as a path', 'AC/DC'],
    ['a Windows device name', 'CON'],
    ['a name with a trailing dot', 'Review.'],
    ['a name with URL syntax', 'Review #?'],
  ])('fetchDirectFormat caches a format with %s under a hash of its URL', async (_label, name) => {
    stubFetch({ 'https://example.test/format.js': formatJs(name, '1.0.0') });
    const info = await fetchDirectFormat('https://example.test/format.js');
    expect(info.name).toBe(name);
    expect(info.filename.startsWith(join(getCacheDir(), 'entries') + sep)).toBe(true);
    expect(
      filesUnder(tmp.root()).every((f) => /^twee-ts[/\\]storyformats[/\\]entries[/\\][0-9a-f]{64}[/\\]/.test(f)),
    ).toBe(true);
  });

  it('fetchDirectFormat rejects a version with a path suffix as not a version', async () => {
    stubFetch({ 'https://example.test/format.js': formatJs('Escaper', '1.0.0/../../../escaped') });
    await expect(fetchDirectFormat('https://example.test/format.js')).rejects.toThrow(
      /Failed to read the story format at https:\/\/example\.test\/format\.js: .*not a SemVer version/,
    );
    expect(filesUnder(tmp.root())).toEqual([]);
  });

  it('resolveRemoteFormat downloads an index entry with a traversal name inside the cache only', async () => {
    const calls = stubFetch({
      [OFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [sfaEntry('../../escaped', '1.0.0')] }),
      [`${OFFICIAL_BASE}/twine2/..%2F..%2Fescaped/1.0.0/format.js`]: formatJs('../../escaped', '1.0.0'),
    });
    const info = await resolveRemoteFormat('../../escaped', '1.0.0');
    expect(info?.name).toBe('../../escaped');
    expect(calls).toContain(`${OFFICIAL_BASE}/twine2/..%2F..%2Fescaped/1.0.0/format.js`);
    expect(existsSync(join(tmp.root(), 'escaped'))).toBe(false);
    expect(filesUnder(tmp.root()).every((f) => f.startsWith(join('twee-ts', 'storyformats', 'entries')))).toBe(true);
  });

  it('refuses to write through a symlink planted in the cache', async () => {
    const url = 'https://example.test/format.js';
    const outside = join(tmp.root(), 'elsewhere');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(getCacheDir(), 'entries'), { recursive: true });
    symlinkSync(outside, join(getCacheDir(), 'entries', cacheKey({ kind: 'url', url })), 'dir');
    stubFetch({ [url]: formatJs('Linked', '1.0.0') });

    await expect(fetchDirectFormat(url)).rejects.toThrow(/outside the cache directory/);
    expect(filesUnder(outside)).toEqual([]);
  });

  it('caches a direct download under its URL', async () => {
    stubFetch({ 'https://example.test/format.js': formatJs('Good Format', '1.2.3') });
    const info = await fetchDirectFormat('https://example.test/format.js');
    expect(info.id).toBe('good-format-1');
    expect(readFileSync(info.filename, 'utf-8')).toBe(formatJs('Good Format', '1.2.3'));
    expect(listCachedFormats()).toEqual([
      expect.objectContaining({ name: 'Good Format', source: 'url', origin: 'https://example.test/format.js' }),
    ]);
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

/** Resolve a request as a compile does, with no local formats. */
async function resolveRequest(
  request: FormatRequest,
  extra: { readonly formatUrls?: string[]; readonly noRemote?: boolean } = {},
): Promise<{ readonly info: StoryFormatInfo | undefined; readonly diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const info = await resolveStoryFormat(request, { formatPaths: [], useTweegoPath: false, ...extra }, diagnostics);
  return { info, diagnostics };
}

describe('format IDs against indices and format URLs', () => {
  useTempHome();

  it('resolves a directory-style ID against index names', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: JSON.stringify({
        twine1: [],
        twine2: [sfaEntry('SugarCube', '2.36.1'), sfaEntry('SugarCube', '2.37.3'), sfaEntry('Harlowe', '3.3.9')],
      }),
      [`${OFFICIAL_BASE}/twine2/SugarCube/2.37.3/format.js`]: formatJs('SugarCube', '2.37.3'),
    });
    const { info } = await resolveRequest({ kind: 'id', id: 'sugarcube-2' });
    expect(info?.name).toBe('SugarCube');
    expect(info?.version).toBe('2.37.3');
  });

  it('does not cross major versions for an ID', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [sfaEntry('SugarCube', '1.0.35')] }),
      [UNOFFICIAL_INDEX]: JSON.stringify({ twine1: [], twine2: [] }),
    });
    const { info, diagnostics } = await resolveRequest({ kind: 'id', id: 'sugarcube-2' });
    expect(info).toBeUndefined();
    expect(diagnostics.at(-1)?.message).toContain('another major version');
  });

  it('matches a direct URL by ID', async () => {
    stubFetch({ 'https://example.test/format.js': formatJs('SugarCube', '2.37.3') });
    const { info } = await resolveRequest(
      { kind: 'id', id: 'sugarcube-2' },
      { formatUrls: ['https://example.test/format.js'] },
    );
    expect(info?.version).toBe('2.37.3');
  });
});

describe('resolveRemoteFormat with a download cache and no network', () => {
  useTempHome();

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

  it('uses an exactly matching cached format when the index cannot be reached', async () => {
    await cacheSugarCube();
    stubOffline();
    const info = await resolveRemoteFormat('SugarCube', '2.37.3');
    expect(info?.version).toBe('2.37.3');
  });

  it('falls back to a compatible cached format when the network fails', async () => {
    await cacheSugarCube();
    stubOffline();
    expect((await resolveRemoteFormat('SugarCube', '2.30.0'))?.version).toBe('2.37.3');
    const byId = await resolveRequest({ kind: 'id', id: 'sugarcube-2' });
    expect(byId.info?.version).toBe('2.37.3');
    expect(byId.diagnostics.map((d) => d.message)).toContainEqual(
      expect.stringContaining(
        `Failed to fetch format index from ${OFFICIAL_INDEX}: offline; using the formats downloaded from it before`,
      ),
    );
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

/** Compiles the inline story with no local formats, so only format URLs and indices can answer. */
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

describe('format cache writes racing another process', () => {
  useTempCacheHome();

  it('accepts an entry folder another process created first', async () => {
    mkdirSync(join(getCacheDir(), 'entries', cacheKey({ kind: 'url', url: FORK_URL })), { recursive: true });
    stubFetch({ [FORK_URL]: taggedSugarCube('FORK') });
    const info = await fetchDirectFormat(FORK_URL);
    expect(readFileSync(info.filename, 'utf-8')).toBe(taggedSugarCube('FORK'));
  });

  it('never shows a reader a partial or mixed entry while it rewrites a cache entry', async () => {
    stubFetch({ [FORK_URL]: taggedSugarCube('FIRST') });
    await fetchDirectFormat(FORK_URL);

    // Another process reads the entry while this one is part way through writing the new copy.
    const seen: unknown[] = [];
    mockedWriteFileSync.mockImplementationOnce((file, data, options) => {
      realFs.writeFileSync(file, data, options);
      const record = readRecord({ kind: 'url', url: FORK_URL });
      seen.push(record && parseFormatJSON(realFs.readFileSync(useCachedRecord(record).filename, 'utf-8'))?.source);
    });
    vi.unstubAllGlobals();
    stubFetch({ [FORK_URL]: taggedSugarCube('SECOND') });
    const second = await fetchDirectFormat(FORK_URL);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('FIRST');
    expect(readFileSync(second.filename, 'utf-8')).toBe(taggedSugarCube('SECOND'));
    // The first copy's folder is gone; the entry holds its record and the second copy.
    const files = filesUnder(join(getCacheDir(), 'entries'));
    expect(files).toHaveLength(2);
    expect(files.filter((f) => f.endsWith('format.js'))).toHaveLength(1);
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

describe('downloads from format URLs and from indices', () => {
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

  it('use the cached copy of a format URL that cannot be reached, with a warning, and with remote fetching off', async () => {
    stubFetch({ [FORK_URL]: taggedSugarCube('FORK') });
    await compileStory({ formatUrls: [FORK_URL] });
    vi.unstubAllGlobals();
    stubOffline();

    const unreachable = await compileStory({ formatUrls: [FORK_URL] });
    expect(titleOf(unreachable)).toBe('FORK');
    expect(unreachable.diagnostics.map((d) => d.message)).toEqual([
      expect.stringMatching(
        new RegExp(
          `Failed to download format from ${FORK_URL.replace(/\./g, '\\.')}: offline; using the copy downloaded on `,
        ),
      ),
    ]);
    vi.mocked(fetch).mockClear();
    const offline = await compileStory({ formatUrls: [FORK_URL], noRemote: true });
    expect(titleOf(offline)).toBe('FORK');
    expect(offline.diagnostics).toEqual([]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('keep each URL’s copy apart from every other URL’s', async () => {
    const OTHER_URL = 'https://example.test/other-fork/format.js';
    stubFetch({ [FORK_URL]: taggedSugarCube('FORK'), [OTHER_URL]: taggedSugarCube('OTHER') });
    expect(titleOf(await compileStory({ formatUrls: [FORK_URL] }))).toBe('FORK');
    expect(titleOf(await compileStory({ formatUrls: [OTHER_URL] }))).toBe('OTHER');
    expect(titleOf(await compileStory({ formatUrls: [FORK_URL], noRemote: true }))).toBe('FORK');
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
    const pending = fetchDirectFormat(FORK_URL, { signal: controller.signal });
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
    const pending = resolveRemoteFormat('SugarCube', '2.0.0', [], [FORK_URL], { signal: controller.signal });
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
    const pending = resolveRemoteFormat('SugarCube', '2.0.0', [], [FORK_URL], { timeout: 20 });
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
    await expect(resolveRemoteFormat('SugarCube', '2.0.0', [], [], { timeout: -1 })).rejects.toThrow(RangeError);
  });
});

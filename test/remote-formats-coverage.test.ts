import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearCachedFormats,
  clearIndexCache,
  discoverCachedFormats,
  fetchAndCacheFormat,
  fetchDirectFormat,
  fetchIndex,
  findEntry,
  getCacheDir,
  listCachedFormats,
  resolveFormatUrls,
  resolveRemoteFormatRequest,
} from '../src/remote-formats.js';
import type { SFAIndex, SFAIndexEntry } from '../src/types.js';

// Mode bits cannot make a file or folder unreadable to root, nor on Windows, where chmod only
// sets or clears the read-only attribute (which does not stop reading, listing or creating files
// in a folder). The tests that need an unreadable path cannot set one up there.
const cannotLockFiles = process.platform === 'win32' || process.getuid?.() === 0;

function formatJs(name: string, version: string): string {
  return `window.storyFormat(${JSON.stringify({ name, version, proofing: false, source: '<html>{{STORY_DATA}}</html>' })});`;
}

function entry(name: string, version: string, checksums: Record<string, string> = {}): SFAIndexEntry {
  return { name, version, proofing: false, files: ['format.js'], checksums };
}

/** Stubs `fetch` with a URL → body table; unknown URLs answer 404. Returns the requested URLs. */
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

let cacheHome = '';
let origCacheHome: string | undefined;
const lockedDirs: string[] = [];

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), 'twee-ts-remote-cov-'));
  origCacheHome = process.env['XDG_CACHE_HOME'];
  process.env['XDG_CACHE_HOME'] = cacheHome;
  clearIndexCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of lockedDirs.splice(0)) chmodSync(dir, 0o755);
  if (origCacheHome !== undefined) process.env['XDG_CACHE_HOME'] = origCacheHome;
  else delete process.env['XDG_CACHE_HOME'];
  rmSync(cacheHome, { recursive: true, force: true });
});

function cachePath(...segments: string[]): string {
  return join(getCacheDir(), ...segments);
}

function writeCached(name: string, version: string, content: string): void {
  mkdirSync(cachePath(name, version), { recursive: true });
  writeFileSync(cachePath(name, version, 'format.js'), content);
}

function lock(dir: string, mode = 0o000): void {
  chmodSync(dir, mode);
  lockedDirs.push(dir);
}

describe('fetching an index', () => {
  const url = 'https://example.test/index.json';

  it('keeps only well-formed entries and tolerates missing or non-array lists', async () => {
    const good = entry('Good', '1.0.0');
    stubFetch({
      [url]: JSON.stringify({
        twine2: [null, [], 'text', { name: 'NoVersion' }, { name: 'X', version: '1.0.0', checksums: [] }, good],
        twine1: 'not a list',
      }),
    });
    const index = await fetchIndex(url);
    expect(index.twine2).toEqual([good]);
    expect(index.twine1).toEqual([]);
  });

  it('treats an index without lists as empty', async () => {
    stubFetch({ [url]: '{}' });
    expect(await fetchIndex(url)).toEqual({ twine1: [], twine2: [] });
  });

  it.each(['null', '5'])('rejects an index that is not an object (%s)', async (body) => {
    stubFetch({ [url]: body });
    await expect(fetchIndex(url)).rejects.toThrow('SFA index is not an object');
  });

  it('answers a repeated request from memory', async () => {
    const calls = stubFetch({ [url]: JSON.stringify({ twine1: [], twine2: [] }) });
    await fetchIndex(url);
    await fetchIndex(url);
    expect(calls).toEqual([url]);
  });

  it('rejects a negative timeout', async () => {
    stubFetch({ [url]: '{}' });
    await expect(fetchIndex(url, { timeout: -1 })).rejects.toThrow(RangeError);
  });

  it('rejects at once with an already aborted signal', async () => {
    const calls = stubFetch({ [url]: '{}' });
    const reason = new Error('stop');
    await expect(fetchDirectFormat(url, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(calls).toEqual([]);
  });
});

describe('findEntry on a partial index', () => {
  it('searches whichever lists exist', () => {
    const twine2Only = { twine2: [entry('A', '1.0.0')] } as unknown as SFAIndex;
    const twine1Only = { twine1: [entry('B', '1.0.0')] } as unknown as SFAIndex;
    expect(findEntry(twine2Only, 'A', '1.0.0')?.formatType).toBe('twine2');
    expect(findEntry(twine1Only, 'B', '1.0.0')?.formatType).toBe('twine1');
  });
});

describe('downloading a format into the cache', () => {
  const downloadUrl = 'https://example.test/twine2/Mock/1.0.0/format.js';

  it('refuses a version that could leave the cache before downloading', async () => {
    const calls = stubFetch({});
    await expect(fetchAndCacheFormat(entry('Mock', '../escape'), downloadUrl)).rejects.toThrow('unsafe version');
    expect(calls).toEqual([]);
  });

  it('rejects an empty checksum value', async () => {
    stubFetch({ [downloadUrl]: formatJs('Mock', '1.0.0') });
    await expect(fetchAndCacheFormat(entry('Mock', '1.0.0', { 'format.js': '' }), downloadUrl)).rejects.toThrow(
      'Missing checksum value',
    );
  });

  it('downloads an entry that carries no checksums', async () => {
    stubFetch({ [downloadUrl]: formatJs('Mock', '1.0.0') });
    const noChecksums = { name: 'Mock', version: '1.0.0', proofing: false, files: [] } as unknown as SFAIndexEntry;
    const info = await fetchAndCacheFormat(noChecksums, downloadUrl);
    expect(info.name).toBe('Mock');
  });

  it('rejects a download that is not a format', async () => {
    stubFetch({ [downloadUrl]: 'this is not a story format' });
    await expect(fetchAndCacheFormat(entry('Mock', '1.0.0'), downloadUrl)).rejects.toThrow(
      'Failed to parse format JSON',
    );
  });

  it('refuses to write through a symlinked format.js', async () => {
    stubFetch({ [downloadUrl]: formatJs('Mock', '1.0.0') });
    mkdirSync(cachePath('Mock', '1.0.0'), { recursive: true });
    const target = join(cacheHome, 'elsewhere.js');
    writeFileSync(target, 'original');
    symlinkSync(target, cachePath('Mock', '1.0.0', 'format.js'));
    await expect(fetchAndCacheFormat(entry('Mock', '1.0.0'), downloadUrl)).rejects.toThrow('is a symlink');
  });

  it.skipIf(cannotLockFiles)('reports a cache directory that cannot be created', async () => {
    stubFetch({ [downloadUrl]: formatJs('Mock', '1.0.0') });
    mkdirSync(getCacheDir(), { recursive: true });
    lock(getCacheDir(), 0o555);
    await expect(fetchAndCacheFormat(entry('Mock', '1.0.0'), downloadUrl)).rejects.toThrow(/EACCES/);
  });
});

describe('cached copies of direct format URLs', () => {
  const url = 'https://example.test/direct/format.js';
  const urlCacheFile = (): string =>
    join(dirname(getCacheDir()), 'storyformat-urls', createHash('sha256').update(url).digest('hex'), 'format.js');

  it('ignores a cached copy that is not a format', async () => {
    mkdirSync(dirname(urlCacheFile()), { recursive: true });
    writeFileSync(urlCacheFile(), 'garbage');
    const found = await resolveFormatUrls({ kind: 'name', name: 'Mock', version: '1.0.0' }, [url], { offline: true });
    expect(found).toBeUndefined();
  });

  it('ignores a cached copy that cannot be read', async () => {
    mkdirSync(urlCacheFile(), { recursive: true });
    const found = await resolveFormatUrls({ kind: 'name', name: 'Mock', version: '1.0.0' }, [url], { offline: true });
    expect(found).toBeUndefined();
  });
});

describe('resolving through an index', () => {
  it('uses the shared cache entry the index points at, without downloading it again', async () => {
    const indexUrl = 'https://example.test/custom/index.json';
    writeCached('Mock', '2.1.0', formatJs('Mock', '2.1.0'));
    const calls = stubFetch({ [indexUrl]: JSON.stringify({ twine1: [], twine2: [entry('Mock', '2.1.0')] }) });
    const info = await resolveRemoteFormatRequest({ kind: 'id', id: 'mock-2' }, [indexUrl], []);
    expect(info?.version).toBe('2.1.0');
    expect(calls).toEqual([indexUrl]);
  });
});

describe('an unreadable or damaged cache', () => {
  it('skips cached entries that are not formats', () => {
    writeCached('Garbage', '1.0.0', 'nothing here');
    mkdirSync(cachePath('Dir', '1.0.0', 'format.js'), { recursive: true });
    writeCached('Good', '1.0.0', formatJs('Good', '1.0.0'));
    expect([...discoverCachedFormats().values()].map((f) => f.name)).toEqual(['Good']);
  });

  it('skips stray files and dangling links beside the format directories', () => {
    writeCached('Good', '1.0.0', formatJs('Good', '1.0.0'));
    writeFileSync(cachePath('stray.txt'), 'x');
    symlinkSync(join(cacheHome, 'missing'), cachePath('dangling'));
    expect([...discoverCachedFormats().values()].map((f) => f.name)).toEqual(['Good']);
    expect(listCachedFormats().map((e) => e.name)).toEqual(['Good']);
  });

  it('finds nothing when the cache location is a file', () => {
    mkdirSync(dirname(getCacheDir()), { recursive: true });
    writeFileSync(getCacheDir(), 'not a directory');
    expect(discoverCachedFormats().size).toBe(0);
    expect(listCachedFormats()).toEqual([]);
  });

  it.skipIf(cannotLockFiles)('skips a format directory that cannot be listed', () => {
    writeCached('Good', '1.0.0', formatJs('Good', '1.0.0'));
    writeCached('Locked', '1.0.0', formatJs('Locked', '1.0.0'));
    lock(cachePath('Locked'));
    expect([...discoverCachedFormats().values()].map((f) => f.name)).toEqual(['Good']);
    expect(listCachedFormats().map((e) => e.name)).toEqual(['Good']);
  });
});

describe('clearing the cache by name', () => {
  it('removes nothing when there is no cache', () => {
    expect(clearCachedFormats('Mock')).toBe(0);
  });

  it.skipIf(cannotLockFiles)('removes nothing from a directory that cannot be listed', () => {
    writeCached('Locked', '1.0.0', formatJs('Locked', '1.0.0'));
    lock(cachePath('Locked'));
    expect(clearCachedFormats('Locked')).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearCachedFormats,
  clearIndexCache,
  discoverCachedFormats,
  fetchAndCacheFormat,
  findCachedFormat,
  getCacheDir,
  listCachedFormats,
  resolveRemoteFormatRequest,
} from '../src/remote-formats.js';
import type { SFAIndexEntry } from '../src/types.js';

const version = '1.2.3';
const downloadUrl = 'https://example.test/format.js';
let root = '';
let oldCacheHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'twee-ts-portable-cache-'));
  oldCacheHome = process.env['XDG_CACHE_HOME'];
  process.env['XDG_CACHE_HOME'] = root;
  clearIndexCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (oldCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
  else process.env['XDG_CACHE_HOME'] = oldCacheHome;
  rmSync(root, { recursive: true, force: true });
});

function entry(name: string): SFAIndexEntry {
  return { name, version, proofing: false, files: ['format.js'], checksums: {} };
}

function format(name?: string): string {
  return `window.storyFormat(${JSON.stringify({ name, version, source: '<html>{{STORY_DATA}}</html>' })});`;
}

function serve(content: string): void {
  vi.stubGlobal('fetch', async () => new Response(content));
}

describe('portable indexed-cache directory names', () => {
  it.each(['Review #?', 'CON', 'aux.txt', 'Review.', 'Review ', '~legacy', 'COM¹', 'quote"name', 'colon:name'])(
    'writes %j using a Windows-safe filename and preserves a nameless format offline',
    async (name) => {
      serve(format());
      const online = await fetchAndCacheFormat(entry(name), downloadUrl);
      const directoryName = basename(dirname(dirname(online.filename)));
      // Windows rejects these characters, trailing punctuation, and device names.
      // Assert portability independently of the particular hashing algorithm.
      expect(directoryName).not.toMatch(/[<>:"/\\|?*\x00-\x1f]|[. ]$/);
      expect(directoryName).not.toMatch(/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i);
      expect(directoryName).not.toBe(name);
      expect(online.name).toBe(name);
      expect(JSON.parse(readFileSync(join(dirname(online.filename), 'identity.json'), 'utf8'))).toEqual({
        name,
        version,
      });

      vi.stubGlobal('fetch', async () => {
        throw new Error('offline');
      });
      expect([...discoverCachedFormats().values()].map((info) => info.name)).toEqual([name]);
      expect(listCachedFormats().map((info) => ({ name: info.name, version: info.version }))).toEqual([
        { name, version },
      ]);
      expect(findCachedFormat({ kind: 'name', name, version })?.name).toBe(name);
      const offline = await resolveRemoteFormatRequest({ kind: 'name', name, version }, [], []);
      expect(offline?.name).toBe(name);
      expect(offline?.filename).toBe(online.filename);
      expect(clearCachedFormats(name)).toBe(1);
      expect(readdirSync(getCacheDir())).toEqual([]);
    },
  );

  it('keeps an ordinary format in its existing cache directory without a sidecar', async () => {
    serve(format('SugarCube'));
    const info = await fetchAndCacheFormat(entry('SugarCube'), downloadUrl);
    expect(info.filename).toBe(join(getCacheDir(), 'SugarCube', version, 'format.js'));
    expect(readdirSync(dirname(info.filename))).toEqual(['format.js']);
  });

  it('keeps different names distinct even when they differ only in trailing punctuation', async () => {
    serve(format());
    const first = await fetchAndCacheFormat(entry('Review'), downloadUrl);
    const second = await fetchAndCacheFormat(entry('Review.'), downloadUrl);
    expect(second.filename).not.toBe(first.filename);
    expect(
      listCachedFormats()
        .map((info) => info.name)
        .sort(),
    ).toEqual(['Review', 'Review.']);
    expect(clearCachedFormats('Review.')).toBe(1);
    expect(findCachedFormat({ kind: 'name', name: 'Review', version })?.filename).toBe(first.filename);
  });

  it.each(['~old-cache', '~' + 'a'.repeat(64)])(
    'discovers and clears an old raw-prefix cache %j without identity metadata',
    (name) => {
      const dir = join(getCacheDir(), name, version);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'format.js'), format());
      expect(findCachedFormat({ kind: 'name', name, version })?.name).toBe(name);
      expect(listCachedFormats()[0]?.name).toBe(name);
      expect(clearCachedFormats(name)).toBe(1);
    },
  );

  it.each(['Review.', 'Review ', 'CON'])('clearing an uncached %j leaves existing formats intact', async (name) => {
    serve(format());
    await fetchAndCacheFormat(entry('Review'), downloadUrl);
    await fetchAndCacheFormat(entry('Other'), downloadUrl);
    expect(clearCachedFormats(name)).toBe(0);
    expect(
      listCachedFormats()
        .map((info) => info.name)
        .sort(),
    ).toEqual(['Other', 'Review']);
  });

  it('keeps lone surrogate names distinct when encoding them', async () => {
    serve(format());
    const names = ['~\uD800', '~\uD801'];
    const first = await fetchAndCacheFormat(entry(names[0]!), downloadUrl);
    const second = await fetchAndCacheFormat(entry(names[1]!), downloadUrl);
    expect(second.filename).not.toBe(first.filename);
    expect(
      listCachedFormats()
        .map((info) => info.name)
        .sort(),
    ).toEqual(names);
  });

  it('does not mistake another format’s encoded directory for a legacy prefix-named format', async () => {
    serve(format());
    const original = await fetchAndCacheFormat(entry('CON'), downloadUrl);
    const prefixName = basename(dirname(dirname(original.filename)));
    expect(clearCachedFormats(prefixName)).toBe(0);
    expect(findCachedFormat({ kind: 'name', name: 'CON', version })?.filename).toBe(original.filename);

    const prefixed = await fetchAndCacheFormat(entry(prefixName), downloadUrl);
    expect(prefixed.filename).not.toBe(original.filename);
    expect(clearCachedFormats(prefixName)).toBe(1);
    expect(findCachedFormat({ kind: 'name', name: 'CON', version })?.filename).toBe(original.filename);
  });

  it.each([
    'not JSON',
    'null',
    '[]',
    '42',
    JSON.stringify({ name: 42, version }),
    JSON.stringify({ version }),
    JSON.stringify({ name: 'Review #?' }),
    JSON.stringify({ name: 'Review #?', version: 123 }),
    JSON.stringify({ name: '../escape', version }),
    JSON.stringify({ name: 'Someone Else', version }),
    JSON.stringify({ name: 'Review #?', version: '9.0.0' }),
  ])('ignores an encoded entry with invalid identity metadata: %s', async (identity) => {
    serve(format());
    const info = await fetchAndCacheFormat(entry('Review #?'), downloadUrl);
    writeFileSync(join(dirname(info.filename), 'identity.json'), identity);
    expect(discoverCachedFormats().size).toBe(0);
    expect(listCachedFormats()).toEqual([]);
    expect(findCachedFormat({ kind: 'name', name: 'Review #?', version })).toBeUndefined();
  });

  it('ignores an encoded entry whose identity sidecar is a directory', async () => {
    serve(format());
    const info = await fetchAndCacheFormat(entry('Review #?'), downloadUrl);
    const sidecar = join(dirname(info.filename), 'identity.json');
    rmSync(sidecar);
    mkdirSync(sidecar);
    expect(discoverCachedFormats().size).toBe(0);
    expect(listCachedFormats()).toEqual([]);
    expect(findCachedFormat({ kind: 'name', name: 'Review #?', version })).toBeUndefined();
  });

  // Backslash is a literal filename character on POSIX; Windows cannot create
  // this legacy directory. A malformed cache must not become a trusted entry.
  it.skipIf(process.platform === 'win32')('preserves a legacy cache with an unsafe version directory', () => {
    const name = '~old-cache';
    const dir = join(getCacheDir(), name, '..\\escape');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'format.js'), format());
    expect(discoverCachedFormats().size).toBe(0);
    expect(listCachedFormats()).toEqual([]);
    expect(clearCachedFormats(name)).toBe(0);
    expect(readFileSync(join(dir, 'format.js'), 'utf8')).toBe(format());
  });

  it('refuses to overwrite an identity sidecar symlink', async () => {
    serve(format());
    const info = await fetchAndCacheFormat(entry('Review #?'), downloadUrl);
    const sidecar = join(dirname(info.filename), 'identity.json');
    const outside = join(root, 'outside.json');
    writeFileSync(outside, 'keep me');
    rmSync(sidecar);
    symlinkSync(outside, sidecar);
    await expect(fetchAndCacheFormat(entry('Review #?'), downloadUrl)).rejects.toThrow('is a symlink');
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    expect(discoverCachedFormats().size).toBe(0);
  });

  it('refuses to write an encoded cache through a symlinked name directory', async () => {
    serve(format());
    const info = await fetchAndCacheFormat(entry('CON'), downloadUrl);
    const nameDir = dirname(dirname(info.filename));
    const outside = join(root, 'outside');
    mkdirSync(outside);
    rmSync(nameDir, { recursive: true });
    symlinkSync(outside, nameDir, 'dir');

    await expect(fetchAndCacheFormat(entry('CON'), downloadUrl)).rejects.toThrow('not a plain directory');
    expect(readdirSync(outside)).toEqual([]);
    expect(clearCachedFormats('CON')).toBe(0);
  });
});

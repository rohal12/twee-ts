/**
 * The format cache heals itself and stays whole under concurrent writers: a verified download
 * restores a damaged content directory (#275), and one writer's cleanup never removes the content
 * another writer's record names or is still writing (#276).
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cacheKey,
  discoverCachedFormats,
  getCacheDir,
  loadEntry,
  readRecord,
  removeStaleContent,
  writeEntry,
} from '../src/format-cache.js';
import type { CacheOrigin, NewRecord } from '../src/format-cache.js';
import { formatJs, isolateFormatEnvironment } from './helpers/format-server.js';

isolateFormatEnvironment('format-cache-repair');

const URL_ORIGIN: CacheOrigin = { kind: 'url', url: 'http://127.0.0.1/format.js' };

function record(origin: CacheOrigin, main: string, name = 'Repair'): NewRecord {
  return {
    origin,
    name,
    version: '1.0.0',
    isTwine2: main === 'format.js',
    metadata: { proofing: false },
    main,
    fetchedAt: new Date().toISOString(),
    downloadUrl: origin.kind === 'url' ? origin.url : origin.index,
  };
}

const bytes = (text: string): Uint8Array => Buffer.from(text);
const twine2 = (marker: string): ReadonlyMap<string, Uint8Array> =>
  new Map([['format.js', bytes(formatJs('Repair', '1.0.0', marker))]]);
const twine1: ReadonlyMap<string, Uint8Array> = new Map([
  ['header.html', bytes('<html>"SUGARCANE" "STORY"</html>')],
  ['code.js', bytes('globalThis.codeRan = true;')],
]);

const keyDir = (origin: CacheOrigin): string => join(getCacheDir(), 'entries', cacheKey(origin));

function usable(origin: CacheOrigin): boolean {
  const saved = readRecord(origin);
  return saved !== undefined && 'record' in loadEntry(saved);
}

describe('saving a download over a damaged content directory (#275)', () => {
  const DAMAGE = {
    'a corrupted main file': (dir: string) => writeFileSync(join(dir, 'format.js'), 'corrupted'),
    'a missing main file': (dir: string) => rmSync(join(dir, 'format.js')),
    'a main file that became a folder': (dir: string) => {
      rmSync(join(dir, 'format.js'));
      mkdirSync(join(dir, 'format.js'));
    },
  };

  it.each(Object.entries(DAMAGE))('restores %s', (_name, damage) => {
    const files = twine2('R1');
    const path = writeEntry(record(URL_ORIGIN, 'format.js'), files);
    damage(join(path, '..'));
    expect(usable(URL_ORIGIN)).toBe(false);
    writeEntry(record(URL_ORIGIN, 'format.js'), files);
    expect(usable(URL_ORIGIN)).toBe(true);
    expect(discoverCachedFormats().size).toBe(1);
  });

  it.each(['header.html', 'code.js'])('restores a Twine 1 entry whose %s is damaged or gone', (file) => {
    const origin: CacheOrigin = {
      kind: 'index',
      index: 'http://127.0.0.1/index.json',
      twine: 'twine1',
      name: 'One',
      version: '1.0.0',
    };
    const path = writeEntry(record(origin, 'header.html', 'One'), twine1);
    const dir = join(path, '..');
    writeFileSync(join(dir, file), 'damaged');
    expect(usable(origin)).toBe(false);
    rmSync(join(dir, file));
    writeEntry(record(origin, 'header.html', 'One'), twine1);
    expect(usable(origin)).toBe(true);
  });

  it('leaves an intact entry as it is', () => {
    const files = twine2('R2');
    const path = writeEntry(record(URL_ORIGIN, 'format.js'), files);
    expect(writeEntry(record(URL_ORIGIN, 'format.js'), files)).toBe(path);
    expect(readdirSync(join(path, '..')).sort()).toEqual(['format.js']);
  });
});

describe('cleaning up the content of an origin while another writer publishes (#276)', () => {
  const HOUR = 60 * 60 * 1000;
  const contentDirs = (dir: string): string[] => readdirSync(dir).filter((name) => /^[0-9a-f]{64}$/.test(name));

  it('keeps the content the published record names, whichever writer cleans up last', () => {
    const dir = keyDir(URL_ORIGIN);
    writeEntry(record(URL_ORIGIN, 'format.js'), twine2('X'));
    const x = readRecord(URL_ORIGIN)?.dir;
    // A publishes and is paused; B publishes and cleans up; A resumes its cleanup of the content it replaced.
    writeEntry(record(URL_ORIGIN, 'format.js'), twine2('A'));
    writeEntry(record(URL_ORIGIN, 'format.js'), twine2('B'));
    removeStaleContent(dir, x, Date.now() + 24 * HOUR);
    expect(usable(URL_ORIGIN)).toBe(true);
    expect(contentDirs(dir)).toEqual([readRecord(URL_ORIGIN)?.dir]);
  });

  it('removes the content a new record replaced at once', () => {
    const dir = keyDir(URL_ORIGIN);
    writeEntry(record(URL_ORIGIN, 'format.js'), twine2('A'));
    writeEntry(record(URL_ORIGIN, 'format.js'), twine2('B'));
    expect(contentDirs(dir)).toHaveLength(1);
    expect(usable(URL_ORIGIN)).toBe(true);
  });

  it('keeps content that is still being written, and removes what is old and unnamed', () => {
    const dir = keyDir(URL_ORIGIN);
    writeEntry(record(URL_ORIGIN, 'format.js'), twine2('A'));
    const published = readRecord(URL_ORIGIN)?.dir ?? '';
    const inFlight = 'f'.repeat(64);
    const abandoned = 'e'.repeat(64);
    for (const name of [inFlight, abandoned]) mkdirSync(join(dir, name));
    const old = new Date(Date.now() - 24 * HOUR);
    utimesSync(join(dir, abandoned), old, old);
    removeStaleContent(dir, undefined);
    expect(contentDirs(dir).sort()).toEqual([published, inFlight].sort());
    expect(usable(URL_ORIGIN)).toBe(true);
  });

  it('leaves another origin’s entry alone', () => {
    const other: CacheOrigin = { kind: 'url', url: 'http://127.0.0.1/other.js' };
    writeEntry(record(URL_ORIGIN, 'format.js'), twine2('A'));
    writeEntry(record(other, 'format.js', 'Other'), twine2('O'));
    removeStaleContent(keyDir(URL_ORIGIN), undefined, Date.now() + 24 * HOUR);
    expect(usable(other)).toBe(true);
  });
});

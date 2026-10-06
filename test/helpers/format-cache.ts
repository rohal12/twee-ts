/**
 * Test helpers that put story format downloads in the cache directly, as an earlier download
 * would have, so a test can start from a known cache state without the network.
 */
import { writeEntry } from '../../src/format-cache.js';
import type { CacheOrigin } from '../../src/format-cache.js';

/** The Story Formats Archive's official index, which every build consults last. */
export const OFFICIAL_INDEX = 'https://videlais.github.io/story-formats-archive/official/index.json';

/**
 * Cache a Twine 2 format.js as downloaded from an index entry (by default the official
 * Story Formats Archive), and return the path of the cached file.
 */
export function seedIndexDownload(name: string, version: string, text: string, index = OFFICIAL_INDEX): string {
  return seed({ kind: 'index', index, twine: 'twine2', name, version }, name, version, text);
}

/** Cache a Twine 2 format.js as downloaded from a format URL, and return the path of the cached file. */
export function seedUrlDownload(url: string, name: string, version: string, text: string): string {
  return seed({ kind: 'url', url }, name, version, text);
}

/** Run `fn` with `XDG_CACHE_HOME` set to `cacheHome`, so the cache helpers write there. */
export function withCacheHome(cacheHome: string, fn: () => void): void {
  const previous = process.env['XDG_CACHE_HOME'];
  process.env['XDG_CACHE_HOME'] = cacheHome;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env['XDG_CACHE_HOME'];
    else process.env['XDG_CACHE_HOME'] = previous;
  }
}

function seed(origin: CacheOrigin, name: string, version: string, text: string): string {
  return writeEntry(
    {
      origin,
      name,
      version,
      isTwine2: true,
      metadata: { proofing: false },
      main: 'format.js',
      fetchedAt: new Date().toISOString(),
      downloadUrl: origin.kind === 'url' ? origin.url : origin.index,
    },
    new Map([['format.js', new TextEncoder().encode(text)]]),
  );
}

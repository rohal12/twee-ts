/**
 * Remote story format fetching, caching, and checksum verification.
 * Uses the Story Formats Archive (SFA) as the default source.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SFAIndex, SFAIndexEntry, StoryFormatInfo } from './types.js';
import { parseSemver, semverCompare, parseFormatJSON } from './formats.js';

const DEFAULT_SFA_INDICES = [
  'https://videlais.github.io/story-formats-archive/official/index.json',
  'https://videlais.github.io/story-formats-archive/unofficial/index.json',
];

/** Get the cache directory for downloaded story formats. */
export function getCacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const base = xdg || join(homedir(), '.cache');
  return join(base, 'twee-ts', 'storyformats');
}

/** In-memory index cache, keyed by URL. Cleared each compile. */
const indexCache = new Map<string, SFAIndex>();

/** Clear the in-memory index cache. */
export function clearIndexCache(): void {
  indexCache.clear();
}

/** Validate that a JSON value is a valid SFAIndexEntry. */
function isValidEntry(val: unknown): val is SFAIndexEntry {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    typeof obj.version === 'string' &&
    typeof obj.checksums === 'object' &&
    obj.checksums !== null &&
    !Array.isArray(obj.checksums)
  );
}

/** Validate that a JSON value conforms to the SFAIndex shape. */
function validateSFAIndex(json: unknown): SFAIndex {
  if (typeof json !== 'object' || json === null) {
    throw new Error('SFA index is not an object');
  }
  const obj = json as Record<string, unknown>;
  const twine1 = Array.isArray(obj['twine1']) ? (obj['twine1'] as unknown[]).filter(isValidEntry) : [];
  const twine2 = Array.isArray(obj['twine2']) ? (obj['twine2'] as unknown[]).filter(isValidEntry) : [];
  return { twine1, twine2 };
}

/** Generate a format ID from name and version. */
function makeFormatId(name: string, version: string): string {
  const major = parseSemver(version)?.[0] ?? '0';
  return `${name.toLowerCase().replace(/\s+/g, '-')}-${major}`;
}

/** Fetch and parse an SFA index.json, with in-memory caching. */
export async function fetchIndex(url: string): Promise<SFAIndex> {
  const cached = indexCache.get(url);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch format index from ${url}: ${res.status} ${res.statusText}`);
  }
  const data = validateSFAIndex(await res.json());
  indexCache.set(url, data);
  return data;
}

interface FindEntryResult {
  entry: SFAIndexEntry;
  formatType: 'twine1' | 'twine2';
}

/**
 * Find the best matching entry in an SFA index.
 * Exact version preferred, then highest version with same major.
 */
export function findEntry(index: SFAIndex, name: string, version: string): FindEntryResult | undefined {
  const wanted = parseSemver(version);

  const searchArrays: Array<{ entries: SFAIndexEntry[]; formatType: 'twine1' | 'twine2' }> = [
    { entries: index.twine2 ?? [], formatType: 'twine2' },
    { entries: index.twine1 ?? [], formatType: 'twine1' },
  ];

  let bestResult: FindEntryResult | undefined;
  let bestVersion: [number, number, number] | null = null;

  for (const { entries, formatType } of searchArrays) {
    for (const entry of entries) {
      if (entry.name.toLowerCase() !== name.toLowerCase()) continue;
      const have = parseSemver(entry.version);
      if (!have) continue;

      // Exact match — return immediately
      if (wanted && semverCompare(have, wanted) === 0) return { entry, formatType };

      // Same-major, highest version
      if (wanted === null || (have[0] === wanted[0] && semverCompare(have, wanted) >= 0)) {
        if (!bestVersion || semverCompare(have, bestVersion) > 0) {
          bestVersion = have;
          bestResult = { entry, formatType };
        }
      }
    }
  }

  return bestResult;
}

/** Verify SHA-256 checksum using Web Crypto API (Node 22 built-in). */
export async function verifySHA256(content: Uint8Array<ArrayBuffer>, expectedHex: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', content);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex === expectedHex.toLowerCase();
}

/** Derive the download URL for a format.js from the index URL and entry. */
function getDownloadUrl(indexUrl: string, entry: SFAIndexEntry, formatType: 'twine1' | 'twine2'): string {
  const base = indexUrl.replace(/\/index\.json$/, '');
  return `${base}/${formatType}/${entry.name}/${entry.version}/format.js`;
}

/** Download a format, verify its checksum, write to cache, and return StoryFormatInfo. */
export async function fetchAndCacheFormat(entry: SFAIndexEntry, downloadUrl: string): Promise<StoryFormatInfo> {
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`Failed to download format from ${downloadUrl}: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  // Verify checksum if available
  const checksumKey = Object.keys(entry.checksums ?? {}).find((k) => k.endsWith('format.js'));
  if (checksumKey) {
    const expected = entry.checksums[checksumKey];
    if (!expected) throw new Error(`Missing checksum value for key "${checksumKey}"`);
    const encoder = new TextEncoder();
    const valid = await verifySHA256(encoder.encode(text), expected);
    if (!valid) {
      throw new Error(`Checksum verification failed for ${entry.name} ${entry.version}`);
    }
  }

  // Parse format JSON to extract name/version/source
  const id = makeFormatId(entry.name, entry.version);
  const data = parseFormatJSON(text, id);
  if (!data) {
    throw new Error(`Failed to parse format JSON from ${downloadUrl}`);
  }

  // Write to cache
  const cacheDir = getCacheDir();
  const formatDir = join(cacheDir, entry.name, entry.version);
  mkdirSync(formatDir, { recursive: true });
  const formatPath = join(formatDir, 'format.js');
  writeFileSync(formatPath, text, 'utf-8');

  return {
    id,
    filename: formatPath,
    isTwine2: true,
    name: data.name,
    version: data.version,
    proofing: data.proofing ?? false,
  };
}

/** Download a direct format.js URL, parse its JSON, cache it, and return StoryFormatInfo. */
export async function fetchDirectFormat(url: string): Promise<StoryFormatInfo> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download format from ${url}: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  const tempId = 'direct-url';
  const data = parseFormatJSON(text, tempId);
  if (!data) {
    throw new Error(`Failed to parse format JSON from ${url}`);
  }

  const id = makeFormatId(data.name, data.version);

  // Write to cache
  const cacheDir = getCacheDir();
  const formatDir = join(cacheDir, data.name, data.version);
  mkdirSync(formatDir, { recursive: true });
  const formatPath = join(formatDir, 'format.js');
  writeFileSync(formatPath, text, 'utf-8');

  return {
    id,
    filename: formatPath,
    isTwine2: true,
    name: data.name,
    version: data.version,
    proofing: data.proofing ?? false,
  };
}

/**
 * Try to resolve a remote story format by name and version.
 * 1. Try direct format URLs
 * 2. Try custom index URLs
 * 3. Try default SFA indices
 */
export async function resolveRemoteFormat(
  name: string,
  version: string,
  indices?: string[],
  urls?: string[],
): Promise<StoryFormatInfo | undefined> {
  let lastError: Error | undefined;

  // 1. Try direct URLs — check if any match by name
  if (urls) {
    for (const url of urls) {
      try {
        const info = await fetchDirectFormat(url);
        if (info.name.toLowerCase() === name.toLowerCase()) {
          const wanted = parseSemver(version);
          const have = parseSemver(info.version);
          if (!wanted || (have && have[0] === wanted[0] && semverCompare(have, wanted) >= 0)) {
            return info;
          }
        }
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
  }

  // 2. Try custom indices, then default SFA indices
  const allIndices = [...(indices ?? []), ...DEFAULT_SFA_INDICES];
  for (const indexUrl of allIndices) {
    try {
      const index = await fetchIndex(indexUrl);
      const result = findEntry(index, name, version);
      if (result) {
        // Check cache first
        const cached = getCachedFormat(result.entry.name, result.entry.version);
        if (cached) return cached;

        const downloadUrl = getDownloadUrl(indexUrl, result.entry, result.formatType);
        return await fetchAndCacheFormat(result.entry, downloadUrl);
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  // If all sources failed with errors, propagate the last one
  if (lastError) throw lastError;
  return undefined;
}

/** Check if a format is already in the local cache. */
function getCachedFormat(name: string, version: string): StoryFormatInfo | undefined {
  const formatPath = join(getCacheDir(), name, version, 'format.js');
  try {
    if (!existsSync(formatPath)) return undefined;
    const source = readFileSync(formatPath, 'utf-8');
    const id = makeFormatId(name, version);
    const data = parseFormatJSON(source, id);
    if (!data) return undefined;
    return {
      id,
      filename: formatPath,
      isTwine2: true,
      name: data.name,
      version: data.version,
      proofing: data.proofing ?? false,
    };
  } catch {
    return undefined;
  }
}

/** Discover all cached remote formats. Returns a Map like discoverFormats(). */
export function discoverCachedFormats(): Map<string, StoryFormatInfo> {
  const formats = new Map<string, StoryFormatInfo>();
  const cacheDir = getCacheDir();

  try {
    if (!existsSync(cacheDir)) return formats;
  } catch {
    return formats;
  }

  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return formats;
  }

  for (const name of names) {
    const nameDir = join(cacheDir, name);
    try {
      if (!statSync(nameDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let versions: string[];
    try {
      versions = readdirSync(nameDir);
    } catch {
      continue;
    }

    for (const version of versions) {
      const info = getCachedFormat(name, version);
      if (info) {
        formats.set(`${info.id}-${version}`, info);
      }
    }
  }

  return formats;
}

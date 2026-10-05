/**
 * Remote story format fetching, caching, and checksum verification.
 * Uses the Story Formats Archive (SFA) as the default source.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { FormatRequest, SFAIndex, SFAIndexEntry, StoryFormatInfo } from './types.js';
import { parseSemver, parseFormatJSON, makeFormatId, selectFormatCandidate } from './formats.js';
import type { SelectFormatOptions } from './formats.js';
import { readUTF8 } from './util.js';

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

/**
 * Whether a string can serve as one directory name inside the cache: not empty, not `.` or `..`,
 * and free of path separators. Format names and versions come from downloaded metadata, so they
 * are untrusted path input.
 */
function isSafeSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..' && !/[/\\\0]/.test(segment);
}

/** Whether absolute path `target` lies strictly inside absolute path `root`. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

/** The cache directory for one format version. Throws when the name or version could leave the cache. */
function cachedFormatDir(name: string, version: string): string {
  if (!isSafeSegment(name)) {
    throw new Error(`Refusing to cache a story format with an unsafe name: ${JSON.stringify(name)}`);
  }
  if (!isSafeSegment(version) || !parseSemver(version)) {
    throw new Error(`Refusing to cache story format "${name}" with an unsafe version: ${JSON.stringify(version)}`);
  }
  const root = resolve(getCacheDir());
  const dir = resolve(root, name, version);
  if (!isInside(root, dir)) {
    throw new Error(`Refusing to cache a story format outside the cache directory ${root}: ${dir}`);
  }
  return dir;
}

/** Create `dir` as a plain directory, or check that it already is one (a symlink could lead out of the cache). */
function ensurePlainDirectory(dir: string): void {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) {
    mkdirSync(dir);
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to write a story format outside the cache directory: ${dir} is not a plain directory`);
  }
}

/** Write a downloaded format.js to `<cache>/<name>/<version>/format.js` and return its path. */
function writeCachedFormat(name: string, version: string, text: string): string {
  const dir = cachedFormatDir(name, version);
  const root = resolve(getCacheDir());
  mkdirSync(root, { recursive: true });
  ensurePlainDirectory(join(root, name));
  ensurePlainDirectory(dir);

  const formatPath = join(dir, 'format.js');
  if (lstatSync(formatPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing to write a story format outside the cache directory: ${formatPath} is a symlink`);
  }
  writeFileSync(formatPath, text, 'utf-8');
  return formatPath;
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
  return findEntryForRequest(index, { kind: 'name', name, version });
}

/** Find the best matching entry in an SFA index for a name or ID request (twine2 entries first). */
function findEntryForRequest(index: SFAIndex, request: FormatRequest): FindEntryResult | undefined {
  const candidates: FindEntryResult[] = [
    ...(index.twine2 ?? []).map((entry) => ({ entry, formatType: 'twine2' as const })),
    ...(index.twine1 ?? []).map((entry) => ({ entry, formatType: 'twine1' as const })),
  ];
  return selectFormatCandidate(request, candidates, (c) => c.entry);
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
  // Index metadata is untrusted: reject a name or version that would leave the cache before downloading.
  cachedFormatDir(entry.name, entry.version);

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

  const formatPath = writeCachedFormat(entry.name, entry.version, text);

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

  const data = parseFormatJSON(text);
  if (!data) {
    throw new Error(`Failed to parse format JSON from ${url}`);
  }

  const id = makeFormatId(data.name, data.version);
  const formatPath = writeCachedFormat(data.name, data.version, text);

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
 * 0. Use an exactly matching cached download, without touching the network
 * 1. Try direct format URLs
 * 2. Try custom index URLs
 * 3. Try default SFA indices
 * 4. Fall back to a compatible cached download (e.g. when offline)
 */
export async function resolveRemoteFormat(
  name: string,
  version: string,
  indices?: string[],
  urls?: string[],
): Promise<StoryFormatInfo | undefined> {
  return resolveRemoteFormatRequest({ kind: 'name', name, version }, indices, urls);
}

/**
 * Resolve a story format request remotely, in the same order as {@link resolveRemoteFormat}.
 * An ID request such as 'sugarcube-2' matches the format whose name and major version build that ID
 * (SugarCube 2.x), taking the greatest version available.
 */
export async function resolveRemoteFormatRequest(
  request: FormatRequest,
  indices?: string[],
  urls?: string[],
): Promise<StoryFormatInfo | undefined> {
  let lastError: Error | undefined;

  // 0. An exact version already downloaded needs no network access.
  const cached = findCachedFormat(request);
  if (cached && request.kind === 'name' && isExactVersion(cached.version, request.version)) return cached;

  // 1. Try direct URLs — use the first that answers the request
  for (const url of urls ?? []) {
    try {
      const info = await fetchDirectFormat(url);
      if (selectFormatCandidate(request, [info], (f) => f)) return info;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  // 2. Try custom indices, then default SFA indices
  const allIndices = [...(indices ?? []), ...DEFAULT_SFA_INDICES];
  for (const indexUrl of allIndices) {
    try {
      const index = await fetchIndex(indexUrl);
      const result = findEntryForRequest(index, request);
      if (result) {
        // Check cache first
        const hit = getCachedFormat(result.entry.name, result.entry.version);
        if (hit) return hit;

        const downloadUrl = getDownloadUrl(indexUrl, result.entry, result.formatType);
        return await fetchAndCacheFormat(result.entry, downloadUrl);
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  // 3. No source had it (or none could be reached): a compatible cached download still answers the request.
  if (cached) return cached;

  // If all sources failed with errors, propagate the last one
  if (lastError) throw lastError;
  return undefined;
}

/** Whether two version strings name the same SemVer version. */
function isExactVersion(have: string, wanted: string): boolean {
  const a = parseSemver(have);
  const b = parseSemver(wanted);
  return a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Find the cached download that best answers a format request, without network access.
 * Matching follows {@link selectFormatCandidate}.
 */
export function findCachedFormat(
  request: FormatRequest,
  options: SelectFormatOptions = {},
): StoryFormatInfo | undefined {
  return selectFormatCandidate(request, [...discoverCachedFormats().values()], (f) => f, options);
}

/** Check if a format is already in the local cache. */
function getCachedFormat(name: string, version: string): StoryFormatInfo | undefined {
  if (!isSafeSegment(name) || !isSafeSegment(version)) return undefined;
  const formatPath = join(getCacheDir(), name, version, 'format.js');
  try {
    if (!existsSync(formatPath)) return undefined;
    const source = readUTF8(formatPath);
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

/** Info about a cached format entry with size and modification date. */
export interface CachedFormatEntry {
  readonly name: string;
  readonly version: string;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
}

/** List all cached formats with size and modification date. */
export function listCachedFormats(): readonly CachedFormatEntry[] {
  const cacheDir = getCacheDir();
  const entries: CachedFormatEntry[] = [];

  try {
    if (!existsSync(cacheDir)) return entries;
  } catch {
    return entries;
  }

  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return entries;
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
      const formatPath = join(nameDir, version, 'format.js');
      try {
        const stat = statSync(formatPath);
        entries.push({
          name,
          version,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
        });
      } catch {
        // Skip entries without a valid format.js
      }
    }
  }

  return entries;
}

/**
 * Clear all cached formats, or only those matching a given name. Returns the number of entries removed.
 * A name must be a single cache entry name (as `listCachedFormats()` reports it); anything with a
 * path separator or `.`/`..` throws instead of deleting outside the format's own directory.
 */
export function clearCachedFormats(name?: string): number {
  if (name && !isSafeSegment(name)) {
    throw new Error(
      `Refusing to clear ${JSON.stringify(name)}: it is not a cached format name. Use a name as "cache list" shows it.`,
    );
  }

  const cacheDir = getCacheDir();
  if (!existsSync(cacheDir)) return 0;

  if (!name) {
    const entries = listCachedFormats();
    const count = entries.length;
    rmSync(cacheDir, { recursive: true, force: true });
    return count;
  }

  const root = resolve(cacheDir);
  const nameDir = resolve(root, name);
  if (!isInside(root, nameDir)) {
    throw new Error(`Refusing to clear ${JSON.stringify(name)}: it is not a cached format name.`);
  }
  // lstat, so a symlinked entry is never followed out of the cache: only plain directories are entries.
  if (!lstatSync(nameDir, { throwIfNoEntry: false })?.isDirectory()) return 0;

  let versions: string[];
  try {
    versions = readdirSync(nameDir);
  } catch {
    return 0;
  }
  const count = versions.length;
  rmSync(nameDir, { recursive: true, force: true });
  return count;
}

/** Get total cache size in bytes and format count. */
export function getCacheSize(): { totalBytes: number; count: number } {
  const entries = listCachedFormats();
  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  return { totalBytes, count: entries.length };
}

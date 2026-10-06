/**
 * Remote story format fetching, caching, and checksum verification.
 * Uses the Story Formats Archive (SFA) as the default source.
 *
 * Two caches hold downloads. Formats found through an index are shared by name and version
 * (`<cache>/<name>/<version>/format.js`). A format downloaded from a direct URL is kept under
 * that URL instead, so one project's copy never answers another project's request.
 * Cache files are replaced atomically, so another process never reads a partly written one.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readdirSync, statSync, rmSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type {
  FormatRequest,
  RemoteFetchOptions,
  SFAIndex,
  SFAIndexEntry,
  StoryFormatInfo,
  Twine2FormatJSON,
} from './types.js';
import { parseFormatJSON, UNNAMED_FORMAT_NAME } from './format-decode.js';
import { parseSemver, makeFormatId, selectFormatCandidate } from './formats.js';
import type { SelectFormatOptions } from './formats.js';
import { sameVersion } from './semver.js';
import { decodeText, readUTF8 } from './util.js';
import { writeFileAtomic } from './atomic-write.js';

const DEFAULT_SFA_INDICES = [
  'https://videlais.github.io/story-formats-archive/official/index.json',
  'https://videlais.github.io/story-formats-archive/unofficial/index.json',
];

/** How long one story format request (an index or a format.js) may take by default, in milliseconds. */
const DEFAULT_FORMAT_FETCH_TIMEOUT = 30_000;

/** The longest delay a timer accepts; a longer timeout means no limit. */
const MAX_TIMER_DELAY = 2_147_483_647;

/** Get the cache directory for downloaded story formats. */
export function getCacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  // An empty XDG_CACHE_HOME counts as unset, as the XDG Base Directory spec says.
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.cache');
  return join(base, 'twee-ts', 'storyformats');
}

/** The cache directory for formats downloaded from direct URLs, beside {@link getCacheDir}. */
function getUrlCacheDir(): string {
  return join(dirname(getCacheDir()), 'storyformat-urls');
}

/** The name of one direct URL's cache entry: a hash of the URL, so each URL has its own. */
function urlCacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
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

/** Whether `e` is a Node.js system error with the given code. */
function hasErrorCode(e: unknown, code: string): boolean {
  return e instanceof Error && 'code' in e && e.code === code;
}

/**
 * Create `dir` as a plain directory, or check that it already is one (a symlink could lead out of the cache).
 * A directory another process creates between the check and the mkdir is fine.
 */
function ensurePlainDirectory(dir: string): void {
  if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) {
    try {
      mkdirSync(dir);
      return;
    } catch (e) {
      if (!hasErrorCode(e, 'EEXIST')) throw e;
    }
  }
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to write a story format outside the cache directory: ${dir} is not a plain directory`);
  }
}

/**
 * Write a downloaded format.js to `<root>/<...segments>/format.js`, replacing any earlier copy
 * atomically, and return its path. Every directory below `root` must be a plain one.
 */
function writeCacheEntry(root: string, segments: readonly string[], text: string): string {
  mkdirSync(root, { recursive: true });
  const dir = segments.reduce((parent, segment) => {
    const child = join(parent, segment);
    ensurePlainDirectory(child);
    return child;
  }, root);

  const formatPath = join(dir, 'format.js');
  if (lstatSync(formatPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing to write a story format outside the cache directory: ${formatPath} is a symlink`);
  }
  writeFileAtomic(formatPath, text);
  return formatPath;
}

/** In-memory index cache, keyed by URL. Cleared each compile. */
const indexCache = new Map<string, SFAIndex>();

/** Clear the in-memory index cache. */
export function clearIndexCache(): void {
  indexCache.clear();
}

/** One network request with everyone in this process who waits on its result. */
interface SharedRequest<T> {
  readonly promise: Promise<T>;
  readonly controller: AbortController;
  waiters: number;
}

/** Requests in progress, by what they fetch, so concurrent compiles make each request once. */
const sharedRequests = new Map<string, SharedRequest<unknown>>();

/** How one caller waits on a shared request. */
interface WaitOptions {
  /** Stops this caller's wait at once, rejecting with the signal's reason. */
  readonly signal: AbortSignal | undefined;
  /** How long this caller waits, in milliseconds (0: no limit). */
  readonly timeout: number;
  /** The error this caller's wait ends with when its timeout passes. */
  readonly timedOut: () => Error;
}

/**
 * Runs `start` once for all callers that ask for `key` while it is in progress. Each caller waits
 * under its own limits: a caller whose `signal` aborts, or whose `timeout` passes, stops waiting
 * at once and rejects, while the others keep waiting. The request itself is aborted (through
 * the signal `start` receives) once no caller waits on it. `start` must not depend on any one
 * caller: what differs between callers belongs after the shared result.
 */
function shareRequest<T>(
  key: string,
  { signal, timeout, timedOut }: WaitOptions,
  start: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    return Promise.reject(reason);
  }
  const request = (sharedRequests.get(key) as SharedRequest<T> | undefined) ?? startSharedRequest(key, start);
  request.waiters++;

  return new Promise<T>((resolve, reject) => {
    let waiting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopWaiting = (): void => {
      if (!waiting) return;
      waiting = false;
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      request.waiters--;
    };
    const giveUp = (reason: unknown): void => {
      stopWaiting();
      if (request.waiters === 0) {
        if (sharedRequests.get(key) === request) sharedRequests.delete(key);
        request.controller.abort(reason);
      }
      reject(reason);
    };
    const onAbort = (): void => {
      giveUp(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeout > 0 && timeout <= MAX_TIMER_DELAY) {
      timer = setTimeout(() => {
        giveUp(timedOut());
      }, timeout);
    }
    request.promise.then(
      (value) => {
        stopWaiting();
        resolve(value);
      },
      (e: unknown) => {
        stopWaiting();
        reject(e);
      },
    );
  });
}

function startSharedRequest<T>(key: string, start: (signal: AbortSignal) => Promise<T>): SharedRequest<T> {
  const controller = new AbortController();
  const request: SharedRequest<T> = { promise: start(controller.signal), controller, waiters: 0 };
  sharedRequests.set(key, request);
  const forget = (): void => {
    if (sharedRequests.get(key) === request) sharedRequests.delete(key);
  };
  request.promise.then(forget, forget);
  return request;
}

/** The time limit for each request, from the caller's options. */
function requestTimeout(options: RemoteFetchOptions): number {
  const timeout = options.timeout ?? DEFAULT_FORMAT_FETCH_TIMEOUT;
  if (!(timeout >= 0)) {
    throw new RangeError(`A story format request timeout must be 0 or more milliseconds, not ${timeout}`);
  }
  return timeout;
}

/** How one caller waits for `url`: under its own signal and timeout. `what` names the request in errors. */
function waitOptions(options: RemoteFetchOptions, what: string, url: string): WaitOptions {
  const timeout = requestTimeout(options);
  return {
    signal: options.signal,
    timeout,
    timedOut: () => new Error(`Failed to ${what} from ${url}: timed out after ${timeout} ms`),
  };
}

/**
 * Fetch `url` as bytes, aborting when `signal` does. `what` names the request in errors, as in
 * "Failed to <what> from <url>". The bytes are returned undecoded, so checksums cover what was served.
 */
async function fetchBytes(url: string, what: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to ${what} from ${url}: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Download a format.js once for every caller in this process that asks for `url` meanwhile. */
function shareDownload(url: string, options: RemoteFetchOptions): Promise<Uint8Array<ArrayBuffer>> {
  return shareRequest(`download\0${url}`, waitOptions(options, 'download format', url), (signal) =>
    fetchBytes(url, 'download format', signal),
  );
}

/** Decode a downloaded format.js as local ones are (UTF-8, else Windows-1252), without a leading BOM. */
function decodeDownload(bytes: Uint8Array, url: string): string {
  const { text } = decodeText(bytes, url);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Validate that a JSON value is a valid SFAIndexEntry. */
function isValidEntry(val: unknown): val is SFAIndexEntry {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj['name'] === 'string' &&
    typeof obj['version'] === 'string' &&
    typeof obj['checksums'] === 'object' &&
    obj['checksums'] !== null &&
    !Array.isArray(obj['checksums'])
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

/** Fetch and parse an SFA index.json, with in-memory caching. Concurrent calls for one URL share a request. */
export async function fetchIndex(url: string, options: RemoteFetchOptions = {}): Promise<SFAIndex> {
  options.signal?.throwIfAborted();
  const cached = indexCache.get(url);
  if (cached) return cached;

  return shareRequest(`index\0${url}`, waitOptions(options, 'fetch format index', url), async (signal) => {
    const text = decodeDownload(await fetchBytes(url, 'fetch format index', signal), url);
    const data = validateSFAIndex(JSON.parse(text));
    indexCache.set(url, data);
    return data;
  });
}

interface FindEntryResult {
  entry: SFAIndexEntry;
  formatType: 'twine1' | 'twine2';
}

/**
 * Find the best matching entry in an SFA index.
 * Exact version preferred, then highest version with same major.
 */
export function findEntry(index: Partial<SFAIndex>, name: string, version: string): FindEntryResult | undefined {
  return findEntryForRequest(index, { kind: 'name', name, version });
}

/** Find the best matching entry in an SFA index for a name or ID request (twine2 entries first). */
function findEntryForRequest(index: Partial<SFAIndex>, request: FormatRequest): FindEntryResult | undefined {
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

/** The StoryFormatInfo of a Twine 2 format.js cached at `filename`. */
function cachedFormatInfo(
  id: string,
  filename: string,
  data: { readonly name: string; readonly version: string; readonly proofing?: boolean },
): StoryFormatInfo {
  return { id, filename, isTwine2: true, name: data.name, version: data.version, proofing: data.proofing ?? false };
}

/**
 * Check that a downloaded format is the one the index entry promised. The name matches without
 * regard to case, as format requests do, and the version by SemVer precedence, so "1.0" and "v1.0.0"
 * agree. A format.js that names no format ({@link UNNAMED_FORMAT_NAME}) is allowed: such formats
 * exist, and the index entry then supplies the name it is cached under.
 */
function checkFormatIdentity(
  entry: Pick<SFAIndexEntry, 'name' | 'version'>,
  data: Twine2FormatJSON,
  downloadUrl: string,
): void {
  const nameMatches = data.name === UNNAMED_FORMAT_NAME || data.name.toLowerCase() === entry.name.toLowerCase();
  if (nameMatches && sameVersion(data.version, entry.version)) return;
  throw new Error(
    `Story format mismatch for ${downloadUrl}: the index lists ${entry.name} ${entry.version}, ` +
      `but the download is ${data.name} ${data.version}`,
  );
}

/**
 * Download a format, verify its checksum, check that it is the format the entry names, write it to
 * the cache shared by name and version, and return its StoryFormatInfo. Concurrent calls for one
 * download URL share one request for the bytes; each call then verifies them against its own
 * entry, within its own timeout.
 */
export async function fetchAndCacheFormat(
  // The parts of an index entry a download uses; an entry without checksums is downloaded unchecked.
  entry: Pick<SFAIndexEntry, 'name' | 'version'> & {
    readonly checksums?: Readonly<Record<string, string>> | undefined;
  },
  downloadUrl: string,
  options: RemoteFetchOptions = {},
): Promise<StoryFormatInfo> {
  // Index metadata is untrusted: reject a name or version that would leave the cache before downloading.
  cachedFormatDir(entry.name, entry.version);
  const bytes = await shareDownload(downloadUrl, options);

  // Verify the checksum against the bytes as served, if the entry has one.
  const checksums = entry.checksums ?? {};
  const checksumKey = Object.keys(checksums).find((k) => k.endsWith('format.js'));
  if (checksumKey) {
    const expected = checksums[checksumKey];
    if (!expected) throw new Error(`Missing checksum value for key "${checksumKey}"`);
    if (!(await verifySHA256(bytes, expected))) {
      throw new Error(`Checksum verification failed for ${entry.name} ${entry.version}`);
    }
  }

  // Parse format JSON to extract name/version/source
  const text = decodeDownload(bytes, downloadUrl);
  const id = makeFormatId(entry.name, entry.version);
  const data = parseFormatJSON(text, id);
  if (!data) {
    throw new Error(`Failed to parse format JSON from ${downloadUrl}`);
  }
  checkFormatIdentity(entry, data, downloadUrl);

  // This caller gave up meanwhile: leave the cache as it was.
  options.signal?.throwIfAborted();
  const formatPath = writeCacheEntry(resolve(getCacheDir()), [entry.name, entry.version], text);
  return cachedFormatInfo(id, formatPath, data);
}

/**
 * Download a direct format.js URL, parse its JSON, cache it under that URL (apart from the
 * downloads shared by name and version), and return its StoryFormatInfo. Concurrent calls for
 * one URL share one request.
 */
export async function fetchDirectFormat(url: string, options: RemoteFetchOptions = {}): Promise<StoryFormatInfo> {
  const bytes = await shareDownload(url, options);
  const text = decodeDownload(bytes, url);

  const data = parseFormatJSON(text);
  if (!data) {
    throw new Error(`Failed to parse format JSON from ${url}`);
  }
  // The metadata is untrusted: refuse what could not be cached by name and version either.
  cachedFormatDir(data.name, data.version);

  // This caller gave up meanwhile: leave the cache as it was.
  options.signal?.throwIfAborted();
  const formatPath = writeCacheEntry(getUrlCacheDir(), [urlCacheKey(url)], text);
  return cachedFormatInfo(makeFormatId(data.name, data.version), formatPath, data);
}

/** The copy of a direct format URL in the download cache, if it has been downloaded before. */
function getCachedDirectFormat(url: string): StoryFormatInfo | undefined {
  const formatPath = join(getUrlCacheDir(), urlCacheKey(url), 'format.js');
  try {
    if (!existsSync(formatPath)) return undefined;
    const data = parseFormatJSON(readUTF8(formatPath));
    if (!data) return undefined;
    return cachedFormatInfo(makeFormatId(data.name, data.version), formatPath, data);
  } catch {
    return undefined;
  }
}

/** Options for {@link resolveFormatUrls}. */
export interface ResolveFormatUrlsOptions extends RemoteFetchOptions {
  /** Use only the URLs downloaded before; fetch nothing. */
  readonly offline?: boolean;
}

/**
 * Look a request up among direct format URLs, in order, and return the first format that
 * answers it. A URL downloaded before is answered by its cached copy without the network;
 * any other is downloaded (unless `offline`). When none answers and a download failed, the
 * last failure is thrown. An aborted signal rejects with its reason and tries no further URL.
 *
 * Internal, for format resolution; not part of the public API.
 */
export async function resolveFormatUrls(
  request: FormatRequest,
  urls: readonly string[],
  options: ResolveFormatUrlsOptions = {},
): Promise<StoryFormatInfo | undefined> {
  let lastError: Error | undefined;
  for (const url of urls) {
    const cached = getCachedDirectFormat(url);
    if (cached) {
      if (answers(request, cached)) return cached;
      continue;
    }
    if (options.offline) continue;
    try {
      const info = await fetchDirectFormat(url, options);
      if (answers(request, info)) return info;
    } catch (e) {
      if (options.signal?.aborted) throw options.signal.reason;
      lastError = toError(e);
    }
  }
  if (lastError) throw lastError;
  return undefined;
}

/**
 * Find the best format among the cached copies of direct format URLs, without network access.
 * Matching follows {@link selectFormatCandidate}, so `allowOlder` admits a same-major older version.
 * Each URL keeps its own copy; the shared name and version downloads are never consulted.
 *
 * Internal, for format resolution; not part of the public API.
 */
export function findCachedUrlFormat(
  request: FormatRequest,
  urls: readonly string[],
  options: SelectFormatOptions = {},
): StoryFormatInfo | undefined {
  const cached = urls.flatMap((url) => getCachedDirectFormat(url) ?? []);
  return selectFormatCandidate(request, cached, (f) => f, options);
}

/** Whether `info` is a format the request accepts. */
function answers(request: FormatRequest, info: StoryFormatInfo): boolean {
  return selectFormatCandidate(request, [info], (f) => f) !== undefined;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Try to resolve a remote story format by name and version.
 * 1. Try direct format URLs (each one's cached copy, else a download)
 * 2. Use an exactly matching download from the shared cache, without touching the network
 * 3. Try custom index URLs, then the default SFA indices
 * 4. Fall back to a compatible download from the shared cache (e.g. when offline)
 *
 * `options.signal` aborts the lookup, which then rejects with the signal's reason;
 * `options.timeout` limits each request (default 30000 ms).
 */
export async function resolveRemoteFormat(
  name: string,
  version: string,
  indices?: readonly string[],
  urls?: readonly string[],
  options: RemoteFetchOptions = {},
): Promise<StoryFormatInfo | undefined> {
  return resolveRemoteFormatRequest({ kind: 'name', name, version }, indices, urls, options);
}

/**
 * Resolve a story format request remotely, in the same order as {@link resolveRemoteFormat}.
 * An ID request such as 'sugarcube-2' matches the format whose name and major version build that ID
 * (SugarCube 2.x), taking the greatest version available.
 */
export async function resolveRemoteFormatRequest(
  request: FormatRequest,
  indices?: readonly string[],
  urls?: readonly string[],
  options: RemoteFetchOptions = {},
): Promise<StoryFormatInfo | undefined> {
  options.signal?.throwIfAborted();
  let lastError: Error | undefined;

  // 1. The caller's own format URLs come before anything shared by name and version.
  try {
    const direct = await resolveFormatUrls(request, urls ?? [], options);
    if (direct) return direct;
  } catch (e) {
    if (options.signal?.aborted) throw options.signal.reason;
    lastError = toError(e);
  }

  // 2. An exact version already downloaded needs no network access.
  const cached = findCachedFormat(request);
  if (cached && request.kind === 'name' && sameVersion(cached.version, request.version)) return cached;

  // 3. Try custom indices, then default SFA indices
  const allIndices = [...(indices ?? []), ...DEFAULT_SFA_INDICES];
  for (const indexUrl of allIndices) {
    try {
      const index = await fetchIndex(indexUrl, options);
      const result = findEntryForRequest(index, request);
      if (result) {
        // Check cache first
        const hit = getCachedFormat(result.entry.name, result.entry.version);
        if (hit) return hit;

        const downloadUrl = getDownloadUrl(indexUrl, result.entry, result.formatType);
        return await fetchAndCacheFormat(result.entry, downloadUrl, options);
      }
    } catch (e) {
      if (options.signal?.aborted) throw options.signal.reason;
      lastError = toError(e);
    }
  }

  // 4. No source had it (or none could be reached): a compatible cached download still answers the request.
  if (cached) return cached;

  // If all sources failed with errors, propagate the last one
  if (lastError) throw lastError;
  return undefined;
}

/**
 * Find the cached download that best answers a format request, without network access.
 * Only the downloads shared by name and version are searched, not those from direct URLs.
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
    return cachedFormatInfo(id, formatPath, data);
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
 * Clearing all also removes the downloads from direct format URLs; a name clears only the
 * downloads shared by name and version.
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

  if (!name) {
    const count = listCachedFormats().length + countUrlCacheEntries();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(getUrlCacheDir(), { recursive: true, force: true });
    return count;
  }

  if (!existsSync(cacheDir)) return 0;

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

/** The number of direct format URLs with a download in the cache. */
function countUrlCacheEntries(): number {
  const dir = getUrlCacheDir();
  try {
    return readdirSync(dir).filter((key) => existsSync(join(dir, key, 'format.js'))).length;
  } catch {
    return 0;
  }
}

/** Get total cache size in bytes and format count. */
export function getCacheSize(): { totalBytes: number; count: number } {
  const entries = listCachedFormats();
  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  return { totalBytes, count: entries.length };
}

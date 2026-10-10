/**
 * Story formats from the network: format URLs and format indices (the Story Formats Archive by
 * default), with request sharing, time and size limits, checksum and identity checks, and the
 * provenance-keyed cache in format-cache.ts.
 *
 * Every URL is parsed once, at the boundary, with the WHATWG URL parser ({@link checkRemoteUrl}),
 * and every URL derived from it is resolved with `new URL(relative, base)`.
 */
import type { RemoteFetchOptions, StoryFormatInfo } from './types.js';
import { decodeFormatJSON, UNNAMED_FORMAT_NAME } from './format-decode.js';
import { errorText, formatNameKey, withFormatBytes } from './formats.js';
import { parseVersion, sameVersion } from './semver.js';
import { decodeText } from './util.js';
import type { DecodeIssue, Decoder, JsonPath, JsonValue } from './json-decode.js';
import {
  field,
  formatJsonPath,
  jsonArrayOf,
  jsonBoolean,
  jsonRecordOf,
  jsonString,
  JsonObject,
  parseJSON,
  readObject,
} from './json-decode.js';
import type { CacheOrigin, CacheRecord, FormatMetadata, NewRecord, TwineKind } from './format-cache.js';
import { getCacheDir, loadEntry, readRecord, recordFormatInfo, sha256Hex, writeEntry } from './format-cache.js';

export {
  getCacheDir,
  discoverCachedFormats,
  listCachedFormats,
  clearCachedFormats,
  getCacheSize,
} from './format-cache.js';

/** The Story Formats Archive indices, consulted after a project's own format indices. */
export const DEFAULT_SFA_INDICES: readonly string[] = [
  'https://videlais.github.io/story-formats-archive/official/index.json',
  'https://videlais.github.io/story-formats-archive/unofficial/index.json',
];

/** How long one story format request (an index or a format file) may take by default, in milliseconds. */
const DEFAULT_FORMAT_FETCH_TIMEOUT = 30_000;

/**
 * How long the search for one story format may take in all by default, in milliseconds: four
 * requests at their default limit. A search asks each format URL and index in turn, so without an
 * overall limit a few hung servers would hold a build for minutes; with it, a build that cannot
 * reach the network ends within two minutes, answering from the download cache where it can.
 */
const DEFAULT_FORMAT_RESOLUTION_TIMEOUT = 120_000;

/** The longest delay a timer accepts; a longer timeout means no limit. */
export const MAX_TIMER_DELAY = 2_147_483_647;

/** The largest response accepted for an index or a format file, in bytes (32 MiB). */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

// --- URLs ---

/** The URL schemes twee-ts fetches from. */
const FETCHABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Redirects followed for one download before giving up (as browsers and curl do, a bounded chain). */
const MAX_REDIRECTS = 20;

/** A configured URL, parsed: its normalized form, or why it cannot be used. */
export type UrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/**
 * Parse a configured format URL or format index URL. Only absolute `http:` and `https:` URLs
 * without credentials are accepted; a local file belongs in a folder listed in `formatPaths`. The
 * fragment is dropped (it is never sent); the query is kept.
 */
export function checkRemoteUrl(text: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return {
      ok: false,
      reason: `${JSON.stringify(text)} is not an absolute URL (for a local format, use formatPaths)`,
    };
  }
  if (url.protocol === 'file:') {
    return {
      ok: false,
      reason: `${JSON.stringify(text)}: file: URLs are not supported; put the format in a folder listed in formatPaths`,
    };
  }
  if (!FETCHABLE_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `${JSON.stringify(text)}: only http: and https: URLs are supported` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: `${JSON.stringify(text)}: URLs with a user name or password are not supported` };
  }
  url.hash = '';
  return { ok: true, url: url.href };
}

/**
 * The URL of one file of an index entry: `<twine1|twine2>/<name>/<version>/<file>`, each segment
 * percent-encoded, resolved against the URL the index was finally served from (after redirects).
 * As with any relative reference, the index URL's file name, query and fragment do not carry over.
 */
function indexFileUrl(indexResponseUrl: string, entry: IndexEntry, file: string): string {
  const path = [entry.twine, entry.name, entry.version, file].map(encodeURIComponent).join('/');
  return new URL(path, indexResponseUrl).href;
}

// --- Requests ---

/** One network request with everyone in this process who waits on its result. */
interface SharedRequest {
  readonly promise: Promise<Fetched>;
  readonly controller: AbortController;
  waiters: number;
}

/** Requests in progress, by what they fetch, so concurrent compiles make each request once. */
const sharedRequests = new Map<string, SharedRequest>();

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
function shareRequest(
  key: string,
  { signal, timeout, timedOut }: WaitOptions,
  start: (signal: AbortSignal) => Promise<Fetched>,
): Promise<Fetched> {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    return Promise.reject(reason);
  }
  const request = sharedRequests.get(key) ?? startSharedRequest(key, start);
  request.waiters++;

  return new Promise<Fetched>((resolve, reject) => {
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

function startSharedRequest(key: string, start: (signal: AbortSignal) => Promise<Fetched>): SharedRequest {
  const controller = new AbortController();
  const request: SharedRequest = { promise: start(controller.signal), controller, waiters: 0 };
  sharedRequests.set(key, request);
  const forget = (): void => {
    if (sharedRequests.get(key) === request) sharedRequests.delete(key);
  };
  request.promise.then(forget, forget);
  return request;
}

/** The time limit for each request, from the caller's options. Throws a RangeError for an invalid one. */
export function requestTimeout(options: RemoteFetchOptions): number {
  const timeout = options.timeout ?? DEFAULT_FORMAT_FETCH_TIMEOUT;
  if (!(timeout >= 0)) {
    throw new RangeError(`A story format request timeout must be 0 or more milliseconds, not ${timeout}`);
  }
  return timeout;
}

/**
 * The time limit for a whole format search, in milliseconds (0: none), from `value` (default
 * {@link DEFAULT_FORMAT_RESOLUTION_TIMEOUT}), which the caller has checked to be 0 or more.
 */
export function resolutionTimeout(value: number | undefined): number {
  return value ?? DEFAULT_FORMAT_RESOLUTION_TIMEOUT;
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

/** Validators of a cached copy, sent so that an unchanged resource is not downloaded again. */
interface Validators {
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
}

/** A response: its bytes (none for 304 Not Modified), the URL it came from after redirects, and its validators. */
interface Fetched extends Validators {
  readonly notModified: boolean;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly url: string;
}

/** A short description of why `fetch` failed: its message and the system error code underneath. */
function describeFetchError(e: unknown): string {
  const cause: unknown = e instanceof Error ? e.cause : undefined;
  if (!(cause instanceof Error)) return errorText(e);
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : cause.message;
  return `${errorText(e)} (${code})`;
}

/**
 * Read a response body, stopping as soon as it grows past {@link MAX_RESPONSE_BYTES}: undefined
 * then. A body that breaks off rejects with the stream's error.
 */
async function readLimited(res: Response): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (Number(res.headers.get('content-length') ?? '0') > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    // A fetch response body is a byte stream; the type says `any`.
    const value: unknown = result.value;
    if (!(value instanceof Uint8Array)) throw new TypeError('the response body is not a byte stream');
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Where undici keeps the dispatcher every `fetch` without its own uses; its class is the one to ask for another. */
const UNDICI_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

type FetchDispatcher = NonNullable<RequestInit['dispatcher']>;

/** A dispatcher for one download, and the call that frees its connections. */
interface RequestDispatcher {
  readonly dispatcher: FetchDispatcher;
  readonly release: () => void;
}

function isDispatcher(value: unknown): value is FetchDispatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispatch' in value &&
    typeof value.dispatch === 'function' &&
    'destroy' in value &&
    typeof value.destroy === 'function'
  );
}

/** The `fetch` of this process when the module loaded: a test or a host may replace the global one with a function that ignores a dispatcher. */
const nativeFetch = globalThis.fetch;

/**
 * The global dispatcher Node created, with its default options, for the request with which
 * {@link ensureGlobalDispatcher} made it; `undefined` while there is none (a dispatcher that was in
 * place before may be one the host installed, with options of its own).
 */
let nodeDefaultDispatcher: object | undefined;

/**
 * Makes undici create its global dispatcher, which it does with the first request of a process: a
 * request for a data: URL makes no connection. undici creates it during the call, before any other
 * code can run, so the dispatcher there right after the call is Node's own. `request` is exported
 * for tests.
 */
export async function ensureGlobalDispatcher(request: (url: string) => Promise<Response> = nativeFetch): Promise<void> {
  if (Reflect.get(globalThis, UNDICI_GLOBAL_DISPATCHER) !== undefined) return;
  const answer = request('data:,');
  const made: unknown = Reflect.get(globalThis, UNDICI_GLOBAL_DISPATCHER);
  if (typeof made === 'object' && made !== null) nodeDefaultDispatcher = made;
  await answer.then(
    (res) => res.body?.cancel(),
    () => undefined,
  );
}

/**
 * A dispatcher whose sockets `signal` destroys, so that a request that ends (at its limit, by a
 * caller's signal or by the resolution deadline) also ends its connection attempt. Aborting `fetch`
 * alone does not: undici leaves a connection attempt in progress to its own ten-second connect
 * timeout, and a host that drops packets holds the process open that long. undici passes these
 * options on to `net.connect()` and `tls.connect()`: `connect` for a direct connection,
 * `proxyTls` for the connection to a proxy, `requestTls` for TLS through its tunnel.
 *
 * Node exports no dispatcher class, so this builds one from the class of the global dispatcher, and
 * only when that is the one Node created with its default options for twee-ts's own first request:
 * a dispatcher built from another's class would lose the options the host gave it (its CA, its proxy
 * URLs). Where the global dispatcher was in place before, or was replaced since, the request runs
 * on it unchanged (`undefined`), and a connection attempt in progress ends at undici's own limit.
 */
async function requestDispatcher(signal: AbortSignal): Promise<RequestDispatcher | undefined> {
  await ensureGlobalDispatcher();
  const current = nodeDefaultDispatcher;
  if (current === undefined || Reflect.get(globalThis, UNDICI_GLOBAL_DISPATCHER) !== current) return undefined;
  const dispatcherClass: unknown = current.constructor;
  if (typeof dispatcherClass !== 'function') return undefined;
  let made: unknown;
  try {
    made = Reflect.construct(dispatcherClass, [{ connect: { signal }, proxyTls: { signal }, requestTls: { signal } }]);
  } catch {
    return undefined;
  }
  if (!isDispatcher(made)) return undefined;
  const dispatcher = made;
  return {
    dispatcher,
    release: () => {
      // The download is over (or aborted): its connections are of no further use, and an idle one
      // would hold the process open. Closing cannot fail in a way that matters to the caller.
      void Promise.resolve(dispatcher.destroy()).catch(() => undefined);
    },
  };
}

/**
 * Fetch `url`, aborting when `signal` does. `what` names the request in errors, as in "Failed to
 * <what> from <url>: <cause>". The bytes are returned undecoded, so checksums cover what was served.
 * A redirect must stay on http: or https:, and never go from https: to http:.
 */
async function fetchBytes(url: string, what: string, signal: AbortSignal, validators: Validators): Promise<Fetched> {
  const own = await requestDispatcher(signal);
  try {
    return await fetchBytesVia(url, what, signal, validators, own?.dispatcher);
  } finally {
    own?.release();
  }
}

async function fetchBytesVia(
  url: string,
  what: string,
  signal: AbortSignal,
  validators: Validators,
  dispatcher: FetchDispatcher | undefined,
): Promise<Fetched> {
  const fail = (reason: string, cause?: unknown): Error =>
    new Error(`Failed to ${what} from ${url}: ${reason}`, cause === undefined ? undefined : { cause });
  const headers = new Headers();
  if (validators.etag !== undefined) headers.set('if-none-match', validators.etag);
  if (validators.lastModified !== undefined) headers.set('if-modified-since', validators.lastModified);
  const init: RequestInit = { signal, headers, redirect: 'manual', ...(dispatcher && { dispatcher }) };
  let res: Response;
  let finalUrl = url;
  let sawHttps = new URL(url).protocol === 'https:';
  for (let hops = 0; ; hops++) {
    try {
      res = await fetch(finalUrl, init);
    } catch (e) {
      throw fail(describeFetchError(e), e);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location === null) break;
    await res.body?.cancel();
    if (hops >= MAX_REDIRECTS) throw fail(`more than ${MAX_REDIRECTS} redirects`);
    let next: URL;
    try {
      next = new URL(location, finalUrl);
    } catch (e) {
      throw fail(`redirected to ${location}, which is not a valid URL`, e);
    }
    if (!FETCHABLE_PROTOCOLS.has(next.protocol) || (sawHttps && next.protocol === 'http:')) {
      throw fail(
        `redirected to ${next.href}, which is not allowed (only http: and https:, never from https: to http:)`,
      );
    }
    sawHttps ||= next.protocol === 'https:';
    finalUrl = next.href;
  }
  const fromHeaders = {
    etag: res.headers.get('etag') ?? undefined,
    lastModified: res.headers.get('last-modified') ?? undefined,
  };
  if (res.status === 304 && (validators.etag !== undefined || validators.lastModified !== undefined)) {
    await res.body?.cancel();
    return { notModified: true, bytes: new Uint8Array(0), url: finalUrl, ...fromHeaders };
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw fail(`${res.status} ${res.statusText}`.trim());
  }
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    bytes = await readLimited(res);
  } catch (e) {
    throw fail(describeFetchError(e), e);
  }
  if (bytes === undefined) throw fail(`the response is larger than the limit of ${MAX_RESPONSE_BYTES} bytes`);
  return { notModified: false, bytes, url: finalUrl, ...fromHeaders };
}

/** Fetch `url` once for every caller in this process that asks for it (with the same validators) meanwhile. */
function sharedFetch(
  url: string,
  what: string,
  options: RemoteFetchOptions,
  validators: Validators = {},
): Promise<Fetched> {
  const key = JSON.stringify([what, url, validators.etag ?? null, validators.lastModified ?? null]);
  return shareRequest(key, waitOptions(options, what, url), (signal) => fetchBytes(url, what, signal, validators));
}

/** Decode downloaded text as local files are (UTF-8, else Windows-1252), without a leading BOM. */
function decodeDownload(bytes: Uint8Array, url: string): string {
  const { text } = decodeText(bytes, url);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// --- Format indices ---

/** One usable entry of a format index. */
export interface IndexEntry {
  readonly twine: TwineKind;
  readonly name: string;
  readonly version: string;
  readonly proofing: boolean;
  /** The entry's files, when it lists them. */
  readonly files: readonly string[] | undefined;
  /** SHA-256 checksums by exact file name, lower-case hex. */
  readonly checksums: ReadonlyMap<string, string>;
}

/** An index entry that cannot be used, and why. */
interface SkippedIndexEntry {
  readonly twine: TwineKind;
  /** The entry's position in its list, from 0. */
  readonly position: number;
  /** Its name, when it has one. */
  readonly name: string | undefined;
  readonly reason: string;
}

/** A format index as fetched and checked. */
export interface FormatIndex {
  /** The index URL as configured. */
  readonly url: string;
  /** The URL the index was finally served from, which its file URLs are resolved against. */
  readonly responseUrl: string;
  readonly entries: readonly IndexEntry[];
  readonly skipped: readonly SkippedIndexEntry[];
}

/** A SHA-256 digest in lower-case hex, as checksums are kept. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Reads any JSON value as it is, so each list element is checked on its own. */
const anyJson: Decoder<JsonValue> = (value) => ({ ok: true, value });

/** The string `name` member of a raw entry, for describing a skipped one. */
function rawName(raw: JsonValue): string | undefined {
  if (!(raw instanceof JsonObject)) return undefined;
  const member = raw.members.findLast((m) => m.key === 'name');
  return typeof member?.value === 'string' ? member.value : undefined;
}

/** What an index entry's members gave. */
interface EntryFields {
  name?: string;
  version?: string;
  proofing?: boolean;
  files?: readonly string[];
  checksums?: ReadonlyMap<string, string>;
}

/**
 * Check one index entry at `path`; a string is the reason it cannot be used. Members other than
 * these fields (`author`, `description`, …) are not used. A member of the wrong type, or a repeated
 * one, makes the entry unusable: an index states what a download must be, so nothing in it is guessed.
 */
function parseIndexEntry(twine: TwineKind, raw: JsonValue, path: JsonPath): IndexEntry | string {
  const issues: DecodeIssue[] = [];
  const read: EntryFields = {};
  readObject(raw, path, issues, {
    keys: 'exact',
    fields: {
      name: field(jsonString, (v) => (read.name = v)),
      version: field(jsonString, (v) => (read.version = v)),
      proofing: field(jsonBoolean, (v) => (read.proofing = v)),
      files: field(jsonArrayOf(jsonString), (v) => (read.files = v)),
      // A malformed digest only matters for a file twee-ts downloads; it is refused there.
      checksums: field(jsonRecordOf(jsonString), (v) => (read.checksums = v)),
    },
    unknown: () => undefined,
  });
  if (issues.length > 0) return issues.map((issue) => issue.message).join('; ');
  const at = formatJsonPath(path);
  const { name, version } = read;
  if (name === undefined) return `${at} has no "name"`;
  if (name === '' || name === '.' || name === '..') return `${at}.name ${JSON.stringify(name)} is not a usable name`;
  if (version === undefined) return `${at} has no "version"`;
  if (!parseVersion(version)) return `${at}.version ${JSON.stringify(version)} is not a SemVer version`;
  return {
    twine,
    name,
    version,
    proofing: read.proofing ?? false,
    files: read.files,
    checksums: new Map([...(read.checksums ?? [])].map(([file, sum]) => [file, sum.toLowerCase()] as const)),
  };
}

/**
 * Check an index.json (with src/json-decode.ts): an object whose optional `twine1` and `twine2`
 * members are lists of entries. Each entry needs a name and a SemVer version; `files` (a list of
 * names) and `checksums` (an object of strings) are optional. Entries that are not usable are kept
 * in `skipped` with the reason. Throws when the text is not JSON or not an index.
 */
export function parseFormatIndex(text: string, url: string, responseUrl: string): FormatIndex {
  const parsed = parseJSON(text);
  if (!parsed.ok) throw new Error(`it is not JSON: ${parsed.error.message}`);
  const lists = new Map<TwineKind, readonly JsonValue[]>();
  const issues: DecodeIssue[] = [];
  const isObject = readObject(parsed.value, [], issues, {
    keys: 'exact',
    fields: {
      twine1: field(jsonArrayOf(anyJson), (v) => lists.set('twine1', v)),
      twine2: field(jsonArrayOf(anyJson), (v) => lists.set('twine2', v)),
    },
    unknown: () => undefined,
  });
  if (!isObject) throw new Error('it is not a format index (an object with "twine1" and "twine2" lists)');
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('; '));
  const entries: IndexEntry[] = [];
  const skipped: SkippedIndexEntry[] = [];
  // Twine 2 entries first, so they come first among equals.
  for (const twine of ['twine2', 'twine1'] as const) {
    (lists.get(twine) ?? []).forEach((raw, position) => {
      const entry = parseIndexEntry(twine, raw, [twine, position]);
      if (typeof entry === 'string') skipped.push({ twine, position, name: rawName(raw), reason: entry });
      else entries.push(entry);
    });
  }
  return { url, responseUrl, entries, skipped };
}

/** Indices fetched during this compile, by URL. Cleared each compile. */
const indexCache = new Map<string, FormatIndex>();

/** Clear the in-memory index cache. */
export function clearIndexCache(): void {
  indexCache.clear();
}

/**
 * Fetch and check a format index ({@link parseFormatIndex}), at most once per compile. Concurrent
 * calls for one URL share a request. `url` must have passed {@link checkRemoteUrl}.
 */
export async function fetchIndex(url: string, options: RemoteFetchOptions = {}): Promise<FormatIndex> {
  options.signal?.throwIfAborted();
  requestTimeout(options);
  const cached = indexCache.get(url);
  if (cached) return cached;
  const fetched = await sharedFetch(url, 'fetch format index', options);
  try {
    const index = parseFormatIndex(decodeDownload(fetched.bytes, url), url, fetched.url);
    indexCache.set(url, index);
    return index;
  } catch (e) {
    throw new Error(`Failed to read format index ${url}: ${errorText(e)}`, { cause: e });
  }
}

// --- Obtaining formats ---

/** A format ready to use, and warnings about how it was obtained (an unverified file, a cache that could not be written). */
export interface Obtained {
  readonly info: StoryFormatInfo;
  readonly warnings: readonly string[];
}

/** The main file of an index entry: format.js for Twine 2, header.html for Twine 1. */
function mainFile(twine: TwineKind): string {
  return twine === 'twine2' ? 'format.js' : 'header.html';
}

/**
 * The files of an index entry that twee-ts downloads besides its main file: for Twine 1, the
 * format's own scripts that its header includes (`code.js`, `userlib.js`) when the entry lists them.
 */
function componentFiles(entry: IndexEntry): readonly string[] {
  return entry.twine === 'twine2' ? [] : ['code.js', 'userlib.js'].filter((file) => entry.files?.includes(file));
}

/** The cache origin of an index entry. */
function indexEntryOrigin(index: Pick<FormatIndex, 'url'>, entry: IndexEntry): CacheOrigin {
  return { kind: 'index', index: index.url, twine: entry.twine, name: entry.name, version: entry.version };
}

/** Save a download to the cache; when that fails, warn and keep it for this build only (at its URL). */
function saveDownload(
  record: NewRecord,
  files: ReadonlyMap<string, Uint8Array>,
  options: RemoteFetchOptions,
): { readonly path: string; readonly warnings: readonly string[] } {
  // This caller gave up meanwhile: leave the cache as it was.
  options.signal?.throwIfAborted();
  try {
    return { path: writeEntry(record, files), warnings: [] };
  } catch (e) {
    const reason = errorText(e);
    return {
      path: record.downloadUrl,
      warnings: [
        `Could not save ${record.name} ${record.version} from ${record.downloadUrl} to the format cache ` +
          `(${getCacheDir()}): ${reason}. It is used for this build only.`,
      ],
    };
  }
}

/** The info of a format with its bytes kept in memory (see {@link withFormatBytes}). */
function formatWithBytes(
  record: Pick<CacheRecord, 'name' | 'version' | 'isTwine2' | 'metadata' | 'main' | 'downloadUrl'>,
  path: string,
  files: ReadonlyMap<string, Uint8Array>,
): StoryFormatInfo {
  const bytes = files.get(record.main) ?? new Uint8Array(0);
  return withFormatBytes(recordFormatInfo(record, path), bytes, record.downloadUrl, files);
}

/**
 * A cached entry as a format, after checking its files against its record. Throws, naming the
 * entry and the reason, when the entry is damaged.
 */
export function useCachedRecord(record: CacheRecord): StoryFormatInfo {
  const loaded = loadEntry(record);
  if ('error' in loaded) {
    throw new Error(`The cached copy of ${record.name} ${record.version} cannot be used: ${loaded.error}`);
  }
  return formatWithBytes(record, loaded.path, loaded.files);
}

/** Whether a cached entry holds every file `files` names, with the checksums the index lists now. */
function cachedEntryMatches(record: CacheRecord, entry: IndexEntry, files: readonly string[]): boolean {
  return files.every((file) => {
    const have = record.files.get(file);
    const listed = entry.checksums.get(file);
    return have !== undefined && (listed === undefined || listed === have);
  });
}

/** Check that a downloaded format.js is the format the index entry names; nameless formats take the entry's name. */
function checkEntryIdentity(
  entry: IndexEntry,
  data: { readonly name: string; readonly version: string },
  url: string,
): void {
  const nameMatches = data.name === UNNAMED_FORMAT_NAME || formatNameKey(data.name) === formatNameKey(entry.name);
  if (nameMatches && sameVersion(data.version, entry.version)) return;
  throw new Error(
    `Story format mismatch for ${url}: the index lists ${entry.name} ${entry.version}, ` +
      `but the download is ${data.name} ${data.version}`,
  );
}

/** Read a downloaded format.js's metadata, or throw with the URL and the reason. */
function decodeDownloadedFormat(
  bytes: Uint8Array,
  url: string,
): { readonly name: string; readonly version: string } & FormatMetadata {
  const decoded = decodeFormatJSON(decodeDownload(bytes, url));
  if (!decoded.ok) throw new Error(`Failed to read the story format at ${url}: ${decoded.reason}`);
  const { data } = decoded;
  return { ...data, proofing: data.proofing === true };
}

/** The metadata fields of a decoded format, without its name and version. */
function metadataOf(data: FormatMetadata): FormatMetadata {
  return {
    proofing: data.proofing,
    author: data.author,
    description: data.description,
    image: data.image,
    url: data.url,
    license: data.license,
  };
}

/**
 * Obtain the format an index entry names: its cached copy when that is from the same index entry
 * and matches the checksums the index lists, else a download of its files, each checked against
 * the index's checksum, and (Twine 2) checked to be the format the entry names. The download is
 * then cached under the entry's origin.
 */
export async function obtainIndexEntry(
  index: FormatIndex,
  entry: IndexEntry,
  options: RemoteFetchOptions = {},
): Promise<Obtained> {
  const origin = indexEntryOrigin(index, entry);
  const main = mainFile(entry.twine);
  const files = [main, ...componentFiles(entry)];
  const warnings: string[] = [];
  const cached = readRecord(origin);
  if (cached && cachedEntryMatches(cached, entry, files)) {
    try {
      return { info: useCachedRecord(cached), warnings };
    } catch (e) {
      warnings.push(`${errorText(e)}; downloading it again.`);
    }
  }

  /** Download one of the entry's files and check it against the checksum the index lists. */
  const download = async (file: string): Promise<Uint8Array<ArrayBuffer>> => {
    const url = indexFileUrl(index.responseUrl, entry, file);
    const { bytes } = await sharedFetch(url, 'download format', options);
    const listed = entry.checksums.get(file);
    const actual = sha256Hex(bytes);
    if (listed === undefined) {
      warnings.push(`The format index ${index.url} lists no checksum for ${url}; it was used unverified.`);
    } else if (!SHA256_HEX.test(listed)) {
      throw new Error(
        `The format index ${index.url} lists ${JSON.stringify(listed)} as the checksum of ${url}, which is not a SHA-256 hex digest`,
      );
    } else if (listed !== actual) {
      throw new Error(
        `Checksum mismatch for ${url}: the format index ${index.url} lists SHA-256 ${listed}, but the download has ${actual}`,
      );
    }
    return bytes;
  };
  const mainBytes = await download(main);
  const downloaded = new Map([[main, mainBytes]]);
  for (const file of componentFiles(entry)) downloaded.set(file, await download(file));

  const mainUrl = indexFileUrl(index.responseUrl, entry, main);
  let identity: { readonly name: string; readonly version: string; readonly metadata: FormatMetadata };
  if (entry.twine === 'twine2') {
    const data = decodeDownloadedFormat(mainBytes, mainUrl);
    checkEntryIdentity(entry, data, mainUrl);
    // A format.js that names no format is known by the name its index entry gives it.
    const name = data.name === UNNAMED_FORMAT_NAME ? entry.name : data.name;
    identity = { name, version: data.version, metadata: metadataOf(data) };
  } else {
    identity = { name: entry.name, version: entry.version, metadata: { proofing: false } };
  }
  const record: NewRecord = {
    origin,
    ...identity,
    isTwine2: entry.twine === 'twine2',
    main,
    fetchedAt: new Date().toISOString(),
    downloadUrl: mainUrl,
  };
  const saved = saveDownload(record, downloaded, options);
  return { info: formatWithBytes(record, saved.path, downloaded), warnings: [...warnings, ...saved.warnings] };
}

/** The cached copy of a format URL, if it has one. `url` must have passed {@link checkRemoteUrl}. */
export function cachedUrlRecord(url: string): CacheRecord | undefined {
  return readRecord({ kind: 'url', url });
}

/**
 * Obtain the format at a format URL, online. A cached copy is checked again with a conditional
 * request (ETag or Last-Modified) and used when the server says it has not changed; otherwise the
 * new download replaces it. `url` must have passed {@link checkRemoteUrl}.
 */
export async function obtainUrlFormat(url: string, options: RemoteFetchOptions = {}): Promise<Obtained> {
  const cached = cachedUrlRecord(url);
  const intact = cached && 'record' in loadEntry(cached) ? cached : undefined;
  const fetched = await sharedFetch(url, 'download format', options, intact ?? {});
  if (fetched.notModified && intact) return { info: useCachedRecord(intact), warnings: [] };

  const data = decodeDownloadedFormat(fetched.bytes, url);
  const record: NewRecord = {
    origin: { kind: 'url', url },
    name: data.name,
    version: data.version,
    isTwine2: true,
    metadata: metadataOf(data),
    main: 'format.js',
    fetchedAt: new Date().toISOString(),
    downloadUrl: url,
    etag: fetched.etag,
    lastModified: fetched.lastModified,
  };
  const files = new Map([['format.js', fetched.bytes]]);
  const saved = saveDownload(record, files, options);
  return { info: formatWithBytes(record, saved.path, files), warnings: saved.warnings };
}

/**
 * Download a direct format.js URL (or confirm that its cached copy is current), cache it under
 * that URL, and return its StoryFormatInfo. Concurrent calls for one URL share one request.
 * Throws when the URL is not usable, the download fails, or the cache cannot be written.
 */
export async function fetchDirectFormat(url: string, options: RemoteFetchOptions = {}): Promise<StoryFormatInfo> {
  const checked = checkRemoteUrl(url);
  if (!checked.ok) throw new Error(`Cannot download a format from ${checked.reason}`);
  const { info, warnings } = await obtainUrlFormat(checked.url, options);
  if (warnings.length > 0) throw new Error(warnings.join(' '));
  return info;
}

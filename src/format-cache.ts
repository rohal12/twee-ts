/**
 * The story format download cache, keyed by provenance.
 *
 * Each download is one entry, named by a hash of where it came from (its origin): a format index
 * URL plus the index entry (Twine version, name and version as the index lists them), or a format
 * URL. A cache hit is therefore only ever for the same origin, so one project's index or URL never
 * answers another project's request, and directory names never depend on format names (no case,
 * reserved-name or path problems on any platform).
 *
 * Layout, below {@link getCacheDir}:
 *
 *     entries/<key>/record.json        what the entry is, where it came from, and its files' SHA-256
 *     entries/<key>/<content>/<file>   the files as downloaded; <content> is a hash of their hashes
 *
 * A content directory is written under a temporary name and renamed into place, and record.json is
 * replaced atomically after it, so a reader sees either the old entry or the new one. Every read
 * checks the files against the hashes in record.json; an entry that does not match is not used.
 * Directories from before this layout (`<name>/<version>/format.js`, and `storyformat-urls/`) are
 * ignored, and removed by {@link clearCachedFormats}.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { StoryFormatInfo } from './types.js';
import { errorText, formatInfoFromJSON, formatNameKey, makeFormatId } from './formats.js';

/** Which list of an index an entry comes from. */
export type TwineKind = 'twine1' | 'twine2';

/** Where a cached download came from. */
export type CacheOrigin =
  | {
      readonly kind: 'index';
      /** The format index URL, as configured (without a fragment). */
      readonly index: string;
      readonly twine: TwineKind;
      /** The entry's name and version, exactly as the index lists them. */
      readonly name: string;
      readonly version: string;
    }
  | { readonly kind: 'url'; readonly url: string };

/** Metadata a Twine 2 format.js may carry besides its name and version. */
export interface FormatMetadata {
  readonly proofing: boolean;
  readonly author?: string | undefined;
  readonly description?: string | undefined;
  readonly image?: string | undefined;
  readonly url?: string | undefined;
  readonly license?: string | undefined;
}

/** What a cache entry holds, as record.json stores it. */
export interface CacheRecord {
  /** The entry's directory name: a hash of its origin. */
  readonly key: string;
  readonly origin: CacheOrigin;
  /** The format's name and version (for a format.js that names no format, the index entry's name). */
  readonly name: string;
  readonly version: string;
  readonly isTwine2: boolean;
  readonly metadata: FormatMetadata;
  /** The file the format is read from: format.js (Twine 2) or header.html (Twine 1). */
  readonly main: string;
  /** Each file's lower-case hex SHA-256. */
  readonly files: ReadonlyMap<string, string>;
  /** The content directory name. */
  readonly dir: string;
  /** When the files were downloaded (ISO 8601). */
  readonly fetchedAt: string;
  /** The URL the main file was downloaded from. */
  readonly downloadUrl: string;
  /** Validators from the response, for a conditional request when a format URL is checked again. */
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
}

/** A cache entry that was read and checked: its record and its files' bytes. */
export interface LoadedEntry {
  readonly record: CacheRecord;
  readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  /** The path of the main file. */
  readonly path: string;
}

const RECORD_SCHEMA = 2;
const ENTRIES = 'entries';
const RECORD_FILE = 'record.json';
const TEMP_PREFIX = '.tmp-';
const HEX64 = /^[0-9a-f]{64}$/;

/** The files a cache entry may hold: those twee-ts reads from a format's folder. */
const CACHEABLE_FILES: ReadonlySet<string> = new Set(['format.js', 'header.html', 'code.js', 'userlib.js']);

/**
 * The cache base directory: `$XDG_CACHE_HOME`, else `~/.cache`. As the XDG Base Directory spec
 * says, an empty or relative `XDG_CACHE_HOME` is ignored, so the cache never moves with the
 * working directory.
 */
function cacheBase(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  return xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(homedir(), '.cache');
}

/** Get the cache directory for downloaded story formats. */
export function getCacheDir(): string {
  return join(cacheBase(), 'twee-ts', 'storyformats');
}

/** Where twee-ts 1.x kept downloads from format URLs; only removed now. */
function legacyUrlCacheDir(): string {
  return join(cacheBase(), 'twee-ts', 'storyformat-urls');
}

function entriesDir(): string {
  return join(resolve(getCacheDir()), ENTRIES);
}

/** The lower-case hex SHA-256 of some bytes or text. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The cache entry name of an origin. */
export function cacheKey(origin: CacheOrigin): string {
  switch (origin.kind) {
    case 'index':
      return sha256Hex(JSON.stringify(['index', origin.index, origin.twine, origin.name, origin.version]));
    case 'url':
      return sha256Hex(JSON.stringify(['url', origin.url]));
    default: {
      const _exhaustive: never = origin;
      throw new Error(`unhandled cache origin: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** The content directory name of a set of files: a hash of their names and hashes. */
function contentDirName(files: ReadonlyMap<string, string>): string {
  return sha256Hex(JSON.stringify([...files].map(([file, hash]) => `${file}:${hash}`).sort()));
}

// --- Reading record.json ---

function isRecordObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseOrigin(value: unknown): CacheOrigin | undefined {
  if (!isRecordObject(value)) return undefined;
  const kind = value['kind'];
  if (kind === 'url') {
    const url = value['url'];
    return typeof url === 'string' ? { kind, url } : undefined;
  }
  if (kind !== 'index') return undefined;
  const { index, twine, name, version } = value;
  if (typeof index !== 'string' || typeof name !== 'string' || typeof version !== 'string') return undefined;
  if (twine !== 'twine1' && twine !== 'twine2') return undefined;
  return { kind, index, twine, name, version };
}

function parseFiles(value: unknown): Map<string, string> | undefined {
  if (!isRecordObject(value)) return undefined;
  const files = new Map<string, string>();
  for (const [file, hash] of Object.entries(value)) {
    if (!CACHEABLE_FILES.has(file) || typeof hash !== 'string' || !HEX64.test(hash)) return undefined;
    files.set(file, hash);
  }
  return files;
}

function parseMetadata(value: unknown): FormatMetadata | undefined {
  if (!isRecordObject(value) || typeof value['proofing'] !== 'boolean') return undefined;
  return {
    proofing: value['proofing'],
    author: optionalString(value['author']),
    description: optionalString(value['description']),
    image: optionalString(value['image']),
    url: optionalString(value['url']),
    license: optionalString(value['license']),
  };
}

/** A record.json's content as a record, or undefined when it is not one written for `key`. */
function parseRecord(key: string, json: unknown): CacheRecord | undefined {
  if (!isRecordObject(json) || json['schema'] !== RECORD_SCHEMA) return undefined;
  const origin = parseOrigin(json['origin']);
  const files = parseFiles(json['files']);
  const metadata = parseMetadata(json['metadata']);
  const { name, version, isTwine2, main, dir, fetchedAt, downloadUrl } = json;
  if (!origin || !files || !metadata || cacheKey(origin) !== key) return undefined;
  if (typeof name !== 'string' || typeof version !== 'string' || typeof isTwine2 !== 'boolean') return undefined;
  if (typeof main !== 'string' || !files.has(main) || typeof dir !== 'string' || dir !== contentDirName(files)) {
    return undefined;
  }
  if (typeof fetchedAt !== 'string' || typeof downloadUrl !== 'string') return undefined;
  return {
    key,
    origin,
    name,
    version,
    isTwine2,
    metadata,
    main,
    files,
    dir,
    fetchedAt,
    downloadUrl,
    etag: optionalString(json['etag']),
    lastModified: optionalString(json['lastModified']),
  };
}

/** The record of the entry for `origin`, or undefined when there is none (or it is damaged). */
export function readRecord(origin: CacheOrigin): CacheRecord | undefined {
  return readRecordByKey(cacheKey(origin));
}

function readRecordByKey(key: string): CacheRecord | undefined {
  try {
    const keyDir = join(entriesDir(), key);
    // A symlinked entry could lead out of the cache: only plain directories are entries.
    if (!lstatSync(keyDir, { throwIfNoEntry: false })?.isDirectory()) return undefined;
    return parseRecord(key, JSON.parse(readFileSync(join(keyDir, RECORD_FILE), 'utf-8')));
  } catch {
    return undefined;
  }
}

/** Every readable cache entry's record, in a stable order (by key). */
export function listRecords(): CacheRecord[] {
  let keys: string[];
  try {
    keys = readdirSync(entriesDir()).filter((key) => HEX64.test(key));
  } catch {
    return [];
  }
  return keys.sort().flatMap((key) => readRecordByKey(key) ?? []);
}

/**
 * Read a cache entry's files and check each against its record. Returns the reason when the entry
 * cannot be used (a file is missing, unreadable, or not the bytes the record names).
 */
export function loadEntry(record: CacheRecord): LoadedEntry | { readonly error: string } {
  const contentDir = join(entriesDir(), record.key, record.dir);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [file, hash] of record.files) {
    const path = join(contentDir, file);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      if (!lstatSync(path).isFile()) return { error: `${path} is not a plain file` };
      bytes = new Uint8Array(readFileSync(path));
    } catch (e) {
      return { error: `could not read ${path}: ${errorText(e)}` };
    }
    const actual = sha256Hex(bytes);
    if (actual !== hash) return { error: `${path} has SHA-256 ${actual}, but was saved with ${hash}` };
    files.set(file, bytes);
  }
  return { record, files, path: join(contentDir, record.main) };
}

/** The StoryFormatInfo of a cache record whose main file is at `filename`. */
export function recordFormatInfo(
  record: Pick<CacheRecord, 'name' | 'version' | 'isTwine2' | 'metadata'>,
  filename: string,
): StoryFormatInfo {
  const id = makeFormatId(record.name, record.version);
  if (record.isTwine2) {
    return formatInfoFromJSON(id, filename, { name: record.name, version: record.version, ...record.metadata });
  }
  return { id, filename, isTwine2: false, name: record.name, version: record.version, proofing: false };
}

// --- Writing ---

/** Whether `e` is a Node.js system error with one of the given codes. */
function hasErrorCode(e: unknown, ...codes: readonly string[]): boolean {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' && codes.includes(e.code);
}

/**
 * Create `dir` as a plain directory, or check that it already is one (a symlink could lead out of
 * the cache). A directory another process creates between the check and the mkdir is fine.
 */
function ensurePlainDirectory(dir: string): void {
  try {
    mkdirSync(dir);
  } catch (e) {
    if (!hasErrorCode(e, 'EEXIST')) throw e;
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to write a story format outside the cache directory: ${dir} is not a plain directory`);
  }
}

/** Write `data` to `path` through a temporary file renamed into place. */
function writeAtomically(path: string, data: string | Uint8Array): void {
  const temp = join(dirname(path), `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temp, data, { flag: 'wx' });
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/** What {@link writeEntry} saves besides the files. */
export type NewRecord = Omit<CacheRecord, 'key' | 'files' | 'dir'>;

/**
 * Save a download as the cache entry of its origin, replacing any earlier one, and return the
 * path of its main file. Throws (with the cache path in the message) when the cache cannot be
 * written; the caller decides whether that fails anything.
 */
export function writeEntry(record: NewRecord, files: ReadonlyMap<string, Uint8Array>): string {
  const hashes = new Map([...files].map(([file, bytes]) => [file, sha256Hex(bytes)] as const));
  if (!hashes.has(record.main) || ![...hashes.keys()].every((file) => CACHEABLE_FILES.has(file))) {
    throw new Error(`A cache entry needs its main file ${record.main}, and only format files`);
  }
  const key = cacheKey(record.origin);
  const dir = contentDirName(hashes);
  const root = entriesDir();
  mkdirSync(root, { recursive: true });
  const keyDir = join(root, key);
  ensurePlainDirectory(keyDir);
  const contentDir = join(keyDir, dir);
  writeContentDir(keyDir, contentDir, files);

  const json = {
    schema: RECORD_SCHEMA,
    origin: record.origin,
    name: record.name,
    version: record.version,
    isTwine2: record.isTwine2,
    metadata: record.metadata,
    main: record.main,
    files: Object.fromEntries(hashes),
    dir,
    fetchedAt: record.fetchedAt,
    downloadUrl: record.downloadUrl,
    ...(record.etag === undefined ? {} : { etag: record.etag }),
    ...(record.lastModified === undefined ? {} : { lastModified: record.lastModified }),
  };
  writeAtomically(join(keyDir, RECORD_FILE), `${JSON.stringify(json, null, 2)}\n`);
  removeStaleContent(keyDir, dir);
  return join(contentDir, record.main);
}

/**
 * Write the files into `contentDir` (named by their hashes) unless it is already there: they go to
 * a temporary directory that is renamed into place, so the directory is complete or absent.
 */
function writeContentDir(keyDir: string, contentDir: string, files: ReadonlyMap<string, Uint8Array>): void {
  const existing = lstatSync(contentDir, { throwIfNoEntry: false });
  if (existing?.isDirectory()) return;
  if (existing) {
    throw new Error(`Refusing to write a story format outside the cache directory: ${contentDir} is not a directory`);
  }
  const temp = join(keyDir, `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    mkdirSync(temp);
    for (const [file, bytes] of files) writeFileSync(join(temp, file), bytes, { flag: 'wx' });
    renameSync(temp, contentDir);
  } catch (e) {
    rmSync(temp, { recursive: true, force: true });
    // Another process put the same content there meanwhile (the name is a hash of it).
    if (lstatSync(contentDir, { throwIfNoEntry: false })?.isDirectory()) return;
    throw e;
  }
}

/** Remove the content directories of an entry that its record no longer names (best effort). */
function removeStaleContent(keyDir: string, current: string): void {
  try {
    for (const name of readdirSync(keyDir)) {
      if (HEX64.test(name) && name !== current) rmSync(join(keyDir, name), { recursive: true, force: true });
    }
  } catch {
    // A directory left behind only takes space; the record decides what is read.
  }
}

// --- Listing and clearing ---

/** Info about a cached format entry with size and modification date. */
export interface CachedFormatEntry {
  /** The format's name and version. */
  readonly name: string;
  readonly version: string;
  /** Where it was downloaded from: a format index or a format URL. */
  readonly source: 'index' | 'url';
  /** The format index URL or the format URL. */
  readonly origin: string;
  readonly sizeBytes: number;
  /** When it was downloaded. */
  readonly modifiedAt: Date;
}

function entrySize(record: CacheRecord): number {
  const contentDir = join(entriesDir(), record.key, record.dir);
  return [...record.files.keys()].reduce((sum, file) => {
    try {
      return sum + statSync(join(contentDir, file)).size;
    } catch {
      return sum;
    }
  }, 0);
}

function originUrl(origin: CacheOrigin): string {
  return origin.kind === 'index' ? origin.index : origin.url;
}

/** List all cached formats (downloads from format indices and from format URLs), in a stable order. */
export function listCachedFormats(): readonly CachedFormatEntry[] {
  return listRecords().map((record) => ({
    name: record.name,
    version: record.version,
    source: record.origin.kind,
    origin: originUrl(record.origin),
    sizeBytes: entrySize(record),
    modifiedAt: new Date(record.fetchedAt),
  }));
}

/**
 * Every cached format whose files are intact, keyed by cache entry (so two downloads of the same
 * name and version from different origins are both listed).
 */
export function discoverCachedFormats(): Map<string, StoryFormatInfo> {
  const formats = new Map<string, StoryFormatInfo>();
  for (const record of listRecords()) {
    const loaded = loadEntry(record);
    if ('record' in loaded) formats.set(record.key, recordFormatInfo(record, loaded.path));
  }
  return formats;
}

/**
 * Clear all cached formats, or only those with a given name (matched as format names are, without
 * regard to letter case). Returns the number of cached formats removed. Clearing all also removes
 * the directories older twee-ts versions wrote.
 */
export function clearCachedFormats(name?: string): number {
  const records = listRecords();
  if (name === undefined || name === '') {
    rmSync(getCacheDir(), { recursive: true, force: true });
    rmSync(legacyUrlCacheDir(), { recursive: true, force: true });
    return records.length;
  }
  const matching = records.filter((record) => formatNameKey(record.name) === formatNameKey(name));
  for (const record of matching) rmSync(join(entriesDir(), record.key), { recursive: true, force: true });
  return matching.length;
}

/** Get total cache size in bytes and format count. */
export function getCacheSize(): { totalBytes: number; count: number } {
  const entries = listCachedFormats();
  return { totalBytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0), count: entries.length };
}

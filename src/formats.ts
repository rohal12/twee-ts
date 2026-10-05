/**
 * Story format discovery, loading, and SemVer matching.
 * Ported from formats.go + config.go.
 *
 * Every lookup (local folders here, the download cache and remote indices in remote-formats.ts)
 * goes through the same version parsing ({@link parseVersion}) and the same matching rules
 * ({@link selectFormatCandidate}).
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  Diagnostic,
  FormatDecodeResult,
  FormatRequest,
  SemVer,
  StoryFormatInfo,
  Twine2FormatJSON,
} from './types.js';
import { parseRelaxedJSON } from './relaxed-json.js';
import { compareVersions, parseVersion } from './semver.js';
import { readUTF8 } from './util.js';

/** A `"setup": function` property, which Harlowe appends to its otherwise-JSON format object. */
const SETUP_FUNCTION_PROPERTY = /,\s*"setup"\s*:\s*function\b/g;

/** Drop a trailing `"setup": function(){…}` property from a format object, if it has one. */
function stripSetupFunction(chunk: string): string | undefined {
  let lastIndex = -1;
  for (const match of chunk.matchAll(SETUP_FUNCTION_PROPERTY)) lastIndex = match.index;
  return lastIndex === -1 ? undefined : chunk.slice(0, lastIndex) + '}';
}

type ObjectParse = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/**
 * Parse the format object at `start`–`end` of `text`: strict JSON first (fast), then the
 * JavaScript literal subset formats use. Error positions point into `text`.
 */
function parseFormatObject(text: string, start: number, end: number): ObjectParse {
  try {
    return { ok: true, value: JSON.parse(text.slice(start, end)) };
  } catch {
    // Not strict JSON; the spec does not require it to be.
  }
  try {
    return { ok: true, value: parseRelaxedJSON(text, start, end) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Check a parsed format object's fields. Per spec, `name` is optional; `version` and `source` are required. */
function toFormatJSON(raw: unknown): FormatDecodeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'Story format JSON chunk is not an object.' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== 'string') return { ok: false, reason: 'Story format has no "version" string.' };
  if (typeof obj.source !== 'string') return { ok: false, reason: 'Story format has no "source" string.' };
  if (!parseVersion(obj.version)) {
    return { ok: false, reason: `Story format version ${JSON.stringify(obj.version)} is not a SemVer version.` };
  }
  const data: Twine2FormatJSON = {
    name: typeof obj.name === 'string' ? obj.name : 'Untitled Story Format',
    version: obj.version,
    source: obj.source,
    proofing: obj.proofing === true,
  };
  if (typeof obj.author === 'string') data.author = obj.author;
  if (typeof obj.description === 'string') data.description = obj.description;
  if (typeof obj.image === 'string') data.image = obj.image;
  if (typeof obj.url === 'string') data.url = obj.url;
  if (typeof obj.license === 'string') data.license = obj.license;
  return { ok: true, data };
}

/**
 * Read the metadata of a Twine 2 format.js, or say why it cannot be used.
 *
 * The object passed to `window.storyFormat()` may be strict JSON or a JavaScript object literal
 * (single quotes, unquoted keys, trailing commas, comments). String values come back exactly as
 * JavaScript evaluation gives them. Harlowe's function-valued `setup` property is dropped; the
 * workaround keys on the property itself, so the same bytes parse whether they come from a
 * `harlowe-3` directory or a direct download.
 */
export function decodeFormatJSON(source: string): FormatDecodeResult {
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first === -1 || last < first) {
    return { ok: false, reason: 'Could not find Twine 2 style story format JSON chunk.' };
  }

  const parsed = parseFormatObject(source, first, last + 1);
  if (parsed.ok) return toFormatJSON(parsed.value);

  // Harlowe workaround: strip the "setup" function property.
  const stripped = stripSetupFunction(source.slice(first, last + 1));
  const retried = stripped === undefined ? undefined : parseFormatObject(stripped, 0, stripped.length);
  if (retried?.ok) return toFormatJSON(retried.value);
  return { ok: false, reason: `Could not decode story format JSON chunk: ${parsed.error}` };
}

/**
 * Parse the Twine 2 format.js JSON chunk; null when it cannot be used ({@link decodeFormatJSON}
 * gives the reason).
 *
 * @param _formatId No longer used; kept so existing callers keep compiling.
 */
export function parseFormatJSON(source: string, _formatId?: string): Twine2FormatJSON | null {
  const result = decodeFormatJSON(source);
  return result.ok ? result.data : null;
}

/** A directory's entries in a stable order, or none when it cannot be read. */
function listDirectory(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Load the format in one folder: its format.js (Twine 2), else its header.html (Twine 1).
 * A format.js that cannot be used is reported as a warning, as Tweego does.
 */
function loadFormatDir(
  searchDir: string,
  id: string,
  diagnostics: Diagnostic[] | undefined,
): StoryFormatInfo | undefined {
  const formatDir = join(searchDir, id);
  if (!isDirectory(formatDir)) return undefined;

  for (const baseFilename of ['format.js', 'header.html']) {
    const filename = join(formatDir, baseFilename);
    if (!isFile(filename)) continue;

    if (baseFilename === 'header.html') {
      // Twine 1 format: the folder name is its name.
      return { id, filename, isTwine2: false, name: id, version: '', proofing: false };
    }

    // An encoding warning explains a skipped format; for a usable one, readFormatSource() reports it when used.
    const encoding: Diagnostic[] = [];
    let decoded: FormatDecodeResult;
    try {
      decoded = decodeFormatJSON(readUTF8(filename, encoding));
    } catch (e) {
      decoded = { ok: false, reason: `Could not read ${filename}: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!decoded.ok) {
      diagnostics?.push(...encoding);
      diagnostics?.push({
        level: 'warning',
        message: `format ${id}: Skipping format; ${decoded.reason} (${filename})`,
      });
      continue;
    }
    const { data } = decoded;
    const format: StoryFormatInfo = {
      id,
      filename,
      isTwine2: true,
      name: data.name,
      version: data.version,
      proofing: data.proofing ?? false,
    };
    if (data.author) format.author = data.author;
    if (data.description) format.description = data.description;
    if (data.image) format.image = data.image;
    if (data.url) format.url = data.url;
    if (data.license) format.license = data.license;
    return format;
  }
  return undefined;
}

/**
 * Discover every story format in the search directories, keyed by folder name (the format ID),
 * without version pruning.
 *
 * Directories are searched in order, and a later directory outranks an earlier one: when two hold
 * the same folder name, the later one's format is kept. The map iterates in that order too, lowest
 * rank first. Formats that cannot be used are left out, with a warning in `diagnostics`.
 */
export function discoverAllFormats(
  searchDirs: readonly string[],
  diagnostics?: Diagnostic[],
): Map<string, StoryFormatInfo> {
  const formats = new Map<string, StoryFormatInfo>();
  for (const searchDir of searchDirs) {
    for (const entry of listDirectory(searchDir)) {
      const format = loadFormatDir(searchDir, entry, diagnostics);
      if (!format) continue;
      // Re-insert, so the map's order follows the directories' rank.
      formats.delete(entry);
      formats.set(entry, format);
    }
  }
  return formats;
}

/** The version a format is pruned and selected by, or null for one outside SemVer pruning. */
function prunableVersion(format: StoryFormatInfo): SemVer | null {
  return format.isTwine2 && format.name ? parseVersion(format.version) : null;
}

/** The search directory a discovered format was found in. */
function searchDirOf(format: StoryFormatInfo): string {
  return dirname(dirname(format.filename));
}

/**
 * Prune formats by SemVer: within each (name, major) group, keep only the version with the highest
 * precedence (a release outranks its prereleases). Between equal versions, the folder in the
 * higher-ranked search directory wins, and within one directory the first folder name in sort
 * order. Returns a new map in the same order.
 *
 * Pruning serves name-based selection and listings. An explicit format ID is looked up in the
 * unpruned map, so a pinned folder is used even when another folder holds a newer version.
 */
export function pruneFormats(formats: ReadonlyMap<string, StoryFormatInfo>): Map<string, StoryFormatInfo> {
  // Search directories first appear in the map in rank order (see discoverAllFormats).
  const dirRank = new Map<string, number>();
  for (const format of formats.values()) {
    const dir = searchDirOf(format);
    if (!dirRank.has(dir)) dirRank.set(dir, dirRank.size);
  }
  const rankOf = (format: StoryFormatInfo): number => dirRank.get(searchDirOf(format)) ?? 0;

  const best = new Map<string, { readonly format: StoryFormatInfo; readonly version: SemVer }>();
  for (const format of formats.values()) {
    const version = prunableVersion(format);
    if (!version) continue;
    const group = `${format.name}@${version.major}`;
    const current = best.get(group);
    const order = current ? compareVersions(version, current.version) : 1;
    if (order > 0 || (order === 0 && current && rankOf(format) > rankOf(current.format))) {
      best.set(group, { format, version });
    }
  }
  return new Map(
    [...formats].filter(([id, format]) => {
      const version = prunableVersion(format);
      return version === null || best.get(`${format.name}@${version.major}`)?.format.id === id;
    }),
  );
}

/**
 * Discover all story formats in the given search directories, pruned by SemVer: within each
 * (name, major) group only the highest version survives. See {@link discoverAllFormats} for the
 * directory ranking and {@link pruneFormats} for pruning.
 */
export function discoverFormats(searchDirs: readonly string[]): Map<string, StoryFormatInfo> {
  return pruneFormats(discoverAllFormats(searchDirs));
}

/**
 * Get the format search directories, lowest rank first: the story format subdirectories of the
 * home directory, then of the working directory, then each `TWEEGO_PATH` entry, then `extraPaths`
 * (`formatPaths`). A later directory outranks an earlier one for the same format folder name, so
 * `formatPaths` override `TWEEGO_PATH`, which overrides the home and working directories, as in
 * Tweego.
 */
export function getFormatSearchDirs(extraPaths: readonly string[] = [], useTweegoPath = true): string[] {
  const subdirNames = ['storyformats', '.storyformats', 'story-formats', 'storyFormats', 'targets'];
  const basePaths = new Set<string>();

  // Home directory
  try {
    basePaths.add(homedir());
  } catch {
    // ignore
  }

  // Working directory
  basePaths.add(process.cwd());

  const dirs = [...basePaths].flatMap((base) => subdirNames.map((sub) => join(base, sub))).filter(isDirectory);

  // TWEEGO_PATH environment variable
  const tweegoPath = useTweegoPath ? process.env.TWEEGO_PATH : undefined;
  if (tweegoPath) dirs.push(...tweegoPath.split(process.platform === 'win32' ? ';' : ':'));

  // Extra user-provided paths outrank everything else.
  dirs.push(...extraPaths);

  return dirs;
}

/**
 * Parse a version string into [major, minor, patch]. Accepts what {@link parseVersion} accepts
 * (`v1.2.3`, `1.2`, `2.0.0-beta.1`); the prerelease and build metadata are dropped.
 */
export function parseSemver(v: string): [number, number, number] | null {
  const parsed = parseVersion(v);
  return parsed ? [parsed.major, parsed.minor, parsed.patch] : null;
}

/** Compare [major, minor, patch] tuples. Use {@link compareVersions} to take prereleases into account. */
export function semverCompare(a: [number, number, number], b: [number, number, number]): number {
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  if (aPatch !== bPatch) return aPatch - bPatch;
  return 0;
}

/** Build a directory-style format ID from a name and version, e.g. ('SugarCube', '2.37.3') → 'sugarcube-2'. */
export function makeFormatId(name: string, version: string): string {
  const major = parseVersion(version)?.major ?? 0;
  return `${name.toLowerCase().replace(/\s+/g, '-')}-${major}`;
}

/** Describe a format request for diagnostics. */
export function describeFormatRequest(request: FormatRequest): string {
  switch (request.kind) {
    case 'id':
      return `"${request.id}"`;
    case 'name':
      return request.version ? `"${request.name}" at version "${request.version}"` : `"${request.name}"`;
    default: {
      const _exhaustive: never = request;
      throw new Error(`unhandled format request: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Options for {@link selectFormatCandidate}. */
export interface SelectFormatOptions {
  /** For a name request, also accept a version older than the one asked for (same major only). */
  readonly allowOlder?: boolean;
}

/** {@link selectFormatCandidate} over one set of candidates, matching names without regard to case. */
function pickFormatCandidate<T>(
  request: FormatRequest,
  candidates: readonly T[],
  describe: (candidate: T) => { readonly name: string; readonly version: string },
  allowOlder: boolean,
): T | undefined {
  const wanted = request.kind === 'name' ? parseVersion(request.version) : null;
  let best: { readonly candidate: T; readonly version: SemVer } | undefined;

  for (const candidate of candidates) {
    const { name, version } = describe(candidate);
    const have = parseVersion(version);
    if (!have) continue;

    if (request.kind === 'id') {
      if (makeFormatId(name, version) !== request.id.toLowerCase()) continue;
    } else {
      if (name.toLowerCase() !== request.name.toLowerCase()) continue;
      if (wanted) {
        const order = compareVersions(have, wanted);
        if (order === 0) return candidate;
        if (have.major !== wanted.major) continue;
        if (!allowOlder && order < 0) continue;
      }
    }

    if (!best || compareVersions(have, best.version) > 0) best = { candidate, version: have };
  }

  return best?.candidate;
}

/**
 * Pick the candidate that best answers a format request. Local folders, the download cache and
 * remote indices all select through this one function.
 *
 * - An ID request ('sugarcube-2') matches, without regard to case, a candidate whose name and
 *   major version build that ID, and takes the greatest such version.
 * - A name request matches the name without regard to case, but a candidate whose name matches in
 *   case too is preferred when one answers the request. An exact version (prerelease included)
 *   wins outright; otherwise the greatest version with the same major that is not older than the
 *   one asked for (or, with `allowOlder`, the greatest same-major version). An unparseable
 *   requested version takes the greatest version of any major.
 *
 * Versions compare by SemVer precedence ({@link compareVersions}), so a release outranks its
 * prereleases. Between equal versions, the earlier candidate wins.
 */
export function selectFormatCandidate<T>(
  request: FormatRequest,
  candidates: readonly T[],
  describe: (candidate: T) => { readonly name: string; readonly version: string },
  options: SelectFormatOptions = {},
): T | undefined {
  const allowOlder = options.allowOlder ?? false;
  if (request.kind === 'name') {
    const exactCase = candidates.filter((c) => describe(c).name === request.name);
    const preferred = pickFormatCandidate(request, exactCase, describe, allowOlder);
    if (preferred !== undefined) return preferred;
  }
  return pickFormatCandidate(request, candidates, describe, allowOlder);
}

/** The Twine 2 formats of a discovered map, those from higher-ranked search directories first. */
export function rankedTwine2Formats(formats: ReadonlyMap<string, StoryFormatInfo>): StoryFormatInfo[] {
  return [...formats.values()].filter((f) => f.isTwine2).reverse();
}

/**
 * Look a format ID up among discovered folders. The ID matches a folder name without regard to
 * case; an exact-case folder is preferred, then the highest-ranked one.
 */
export function findFormatById(formats: ReadonlyMap<string, StoryFormatInfo>, id: string): StoryFormatInfo | undefined {
  const exact = formats.get(id);
  if (exact) return exact;
  const wanted = id.toLowerCase();
  return [...formats.values()].reverse().find((f) => f.id.toLowerCase() === wanted);
}

/**
 * Get format ID from Twine 2 name and version, as a compile selects a local format by StoryData:
 * {@link selectFormatCandidate} over the pruned formats, so the greatest version with the same
 * major that is not older than `version` (any major when `version` is unparseable).
 */
export function getFormatIdByNameAndVersion(
  formats: ReadonlyMap<string, StoryFormatInfo>,
  name: string,
  version: string,
): string | undefined {
  const request: FormatRequest = { kind: 'name', name, version };
  return selectFormatCandidate(request, rankedTwine2Formats(pruneFormats(formats)), (f) => f)?.id;
}

/** Get format ID from Twine 2 name, picking the greatest version. */
export function getFormatIdByName(formats: ReadonlyMap<string, StoryFormatInfo>, name: string): string | undefined {
  return getFormatIdByNameAndVersion(formats, name, '');
}

/**
 * Read the story format source (for Twine 2, extract the `source` property from JSON).
 * `diagnostics` receives a warning when the format file is not valid UTF-8 (it is read as Windows-1252).
 */
export function readFormatSource(format: StoryFormatInfo, diagnostics?: Diagnostic[]): string {
  const source = readUTF8(format.filename, diagnostics);
  if (!format.isTwine2) return source;
  const decoded = decodeFormatJSON(source);
  if (!decoded.ok) throw new Error(`Cannot parse format ${format.id} JSON: ${decoded.reason}`);
  return decoded.data.source;
}

/** Read a file as UTF-8 (re-exported for loader use). */
export { readUTF8 as readFileUTF8 } from './util.js';

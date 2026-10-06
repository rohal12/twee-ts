/**
 * Story format discovery in local folders, and the one selection policy every source shares.
 * Ported from formats.go + config.go.
 *
 * Every source (local folders here; format URLs and format indices in format-resolution.ts) turns
 * what it has into {@link FormatCandidate}s, and {@link selectFormat} alone decides which one
 * answers a request. docs/story-formats.md ("How a format is chosen") states the same policy.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Diagnostic, FormatDecodeResult, FormatRequest, SemVer, StoryFormatInfo } from './types.js';
import { decodeFormatJSON } from './format-decode.js';
import { compareVersions, parseVersion } from './semver.js';
import { normalizeSourceText } from './source-text.js';
import { decodeText, readUTF8 } from './util.js';

/** The message of a caught error, or the text of a thrown value that is not an Error. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

/** The device and inode of the folder at `path` (the same however the folder is named), or undefined for no folder. */
function directoryIdentity(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : undefined;
  } catch {
    return undefined;
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
      decoded = { ok: false, reason: `Could not read ${filename}: ${errorText(e)}` };
    }
    if (!decoded.ok) {
      diagnostics?.push(...encoding);
      diagnostics?.push({
        level: 'warning',
        message: `format ${id}: Skipping format; ${decoded.reason} (${filename})`,
      });
      continue;
    }
    return formatInfoFromJSON(id, filename, decoded.data);
  }
  return undefined;
}

/** The StoryFormatInfo of a Twine 2 format, from its decoded format.js metadata. */
export function formatInfoFromJSON(
  id: string,
  filename: string,
  data: {
    readonly name: string;
    readonly version: string;
    readonly proofing?: boolean | undefined;
    readonly author?: string | undefined;
    readonly description?: string | undefined;
    readonly image?: string | undefined;
    readonly url?: string | undefined;
    readonly license?: string | undefined;
  },
): StoryFormatInfo {
  const format: StoryFormatInfo = {
    id,
    filename,
    isTwine2: true,
    name: data.name,
    version: data.version,
    proofing: data.proofing === true,
  };
  if (data.author) format.author = data.author;
  if (data.description) format.description = data.description;
  if (data.image) format.image = data.image;
  if (data.url) format.url = data.url;
  if (data.license) format.license = data.license;
  return format;
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
 * The rank of each format's search directory in a discovered map (higher outranks lower).
 * Search directories first appear in the map in rank order (see {@link discoverAllFormats}).
 */
function searchDirRanks(formats: ReadonlyMap<string, StoryFormatInfo>): Map<StoryFormatInfo, number> {
  const dirRank = new Map<string, number>();
  return new Map(
    [...formats.values()].map((format) => {
      const dir = searchDirOf(format);
      const rank = dirRank.get(dir) ?? dirRank.size;
      dirRank.set(dir, rank);
      return [format, rank] as const;
    }),
  );
}

/**
 * The pruning group of a format: its name, exactly as written (as in Tweego), and its major version.
 * Two formats whose names differ only in case both survive pruning, so that selection can prefer
 * the one in the request's exact case between equal versions.
 */
function pruneGroup(format: StoryFormatInfo, version: SemVer): string {
  return `${format.name}\0${version.major}`;
}

/**
 * Prune formats by SemVer: within each (name, major) group, keep only the version with the highest
 * precedence (a release outranks its prereleases). Between equal versions, the folder in the higher-ranked search directory wins, and within
 * one directory the first folder name in sort order. Returns a new map in the same order.
 *
 * Pruning serves name-based selection and listings. An explicit format ID is looked up in the
 * unpruned map, so a pinned folder is used even when another folder holds a newer version.
 */
export function pruneFormats(formats: ReadonlyMap<string, StoryFormatInfo>): Map<string, StoryFormatInfo> {
  const ranks = searchDirRanks(formats);
  const best = new Map<string, { readonly format: StoryFormatInfo; readonly version: SemVer; readonly rank: number }>();
  for (const [format, rank] of ranks) {
    const version = prunableVersion(format);
    if (!version) continue;
    const group = pruneGroup(format, version);
    const current = best.get(group);
    const order = current ? compareVersions(version, current.version) : 1;
    if (order > 0 || (order === 0 && current && rank > current.rank)) {
      best.set(group, { format, version, rank });
    }
  }
  return new Map(
    [...formats].filter(([, format]) => {
      const version = prunableVersion(format);
      return version === null || best.get(pruneGroup(format, version))?.format === format;
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

  // On a case-insensitive file system (macOS and Windows by default) `storyformats` and
  // `storyFormats` name one folder, as do two names that reach it through a link. Each folder
  // is searched once, at the rank of the first name found for it, on every platform.
  const seen = new Set<string>();
  const dirs = [...basePaths]
    .flatMap((base) => subdirNames.map((sub) => join(base, sub)))
    .filter((dir) => {
      const identity = directoryIdentity(dir);
      if (identity === undefined || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });

  // TWEEGO_PATH environment variable
  const tweegoPath = useTweegoPath ? process.env['TWEEGO_PATH'] : undefined;
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

/**
 * The key two format names match by: names that differ only in letter case are the same format.
 * Every lookup, pruning, and `cache clear` compare names through this one function.
 */
export function formatNameKey(name: string): string {
  return name.toLowerCase();
}

/**
 * Build a directory-style format ID from a name and version, e.g. ('SugarCube', '2.37.3') →
 * 'sugarcube-2': the name in lower case with each run of whitespace replaced by `-`, then the major
 * version. A version that is not a version gives major 0.
 */
export function makeFormatId(name: string, version: string): string {
  const major = parseVersion(version)?.major ?? 0;
  return `${formatNameKey(name).replace(/\s+/g, '-')}-${major}`;
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

// --- The candidate model and the selection policy ---

/** The kind of source a candidate comes from. */
export type FormatSourceKind = 'local' | 'url' | 'index';

/**
 * One format some source can supply, with what selection needs to know about it. Candidates from
 * every source have this one shape, so {@link selectFormat} cannot treat two sources differently
 * except through `rank`.
 */
export interface FormatCandidate {
  /** The format's name: from its format.js, an index entry, or (Twine 1, local) its folder. */
  readonly name: string;
  /** The format's version as written; '' for a local Twine 1 format. */
  readonly version: string;
  readonly isTwine2: boolean;
  readonly source: FormatSourceKind;
  /**
   * The position of the candidate's source in the source order: local folders 0, then each format
   * URL, then each format index. A lower rank is preferred (see {@link selectFormat}).
   */
  readonly rank: number;
  /** A local candidate's folder name, which an ID request may name. */
  readonly folder?: string | undefined;
  /** A local candidate's search directory rank (higher outranks lower). */
  readonly dirRank?: number | undefined;
}

/**
 * How a candidate answers a request, best first:
 * - `pinned`: an ID request names the candidate's local folder.
 * - `exact`: a name request's version, by SemVer precedence.
 * - `newer`: a name request, the same major version and above the version asked for.
 * - `any`: a name request whose version is empty or not a version: any version.
 * - `id`: an ID request matches the candidate's name and major version ({@link makeFormatId}).
 * - `older`: a name request, the same major version and below the version asked for. Used only
 *   when no source has a candidate of any other tier, and then with a warning.
 */
export type MatchTier = 'pinned' | 'exact' | 'newer' | 'any' | 'id' | 'older';

const TIER_ORDER: readonly MatchTier[] = ['pinned', 'exact', 'newer', 'any', 'id', 'older'];

/** How a candidate relates to a request: the tier it answers in, or why it does not answer. */
export type Judgement =
  | { readonly kind: 'match'; readonly tier: MatchTier; readonly version: SemVer | null }
  | { readonly kind: 'rejected'; readonly reason: string };

function rejected(reason: string): Judgement {
  return { kind: 'rejected', reason };
}

/** Whether a request's ID names a local candidate's folder (without regard to case). */
function namesFolder(request: { readonly id: string }, candidate: FormatCandidate): boolean {
  return candidate.folder !== undefined && formatNameKey(candidate.folder) === formatNameKey(request.id);
}

/** Judge one candidate against a request: the policy for a single candidate, whatever its source. */
export function judgeCandidate(request: FormatRequest, candidate: FormatCandidate): Judgement {
  const version = parseVersion(candidate.version);
  switch (request.kind) {
    case 'id': {
      if (namesFolder(request, candidate)) return { kind: 'match', tier: 'pinned', version };
      if (!version) return rejected('its version is not a SemVer version');
      const id = makeFormatId(candidate.name, candidate.version);
      const wanted = formatNameKey(request.id);
      if (id !== wanted) {
        const sameName = id.replace(/-\d+$/, '') === wanted.replace(/-\d+$/, '');
        return rejected(`${sameName ? 'another major version' : 'a different format'} (its ID is ${id})`);
      }
      return { kind: 'match', tier: 'id', version };
    }
    case 'name': {
      if (formatNameKey(candidate.name) !== formatNameKey(request.name)) return rejected('a different format');
      if (!candidate.isTwine2) return rejected('a Twine 1 format (StoryData names Twine 2 formats)');
      if (!version) return rejected('its version is not a SemVer version');
      const wanted = parseVersion(request.version);
      if (!wanted) return { kind: 'match', tier: 'any', version };
      const order = compareVersions(version, wanted);
      if (order === 0) return { kind: 'match', tier: 'exact', version };
      if (version.major !== wanted.major) return rejected(`another major version than ${wanted.major}`);
      return { kind: 'match', tier: order > 0 ? 'newer' : 'older', version };
    }
    default: {
      const _exhaustive: never = request;
      throw new Error(`unhandled format request: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Whether a candidate's name (or, for an ID request, folder) has the request's exact letter case. */
function hasExactCase(request: FormatRequest, candidate: FormatCandidate): boolean {
  return request.kind === 'id' ? candidate.folder === request.id : candidate.name === request.name;
}

/** Options for {@link selectFormat}. */
export interface SelectFormatOptions {
  /** When no candidate answers in another tier, take one from the `older` tier. */
  readonly allowOlder?: boolean | undefined;
}

/** The candidate {@link selectFormat} chose, and the tier it answers the request in. */
export interface FormatSelection<C extends FormatCandidate> {
  readonly choice: C;
  readonly tier: MatchTier;
}

/**
 * Choose the candidate that answers a request. This is the whole selection policy:
 *
 * 1. Each candidate is judged alone ({@link judgeCandidate}); the result depends on its name,
 *    version and (local) folder, never on its source kind.
 * 2. Every tier but `older` answers. Among the answering candidates, the lowest source rank wins;
 *    within one source, the better tier ({@link MatchTier}); then the greater version (SemVer
 *    precedence); then a name (or folder) in the request's exact letter case; then the
 *    higher-ranked search directory (local folders); then the earlier candidate.
 * 3. Only when no candidate answers, and `allowOlder` is set, the `older` candidates are ordered
 *    the same way (source rank, then greater version, …) and the first is taken.
 *
 * Because the source rank comes first among answering candidates, a source's answer never depends
 * on sources ranked after it, so callers may gather sources one at a time and stop at the first
 * answer: the result equals selecting over every source at once.
 */
export function selectFormat<C extends FormatCandidate>(
  request: FormatRequest,
  candidates: readonly C[],
  options: SelectFormatOptions = {},
): FormatSelection<C> | undefined {
  const judged = candidates.flatMap((candidate, index) => {
    const judgement = judgeCandidate(request, candidate);
    return judgement.kind === 'match' ? [{ candidate, index, tier: judgement.tier, version: judgement.version }] : [];
  });
  type Judged = (typeof judged)[number];
  const order = (a: Judged, b: Judged): number =>
    a.candidate.rank - b.candidate.rank ||
    TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
    compareOptionalVersions(b.version, a.version) ||
    Number(hasExactCase(request, b.candidate)) - Number(hasExactCase(request, a.candidate)) ||
    (b.candidate.dirRank ?? 0) - (a.candidate.dirRank ?? 0) ||
    a.index - b.index;

  const answering = judged.filter((j) => j.tier !== 'older').sort(order);
  const best =
    answering[0] ?? (options.allowOlder ? judged.filter((j) => j.tier === 'older').sort(order)[0] : undefined);
  return best && { choice: best.candidate, tier: best.tier };
}

/** Compare versions that may be missing (a local Twine 1 format); a missing one ranks lowest. */
function compareOptionalVersions(a: SemVer | null, b: SemVer | null): number {
  if (a && b) return compareVersions(a, b);
  return Number(a !== null) - Number(b !== null);
}

/** Local formats as candidates: rank 0, their folder, and their search directory's rank. */
export function localCandidates(
  formats: ReadonlyMap<string, StoryFormatInfo>,
): (FormatCandidate & { readonly folder: string; readonly info: StoryFormatInfo })[] {
  const ranks = searchDirRanks(formats);
  return [...formats].map(([folder, info]) => ({
    name: info.name,
    version: info.version,
    isTwine2: info.isTwine2,
    source: 'local' as const,
    rank: 0,
    folder,
    dirRank: ranks.get(info),
    info,
  }));
}

/**
 * Get format ID from Twine 2 name and version, as a compile selects a local format by StoryData:
 * {@link selectFormat} over the pruned formats, so the greatest version with the same major that
 * is not older than `version` (any major when `version` is empty or unparseable).
 */
export function getFormatIdByNameAndVersion(
  formats: ReadonlyMap<string, StoryFormatInfo>,
  name: string,
  version: string,
): string | undefined {
  const request: FormatRequest = { kind: 'name', name, version };
  return selectFormat(request, localCandidates(pruneFormats(formats)))?.choice.folder;
}

/** Get format ID from Twine 2 name, picking the greatest version. */
export function getFormatIdByName(formats: ReadonlyMap<string, StoryFormatInfo>, name: string): string | undefined {
  return getFormatIdByNameAndVersion(formats, name, '');
}

// --- Format sources ---

/** The bytes of formats that were downloaded, kept with their info so they are never read back from disk. */
const downloadedBytes = new WeakMap<StoryFormatInfo, { readonly bytes: Uint8Array; readonly from: string }>();

/**
 * Keep the bytes of a downloaded format with its info, so {@link readFormatSource} uses exactly the
 * bytes that were verified, even when the cache could not be written or changes later.
 */
export function withFormatBytes(info: StoryFormatInfo, bytes: Uint8Array, from: string): StoryFormatInfo {
  downloadedBytes.set(info, { bytes, from });
  return info;
}

/**
 * Read the story format source (for Twine 2, extract the `source` property from JSON).
 * `diagnostics` receives a warning when the format file is not valid UTF-8 (it is read as Windows-1252).
 */
export function readFormatSource(format: StoryFormatInfo, diagnostics?: Diagnostic[]): string {
  const downloaded = downloadedBytes.get(format);
  let source: string;
  if (downloaded) {
    const decoded = decodeText(downloaded.bytes, downloaded.from);
    diagnostics?.push(...decoded.diagnostics);
    source = normalizeSourceText(decoded.text);
  } else {
    source = readUTF8(format.filename, diagnostics);
  }
  if (!format.isTwine2) return source;
  const decoded = decodeFormatJSON(source);
  if (!decoded.ok) throw new Error(`Cannot parse format ${format.id} JSON: ${decoded.reason}`);
  // What decoding left out of the format a build uses (a skipped function, a field of the wrong
  // type), once per build, naming where the format came from.
  const from = downloaded ? `downloaded from ${downloaded.from}` : format.filename;
  diagnostics?.push(
    ...decoded.notes.map((note) => ({ level: 'warning' as const, message: `format ${format.id}: ${note} (${from})` })),
  );
  return decoded.data.source;
}

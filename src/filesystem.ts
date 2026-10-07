/**
 * File system utilities: source discovery, output-path checks, watch mode.
 * Ported from filesystem.go. Every path comparison goes through path-identity.ts.
 */
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  watch as fsWatch,
} from 'node:fs';
import type { FSWatcher, Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { isKnownFileType, normalizedFileExt } from './media-types.js';
import { identify, isKeyInside, matchesExclude } from './path-identity.js';
import type { PathIdentity } from './path-identity.js';
import { failureOfError, inputProblem, problemDiagnostic } from './input-policy.js';
import type { InputDiscovery, InputFailure, InputRole } from './input-policy.js';
import type { Diagnostic } from './types.js';
import { attributeOf, documentTextContains, findStoreArea, findStoryData, parseHtml } from './html-structure.js';
import { JsonObject, parseJSON } from './json-decode.js';
import type { JsonValue } from './json-decode.js';

/**
 * Whether `filename` matches one of the `exclude` globs (see `matchesExclude` in path-identity.ts): the
 * globs are matched against the file's path relative to the working directory, the path getFilenames
 * reports, and against its real path relative to the working directory; an absolute glob against the
 * absolute paths. A leading `./` in a glob is dropped. The extension is matched without case, and on a
 * case-insensitive volume the whole path.
 */
export function isExcluded(filename: string, exclude: readonly string[]): boolean {
  if (exclude.length === 0) return false;
  return matchesExclude(identify(filename), exclude);
}

/**
 * The paths a build writes. Source discovery never reads them back as sources,
 * and the watchers don't rebuild for them.
 */
export interface BuildOutputs {
  /**
   * Files the build writes: the story, and for a bundler also its chunks, its
   * assets and the public files it copies.
   */
  readonly files: readonly string[];
  /**
   * Folders the build writes into, which hold nothing but its output. One found
   * while walking a source folder is skipped whole, files from earlier builds
   * included (old hashed chunks, say). A folder named as a source, or one that
   * holds a source folder, is still walked, and only `files` are left out of it.
   */
  readonly dirs: readonly string[];
}

/** A build that writes nothing: `compile()`, or output to stdout. */
const NO_BUILD_OUTPUTS: BuildOutputs = { files: [], dirs: [] };

/** The outputs of a build that writes the one file `outFile`, or none without it. */
export function toBuildOutputs(outputs: BuildOutputs | string | undefined): BuildOutputs {
  if (outputs === undefined) return NO_BUILD_OUTPUTS;
  return typeof outputs === 'string' ? { files: [outputs], dirs: [] } : outputs;
}

/**
 * The real path of `path` (see `canonical` in path-identity.ts): absolute, with every symbolic link
 * resolved, so two paths that reach the same file through different links compare equal. A path that
 * doesn't exist yet is its nearest existing folder's real path joined with the rest.
 */
export function realPathOf(path: string): string {
  return identify(path).canonical;
}

/** The inode of an existing file, as `dev:ino`, so a hard link of an output is recognised as one. */
function inodeOf(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return stats.isFile() ? `${stats.dev}:${stats.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/** A build's outputs, with the checks discovery and the watchers make. Every path is compared by identity. */
export interface OutputPaths {
  /** Whether `path` is a file the build writes (the same file, or a hard link to it). */
  isFile(path: string): boolean;
  /** Whether `path` is a folder the build owns (see BuildOutputs.dirs). */
  isDir(path: string): boolean;
  /** Whether the folder at `path` is an owned folder or holds an output, at any depth. */
  holds(path: string): boolean;
  /**
   * Whether source discovery, walking the folders `roots`, leaves the path out
   * as output: an output file, or a path it only reaches through an owned folder.
   */
  isOutput(path: string, roots: readonly string[]): boolean;
}

export function outputPaths(outputs: BuildOutputs): OutputPaths {
  const files = new Set(outputs.files.map((f) => identify(f).key));
  // Read when asked: an output that is written, or replaced, after these paths are made is a new file.
  const outputInodes = (): ReadonlySet<string> => new Set(outputs.files.map(inodeOf).filter((id) => id !== undefined));
  const dirs = new Set(outputs.dirs.map((d) => identify(d).key));
  const all = [...files, ...dirs];
  const keyOf = (path: string): string => identify(path).key;
  const isFile = (path: string): boolean => {
    if (files.has(keyOf(path))) return true;
    const inode = inodeOf(path);
    return inode !== undefined && outputInodes().has(inode);
  };
  return {
    isFile,
    isDir: (path) => dirs.has(keyOf(path)),
    holds(path) {
      const key = keyOf(path);
      return dirs.has(key) || all.some((output) => output !== key && isKeyInside(output, key, sep));
    },
    isOutput(path, roots) {
      if (isFile(path)) return true;
      const key = keyOf(path);
      const owners = [...dirs].filter((dir) => isKeyInside(key, dir, sep));
      if (owners.length === 0) return false;
      // A root walks into the path unless an owned folder below the root holds it.
      const reaching = roots.map(keyOf).filter((root) => isKeyInside(key, root, sep));
      return reaching.every((root) => owners.some((dir) => dir !== root && isKeyInside(dir, root, sep)));
    },
  };
}

/**
 * A folder entry as source discovery walks it, found at `pathname` with the real
 * path `real` when it is no link: a link to a file counts as that file, and a
 * link to anything else (a folder above all) as nothing, undefined. Throws when
 * the entry or a link's target can't be read (a dangling link: ENOENT).
 */
export function walkedEntry(
  pathname: string,
  real: string,
): { readonly stat: Stats; readonly real: string } | undefined {
  const stat = lstatSync(pathname);
  if (!stat.isSymbolicLink()) return { stat, real };
  const target = statSync(pathname);
  return target.isFile() ? { stat: target, real: realPathOf(pathname) } : undefined;
}

/** A file source discovery found, as the loader reads and reports it. */
export interface DiscoveredFile {
  /** The path reported for it: relative to the working directory when inside it (`display` of its identity). */
  readonly path: string;
  /** Its identity key: the same for every spelling of the same file. */
  readonly key: string;
  /** Named by the user, or found walking a named folder. */
  readonly discovery: InputDiscovery;
  /** Reached through a symbolic link (the entry found, or the path named, is a link). */
  readonly link?: boolean;
}

/** An output file found while walking a source or module folder: left out of the inputs. */
export interface SkippedOutput {
  readonly path: string;
  /** The named folder whose walk found it. */
  readonly folder: string;
}

export interface FilenamesResult {
  /** The paths of `files`, for callers that only need them. */
  readonly filenames: string[];
  readonly files: readonly DiscoveredFile[];
  /** A warning (or error) per path that could not be used, as the input policy says (see input-policy.ts). */
  readonly diagnostics: Diagnostic[];
  /**
   * The paths given that are themselves an output file. A build reading one would
   * overwrite its own source; the compiler refuses it, as Tweego does.
   */
  readonly outputSources: string[];
  /** Output files found while walking a named folder, which were left out. */
  readonly skippedOutputs: readonly SkippedOutput[];
}

/** Orders folder entries by code point, as Tweego's walk (Go's sort.Strings on UTF-8) does, on every OS. */
function compareNames(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Recursively walk directories, collecting regular file paths.
 *
 * Leaves out what the build writes (`outputs`, compared by identity, see path-identity.ts) so its last
 * output is never read back, and the files that match an `exclude` glob (see isExcluded). A path given
 * that is itself an output file is not walked but listed in `outputSources`. Folder entries are walked in
 * code-point order, so the order sources load in (and so which duplicate passage wins) is the same on
 * every operating system.
 *
 * Symbolic links: a path given is followed wherever it leads. Inside a folder, a
 * link to a file is read, but a link to a folder is not followed, as Tweego's walk
 * doesn't follow one. A link back to its own folder or a parent would otherwise
 * walk the same files again at every depth.
 *
 * What can't be used (a missing path, a dangling link, an unreadable folder) is handled as the input
 * policy says for `role` (see input-policy.ts): a missing named path is a warning, as in Tweego, and a
 * dangling link found in a folder (an editor's lock file) is skipped without a word.
 */
export function getFilenames(
  pathnames: readonly string[],
  outputs?: BuildOutputs | string,
  exclude: readonly string[] = [],
  role: Extract<InputRole, 'source' | 'module'> = 'source',
): FilenamesResult {
  const files: DiscoveredFile[] = [];
  const diagnostics: Diagnostic[] = [];
  const outputSources: string[] = [];
  const skippedOutputs: SkippedOutput[] = [];
  const output = outputPaths(toBuildOutputs(outputs));

  function problem(discovery: InputDiscovery, failure: InputFailure, path: string, cause: unknown): void {
    const diagnostic = problemDiagnostic(inputProblem(role, discovery, failure, path, cause));
    if (diagnostic !== undefined) diagnostics.push(diagnostic);
  }

  function addFile(id: PathIdentity, discovery: InputDiscovery, link: boolean): void {
    if (matchesExclude(id, exclude)) return;
    files.push({ path: id.display, key: id.key, discovery, ...(link ? { link } : {}) });
  }

  function walkDir(pathname: string, discovery: InputDiscovery, folder: string): void {
    let entries: string[];
    try {
      entries = readdirSync(pathname).sort(compareNames);
    } catch (e) {
      problem(discovery, 'unreadable-folder', pathname, e);
      return;
    }
    for (const entry of entries) walkEntry(join(pathname, entry), folder);
  }

  function walkEntry(pathname: string, folder: string): void {
    let stat: Stats;
    let link = false;
    try {
      stat = lstatSync(pathname);
      if (stat.isSymbolicLink()) {
        link = true;
        const target = statSync(pathname, { throwIfNoEntry: false });
        if (target === undefined) {
          problem('found', 'dangling-link', pathname, readLinkText(pathname));
          return;
        }
        // A link to a folder is not followed.
        if (target.isDirectory()) return;
        stat = target;
      }
    } catch (e) {
      problem('found', 'unreadable', pathname, e);
      return;
    }
    if (stat.isFile()) {
      const id = identify(pathname);
      if (output.isFile(pathname)) {
        if (!matchesExclude(id, exclude)) skippedOutputs.push({ path: id.display, folder });
        return;
      }
      addFile(id, 'found', link);
    } else if (stat.isDirectory()) {
      if (!output.isDir(pathname)) walkDir(pathname, 'found', folder);
    } else {
      problem('found', 'not-a-file', pathname, undefined);
    }
  }

  for (const pathname of pathnames) {
    if (pathname === '-') {
      diagnostics.push({ level: 'warning', message: 'path -: Reading from standard input is unsupported.' });
      continue;
    }
    let stat: Stats;
    try {
      stat = statSync(pathname);
    } catch (e) {
      if (isSymbolicLink(pathname)) problem('named', 'dangling-link', pathname, readLinkText(pathname));
      else problem('named', failureOfError(e), pathname, e);
      continue;
    }
    if (stat.isFile()) {
      if (output.isFile(pathname)) outputSources.push(pathname);
      else addFile(identify(pathname), 'named', lstatSync(pathname).isSymbolicLink());
    } else if (stat.isDirectory()) {
      walkDir(pathname, 'named', pathname);
    } else {
      problem('named', 'not-a-file', pathname, undefined);
    }
  }

  return { filenames: files.map((f) => f.path), files, diagnostics, outputSources, skippedOutputs };
}

/**
 * What `lstat` finds at `path`, or undefined when there is nothing it can look at: a missing path (ENOENT), a
 * path below a file (ENOTDIR), a folder it may not search (EACCES), a link loop (ELOOP). The watcher asks this
 * while the file system changes under it, and treats all of them as "not there yet".
 */
function lstatIfReadable(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Whether `path` is itself a symbolic link; false when it can't be looked at (the caller already has that cause). */
function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The target a link holds, for a message; undefined when it can't be read. */
function readLinkText(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/** The creator Twine 2 story data and JSON output name (see compiler.ts and output-twine2.ts). */
const CREATOR = 'Twee-ts';

/** The words Twine 1 HTML output puts where its story format has the `"VERSION"` placeholder. */
const TWINE1_VERSION_TEXT = 'Compiled with twee-ts, ';

/** Whether a parsed JSON value is the story JSON output writes: an object with the creator and the passages. */
function isStoryJson(value: JsonValue): boolean {
  if (!(value instanceof JsonObject)) return false;
  const member = (key: string): JsonValue | undefined => value.members.find((m) => m.key === key)?.value;
  return member('creator') === CREATOR && Array.isArray(member('passages'));
}

/**
 * Whether the file at `path` is a story twee-ts built, recognised by its structure and not by text that
 * happens to appear in it: JSON output is a JSON object with the creator and the passages; Twine 2 HTML and
 * archive output hold a `tw-storydata` element whose `creator` attribute is twee-ts; Twine 1 HTML output has
 * a store area, and the version text where its story format put it (in text or a comment, never only in an
 * attribute). HTML is read only from a file named as HTML (`.html`, `.htm`): any text parses as HTML, and a
 * script, a stylesheet or a Twee file that quotes `<tw-storydata creator="Twee-ts">` is not a build. Twee
 * output and Twine 1 archives carry no mark and are never recognised; false for a file that can't be read.
 */
export function isPreviousBuild(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const json = parseJSON(text);
  if (json.ok) return isStoryJson(json.value);
  if (!['html', 'htm'].includes(normalizedFileExt(path))) return false;
  const doc = parseHtml(text, false);
  const storyData = findStoryData(doc);
  if (storyData !== undefined) return attributeOf(storyData, 'creator') === CREATOR;
  return findStoreArea(doc) !== undefined && documentTextContains(doc, TWINE1_VERSION_TEXT);
}

/** Whether `path` has a file type the `role` loads from a folder. */
export function isLoadableType(path: string, role: Extract<InputRole, 'source' | 'module'>): boolean {
  if (role === 'source') return isKnownFileType(path);
  return ['css', 'js', 'otf', 'ttf', 'woff', 'woff2'].includes(normalizedFileExt(path));
}

/** A file the last build found, as the watcher is told about it (see WatchHandle.track). */
interface TrackedFile {
  readonly path: string;
  /** Reached through a symbolic link. */
  readonly link?: boolean;
}

export interface WatchHandle {
  close(): void;
  /**
   * Tells the watcher which files the last build found, for as long as the next call doesn't list them
   * again. Each one outside the watched folders, and each one reached through a symbolic link, is also
   * watched on its own (the link, every link on the way, and the target): Node's recursive watch on Linux
   * reports neither a change to a link's target outside the folder nor a link deleted or retargeted.
   */
  track(files: readonly TrackedFile[]): void;
}

/**
 * A watched path that can't be watched: fs.watch failed on it, or on the folder it is
 * watched through. watchFilesystem passes it to its `onError` and keeps watching the rest.
 */
export class WatchPathError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`Cannot watch ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'WatchPathError';
  }
}

/** What a stat finds at a path: a folder (with its identity) or something else. */
type PathKind =
  { readonly kind: 'dir'; readonly id: string } | { readonly kind: 'file' } | { readonly kind: 'missing' };

function pathKind(path: string): PathKind {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? { kind: 'dir', id: `${stats.dev}:${stats.ino}` } : { kind: 'file' };
  } catch {
    // Missing, or unreadable: either way, wait for it to change.
    return { kind: 'missing' };
  }
}

/** A folder a watched path is watched through, and the names in it that lead to the path. */
interface Anchor {
  readonly path: string;
  readonly id: string;
  readonly names: ReadonlySet<string>;
}

/**
 * Where a watched path stands, and so which folders its watches must be on. A watch follows the
 * folder it was started on, not its path, so the watches are set up again whenever this changes.
 */
interface RootState {
  /**
   * The folders the path is watched through, which see it, every symbolic link on the way to it and
   * its final target created, deleted, replaced or retargeted: the folder holding each, or while that
   * is missing, the nearest folder above it that exists.
   */
  readonly anchors: readonly Anchor[];
  /** The path itself, links followed: a folder is watched recursively; a file is watched through `anchors`. */
  readonly self: PathKind;
}

/** Links followed before a path counts as a cycle (Linux stops at 40 as well). */
const MAX_LINK_DEPTH = 40;

/**
 * Every place a change can alter what `abs` refers to: `abs` itself, each symbolic link met while
 * resolving it component by component (in the path's folders or as the path itself), and the final
 * target. Each is absolute; a relative link target is resolved against the folder that really holds it.
 */
function linkLocations(abs: string): string[] {
  const locations = [abs];
  const { root } = parse(abs);
  let resolved = root;
  let rest = abs.slice(root.length).split(sep).filter(Boolean);
  for (let hops = 0; rest.length > 0;) {
    const [name, ...after] = rest;
    const next = join(resolved, name ?? '');
    const stat = lstatIfReadable(next);
    if (stat?.isSymbolicLink() === true && hops < MAX_LINK_DEPTH) {
      hops++;
      if (!locations.includes(next)) locations.push(next);
      const target = readLinkText(next) ?? '';
      const targetRoot = isAbsolute(target) ? parse(target).root : '';
      resolved = targetRoot === '' ? resolved : targetRoot;
      rest = [...target.slice(targetRoot.length).split(/[\\/]/).filter(Boolean), ...after];
    } else {
      resolved = join(resolved, name ?? '');
      rest = after;
    }
  }
  if (!locations.includes(resolved)) locations.push(resolved);
  return locations;
}

function nearestFolderAbove(
  abs: string,
): { readonly path: string; readonly id: string; readonly name: string } | undefined {
  for (let dir = dirname(abs), below = abs; dir !== below; below = dir, dir = dirname(dir)) {
    const kind = pathKind(dir);
    if (kind.kind === 'dir') return { path: dir, id: kind.id, name: basename(below) };
  }
  return undefined;
}

function rootState(abs: string): RootState {
  // One watch per folder, however many spellings reach it (the path as written, and its real path).
  const byFolder = new Map<string, { path: string; names: Set<string> }>();
  for (const location of linkLocations(abs)) {
    const anchor = nearestFolderAbove(location);
    if (anchor === undefined) continue;
    const entry = byFolder.get(anchor.id) ?? { path: anchor.path, names: new Set<string>() };
    entry.names.add(anchor.name);
    byFolder.set(anchor.id, entry);
  }
  const anchors = [...byFolder].map(([id, { path, names }]) => ({ path, id, names }));
  return { anchors, self: pathKind(abs) };
}

/** Whether two states need the same watches: the same anchor folders (and names), and the same watched folder. */
function sameWatches(a: RootState, b: RootState): boolean {
  const selfId = (s: RootState): string | undefined => (s.self.kind === 'dir' ? s.self.id : undefined);
  const anchorsId = (s: RootState): string => JSON.stringify(s.anchors.map((x) => [x.path, x.id, [...x.names].sort()]));
  return selfId(a) === selfId(b) && anchorsId(a) === anchorsId(b);
}

/** One watched path (a source, module or head file, or a file a build read through a link), as given and absolute. */
interface Root {
  readonly path: string;
  readonly abs: string;
  /** Watched because a build read it (see WatchHandle.track), not because it was named. */
  readonly tracked: boolean;
  state: RootState;
  watchers: FSWatcher[];
  /** The folders found under a watched folder, by identity key, so a folder that goes away is recognised. */
  folders: Set<string>;
  /** A watch could not be started, or broke: it is tried again on the next event in its anchor folder. */
  failed: boolean;
  /** The last failure reported, so that one that persists is reported once. */
  lastReport: string | undefined;
}

/** How long watch mode waits for changes to settle before it builds. */
export interface WatchTiming {
  /** A build starts this long after the last change (default 500 ms, Tweego's rate). */
  readonly debounceMs?: number;
  /** …but no later than this long after the first change it builds (default 1000 ms), so a steady stream still builds. */
  readonly maxWaitMs?: number;
}

/** Every folder below `dir` (links to folders not followed), by identity key, `dir` included. */
function foldersUnder(dir: string): Set<string> {
  const found = new Set<string>([identify(dir).key]);
  const visit = (path: string): void => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(path, entry.name);
      found.add(identify(child).key);
      visit(child);
    }
  };
  visit(dir);
  return found;
}

/**
 * Watch paths for changes, calling the build callback on known file type changes.
 * A folder is watched recursively; a file is watched on its own and counts
 * whatever its type (a head file, say). A change to a file `ignore` returns true
 * for (given the path relative to the working directory) schedules no build.
 *
 * Events are hints, not the truth: every build walks the sources again. A change to a file of a known
 * type is reported as that file (`changedFiles`, the path relative to the working directory), so it is
 * read again whatever its modification time. Any event on something that is not such a file (a folder
 * created, deleted, moved or renamed, or a path that was a folder) schedules a full build
 * (`changedFiles` undefined), which revalidates every cached file. Changes to files of unknown types
 * schedule nothing.
 *
 * A build starts once changes stop for `timing.debounceMs`, but no later than `timing.maxWaitMs` after
 * the first change it covers, so a steady stream of changes still builds.
 *
 * A watched path that doesn't exist yet is waited for, and one that is deleted, or renamed away and
 * replaced, is followed to the new folder or file at its path: each path is watched through the folder
 * above it, and so are every symbolic link on the way to it and its final target (#239), so editing,
 * replacing or retargeting any of them rebuilds. When that sets up a path's watches again, the next build
 * is a full one, since changes made in between went unseen. A path that can't be watched is passed to
 * `onError` as a WatchPathError, once while the failure persists; the other paths are still watched.
 */
export function watchFilesystem(
  pathnames: string[],
  outFilename: string,
  callback: (changedFiles?: ReadonlySet<string>) => void,
  ignore: (filename: string) => boolean = () => false,
  onError: (error: WatchPathError) => void = () => {
    // Errors are dropped when the caller does not ask for them.
  },
  timing: WatchTiming = {},
): WatchHandle {
  const output = outputPaths(toBuildOutputs(outFilename));
  const debounceMs = timing.debounceMs ?? 500;
  const maxWaitMs = Math.max(debounceMs, timing.maxWaitMs ?? 2 * debounceMs);
  let buildTimer: ReturnType<typeof setTimeout> | null = null;
  let firstPendingAt: number | undefined;
  const pendingFiles = new Set<string>();
  let pendingFullBuild = false;
  let closed = false;
  /** The files the last build read, as reported (see WatchHandle.track). */
  let lastInputs: ReadonlySet<string> = new Set();

  // `changedFile` undefined: a full build, which wins over the changed files pending with it.
  function scheduleBuild(changedFile?: string): void {
    if (changedFile === undefined) pendingFullBuild = true;
    else pendingFiles.add(changedFile);
    const now = Date.now();
    firstPendingAt ??= now;
    if (buildTimer) clearTimeout(buildTimer);
    const delay = Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - now));
    buildTimer = setTimeout(() => {
      buildTimer = null;
      firstPendingAt = undefined;
      const files = pendingFullBuild || pendingFiles.size === 0 ? undefined : new Set(pendingFiles);
      pendingFiles.clear();
      pendingFullBuild = false;
      callback(files);
    }, delay);
  }

  const makeRoot = (path: string, tracked: boolean): Root => {
    const abs = resolve(path);
    const state = rootState(abs);
    return {
      path,
      abs,
      tracked,
      state,
      watchers: [],
      folders: state.self.kind === 'dir' ? foldersUnder(abs) : new Set(),
      failed: false,
      lastReport: undefined,
    };
  };
  const roots: Root[] = pathnames.map((path) => makeRoot(path, false));

  // A watched path that is a file counts whatever its type.
  const isNamedFile = (abs: string): boolean => roots.some((r) => r.abs === abs && r.state.self.kind === 'file');

  // A changed file. `named`: it is one of the watched paths itself, so it counts whatever its type.
  // Reported relative to the working directory, the form getFilenames gives.
  function fileChanged(abs: string, named: boolean): void {
    if (!named && !isKnownFileType(abs)) return;
    if (output.isFile(abs)) return;
    const { display } = identify(abs);
    if (!ignore(display)) scheduleBuild(display);
  }

  // An event in a watched folder `root` for the path `abs` below it.
  function changedBelow(root: Root, abs: string): void {
    if (output.isFile(abs)) return;
    const kind = pathKind(abs);
    if (kind.kind === 'dir') {
      // A folder created, moved in or renamed: walk again, and remember what is in it.
      for (const key of foldersUnder(abs)) root.folders.add(key);
      scheduleBuild();
      return;
    }
    if (kind.kind === 'missing') {
      const id = identify(abs);
      const gone = [...root.folders].filter((folder) => isKeyInside(folder, id.key, sep));
      if (gone.length > 0) {
        // A folder deleted, moved out or renamed: its files went with it, without events of their own.
        for (const folder of gone) root.folders.delete(folder);
        scheduleBuild();
        return;
      }
      // A dangling link (an editor's lock file, `.#a.tw`) is no source, unless the last build read a
      // file through it before its target went.
      if (lstatIfReadable(abs)?.isSymbolicLink() === true) {
        if (lastInputs.has(id.display)) scheduleBuild();
        return;
      }
    }
    fileChanged(abs, isNamedFile(abs));
  }

  function report(root: Root, cause: unknown): void {
    const error = new WatchPathError(root.path, cause);
    if (error.message === root.lastReport) return;
    root.lastReport = error.message;
    onError(error);
  }

  /** Starts one watch for `root`; false, with the error reported, when it can't be started. */
  function startWatch(root: Root, path: string, recursive: boolean, listener: (filename: string) => void): boolean {
    try {
      // A recursive watch on a folder it can't read starts without an error on Linux, and
      // then never reports anything: check first.
      if (recursive) accessSync(path, fsConstants.R_OK | fsConstants.X_OK);
      const watcher = fsWatch(path, { recursive }, (_event, filename) => {
        if (!closed) listener(filename ?? '');
      });
      watcher.on('error', (e) => {
        watcher.close();
        root.watchers = root.watchers.filter((w) => w !== watcher);
        root.failed = true;
        if (!closed && !recheck(root, false)) report(root, e);
      });
      root.watchers.push(watcher);
      return true;
    } catch (e) {
      report(root, e);
      return false;
    }
  }

  const selfKind = (root: Root): PathKind['kind'] => root.state.self.kind;

  // Starts the watches `root.state` calls for, closing any earlier ones.
  function arm(root: Root): void {
    for (const w of root.watchers) w.close();
    root.watchers = [];
    root.failed = false;
    const { anchors, self } = root.state;
    const anchorsStarted = anchors.map((anchor) =>
      startWatch(root, anchor.path, false, (filename) => {
        // A file is watched through its folder, not on its own: the OS reports only the file's
        // name for a watch on the file, and an editor that saves by replacing the file would
        // leave such a watch on the old one. Any event may mean the folder itself went away.
        const before = root.state.self.kind;
        recheck(root, true);
        // Read through a function: recheck() may have replaced root.state.
        const isFile = before === 'file' || selfKind(root) === 'file';
        if (isFile && anchor.names.has(filename)) fileChanged(root.abs, !root.tracked || isKnownFileType(root.abs));
      }),
    );
    const selfStarted =
      self.kind !== 'dir' ||
      startWatch(root, root.path, true, (filename) => {
        // No name: an event on the folder itself, such as its deletion.
        if (filename === '') recheck(root, true);
        else changedBelow(root, resolve(root.abs, filename));
      });
    if (anchorsStarted.every(Boolean) && selfStarted) root.lastReport = undefined;
    else root.failed = true;
  }

  /**
   * Sets up `root`'s watches again when its path, a link on the way to it, or the folder above any of
   * them is no longer the one they were started on (or, with `retry`, when one of them failed), and then
   * schedules a full build. Returns whether its state changed.
   */
  function recheck(root: Root, retry: boolean): boolean {
    const before = root.state;
    const after = rootState(root.abs);
    const changed = !sameWatches(before, after);
    const wasFailed = root.failed;
    if (!changed && !(retry && wasFailed)) {
      root.state = after;
      return false;
    }
    root.state = after;
    root.folders = after.self.kind === 'dir' ? foldersUnder(root.abs) : new Set();
    arm(root);
    const recovered = wasFailed && !root.failed;
    if ((changed || recovered) && (before.self.kind !== 'missing' || after.self.kind !== 'missing')) scheduleBuild();
    return changed;
  }

  for (const root of roots) arm(root);

  // Build once initially (no changedFiles = full build).
  callback();

  /** Whether `path` is already seen by a named root: inside a watched folder, or a watched file itself. */
  const covered = (key: string): boolean =>
    roots.some(
      (root) =>
        !root.tracked &&
        (root.state.self.kind === 'dir'
          ? isKeyInside(key, identify(root.abs).key, sep)
          : identify(root.abs).key === key),
    );

  return {
    close() {
      closed = true;
      if (buildTimer) clearTimeout(buildTimer);
      buildTimer = null;
      for (const root of roots) for (const w of root.watchers) w.close();
    },
    track(files) {
      if (closed) return;
      const wanted = new Map<string, string>();
      lastInputs = new Set(files.map((file) => file.path));
      for (const file of files) {
        if (file.link === true || !covered(identify(file.path).key)) wanted.set(resolve(file.path), file.path);
      }
      for (let i = roots.length - 1; i >= 0; i--) {
        const root = roots[i];
        if (root?.tracked !== true) continue;
        if (wanted.has(root.abs)) wanted.delete(root.abs);
        else if (lstatIfReadable(root.abs) !== undefined) {
          // Still there but no longer an input (excluded, say): stop watching it. One that went away is
          // still waited for: Node's recursive watch on Linux may not report a link created again in its
          // place.
          for (const w of root.watchers) w.close();
          roots.splice(i, 1);
        }
      }
      for (const path of wanted.values()) {
        const root = makeRoot(path, true);
        roots.push(root);
        arm(root);
      }
    },
  };
}

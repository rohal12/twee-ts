/**
 * File system utilities: path walking, file type detection, watch mode.
 * Ported from filesystem.go.
 */
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  watch as fsWatch,
} from 'node:fs';
import type { FSWatcher, Stats } from 'node:fs';
import * as nodePath from 'node:path';
import { basename, dirname, resolve, relative, join, sep } from 'node:path';
import { isKnownFileType } from './media-types.js';
import type { Diagnostic } from './types.js';

/**
 * Whether `filename` matches one of the `exclude` globs. The globs are matched
 * against the file's path relative to the working directory, the path
 * getFilenames reports; an absolute `filename` is made relative first. A leading
 * `./` in a glob is dropped. Matching is Node's `path.matchesGlob`.
 */
export function isExcluded(filename: string, exclude: readonly string[]): boolean {
  if (exclude.length === 0) return false;
  // Read from the namespace, not imported by name: path.matchesGlob arrived in
  // Node 22.5, and a named import would stop this module loading on 22.0-22.4.
  const { matchesGlob } = nodePath;
  if (typeof matchesGlob !== 'function') {
    throw new Error(`The exclude option needs Node.js 22.5 or newer (found ${process.version}).`);
  }
  const rel = relative(process.cwd(), resolve(filename)) || filename;
  return exclude.some((pattern) => matchesGlob(rel, pattern.replace(/^\.\//, '')));
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
export const NO_BUILD_OUTPUTS: BuildOutputs = { files: [], dirs: [] };

/** The outputs of a build that writes the one file `outFile`, or none without it. */
export function toBuildOutputs(outputs: BuildOutputs | string | undefined): BuildOutputs {
  if (outputs === undefined) return NO_BUILD_OUTPUTS;
  return typeof outputs === 'string' ? { files: [outputs], dirs: [] } : outputs;
}

/**
 * The path outputs are compared by: absolute, with every symbolic link in it
 * resolved, so two paths that reach the same file through different links (a
 * symlinked project folder, an alias of the output folder) compare equal. A
 * path that doesn't exist yet, such as the output before the first build, is
 * its nearest existing folder's real path joined with the rest.
 */
export function realPathOf(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync.native(abs);
  } catch {
    // Missing or unreadable: resolve the folder it would be in instead.
  }
  const parent = dirname(abs);
  return parent === abs ? abs : join(realPathOf(parent), basename(abs));
}

/** Whether the path `inner` is `outer` or inside it. */
function isSameOrInside(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/** A build's outputs as real paths (see realPathOf), with the checks discovery and the watchers make. */
export interface OutputPaths {
  /** Whether the real path `real` is a file the build writes. */
  isFile(real: string): boolean;
  /** Whether the real path `real` is a folder the build owns (see BuildOutputs.dirs). */
  isDir(real: string): boolean;
  /** Whether the folder at the real path `real` is an owned folder or holds an output, at any depth. */
  holds(real: string): boolean;
  /**
   * Whether source discovery, walking the folders `roots`, leaves the path out
   * as output: an output file, or a path it only reaches through an owned folder.
   */
  isOutput(path: string, roots: readonly string[]): boolean;
}

export function outputPaths(outputs: BuildOutputs): OutputPaths {
  const files = new Set(outputs.files.map(realPathOf));
  const dirs = new Set(outputs.dirs.map(realPathOf));
  const all = [...files, ...dirs];
  return {
    isFile: (real) => files.has(real),
    isDir: (real) => dirs.has(real),
    holds: (real) => dirs.has(real) || all.some((output) => output !== real && isSameOrInside(output, real)),
    isOutput(path, roots) {
      const real = realPathOf(path);
      if (files.has(real)) return true;
      const owners = [...dirs].filter((dir) => isSameOrInside(real, dir));
      if (owners.length === 0) return false;
      // A root walks into the path unless an owned folder below the root holds it.
      const reaching = roots.map(realPathOf).filter((root) => isSameOrInside(real, root));
      return reaching.every((root) => owners.some((dir) => dir !== root && isSameOrInside(dir, root)));
    },
  };
}

/**
 * A folder entry as source discovery walks it, found at `pathname` with the real
 * path `real` when it is no link: a link to a file counts as that file, and a
 * link to anything else (a folder above all) as nothing, undefined. Throws when
 * the entry or a link's target can't be read.
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

export interface FilenamesResult {
  readonly filenames: string[];
  /** One warning per path that could not be read. */
  readonly diagnostics: Diagnostic[];
  /**
   * The paths given that are themselves an output file. A build reading one would
   * overwrite its own source; the compiler refuses it, as Tweego does.
   */
  readonly outputSources: string[];
}

/**
 * Recursively walk directories, collecting regular file paths.
 *
 * Leaves out what the build writes (`outputs`, compared by real path, see
 * realPathOf) so its last output is never read back, and the files that match an
 * `exclude` glob (see isExcluded). A path given that is itself an output file is
 * not walked but listed in `outputSources`.
 *
 * Symbolic links: a path given is followed wherever it leads. Inside a folder, a
 * link to a file is read, but a link to a folder is not followed, as Tweego's walk
 * doesn't follow one. A link back to its own folder or a parent would otherwise
 * walk the same files again at every depth.
 *
 * Like Tweego, a path that cannot be read is reported as a warning and skipped.
 */
export function getFilenames(
  pathnames: readonly string[],
  outputs?: BuildOutputs | string,
  exclude: readonly string[] = [],
): FilenamesResult {
  const filenames: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const outputSources: string[] = [];
  const output = outputPaths(toBuildOutputs(outputs));

  function warn(pathname: string, e: unknown): void {
    diagnostics.push({ level: 'warning', message: `path ${pathname}: ${e instanceof Error ? e.message : String(e)}` });
  }

  function addFile(pathname: string): void {
    const abs = resolve(pathname);
    const rel = relative(process.cwd(), abs);
    if (isExcluded(rel || abs, exclude)) return;
    filenames.push(rel || abs);
  }

  // A folder's entries. `real` is the folder's real path; an entry that is no link
  // has the real path `real/entry`, so no entry needs resolving.
  function walkDir(pathname: string, real: string): void {
    let entries;
    try {
      entries = readdirSync(pathname);
    } catch (e) {
      warn(pathname, e);
      return;
    }
    for (const entry of entries) walkEntry(join(pathname, entry), join(real, entry));
  }

  function walkEntry(pathname: string, real: string): void {
    let entry;
    try {
      entry = walkedEntry(pathname, real);
    } catch (e) {
      warn(pathname, e);
      return;
    }
    if (entry === undefined) return;
    if (entry.stat.isFile()) {
      if (!output.isFile(entry.real)) addFile(pathname);
    } else if (entry.stat.isDirectory() && !output.isDir(entry.real)) {
      walkDir(pathname, entry.real);
    }
  }

  for (const pathname of pathnames) {
    let stat;
    try {
      stat = statSync(pathname);
    } catch (e) {
      warn(pathname, e);
      continue;
    }
    const real = realPathOf(pathname);
    if (stat.isFile()) {
      if (output.isFile(real)) outputSources.push(pathname);
      else addFile(pathname);
    } else if (stat.isDirectory()) {
      walkDir(pathname, real);
    }
  }

  return { filenames, diagnostics, outputSources };
}

export interface WatchHandle {
  close(): void;
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
    super(`Cannot watch ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
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

/**
 * Where a watched path stands, and so which folders its watches must be on. A watch follows the
 * folder it was started on, not its path, so the watches are set up again whenever this changes.
 */
interface RootState {
  /**
   * The folder the path is watched through, which sees it created, deleted or replaced: its
   * parent folder, or while that is missing, the nearest folder above it that exists.
   */
  readonly anchor: { readonly path: string; readonly id: string } | undefined;
  /** The path itself: a folder is watched recursively; a file is watched through `anchor`. */
  readonly self: PathKind;
}

function rootState(abs: string): RootState {
  return { anchor: nearestFolderAbove(abs), self: pathKind(abs) };
}

function nearestFolderAbove(abs: string): RootState['anchor'] {
  for (let dir = dirname(abs), below = abs; dir !== below; below = dir, dir = dirname(dir)) {
    const kind = pathKind(dir);
    if (kind.kind === 'dir') return { path: dir, id: kind.id };
  }
  return undefined;
}

/** Whether two states need the same watches: the same anchor folder, and the same watched folder if any. */
function sameWatches(a: RootState, b: RootState): boolean {
  const selfId = (s: RootState): string | undefined => (s.self.kind === 'dir' ? s.self.id : undefined);
  return a.anchor?.path === b.anchor?.path && a.anchor?.id === b.anchor?.id && selfId(a) === selfId(b);
}

/** One watched path (a source, module or head file), as given and as an absolute path. */
interface Root {
  readonly path: string;
  readonly abs: string;
  state: RootState;
  watchers: FSWatcher[];
  /** A watch could not be started, or broke: it is tried again on the next event in its anchor folder. */
  failed: boolean;
  /** The last failure reported, so that one that persists is reported once. */
  lastReport: string | undefined;
}

/**
 * Watch paths for changes, calling the build callback on known file type changes.
 * A folder is watched recursively; a file is watched on its own and counts
 * whatever its type (a head file, say). A change to a file `ignore` returns true
 * for (given the path relative to the working directory) schedules no build.
 * Uses debouncing to avoid rapid rebuilds.
 *
 * A watched path that doesn't exist yet is waited for, and one that is deleted, or renamed
 * away and replaced, is followed to the new folder or file at its path: each path is also
 * watched through the folder above it. When that sets up a path's watches again, the next
 * build is a full one (`changedFiles` undefined), since changes made in between went unseen.
 * A path that can't be watched is passed to `onError` as a WatchPathError, once while the
 * failure persists; the other paths are still watched.
 */
export function watchFilesystem(
  pathnames: string[],
  outFilename: string,
  callback: (changedFiles?: ReadonlySet<string>) => void,
  ignore: (filename: string) => boolean = () => false,
  onError: (error: WatchPathError) => void = () => {},
): WatchHandle {
  const output = outputPaths(toBuildOutputs(outFilename));
  let buildTimer: ReturnType<typeof setTimeout> | null = null;
  const BUILD_DEBOUNCE = 500;
  const pendingFiles = new Set<string>();
  let pendingFullBuild = false;
  let closed = false;

  // `changedFile` undefined: a full build, which wins over the changed files pending with it.
  function scheduleBuild(changedFile?: string): void {
    if (changedFile === undefined) pendingFullBuild = true;
    else pendingFiles.add(changedFile);
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = setTimeout(() => {
      buildTimer = null;
      const files = pendingFullBuild || pendingFiles.size === 0 ? undefined : new Set(pendingFiles);
      pendingFiles.clear();
      pendingFullBuild = false;
      callback(files);
    }, BUILD_DEBOUNCE);
  }

  const roots: Root[] = pathnames.map((path) => {
    const abs = resolve(path);
    return { path, abs, state: rootState(abs), watchers: [], failed: false, lastReport: undefined };
  });

  // A watched path that is a file counts whatever its type.
  const isNamedFile = (abs: string): boolean => roots.some((r) => r.abs === abs && r.state.self.kind === 'file');

  // A changed file, as an absolute path. `named`: it is one of the watched paths
  // itself, so it counts whatever its type. Reported relative to the working
  // directory, the form getFilenames gives and the incremental cache is keyed by.
  function fileChanged(abs: string, named: boolean): void {
    if (!named && !isKnownFileType(abs)) return;
    // Compared by real path: the output may be reached through a link.
    if (output.isFile(realPathOf(abs))) return;
    const rel = relative(process.cwd(), abs);
    if (!ignore(rel || abs)) scheduleBuild(rel || abs);
  }

  function report(root: Root, cause: unknown): void {
    const error = new WatchPathError(root.path, cause);
    if (error.message === root.lastReport) return;
    root.lastReport = error.message;
    onError(error);
  }

  function startWatch(root: Root, path: string, recursive: boolean, listener: (filename: string) => void): void {
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
    } catch (e) {
      root.failed = true;
      report(root, e);
    }
  }

  // Starts the watches `root.state` calls for, closing any earlier ones.
  function arm(root: Root): void {
    for (const w of root.watchers) w.close();
    root.watchers = [];
    root.failed = false;
    const { anchor, self } = root.state;
    if (anchor) {
      startWatch(root, anchor.path, false, (filename) => {
        // A file is watched through its folder, not on its own: the OS reports only the file's
        // name for a watch on the file, and an editor that saves by replacing the file would
        // leave such a watch on the old one.
        const before = root.state.self.kind;
        recheck(root, true);
        const isFile = before === 'file' || isNamedFile(root.abs);
        if (isFile && filename !== '' && resolve(anchor.path, filename) === root.abs) fileChanged(root.abs, true);
      });
    }
    if (self.kind === 'dir') {
      startWatch(root, root.path, true, (filename) => {
        // No name: an event on the folder itself, such as its deletion.
        if (filename === '') recheck(root, true);
        else {
          const abs = resolve(root.abs, filename);
          fileChanged(abs, isNamedFile(abs));
        }
      });
    }
    if (!root.failed) root.lastReport = undefined;
  }

  /**
   * Sets up `root`'s watches again when its path, or the folder above it, is no longer the
   * one they were started on (or, with `retry`, when one of them failed), and then schedules a
   * full build. Returns whether its state changed.
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
    arm(root);
    const recovered = wasFailed && !root.failed;
    if ((changed || recovered) && (before.self.kind !== 'missing' || after.self.kind !== 'missing')) scheduleBuild();
    return changed;
  }

  for (const root of roots) arm(root);

  // Build once initially (no changedFiles = full build).
  callback();

  return {
    close() {
      closed = true;
      if (buildTimer) clearTimeout(buildTimer);
      for (const root of roots) for (const w of root.watchers) w.close();
    },
  };
}

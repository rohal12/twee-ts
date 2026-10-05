/**
 * File system utilities: path walking, file type detection, watch mode.
 * Ported from filesystem.go.
 */
import { readdirSync, statSync, watch as fsWatch } from 'node:fs';
import * as nodePath from 'node:path';
import { dirname, resolve, relative, join, sep } from 'node:path';
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

export interface FilenamesResult {
  readonly filenames: string[];
  /** One warning per path that could not be read. */
  readonly diagnostics: Diagnostic[];
}

/**
 * Recursively walk directories, collecting regular file paths.
 * Filters out the output file to prevent circular compilation, and the files
 * that match an `exclude` glob (see isExcluded).
 * Like Tweego, a path that cannot be read is reported as a warning and skipped.
 */
export function getFilenames(
  pathnames: string[],
  outFilename?: string,
  exclude: readonly string[] = [],
): FilenamesResult {
  const filenames: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const absOutFile = outFilename ? resolve(outFilename) : '';

  function warn(pathname: string, e: unknown): void {
    diagnostics.push({ level: 'warning', message: `path ${pathname}: ${e instanceof Error ? e.message : String(e)}` });
  }

  function walk(pathname: string): void {
    let stat;
    try {
      stat = statSync(pathname);
    } catch (e) {
      warn(pathname, e);
      return;
    }

    if (stat.isFile()) {
      const abs = resolve(pathname);
      if (abs === absOutFile) return;
      const rel = relative(process.cwd(), abs);
      if (isExcluded(rel || abs, exclude)) return;
      filenames.push(rel || abs);
    } else if (stat.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(pathname);
      } catch (e) {
        warn(pathname, e);
        return;
      }
      for (const entry of entries) {
        walk(join(pathname, entry));
      }
    }
  }

  for (const pathname of pathnames) {
    walk(pathname);
  }

  return { filenames, diagnostics };
}

export interface WatchHandle {
  close(): void;
}

/** Whether the absolute path `file` is the absolute path `dir` or inside it. */
function isInsideDir(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * The watched paths split into folders (as given) and files (absolute). A path
 * that cannot be read counts as a folder, which fs.watch then fails to watch.
 */
function splitWatchRoots(pathnames: readonly string[]): { dirs: string[]; files: Set<string> } {
  const dirs: string[] = [];
  const files = new Set<string>();
  for (const pathname of pathnames) {
    let isFile = false;
    try {
      isFile = statSync(pathname).isFile();
    } catch {
      // Unreadable: left to fs.watch, as a folder.
    }
    if (isFile) files.add(resolve(pathname));
    else dirs.push(pathname);
  }
  return { dirs, files };
}

/**
 * Watch paths for changes, calling the build callback on known file type changes.
 * A folder is watched recursively; a file is watched on its own and counts
 * whatever its type (a head file, say). A change to a file `ignore` returns true
 * for (given the path relative to the working directory) schedules no build.
 * Uses debouncing to avoid rapid rebuilds.
 */
export function watchFilesystem(
  pathnames: string[],
  outFilename: string,
  callback: (changedFiles?: ReadonlySet<string>) => void,
  ignore: (filename: string) => boolean = () => false,
): WatchHandle {
  const absOutFile = resolve(outFilename);
  const watchers: ReturnType<typeof fsWatch>[] = [];
  let buildTimer: ReturnType<typeof setTimeout> | null = null;
  const BUILD_DEBOUNCE = 500;
  const pendingFiles = new Set<string>();

  function scheduleBuild(changedFile?: string): void {
    if (changedFile) pendingFiles.add(changedFile);
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = setTimeout(() => {
      buildTimer = null;
      const files = pendingFiles.size > 0 ? new Set(pendingFiles) : undefined;
      pendingFiles.clear();
      callback(files);
    }, BUILD_DEBOUNCE);
  }

  // A changed file, as an absolute path. `named`: it is one of the watched paths
  // itself, so it counts whatever its type. Reported relative to the working
  // directory, the form getFilenames gives and the incremental cache is keyed by.
  function fileChanged(abs: string, named: boolean): void {
    if (abs === absOutFile) return;
    if (!named && !isKnownFileType(abs)) return;
    const rel = relative(process.cwd(), abs);
    if (!ignore(rel || abs)) scheduleBuild(rel || abs);
  }

  function watchPath(pathname: string, recursive: boolean, listener: (filename: string) => void): void {
    try {
      watchers.push(
        fsWatch(pathname, { recursive }, (_event, filename) => {
          if (filename) listener(filename);
        }),
      );
    } catch {
      // Ignore inaccessible paths
    }
  }

  const { dirs, files } = splitWatchRoots(pathnames);
  const absDirs = dirs.map((dir) => resolve(dir));
  for (const dir of dirs) {
    watchPath(dir, true, (filename) => {
      const abs = resolve(dir, filename);
      fileChanged(abs, files.has(abs));
    });
  }

  // A file is watched through its folder, not on its own: the OS reports only the
  // file's name for a watch on the file, and an editor that saves by replacing the
  // file would leave such a watch on the old one. A file inside a watched folder is
  // seen by that folder's watcher.
  const fileDirs = new Set(
    [...files].filter((file) => !absDirs.some((dir) => isInsideDir(file, dir))).map((file) => dirname(file)),
  );
  for (const dir of fileDirs) {
    watchPath(dir, false, (filename) => {
      const abs = resolve(dir, filename);
      if (files.has(abs)) fileChanged(abs, true);
    });
  }

  // Build once initially (no changedFiles = full build).
  callback();

  return {
    close() {
      if (buildTimer) clearTimeout(buildTimer);
      for (const w of watchers) w.close();
    },
  };
}

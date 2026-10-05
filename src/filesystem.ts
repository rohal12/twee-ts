/**
 * File system utilities: path walking, file type detection, watch mode.
 * Ported from filesystem.go.
 */
import { readdirSync, statSync, watch as fsWatch } from 'node:fs';
import * as nodePath from 'node:path';
import { resolve, relative, join } from 'node:path';
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

/**
 * Watch paths for changes, calling the build callback on known file type changes.
 * A change to a file `ignore` returns true for (given the path relative to the
 * working directory) schedules no build.
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

  for (const pathname of pathnames) {
    try {
      const watcher = fsWatch(pathname, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const abs = resolve(pathname, filename);
        if (abs === absOutFile) return;
        if (isKnownFileType(filename)) {
          const rel = relative(process.cwd(), abs);
          if (!ignore(rel || abs)) scheduleBuild(rel || abs);
        }
      });
      watchers.push(watcher);
    } catch {
      // Ignore inaccessible paths
    }
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

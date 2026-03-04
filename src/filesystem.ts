/**
 * File system utilities: path walking, file type detection, watch mode.
 * Ported from filesystem.go.
 */
import { readdirSync, statSync, watch as fsWatch } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { isKnownFileType } from './media-types.js';

/**
 * Recursively walk directories, collecting regular file paths.
 * Filters out the output file to prevent circular compilation.
 */
export function getFilenames(pathnames: string[], outFilename?: string): string[] {
  const filenames: string[] = [];
  const absOutFile = outFilename ? resolve(outFilename) : '';

  function walk(pathname: string): void {
    let stat;
    try {
      stat = statSync(pathname);
    } catch {
      return;
    }

    if (stat.isFile()) {
      const abs = resolve(pathname);
      if (abs === absOutFile) return;
      const rel = relative(process.cwd(), abs);
      filenames.push(rel || abs);
    } else if (stat.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(pathname);
      } catch {
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

  return filenames;
}

export interface WatchHandle {
  close(): void;
}

/**
 * Watch paths for changes, calling the build callback on known file type changes.
 * Uses debouncing to avoid rapid rebuilds.
 */
export function watchFilesystem(pathnames: string[], outFilename: string, callback: () => void): WatchHandle {
  const absOutFile = resolve(outFilename);
  const watchers: ReturnType<typeof fsWatch>[] = [];
  let buildTimer: ReturnType<typeof setTimeout> | null = null;
  const BUILD_DEBOUNCE = 500;

  function scheduleBuild(): void {
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = setTimeout(() => {
      buildTimer = null;
      callback();
    }, BUILD_DEBOUNCE);
  }

  for (const pathname of pathnames) {
    try {
      const watcher = fsWatch(pathname, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const abs = resolve(pathname, filename);
        if (abs === absOutFile) return;
        if (isKnownFileType(filename)) {
          scheduleBuild();
        }
      });
      watchers.push(watcher);
    } catch {
      // Ignore inaccessible paths
    }
  }

  // Build once initially.
  callback();

  return {
    close() {
      if (buildTimer) clearTimeout(buildTimer);
      for (const w of watchers) w.close();
    },
  };
}

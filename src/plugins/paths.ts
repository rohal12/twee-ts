/**
 * Path helpers for the bundler plugins. Watchers and bundlers spell one file
 * differently: macOS FSEvents reports /private/var/… for a file under /var/…,
 * Vite resolves module ids through symbolic links, Windows keeps a short 8.3
 * folder name (C:\Users\RUNNER~1) where another tool gives the long one, and
 * a case-insensitive volume takes any letter case. So the plugins compare
 * files by their identity key (see path-identity.ts), and spell a path they
 * hand a watcher by its canonical (real) path.
 */
import { dirname, resolve, sep } from 'node:path';
import type { BuildOutputs } from '../filesystem.js';
import { identify, isKeyInside } from '../path-identity.js';

/** The real path of `path`, with forward slashes: how the Vite plugin spells a path it hands a watcher. */
export function canonicalPath(path: string): string {
  return toPosix(identify(path).canonical);
}

/** The key a file is compared by: two paths name the same file exactly when their keys are equal. */
export function fileKey(path: string): string {
  return identify(path).key;
}

/** Whether the file with key `key` is one of the folders (or files) with keys `within`, or inside one. */
export function keyWithin(key: string, within: readonly string[]): boolean {
  return within.some((outer) => isKeyInside(key, outer, sep));
}

/** The output settings that say where a bundle is written, as Rollup and Vite pass them to generateBundle. */
export interface OutputLocation {
  readonly dir?: string | undefined;
  readonly file?: string | undefined;
}

/**
 * The absolute path a bundle writes the file it emits as `fileName` to: inside
 * `output.dir`, or next to `output.file`, either resolved against the working
 * directory, as the bundler resolves them. Undefined when the output names
 * neither, as for a bundle only generated in memory.
 */
function emittedFilePath(output: OutputLocation, fileName: string): string | undefined {
  const dir = output.dir ?? (output.file === undefined ? undefined : dirname(output.file));
  return dir === undefined ? undefined : resolve(dir, fileName);
}

/**
 * The locations a bundler's `output` option names: one output's settings or an
 * array of them, as a config gives them. Outputs that name neither `dir` nor
 * `file`, and anything that isn't an output's settings, are left out.
 */
export function outputLocations(option: unknown): OutputLocation[] {
  return (Array.isArray(option) ? option : [option]).flatMap((output: unknown): OutputLocation[] => {
    if (typeof output !== 'object' || output === null) return [];
    const dir: unknown = 'dir' in output ? output.dir : undefined;
    const file: unknown = 'file' in output ? output.file : undefined;
    const location = {
      ...(typeof dir === 'string' ? { dir } : {}),
      ...(typeof file === 'string' ? { file } : {}),
    };
    return location.dir === undefined && location.file === undefined ? [] : [location];
  });
}

/**
 * Every path the builds of one plugin instance write, gathered from what the
 * bundler reports: each output's location (`output.dir`, `output.file`, the
 * story inside it) and the files of each bundle written there. It is kept across
 * builds, so a compile also leaves out what another output of the same build
 * writes, before or after it, and files an earlier build wrote that the current
 * one doesn't (an old hashed chunk).
 */
export interface OutputRecord {
  /** Records an output location: its folder, its file, and the story it writes. */
  addLocation(output: OutputLocation): void;
  /** Records the files a bundle writes to `output`, by output file name. */
  addFiles(output: OutputLocation, fileNames: Iterable<string>): void;
  /** Every path recorded so far: `output.dir` folders as folders, the rest as files. */
  outputs(): BuildOutputs;
}

/** An empty OutputRecord for a plugin that writes its story as `storyFileName`. */
export function createOutputRecord(storyFileName: string): OutputRecord {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const addFiles = (output: OutputLocation, fileNames: Iterable<string>): void => {
    for (const fileName of fileNames) {
      const path = emittedFilePath(output, fileName);
      if (path !== undefined) files.add(path);
    }
  };
  return {
    addLocation(output) {
      if (output.dir !== undefined) dirs.add(resolve(output.dir));
      if (output.file !== undefined) files.add(resolve(output.file));
      addFiles(output, [storyFileName]);
    },
    addFiles,
    outputs: () => ({ files: [...files], dirs: [...dirs] }),
  };
}

/** The path with Windows separators turned into forward slashes. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Whether `file` is a temporary copy of a Vite config file. Vite writes one next
 * to the config file each time it loads it (when no node_modules folder is
 * above the config, and always under Deno), then deletes it.
 */
export function isViteConfigTemp(file: string): boolean {
  return /\.timestamp-\d+-[0-9a-f]*\.mjs$/.test(file);
}

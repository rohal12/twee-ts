/**
 * Path helpers for the bundler plugins. Vite reports module ids with forward
 * slashes on every platform, while node:path gives backslashes on Windows, so
 * the Vite plugin compares paths in forward-slash form only.
 */
import { dirname, resolve } from 'node:path';

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
export function emittedFilePath(output: OutputLocation, fileName: string): string | undefined {
  const dir = output.dir ?? (output.file === undefined ? undefined : dirname(output.file));
  return dir === undefined ? undefined : resolve(dir, fileName);
}

/** The path with Windows separators turned into forward slashes. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Whether `file` is one of `dirs` or inside one of them. All paths in forward-slash form. */
export function isInside(file: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => file === dir || file.startsWith(dir.endsWith('/') ? dir : `${dir}/`));
}

/**
 * Whether `file` is a temporary copy of a Vite config file. Vite writes one next
 * to the config file each time it loads it (when no node_modules folder is
 * above the config, and always under Deno), then deletes it.
 */
export function isViteConfigTemp(file: string): boolean {
  return /\.timestamp-\d+-[0-9a-f]*\.mjs$/.test(file);
}

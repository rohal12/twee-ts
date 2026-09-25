/**
 * Path helpers for the Vite plugin. Vite reports module ids with forward
 * slashes on every platform, while node:path gives backslashes on Windows, so
 * the plugin compares paths in forward-slash form only.
 */

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

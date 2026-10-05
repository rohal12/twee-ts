/**
 * Atomic file replacement, for every file twee-ts writes that something else may read
 * meanwhile: build output (which live-reload servers read on each change) and downloaded
 * story formats (which other twee-ts processes share).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Writes `data` to `path` so that a reader sees either the previous file or the complete new
 * one, never a partly written file. The data goes to a temporary file in the same folder,
 * which is then renamed over `path`. When `path` is a symlink, the file it points to is
 * replaced, and an existing file keeps its permissions.
 *
 * On failure (a full disk, a missing folder) the temporary file is removed, `path` is left
 * as it was, and the error is thrown with `path` in its message and its original `code`.
 */
export function writeFileAtomic(path: string, data: string): void {
  const target = followSymlink(path);
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, data, { encoding: 'utf-8', flag: 'wx' });
    keepPermissions(target, temp);
    renameSync(temp, target);
  } catch (e) {
    rmSync(temp, { force: true });
    throw writeError(path, e);
  }
}

/** The file a symlink at `path` points to, or `path` itself (also when it doesn't exist yet). */
function followSymlink(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Gives `temp` the permission bits of `target`, when `target` exists. Best effort: on a file
 * system without Unix permissions chmod can fail, and writing in place never kept them there either.
 */
function keepPermissions(target: string, temp: string): void {
  const existing = statSync(target, { throwIfNoEntry: false });
  if (existing === undefined) return;
  try {
    chmodSync(temp, existing.mode & 0o7777);
  } catch {
    // The new file keeps the default permissions.
  }
}

/** `cause` as an error that names `path` and keeps the original error code. */
function writeError(path: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  const error: Error & { code?: unknown } = new Error(`Cannot write ${path}: ${message}`, { cause });
  if (cause instanceof Error && 'code' in cause) error.code = cause.code;
  return error;
}

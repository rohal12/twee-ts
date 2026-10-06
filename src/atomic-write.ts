/**
 * Atomic file replacement, for every file twee-ts writes that something else may read
 * meanwhile: build output (which live-reload servers read on each change) and downloaded
 * story formats (which other twee-ts processes share).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Writes `data` to `path` so that a reader sees either the previous file or the complete new
 * one, never a partly written file. The data goes to a temporary file in the same folder,
 * which is then renamed over `path`. When `path` is a symlink (even a dangling one, or a chain of links), the file it
 * finally points to is replaced or created and the link stays, and an existing file keeps its permissions.
 *
 * On failure (a full disk, a missing folder) the temporary file is removed, `path` is left
 * as it was, and the error is thrown with `path` in its message and its original `code`.
 */
export function writeFileAtomic(path: string, data: string): void {
  let temp: string | undefined;
  try {
    const target = resolveWriteTarget(path);
    temp = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(temp, data, { encoding: 'utf-8', flag: 'wx' });
    keepPermissions(target, temp);
    renameSync(temp, target);
  } catch (e) {
    if (temp !== undefined) rmSync(temp, { force: true });
    throw writeError(path, e);
  }
}

/** Links followed before a path counts as a cycle (Linux stops at 40 as well). */
const MAX_LINK_DEPTH = 40;

/**
 * The file a symlink at `path` finally points to, or `path` itself when it is no link. Links are
 * followed one by one, so a link whose target does not exist yet (absolute, relative, or a chain
 * of them) still resolves to the file that should be created. A cycle or an unreadable link throws.
 */
function resolveWriteTarget(path: string): string {
  let current = path;
  for (let depth = 0; depth <= MAX_LINK_DEPTH; depth++) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) return current;
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw Object.assign(new Error(`ELOOP: too many levels of symbolic links, ${path}`), { code: 'ELOOP' });
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

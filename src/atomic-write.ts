/**
 * Writing the files twee-ts produces: build output, and downloaded story formats (which other
 * twee-ts processes share). How a file is written depends on what is at its path:
 *
 * | target | how |
 * |---|---|
 * | nothing, or a regular file with one link | atomic replace: a temporary file in the same folder, renamed over it |
 * | a regular file with more than one hard link | written in place, so every link sees the new build |
 * | a writable regular file whose folder takes no temporary file or rename (a read-only folder, a file bind-mounted on its own) | written in place, as Tweego writes it: not atomic |
 * | a read-only regular file | refused (EACCES), as Tweego's `os.Create` refuses it |
 * | a FIFO, a character device (`/dev/null`, a terminal), `/dev/stdout`, `/dev/fd/N`, a Windows device name (`NUL`) | written through, as a stream |
 * | a folder, a socket, a block device | refused |
 * | nothing, in a folder that does not exist | refused (ENOENT) |
 *
 * A symbolic link (even a dangling one, or a chain of them) is followed to the file it finally points to,
 * which is then written as above; the link stays. A replaced file keeps its permissions. An error names the
 * path the caller gave, never the temporary file.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { getSystemErrorMessage } from 'node:util';
import { identify } from './path-identity.js';

/**
 * Writes `data` to `path` as the table above says. An atomic replace means a reader sees either the
 * previous file or the complete new one, never a partly written file.
 *
 * On failure (a full disk, a missing folder, a refused target) a temporary file is removed, `path` is
 * left as it was (unless it was being written in place), and the error is thrown with `path` in its
 * message, its original `code`, and the original error as its `cause`.
 */
export function writeFileAtomic(path: string, data: string, platform: NodeJS.Platform = process.platform): void {
  try {
    writeTo(path, data, platform);
  } catch (e) {
    throw writeError(path, e);
  }
  const signature = signatureOf(path);
  if (signature !== undefined)
    ownOutputs.set(identify(path).key, { signature, hash: sha256(Buffer.from(data, 'utf-8')) });
}

/** What identifies a file this process wrote: its stat signature right after the write, and a hash of what was written. */
interface WrittenOutput {
  readonly signature: string;
  readonly hash: string;
}

/** The files this process wrote, by identity key. */
const ownOutputs = new Map<string, WrittenOutput>();

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * What identifies a regular file's state: size, inode and modification time. An edit in place that keeps all
 * of them (a copy that preserves timestamps) is not seen by this, so {@link isOwnOutput} also checks the content.
 */
function signatureOf(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false, bigint: true });
  return stat?.isFile() === true ? `${stat.size}:${stat.dev}:${stat.ino}:${stat.mtimeNs}` : undefined;
}

/**
 * Whether the file at `path` is one this process wrote and nothing has changed since: an earlier build of
 * a running watch, which may be written over. Its size, inode and modification time must be as they were
 * after the write, and it must hold exactly the bytes that were written: a same-size edit that restores the
 * modification time still changes the content, and the file is then the author's.
 */
export function isOwnOutput(path: string): boolean {
  const signature = signatureOf(path);
  const written = ownOutputs.get(identify(path).key);
  if (signature === undefined || written?.signature !== signature) return false;
  try {
    return sha256(readFileSync(path)) === written.hash;
  } catch {
    return false;
  }
}

/** How a target is written. */
type WriteStrategy = 'atomic' | 'in-place' | 'stream';

/**
 * The descriptor of this process that `path` names (`/dev/stdout` is 1, `/dev/fd/3` is 3), or undefined.
 * It is written directly: a socket (what a parent process often gives as standard output) can't be opened
 * by its `/dev/fd` path.
 */
export function ownDescriptor(path: string): number | undefined {
  const match = /^\/dev\/(?:(stdout)|(stderr)|fd\/(\d+))$|^\/proc\/self\/fd\/(\d+)$/.exec(posix.resolve(path));
  if (match === null) return undefined;
  if (match[1] !== undefined) return 1;
  if (match[2] !== undefined) return 2;
  return Number(match[3] ?? match[4]);
}

/** Writes all of `data` to the open descriptor `fd`, waiting while a non-blocking pipe is full. */
export function writeToDescriptor(
  fd: number,
  data: string,
  write: (fd: number, bytes: Buffer, offset: number) => number = writeSync,
): void {
  const bytes = Buffer.from(data, 'utf-8');
  for (let offset = 0; offset < bytes.length;) {
    try {
      offset += write(fd, bytes, offset);
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'EAGAIN')) throw e;
      pause(1);
    }
  }
}

/**
 * Throws, as writeFileAtomic() would, when `path` can't be written: a folder, a read-only file, a missing
 * folder. A caller checks this before a build, so a target that can't be written fails before the work.
 */
export function checkWritable(path: string, platform: NodeJS.Platform = process.platform): void {
  try {
    planWrite(path, platform);
  } catch (e) {
    throw writeError(path, e);
  }
}

/** The file `path` is written to (links resolved) and how, or undefined for a stream path; throws when it can't be. */
function planWrite(
  path: string,
  platform: NodeJS.Platform,
): { readonly target: string; readonly strategy: WriteStrategy } | undefined {
  if (isStreamPath(path, platform)) return undefined;
  const target = resolveWriteTarget(path);
  const stat = statSync(target, { throwIfNoEntry: false });
  if (stat === undefined) checkFolder(target);
  return { target, strategy: strategyFor(target, stat) };
}

/**
 * Throws when the folder that would hold the new file `target` does not exist. (A file where a folder should
 * be has already failed the look at `target`, with ENOTDIR.)
 */
function checkFolder(target: string): void {
  const folder = dirname(target);
  if (statSync(folder, { throwIfNoEntry: false }) === undefined)
    throw codeError('ENOENT', `the folder ${folder} does not exist`);
}

function writeTo(path: string, data: string, platform: NodeJS.Platform): void {
  const plan = planWrite(path, platform);
  if (plan === undefined) {
    const fd = platform === 'win32' ? undefined : ownDescriptor(path);
    if (fd === undefined) writeFileSync(path, data, { encoding: 'utf-8' });
    else writeToDescriptor(fd, data);
    return;
  }
  const { target, strategy } = plan;
  switch (strategy) {
    case 'stream':
    case 'in-place':
      writeFileSync(target, data, { encoding: 'utf-8' });
      return;
    case 'atomic':
      replaceAtomically(target, data);
      return;
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`unhandled write strategy: ${String(_exhaustive)}`);
    }
  }
}

/** An error with a Node-style `code`. */
function codeError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** How the file at `target` (links resolved) is written, or a thrown error when it must not be. */
export function strategyFor(target: string, stat: Stats | undefined): WriteStrategy {
  if (stat === undefined) return 'atomic';
  if (stat.isDirectory()) throw codeError('EISDIR', 'the output is a folder');
  if (stat.isFIFO() || stat.isCharacterDevice()) return 'stream';
  if (!stat.isFile()) throw codeError('EINVAL', 'the output is not a file, a FIFO or a character device');
  try {
    accessSync(target, fsConstants.W_OK);
  } catch (cause) {
    throw Object.assign(codeError('EACCES', 'the output file is read-only'), { cause });
  }
  return stat.nlink > 1 ? 'in-place' : 'atomic';
}

/** Windows device names, which are devices in every folder and with any extension. */
const WINDOWS_DEVICE = /(?:^|[\\/])(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.[^\\/]*)?$/i;

/**
 * Whether `path` names a stream the operating system resolves itself, which is written through
 * without looking at it: the process's own descriptors (`/dev/stdout`, `/dev/stderr`, `/dev/fd/N`,
 * `/proc/self/fd/N`), whose links don't lead to a path that can be replaced, and on Windows the
 * device names (`NUL`, `CON`, `\\.\…`).
 */
export function isStreamPath(path: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return path.startsWith('\\\\.\\') || WINDOWS_DEVICE.test(path);
  }
  return /^\/dev\/(?:stdout|stderr|stdin|fd\/\d+)$|^\/proc\/(?:self|\d+)\/fd\/\d+$/.test(posix.resolve(path));
}

/**
 * Replaces `target` with a temporary file holding `data`, keeping the permissions of the file replaced. When
 * the folder refuses the temporary file or the rename and `target` is a file that can be written, it is
 * written in place instead (see canWriteInPlace).
 */
function replaceAtomically(target: string, data: string): void {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, data, { encoding: 'utf-8', flag: 'wx' });
    keepPermissions(target, temp);
    renameWithRetry(temp, target);
  } catch (e) {
    rmSync(temp, { force: true });
    if (!canWriteInPlace(target, e)) throw e;
    writeFileSync(target, data, { encoding: 'utf-8' });
  }
}

/**
 * Codes for a folder that takes no new file (EACCES, EPERM: a read-only folder) or no rename over the file
 * (EBUSY: a file bind-mounted on its own; on Windows also EPERM, EACCES while another program holds it open).
 */
const NO_REPLACE_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

/**
 * Whether a replace that failed with `error` falls back to writing `target` in place: the folder refused the
 * temporary file or the rename, and `target` is a regular file (strategyFor() found it writable). Tweego writes
 * every output in place, so a file it can rebuild, twee-ts can too; it is then not atomic. Any other failure (a
 * full disk, no file to write in place) is kept, and a file made read-only meanwhile refuses the write itself.
 */
function canWriteInPlace(target: string, error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return (
    typeof code === 'string' &&
    NO_REPLACE_CODES.has(code) &&
    statSync(target, { throwIfNoEntry: false })?.isFile() === true
  );
}

/** Codes Windows gives a rename over a file that another program (an antivirus, a live server) has open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** How long a rename on Windows is retried, in milliseconds per attempt. */
const RENAME_BACKOFF_MS = [10, 20, 40, 80, 160, 320] as const;

/** Blocks the thread for `ms` milliseconds (the write is synchronous, and short). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Renames `from` to `to`. On Windows a rename over a file another program holds open fails with
 * EPERM, EBUSY or EACCES for a moment; it is retried with a growing pause, about 0.6 s in all.
 */
export function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  platform: NodeJS.Platform = process.platform,
  wait: (ms: number) => void = pause,
): void {
  for (const delay of platform === 'win32' ? RENAME_BACKOFF_MS : []) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? e.code : undefined;
      if (typeof code !== 'string' || !TRANSIENT_RENAME_CODES.has(code)) throw e;
      wait(delay);
    }
  }
  rename(from, to);
}

/** Links followed before a path counts as a cycle (Linux stops at 40 as well). */
const MAX_LINK_DEPTH = 40;

/**
 * The file a symlink at `path` finally points to, or `path` itself when it is no link. Links are
 * followed one by one, so a link whose target does not exist yet (absolute, relative, or a chain
 * of them) still resolves to the file that should be created. A relative target is resolved against
 * the folder that really holds the link (see path-identity.ts). A cycle or an unreadable link throws.
 */
function resolveWriteTarget(path: string): string {
  let current = path;
  for (let depth = 0; depth <= MAX_LINK_DEPTH; depth++) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) return current;
    current = resolve(identify(dirname(current)).canonical, readlinkSync(current));
  }
  throw codeError('ELOOP', `too many levels of symbolic links, ${path}`);
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

/**
 * `cause` as an error that names `path` and keeps the original error code. A system error's own message names
 * the file its call was given, which may be the temporary file: its code and description are used instead.
 */
function writeError(path: string, cause: unknown): Error {
  const message =
    cause instanceof Error && 'errno' in cause && typeof cause.errno === 'number' && 'code' in cause
      ? `${String(cause.code)}: ${getSystemErrorMessage(cause.errno)}`
      : cause instanceof Error
        ? cause.message
        : String(cause);
  const error: Error & { code?: unknown } = new Error(`Cannot write ${path}: ${message}`, { cause });
  if (cause instanceof Error && 'code' in cause) error.code = cause.code;
  return error;
}

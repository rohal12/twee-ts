/**
 * readUTF8() and readBase64() check a file's size before reading it. The check and the read must be of one file:
 * a file another process puts at the path in between is not the one read (CodeQL js/file-system-race).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBase64, readUTF8 } from '../src/util.js';

/** Runs once, right after the next call that reads a file's size. */
const pending = vi.hoisted(() => ({ afterSize: undefined as (() => void) | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const sized = <T>(stats: T): T => {
    const run = pending.afterSize;
    pending.afterSize = undefined;
    run?.();
    return stats;
  };
  return {
    ...actual,
    statSync: (path: NodeFs.PathLike, options?: Parameters<typeof NodeFs.statSync>[1]) =>
      sized(actual.statSync(path, options)),
    fstatSync: (fd: number, options?: NodeFs.StatOptions) => sized(actual.fstatSync(fd, options)),
  };
});

// Windows does not rename a file over one that another handle holds open.
describe.skipIf(process.platform === 'win32')('a file replaced right after its size is checked', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-read-race-'));
  });

  afterEach(() => {
    pending.afterSize = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A file holding `checked`, which the next size check replaces with one holding `replacement`. */
  function replacedAfterCheck(checked: string, replacement: string): string {
    const file = join(dir, 'story.tw');
    const other = join(dir, 'other.tw');
    writeFileSync(file, checked);
    writeFileSync(other, replacement);
    pending.afterSize = () => {
      renameSync(other, file);
    };
    return file;
  }

  it('readUTF8 reads the file whose size it checked', () => {
    expect(readUTF8(replacedAfterCheck('checked', 'replaced'))).toBe('checked');
    expect(pending.afterSize).toBeUndefined();
  });

  it('readBase64 reads the file whose size it checked', () => {
    expect(readBase64(replacedAfterCheck('checked', 'replaced'))).toBe(Buffer.from('checked').toString('base64'));
    expect(pending.afterSize).toBeUndefined();
  });
});

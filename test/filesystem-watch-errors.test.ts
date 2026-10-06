import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FSWatcher } from 'node:fs';
import { watchFilesystem } from '../src/filesystem.js';
import type { WatchHandle, WatchPathError } from '../src/filesystem.js';
import type * as NodeFs from 'node:fs';

/** A stand-in for an `fs.FSWatcher`, so a test can make the OS watcher fail. */
class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

const watchers: FakeWatcher[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    watch: vi.fn(() => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    }),
  };
});

let dir: string;
let handle: WatchHandle | undefined;
let errors: WatchPathError[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-fs-watch-err-'));
  watchers.length = 0;
  errors = [];
});

afterEach(() => {
  handle?.close();
  handle = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function watchDir(withErrorHandler = true): void {
  handle = watchFilesystem(
    [dir],
    join(dir, 'out.html'),
    () => {},
    () => false,
    withErrorHandler ? (e) => errors.push(e) : undefined,
  );
}

describe('watchFilesystem when the OS watcher fails', () => {
  it('reports the failure as a WatchPathError and stops using the failed watcher', () => {
    watchDir();
    // One watcher on the folder above (for the folder's own deletion), one recursive on the folder.
    expect(watchers).toHaveLength(2);
    const [anchor, recursive] = watchers;
    recursive?.emit('error', new Error('EMFILE: too many open files'));
    expect(recursive?.closed).toBe(true);
    expect(anchor?.closed).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe('WatchPathError');
    expect(errors[0]?.path).toBe(dir);
    expect(errors[0]?.message).toBe(`Cannot watch ${dir}: EMFILE: too many open files`);
  });

  it('names a failure that is not an Error by its text', () => {
    watchDir();
    watchers[1]?.emit('error', 'watch limit reached');
    expect(errors.map((e) => e.message)).toEqual([`Cannot watch ${dir}: watch limit reached`]);
  });

  it('does not report a failure that arrives after close()', () => {
    watchDir();
    handle?.close();
    watchers[1]?.emit('error', new Error('late'));
    expect(errors).toEqual([]);
  });

  it('survives a failure when no error handler was given', () => {
    watchDir(false);
    expect(() => watchers[1]?.emit('error', new Error('boom'))).not.toThrow();
  });
});

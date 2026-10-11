/**
 * The probe that learns when the folder event stream runs again after a watch started or closed (folder-stream.ts,
 * #436). fs.watch is a stand-in here, so the test decides which probe events the stream reports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onStreamRunning, streamReplaced } from '../src/folder-stream.js';
import { watchFilesystem } from '../src/filesystem.js';

/** A stand-in for an `fs.FSWatcher` that reports what the test emits. */
class FakeWatcher extends EventEmitter {
  closed = false;
  constructor(
    readonly path: string,
    readonly listener: (event: string, filename: string | null) => void,
  ) {
    super();
  }
  close(): void {
    this.closed = true;
  }
}

const fake = vi.hoisted(() => ({ watchers: [] as unknown[], failOn: undefined as string | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    watch: vi.fn((path: string, ...rest: unknown[]) => {
      if (fake.failOn !== undefined && path.startsWith(fake.failOn)) throw new Error('EMFILE: too many open files');
      const listener = rest.find((x) => typeof x === 'function') as (event: string, filename: string | null) => void;
      const watcher = new FakeWatcher(path, listener);
      fake.watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    }),
  };
});

let parent: string;
const left: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-folder-stream-')));
  fake.watchers.length = 0;
  fake.failOn = undefined;
});

afterEach(() => {
  for (const leave of left.splice(0)) leave();
  vi.useRealTimers();
  rmSync(parent, { recursive: true, force: true });
});

const watchers = (): FakeWatcher[] => fake.watchers as FakeWatcher[];
const probeWatcher = (): FakeWatcher | undefined => watchers().find((w) => w.path.startsWith(parent));
const probeFiles = (): string[] => {
  const dir = probeWatcher()?.path;
  return dir === undefined || !existsSync(dir) ? [] : readdirSync(dir);
};

function subscribe(): { readonly calls: () => number } {
  let calls = 0;
  left.push(
    onStreamRunning(() => {
      calls++;
    }, parent),
  );
  return { calls: () => calls };
}

describe('the folder stream probe', () => {
  it('tells every listener once the stream reports the probe of the latest replacement', () => {
    const a = subscribe();
    const b = subscribe();
    streamReplaced();
    const [first = ''] = probeFiles();
    expect(first).toMatch(/^probe-\d+$/);
    streamReplaced();
    vi.advanceTimersByTime(25);
    // The newer replacement's file replaces the older one.
    const [second = ''] = probeFiles();
    expect(probeFiles()).toHaveLength(1);
    expect(second).not.toBe(first);
    // The event of the earlier stream says nothing about the new one.
    probeWatcher()?.listener('rename', first);
    expect([a.calls(), b.calls()]).toEqual([0, 0]);
    probeWatcher()?.listener('rename', second);
    expect([a.calls(), b.calls()]).toEqual([1, 1]);
    // Answered: later events of the same file, and the timer, do nothing.
    probeWatcher()?.listener('change', second);
    vi.advanceTimersByTime(1000);
    expect([a.calls(), b.calls()]).toEqual([1, 1]);
  });

  it('gives up writing after 10 s, and still answers a late event', () => {
    const a = subscribe();
    streamReplaced();
    const [name = ''] = probeFiles();
    vi.advanceTimersByTime(20_000);
    expect(vi.getTimerCount()).toBe(0);
    probeWatcher()?.listener('change', name);
    expect(a.calls()).toBe(1);
  });

  it('keeps trying when its folder goes away, and removes the folder when the last listener leaves', () => {
    subscribe();
    const dir = probeWatcher()?.path ?? '';
    rmSync(dir, { recursive: true });
    streamReplaced();
    vi.advanceTimersByTime(100);
    expect(existsSync(dir)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    for (const leave of left.splice(0)) leave();
    expect(vi.getTimerCount()).toBe(0);
    expect(probeWatcher()?.closed).toBe(true);
  });

  it('closes its watch when the watch fails, without an exception', () => {
    subscribe();
    expect(() => probeWatcher()?.emit('error', new Error('EMFILE'))).not.toThrow();
    expect(probeWatcher()?.closed).toBe(true);
  });

  it('does nothing without a folder to probe in, or without a watch on it', () => {
    left.push(onStreamRunning(() => undefined, join(parent, 'missing')));
    streamReplaced();
    expect(vi.getTimerCount()).toBe(0);
    for (const leave of left.splice(0)) leave();
    fake.failOn = parent;
    left.push(onStreamRunning(() => undefined, parent));
    streamReplaced();
    expect(vi.getTimerCount()).toBe(0);
    // The folder made for the probe is removed again.
    expect(readdirSync(parent)).toEqual([]);
  });

  it('does nothing when nothing listens', () => {
    streamReplaced();
    expect(vi.getTimerCount()).toBe(0);
    expect(watchers()).toEqual([]);
  });
});

describe('watchFilesystem on a shared folder stream', () => {
  it('builds in full once the stream runs again after its watches started, and after a failed watch', () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-folder-stream-src-')));
    const builds: (ReadonlySet<string> | undefined)[] = [];
    const handle = watchFilesystem(
      [dir],
      join(dir, 'out.html'),
      (files) => builds.push(files),
      () => false,
      () => undefined,
      {},
      { shared: true, probeParent: parent },
    );
    try {
      expect(builds).toEqual([undefined]);
      const current = (): string => probeFiles()[0] ?? '';
      probeWatcher()?.listener('rename', current());
      vi.advanceTimersByTime(500);
      expect(builds).toEqual([undefined, undefined]);
      // A watch that fails is closed: the stream is replaced again.
      watchers()
        .find((w) => w.path === dir)
        ?.emit('error', new Error('EMFILE'));
      vi.advanceTimersByTime(25);
      probeWatcher()?.listener('rename', current());
      vi.advanceTimersByTime(500);
      expect(builds.length).toBeGreaterThan(2);
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
    // The last listener left: the probe is gone.
    expect(probeWatcher()?.closed).toBe(true);
  });

  it('replaces the stream of the other watches when it closes, and builds no more itself', () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-folder-stream-src-')));
    const other = subscribe();
    const builds: (ReadonlySet<string> | undefined)[] = [];
    const handle = watchFilesystem(
      [dir],
      join(dir, 'out.html'),
      (files) => builds.push(files),
      () => false,
      () => undefined,
      {},
      { shared: true, probeParent: parent },
    );
    handle.close();
    rmSync(dir, { recursive: true, force: true });
    // Closing replaced the stream for the other listener, which hears when it runs.
    vi.advanceTimersByTime(25);
    probeWatcher()?.listener('rename', probeFiles()[0] ?? '');
    vi.advanceTimersByTime(500);
    expect(builds).toEqual([undefined]);
    expect(other.calls()).toBe(1);
  });
});

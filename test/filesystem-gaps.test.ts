import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FSWatcher } from 'node:fs';
import { isExcluded, watchFilesystem } from '../src/filesystem.js';

type Listener = (event: string, filename: string | null) => void;

const fake = vi.hoisted(() => ({ listeners: [] as { path: string; listener: Listener }[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    watch: (path: string, _options: unknown, listener: Listener) => {
      fake.listeners.push({ path, listener });
      return Object.assign(new Emitter(), { close: () => {} }) as unknown as FSWatcher;
    },
  };
});

// A path module without matchesGlob, as Node.js 22.0 to 22.4 has it.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, matchesGlob: undefined };
});

afterEach(() => {
  fake.listeners.length = 0;
  vi.useRealTimers();
});

describe('isExcluded on a Node.js without path.matchesGlob', () => {
  it('names the Node.js version the exclude option needs', () => {
    expect(() => isExcluded('a.tw', ['*.png'])).toThrow(/needs Node\.js 22\.5 or newer/);
  });

  it('excludes nothing, and needs no glob support, without exclude patterns', () => {
    expect(isExcluded('a.tw', [])).toBe(false);
  });
});

describe('watchFilesystem and an event without a file name', () => {
  it('treats it as an event on the folder itself: a deleted folder schedules a full build', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = mkdtempSync(join(tmpdir(), 'twee-ts-fs-gaps-'));
    const builds: (ReadonlySet<string> | undefined)[] = [];
    const handle = watchFilesystem(
      [dir],
      join(dir, 'out.html'),
      (files) => builds.push(files),
      () => false,
    );
    try {
      expect(builds).toEqual([undefined]);
      rmSync(dir, { recursive: true, force: true });
      const own = fake.listeners.find((l) => l.path === dir);
      expect(own).toBeDefined();
      own?.listener('rename', null);
      vi.advanceTimersByTime(500);
      expect(builds).toEqual([undefined, undefined]);
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FSWatcher } from 'node:fs';
import { watchFilesystem } from '../src/filesystem.js';
import type * as NodeFs from 'node:fs';

type Listener = (event: string, filename: string | null) => void;

const fake = vi.hoisted(() => ({ listeners: [] as { path: string; listener: Listener }[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    watch: (path: string, _options: unknown, listener: Listener) => {
      fake.listeners.push({ path, listener });
      return Object.assign(new Emitter(), { close: () => {} }) as unknown as FSWatcher;
    },
  };
});

afterEach(() => {
  fake.listeners.length = 0;
  vi.useRealTimers();
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

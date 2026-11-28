/** Healthy native link watches survive rebuilds, while replaced or failed parents are retried (#576). */
import { EventEmitter } from 'node:events';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinkWatch } from '../src/plugins/link-watch.js';
import type { LinkWatch } from '../src/plugins/link-watch.js';
import { cleanUp, makeProject } from './helpers/plugins.js';

class ParentWatch extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

const watches: ParentWatch[] = [];
const failing = new Set<string>();
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  return {
    ...real,
    watch: (path: unknown): FSWatcher => {
      if (failing.has(String(path))) throw new Error('Watch unavailable');
      const watcher = new ParentWatch();
      watches.push(watcher);
      return watcher as unknown as FSWatcher;
    },
  };
});

// The shared-stream probe owns separate fs.watch registrations. Its integration is covered by the recovery
// matrix and watch-shared-stream tests; these counts measure only the link watch's retained parents.
vi.mock('../src/folder-stream.js', () => ({
  onStreamRunning: vi.fn(() => vi.fn()),
  streamReplaced: vi.fn(),
}));

let handle: LinkWatch | undefined;
afterEach(async () => {
  handle?.close();
  handle = undefined;
  watches.length = 0;
  failing.clear();
  await cleanUp();
});

function start(): LinkWatch {
  // Exercise the shared-stream subscription on every OS, so probe isolation cannot regress only on macOS.
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    handle = createLinkWatch();
  } finally {
    Object.defineProperty(process, 'platform', { value: platform });
  }
  if (handle === undefined) throw new Error('The link watch could not be created');
  return handle;
}

describe('native link watch retention', () => {
  it('keeps a healthy parent registration even when the links within it change', () => {
    const parent = makeProject({});
    const watch = start();
    watch.watch([join(parent, 'one.tw')]);
    const first = watches[0];
    watch.watch([join(parent, 'two.tw'), join(parent, 'three.tw')]);
    expect(watches).toHaveLength(1);
    expect(first?.closed).toBe(false);
    watch.watch([]);
    expect(first?.closed).toBe(true);
  });

  it('reopens a replaced parent even with the same link paths', () => {
    const root = makeProject({});
    const parent = join(root, 'parent');
    mkdirSync(parent);
    const watch = start();
    const links = [join(parent, 'one.tw')];
    watch.watch(links);
    renameSync(parent, join(root, 'old-parent'));
    mkdirSync(parent);
    watch.watch(links);
    expect(watches).toHaveLength(2);
    expect(watches[0]?.closed).toBe(true);
    expect(watches[1]?.closed).toBe(false);
  });

  it.each(['missing', 'registration', 'error'] as const)('retries a %s parent failure on refresh', (failure) => {
    const root = makeProject({});
    const parent = join(root, 'parent');
    mkdirSync(parent);
    const watch = start();
    const links = [join(parent, 'one.tw')];
    if (failure === 'registration') failing.add(parent);
    watch.watch(links);
    if (failure === 'missing') {
      rmSync(parent, { recursive: true });
      watch.watch(links);
      mkdirSync(parent);
    } else if (failure === 'error') {
      watches[0]?.emit('error', new Error('Watch failed'));
    }
    failing.clear();
    const previous = watches.at(-1);
    watch.watch(links);
    const current = watches.at(-1);
    expect(current).toBeDefined();
    expect(current).not.toBe(previous);
    expect(current?.closed).toBe(false);
    // A late error on a retired watcher must not discard its replacement or create a timer after close.
    previous?.emit('error', new Error('Late failure'));
    expect(current?.closed).toBe(false);
    watch.close();
    current?.emit('error', new Error('After close'));
    expect(current?.closed).toBe(true);
  });
});

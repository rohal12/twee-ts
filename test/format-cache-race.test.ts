/**
 * One writer's cleanup and another writer saving the same bytes again for the same origin (#291): whatever the
 * order of their steps, the content directory the published record names is there and whole afterwards. Each
 * schedule runs the other writer at one step of the cleanup, found by the file system call that step makes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cpSync, readdirSync, renameSync, rmSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { join } from 'node:path';
import { cacheKey, getCacheDir, loadEntry, readRecord, removeStaleContent, writeEntry } from '../src/format-cache.js';
import type { CacheOrigin, NewRecord } from '../src/format-cache.js';
import { formatJs, isolateFormatEnvironment } from './helpers/format-server.js';

/** Runs once, just before or after the next file system call that `matches`. */
interface Interleave {
  readonly call: 'renameSync' | 'rmSync';
  readonly matches: (path: string, to?: string) => boolean;
  readonly when: 'before' | 'after';
  readonly run: () => void;
}

const pending = vi.hoisted(() => ({ interleaves: [] as Interleave[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  /** The interleave for this call, taken off the list so that what it runs is not interleaved again. */
  const take = (call: Interleave['call'], path: string, to?: string): Interleave | undefined => {
    const index = pending.interleaves.findIndex((i) => i.call === call && i.matches(path, to));
    return index === -1 ? undefined : pending.interleaves.splice(index, 1)[0];
  };
  return {
    ...actual,
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike) => {
      const interleave = take('renameSync', String(from), String(to));
      if (interleave?.when === 'before') interleave.run();
      actual.renameSync(from, to);
      if (interleave?.when === 'after') interleave.run();
    },
    rmSync: (path: NodeFs.PathLike, options?: NodeFs.RmOptions) => {
      const interleave = take('rmSync', String(path));
      if (interleave?.when === 'before') interleave.run();
      actual.rmSync(path, options);
      if (interleave?.when === 'after') interleave.run();
    },
  };
});

isolateFormatEnvironment('format-cache-race');

afterEach(() => {
  pending.interleaves.length = 0;
});

const ORIGIN = { kind: 'url', url: 'http://127.0.0.1/format.js' } as const satisfies CacheOrigin;

function record(): NewRecord {
  return {
    origin: ORIGIN,
    name: 'Race',
    version: '1.0.0',
    isTwine2: true,
    metadata: { proofing: false },
    main: 'format.js',
    fetchedAt: new Date().toISOString(),
    downloadUrl: ORIGIN.url,
  };
}

const files = (marker: string): ReadonlyMap<string, Uint8Array> =>
  new Map([['format.js', Buffer.from(formatJs('Race', '1.0.0', marker))]]);

const keyDir = (): string => join(getCacheDir(), 'entries', cacheKey(ORIGIN));
const isAside = (path: string): boolean => path.includes('.tmp-removed-');

function usable(): boolean {
  const saved = readRecord(ORIGIN);
  return saved !== undefined && 'record' in loadEntry(saved);
}

/**
 * Writer A has saved content A over content X and is about to clean up: the record names A, and the
 * directory of X is still there. Returns the name of X's directory.
 */
function replacedByA(): string {
  writeEntry(record(), files('X'));
  const x = readRecord(ORIGIN)?.dir ?? '';
  const kept = join(keyDir(), '..', 'kept-x');
  cpSync(join(keyDir(), x), kept, { recursive: true });
  writeEntry(record(), files('A'));
  cpSync(kept, join(keyDir(), x), { recursive: true });
  rmSync(kept, { recursive: true });
  return x;
}

/** Writer C saves the same bytes as X again. */
const writerC = (): void => {
  writeEntry(record(), files('X'));
};

describe('a cleanup and a writer that saves the replaced content again (#291)', () => {
  const schedules: Record<string, (x: string) => Interleave> = {
    'C saves and publishes before A sets X aside': (x) => ({
      call: 'renameSync',
      matches: (from, to) => from === join(keyDir(), x) && isAside(to ?? ''),
      when: 'before',
      run: writerC,
    }),
    'C saves and publishes after A sets X aside, before A reads the record again': (x) => ({
      call: 'renameSync',
      matches: (from, to) => from === join(keyDir(), x) && isAside(to ?? ''),
      when: 'after',
      run: writerC,
    }),
    'C saves and publishes after A read the record again, before A removes X': () => ({
      call: 'rmSync',
      matches: isAside,
      when: 'before',
      run: writerC,
    }),
    'C saves and publishes after A removed X': () => ({
      call: 'rmSync',
      matches: isAside,
      when: 'after',
      run: writerC,
    }),
  };

  it.each(Object.entries(schedules))('keeps X whole when %s', (_name, schedule) => {
    const x = replacedByA();
    pending.interleaves.push(schedule(x));
    removeStaleContent(keyDir(), x);
    expect(pending.interleaves).toEqual([]);
    expect(readRecord(ORIGIN)?.dir).toBe(x);
    expect(usable()).toBe(true);
    expect(readdirSync(keyDir()).sort()).toEqual([x, 'record.json']);
  });

  it('keeps X whole when C wrote X before A cleaned up, and publishes after A removed it', () => {
    const x = replacedByA();
    // C finds X there (and whole), then A's cleanup runs to its end, then C publishes.
    pending.interleaves.push({
      call: 'renameSync',
      matches: (_from, to) => to === join(keyDir(), 'record.json'),
      when: 'before',
      run: () => {
        removeStaleContent(keyDir(), x);
      },
    });
    writerC();
    expect(pending.interleaves).toEqual([]);
    expect(readRecord(ORIGIN)?.dir).toBe(x);
    expect(usable()).toBe(true);
  });

  it('leaves the entry as it is when another cleanup removed X first', () => {
    const x = replacedByA();
    pending.interleaves.push({
      call: 'renameSync',
      matches: (from, to) => from === join(keyDir(), x) && isAside(to ?? ''),
      when: 'before',
      run: () => {
        rmSync(join(keyDir(), x), { recursive: true });
      },
    });
    removeStaleContent(keyDir(), x);
    expect(pending.interleaves).toEqual([]);
    expect(readdirSync(keyDir()).filter((name) => name !== 'record.json')).toEqual([readRecord(ORIGIN)?.dir]);
    expect(usable()).toBe(true);
  });

  it('still removes the replaced content when no writer saves it again', () => {
    const x = replacedByA();
    removeStaleContent(keyDir(), x);
    expect(readdirSync(keyDir()).filter((name) => name !== 'record.json')).toEqual([readRecord(ORIGIN)?.dir]);
    expect(usable()).toBe(true);
  });

  it('removes what a cleanup that stopped part way set aside, once it is old', () => {
    const x = replacedByA();
    const aside = join(keyDir(), `.tmp-removed-1-abc`);
    renameSync(join(keyDir(), x), aside);
    removeStaleContent(keyDir(), undefined);
    expect(readdirSync(keyDir())).toContain('.tmp-removed-1-abc');
    removeStaleContent(keyDir(), undefined, Date.now() + 24 * 60 * 60 * 1000);
    expect(readdirSync(keyDir())).not.toContain('.tmp-removed-1-abc');
    expect(usable()).toBe(true);
  });
});

/**
 * Several processes share the format cache, and on Windows a rename over a file another process has open fails
 * with EPERM for a moment. Saving a cache entry retries it instead of giving up with a warning (the
 * `format-cache-concurrency` test failed on Windows CI this way).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type * as NodeFs from 'node:fs';
import { readRecord, writeEntry } from '../src/format-cache.js';
import type { CacheOrigin, NewRecord } from '../src/format-cache.js';
import { formatJs, isolateFormatEnvironment } from './helpers/format-server.js';

const busy = vi.hoisted(() => ({ failures: 0, attempts: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike) => {
      if (String(to).endsWith('record.json')) {
        busy.attempts++;
        if (busy.failures > 0) {
          busy.failures--;
          throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}'`), { code: 'EPERM' });
        }
      }
      actual.renameSync(from, to);
    },
  };
});

isolateFormatEnvironment('format-cache-windows-rename');

const platform = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  busy.failures = 0;
  busy.attempts = 0;
});

const ORIGIN = { kind: 'url', url: 'http://127.0.0.1/format.js' } as const satisfies CacheOrigin;

const RECORD: NewRecord = {
  origin: ORIGIN,
  name: 'Busy',
  version: '1.0.0',
  isTwine2: true,
  metadata: { proofing: false },
  main: 'format.js',
  fetchedAt: new Date().toISOString(),
  downloadUrl: ORIGIN.url,
};

describe('saving a cache entry while another process holds the record open (Windows)', () => {
  it('retries the rename of record.json until it goes through', () => {
    const files = new Map([['format.js', Buffer.from(formatJs('Busy', '1.0.0', 'X'))]]);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    busy.failures = 3;
    writeEntry(RECORD, files);
    Object.defineProperty(process, 'platform', platform ?? { value: 'linux' });
    expect(busy.attempts).toBe(4);
    expect(readRecord(ORIGIN)?.name).toBe('Busy');
  });
});

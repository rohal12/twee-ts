import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import { resolveRemoteFormat } from '../src/format-resolution.js';
import { isolateFormatEnvironment, indexJson, storySource, formatJs, entryPath } from './helpers/format-server.js';
import { LINEAR_GROWTH } from './helpers/growth.js';

isolateFormatEnvironment('selection-work');

function fetchUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

describe('failed format candidate selection work (#503)', () => {
  it.each([
    ['lookup', false],
    ['lookup', true],
    ['compile', false],
    ['compile', true],
  ] as const)('bounds SemVer parsing through %s (duplicate versions: %s)', async (mode, duplicates) => {
    let parses = 0;
    // Count the real shared SemVer parser, including all retry and final-diagnostic work.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with its native RegExp receiver.
    const exec = RegExp.prototype.exec;
    const spy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, text: string) {
      if (this.source.startsWith('^[vV]?')) parses += 1;
      return exec.call(this, text);
    });
    const work = async (n: number): Promise<number> => {
      const index = indexJson(
        Array.from({ length: n }, (_, i) => ({
          name: 'Review',
          version: `1.0.0+b${String(duplicates ? 0 : i)}`,
        })),
      );
      vi.stubGlobal('fetch', (input: string | URL | Request) =>
        Promise.resolve(
          new Response(fetchUrl(input).endsWith('/index.json') ? index : 'missing', {
            status: fetchUrl(input).endsWith('/index.json') ? 200 : 404,
          }),
        ),
      );
      const indices = ['https://selection.test/index.json'];
      parses = 0;
      const result =
        mode === 'lookup'
          ? resolveRemoteFormat('Review', '1.0.0', { indices, useDefaultIndices: false, resolutionTimeout: 0 })
          : compile({
              sources: storySource('Review', '1.0.0'),
              formatPaths: [],
              useTweegoPath: false,
              formatIndices: indices,
              useDefaultFormatIndices: false,
              formatResolutionTimeout: 0,
            });
      await expect(result).rejects.toMatchObject({ code: mode === 'lookup' ? 'FORMAT_UNAVAILABLE' : 'BUILD_FAILED' });
      return parses;
    };
    try {
      const small = await work(100);
      const large = await work(400);
      expect(small).toBeGreaterThan(0);
      expect(large).toBeLessThan(small * LINEAR_GROWTH);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['first', 'last'] as const)('obtains the %s usable candidate from a large ranked group', async (position) => {
    const versions = Array.from({ length: 400 }, (_, i) => `1.0.0+b${String(i)}`);
    const usable = position === 'first' ? versions[0] : versions.at(-1);
    const requests: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const url = fetchUrl(input);
      requests.push(url);
      if (url.endsWith('/index.json'))
        return Promise.resolve(new Response(indexJson(versions.map((version) => ({ name: 'Review', version })))));
      return Promise.resolve(
        url.endsWith(`/${entryPath('Review', usable ?? '')}`)
          ? new Response(formatJs('Review', usable ?? '', 'USABLE'))
          : new Response('missing', { status: 404 }),
      );
    });
    const found = await resolveRemoteFormat('Review', '1.0.0', {
      indices: ['https://selection.test/index.json'],
      useDefaultIndices: false,
      resolutionTimeout: 0,
    });
    expect(found?.version).toBe(usable);
    expect(requests).toHaveLength(position === 'first' ? 2 : 401);
  });

  it('uses a later intact cache after expiry, skipping missing and damaged copies without downloads', async () => {
    const indexUrl = 'https://selection.test/index.json';
    const options = { indices: [indexUrl], useDefaultIndices: false, timeout: 0, resolutionTimeout: 0 };
    // Prime both entries through the public resolver, then damage the first one's real file.
    for (const version of ['1.0.0+damaged', '1.0.0+intact']) {
      vi.stubGlobal('fetch', (input: string | URL | Request) =>
        Promise.resolve(
          new Response(
            fetchUrl(input).endsWith('/index.json')
              ? indexJson([{ name: 'Review', version }])
              : formatJs('Review', version),
          ),
        ),
      );
      const found = await resolveRemoteFormat('Review', '1.0.0', options);
      expect(found?.version).toBe(version);
      if (version === '1.0.0+damaged') writeFileSync(found?.filename ?? '', 'damaged');
    }
    const index = indexJson([
      ...Array.from({ length: 400 }, (_, i) => ({ name: 'Review', version: `1.0.0+missing${String(i)}` })),
      { name: 'Review', version: '1.0.0+damaged' },
      { name: 'Review', version: '1.0.0+intact' },
    ]);
    const requests: string[] = [];
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      requests.push(fetchUrl(input));
      if (fetchUrl(input).endsWith('/index.json')) return Promise.resolve(new Response(index));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('request aborted', { cause: signal.reason }));
          },
          { once: true },
        );
      });
    });
    try {
      const resolving = resolveRemoteFormat('Review', '1.0.0', { ...options, resolutionTimeout: 10 }).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(await resolving).toMatchObject({ version: '1.0.0+intact' });
      expect(requests).toEqual([indexUrl, `https://selection.test/${entryPath('Review', '1.0.0+missing0')}`]);
    } finally {
      vi.useRealTimers();
    }
  });
});

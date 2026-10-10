/**
 * Edge cases of the format cache, the index checks and the request layer: damaged cache entries,
 * cache writes that fail part way, response bodies that break off, and malformed index entries.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type * as NodeFs from 'node:fs';
import {
  cacheKey,
  clearCachedFormats,
  discoverCachedFormats,
  getCacheDir,
  listCachedFormats,
  listRecords,
  readRecord,
  writeEntry,
} from '../src/format-cache.js';
import type { CacheOrigin, NewRecord } from '../src/format-cache.js';
import { compile } from '../src/compiler.js';
import { resolveStoryFormat } from '../src/format-resolution.js';
import { describeFormatRequest, errorText, judgeCandidate, readFormatSource, selectFormat } from '../src/formats.js';
import {
  checkRemoteUrl,
  ensureGlobalDispatcher,
  fetchDirectFormat,
  fetchIndex,
  parseFormatIndex,
} from '../src/remote-formats.js';
import type { Diagnostic, FormatRequest } from '../src/types.js';
import {
  entryPath,
  formatJs,
  guardNetwork,
  indexEntry,
  indexJson,
  isolateFormatEnvironment,
  markerOf,
  startFormatServer,
  storySource,
} from './helpers/format-server.js';
import { seedIndexDownload, seedUrlDownload, OFFICIAL_INDEX } from './helpers/format-cache.js';

// renameSync passes through unless a test stands in for another process that finishes the same
// cache write first.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const realFs = await vi.importActual<typeof NodeFs>('node:fs');
const mockedRenameSync = vi.mocked(fs.renameSync);

const tempRoot = isolateFormatEnvironment('format-coverage');
const isRoot = process.getuid?.() === 0;
const posixOnly = isRoot || process.platform === 'win32';

/** The folder of a cache entry, from the path of its main file. */
const entryDirOf = (mainPath: string): string => dirname(dirname(mainPath));

function newRecord(origin: CacheOrigin, main = 'format.js'): NewRecord {
  return {
    origin,
    name: 'Review',
    version: '1.0.0',
    isTwine2: true,
    metadata: { proofing: false },
    main,
    fetchedAt: new Date(0).toISOString(),
    downloadUrl: 'https://example.test/format.js',
  };
}

const URL_ORIGIN: CacheOrigin = { kind: 'url', url: 'https://example.test/format.js' };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('record.json that is not one twee-ts wrote', () => {
  type Json = Record<string, unknown>;
  const damage: readonly (readonly [string, (record: Json) => unknown])[] = [
    ['not an object', () => [1]],
    ['another schema', (r) => ({ ...r, schema: 1 })],
    ['no origin', (r) => ({ ...r, origin: null })],
    ['a URL origin without a URL', (r) => ({ ...r, origin: { kind: 'url', url: 5 } })],
    ['an unknown origin kind', (r) => ({ ...r, origin: { kind: 'disk' } })],
    [
      'an index origin without a name',
      (r) => ({ ...r, origin: { kind: 'index', index: 'x', twine: 'twine2', version: '1' } }),
    ],
    [
      'an index origin with an unknown list',
      (r) => ({ ...r, origin: { kind: 'index', index: 'x', twine: 'twine3', name: 'a', version: '1' } }),
    ],
    ['another origin than its folder', (r) => ({ ...r, origin: { kind: 'url', url: 'https://elsewhere.test/' } })],
    ['files that are not an object', (r) => ({ ...r, files: 'format.js' })],
    ['a file twee-ts never writes', (r) => ({ ...r, files: { ...(r['files'] as Json), 'evil.sh': 'a'.repeat(64) } })],
    ['a hash that is not SHA-256', (r) => ({ ...r, files: { 'format.js': 'abc' } })],
    ['metadata without proofing', (r) => ({ ...r, metadata: {} })],
    ['a name that is not a string', (r) => ({ ...r, name: 1 })],
    ['isTwine2 that is not a boolean', (r) => ({ ...r, isTwine2: 'yes' })],
    ['a main file it does not list', (r) => ({ ...r, main: 'header.html' })],
    ['a content folder that does not match its files', (r) => ({ ...r, dir: 'b'.repeat(64) })],
    ['no fetch time', (r) => ({ ...r, fetchedAt: undefined })],
  ];

  it.each(damage)('is ignored when it has %s', (_label, change) => {
    const main = writeEntry(newRecord(URL_ORIGIN), new Map([['format.js', bytes(formatJs('Review', '1.0.0'))]]));
    const recordPath = join(entryDirOf(main), 'record.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf-8')) as Json;
    writeFileSync(recordPath, JSON.stringify(change(record)));
    expect(readRecord(URL_ORIGIN)).toBeUndefined();
    expect(listCachedFormats()).toEqual([]);
  });

  it('is ignored when it is not JSON', () => {
    const main = writeEntry(newRecord(URL_ORIGIN), new Map([['format.js', bytes(formatJs('Review', '1.0.0'))]]));
    writeFileSync(join(entryDirOf(main), 'record.json'), '{');
    expect(readRecord(URL_ORIGIN)).toBeUndefined();
  });

  it('keeps optional metadata and validators', () => {
    writeEntry(
      { ...newRecord(URL_ORIGIN), metadata: { proofing: true, author: 'A', license: 'MIT' }, lastModified: 'Mon' },
      new Map([['format.js', bytes(formatJs('Review', '1.0.0'))]]),
    );
    expect(readRecord(URL_ORIGIN)).toMatchObject({
      metadata: { proofing: true, author: 'A', license: 'MIT' },
      lastModified: 'Mon',
    });
  });
});

describe('cache entries whose files changed after they were written', () => {
  const formatUrl = (origin: string): string => `${origin}/format.js`;

  async function cached(): Promise<{ readonly main: string; readonly url: string }> {
    const server = await startFormatServer({ '/format.js': formatJs('Review', '1.0.0', 'SERVED') });
    const url = formatUrl(server.origin);
    const info = await fetchDirectFormat(url);
    await server.close();
    return { main: info.filename, url };
  }

  async function offlineBuild(url: string) {
    const diagnostics: Diagnostic[] = [];
    const info = await resolveStoryFormat(
      { kind: 'name', name: 'Review', version: '1.0.0' },
      { formatPaths: [], useTweegoPath: false, formatUrls: [url], noRemote: true },
      diagnostics,
    );
    return { info, messages: diagnostics.map((d) => d.message).join('\n') };
  }

  it('reports a cached file whose bytes changed, and does not use it', async () => {
    const { main, url } = await cached();
    writeFileSync(main, formatJs('Review', '1.0.0', 'TAMPERED'));
    const { info, messages } = await offlineBuild(url);
    expect(info).toBeUndefined();
    expect(messages).toMatch(
      /The cached copy of Review 1\.0\.0 cannot be used: .*format\.js has SHA-256 [0-9a-f]{64}, but was saved with [0-9a-f]{64}/,
    );
  });

  it('reports a cached file that is gone', async () => {
    const { main, url } = await cached();
    rmSync(main);
    expect((await offlineBuild(url)).messages).toContain('could not read');
    expect(listCachedFormats()[0]?.sizeBytes).toBe(0);
    expect(discoverCachedFormats().size).toBe(0);
  });

  it('reports a cached file replaced by a link', async () => {
    const { main, url } = await cached();
    const elsewhere = join(tempRoot(), 'elsewhere.js');
    cpSync(main, elsewhere);
    rmSync(main);
    symlinkSync(elsewhere, main);
    expect((await offlineBuild(url)).messages).toContain('is not a plain file');
  });

  it('downloads an index entry again when its cached copy is damaged', async () => {
    const text = formatJs('Review', '1.0.0', 'FRESH');
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('Review', '1.0.0', text)]),
      [`/${entryPath('Review', '1.0.0')}`]: text,
    });
    const options = {
      sources: storySource('Review', '1.0.0'),
      useTweegoPath: false,
      formatIndices: [`${server.origin}/index.json`],
    };
    const first = await compile(options);
    writeFileSync(first.format?.filename ?? '', 'garbage');
    const second = await compile(options);
    expect(markerOf(second.output)).toBe('FRESH');
    expect(second.diagnostics.map((d) => d.message)).toEqual([
      expect.stringMatching(/cannot be used: .*; downloading it again\.$/),
    ]);
  });

  it('keeps using the bytes it read, when the cache is cleared during a build', async () => {
    const { url } = await cached();
    const server = await startFormatServer({ '/format.js': formatJs('Review', '1.0.0', 'KEPT') });
    const info = await fetchDirectFormat(`${server.origin}/format.js`);
    clearCachedFormats();
    expect(readFormatSource(info)).toContain('KEPT');
    expect(url).not.toBe('');
  });
});

describe('cache writes that fail part way', () => {
  const files = new Map([['format.js', bytes(formatJs('Review', '1.0.0'))]]);

  it('refuses a record without its main file, or with a file twee-ts never reads', () => {
    expect(() => writeEntry(newRecord(URL_ORIGIN, 'header.html'), files)).toThrow(/needs its main file/);
    expect(() => writeEntry(newRecord(URL_ORIGIN), new Map([...files, ['run.sh', bytes('x')]]))).toThrow(
      /only format files/,
    );
  });

  it('refuses a content folder name taken by a file', () => {
    const main = writeEntry(newRecord(URL_ORIGIN), files);
    const contentDir = dirname(main);
    rmSync(contentDir, { recursive: true });
    writeFileSync(contentDir, 'not a folder');
    expect(() => writeEntry(newRecord(URL_ORIGIN), files)).toThrow(/is not a directory/);
  });

  it('accepts the content another process renamed into place first', () => {
    mockedRenameSync.mockImplementationOnce((from, to) => {
      // The other process finished the same write a moment earlier.
      realFs.cpSync(String(from), String(to), { recursive: true });
      realFs.renameSync(from, to);
    });
    const main = writeEntry(newRecord(URL_ORIGIN), files);
    expect(readFileSync(main, 'utf-8')).toBe(formatJs('Review', '1.0.0'));
    expect(readdirSync(entryDirOf(main)).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  it('leaves no temporary file when record.json cannot be replaced', () => {
    const keyDir = join(getCacheDir(), 'entries', cacheKey(URL_ORIGIN));
    mkdirSync(join(keyDir, 'record.json'), { recursive: true });
    expect(() => writeEntry(newRecord(URL_ORIGIN), files)).toThrow();
    expect(readdirSync(keyDir).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  it.skipIf(posixOnly)('reports an entry folder that cannot be created', () => {
    const entries = join(getCacheDir(), 'entries');
    mkdirSync(entries, { recursive: true });
    chmodSync(entries, 0o555);
    try {
      expect(() => writeEntry(newRecord(URL_ORIGIN), files)).toThrow(/EACCES/);
    } finally {
      chmodSync(entries, 0o755);
    }
  });

  it.skipIf(posixOnly)('reports content that cannot be written, leaving nothing behind', () => {
    const keyDir = join(getCacheDir(), 'entries', cacheKey(URL_ORIGIN));
    mkdirSync(keyDir, { recursive: true });
    chmodSync(keyDir, 0o555);
    try {
      expect(() => writeEntry(newRecord(URL_ORIGIN), files)).toThrow(/EACCES/);
      expect(readdirSync(keyDir)).toEqual([]);
    } finally {
      chmodSync(keyDir, 0o755);
    }
  });
});

describe('listing and clearing', () => {
  it('ignores folders in the entries folder that are not entries', () => {
    seedIndexDownload('Review', '1.0.0', formatJs('Review', '1.0.0'));
    mkdirSync(join(getCacheDir(), 'entries', 'not-a-hash'), { recursive: true });
    expect(listRecords()).toHaveLength(1);
  });

  it('removes the folders of twee-ts 1.x when clearing everything', () => {
    const legacyIndex = join(getCacheDir(), 'SugarCube', '2.37.3');
    const legacyUrls = join(tempRoot(), 'cache', 'twee-ts', 'storyformat-urls', 'abc');
    mkdirSync(legacyIndex, { recursive: true });
    mkdirSync(legacyUrls, { recursive: true });
    writeFileSync(join(legacyIndex, 'format.js'), formatJs('SugarCube', '2.37.3'));
    seedUrlDownload('https://example.test/f.js', 'Review', '1.0.0', formatJs('Review', '1.0.0'));
    expect(listCachedFormats().map((e) => e.name)).toEqual(['Review']);
    expect(clearCachedFormats()).toBe(1);
    expect(existsSync(legacyIndex)).toBe(false);
    expect(existsSync(legacyUrls)).toBe(false);
  });

  it('clears everything for an empty name too', () => {
    seedIndexDownload('Review', '1.0.0', formatJs('Review', '1.0.0'), OFFICIAL_INDEX);
    expect(clearCachedFormats('')).toBe(1);
  });

  it('reaches no origin it does not know', () => {
    expect(() => cacheKey({ kind: 'disk' } as unknown as CacheOrigin)).toThrow(/unhandled cache origin/);
  });
});

/** The name of a raw index entry, when it has a string one. */
function nameOf(raw: unknown): string | undefined {
  return typeof raw === 'object' && raw !== null && 'name' in raw && typeof raw.name === 'string'
    ? raw.name
    : undefined;
}

describe('format indices', () => {
  const parse = (json: unknown) =>
    parseFormatIndex(JSON.stringify(json), 'https://example.test/index.json', 'https://example.test/index.json');

  it.each([
    [null, '$.twine2[0] must be an object, not null'],
    [{ version: '1.0.0' }, '$.twine2[0] has no "name"'],
    [{ name: '', version: '1.0.0' }, '$.twine2[0].name "" is not a usable name'],
    [{ name: '..', version: '1.0.0' }, '$.twine2[0].name ".." is not a usable name'],
    [{ name: 'A' }, '$.twine2[0] has no "version"'],
    [{ name: 'A', version: 1 }, '$.twine2[0].version must be a string, not a number (1)'],
    [{ name: 'A', version: '01.0.0' }, '$.twine2[0].version "01.0.0" is not a SemVer version'],
    [{ name: 'A', version: '1.0.0', proofing: 'yes' }, '$.twine2[0].proofing must be a boolean, not a string ("yes")'],
    [
      { name: 'A', version: '1.0.0', files: 'format.js' },
      '$.twine2[0].files must be an array, not a string ("format.js")',
    ],
    [
      { name: 'A', version: '1.0.0', files: ['format.js', 3] },
      '$.twine2[0].files[1] must be a string, not a number (3)',
    ],
    [{ name: 'A', version: '1.0.0', checksums: ['x'] }, '$.twine2[0].checksums must be an object, not an array'],
    [
      { name: 'A', version: '1.0.0', checksums: { 'format.js': 5 } },
      '$.twine2[0].checksums["format.js"] must be a string, not a number (5)',
    ],
  ])('skips the entry %j: %s', (raw, reason) => {
    const index = parse({ twine2: [raw] });
    expect(index.entries).toEqual([]);
    expect(index.skipped).toEqual([
      {
        twine: 'twine2',
        position: 0,
        name: nameOf(raw),
        reason,
      },
    ]);
  });

  it('accepts an entry with only a name and a version, and lower-cases checksums', () => {
    const index = parse({ twine1: [{ name: 'A', version: '1.0.0', checksums: { 'header.html': 'AB'.repeat(32) } }] });
    expect(index.entries).toEqual([
      {
        twine: 'twine1',
        name: 'A',
        version: '1.0.0',
        proofing: false,
        files: undefined,
        checksums: new Map([['header.html', 'ab'.repeat(32)]]),
      },
    ]);
  });

  it.each([
    ['null', null, 'it is not a format index'],
    ['a list', [], 'it is not a format index'],
    ['a twine1 field that is not a list', { twine1: {} }, '$.twine1 must be an array, not an object'],
  ])('rejects an index that is %s', (_label, json, reason) => {
    expect(() => parse(json)).toThrow(reason);
  });

  it('keeps a __proto__ file name as an ordinary checksum key, and refuses a repeated member', () => {
    const text = `{"twine2": [
      {"name": "A", "version": "1.0.0", "checksums": {"__proto__": "${'c'.repeat(64)}"}},
      {"name": "B", "version": "1.0.0", "version": "2.0.0"}
    ]}`;
    const index = parseFormatIndex(text, 'https://example.test/index.json', 'https://example.test/index.json');
    expect([...(index.entries[0]?.checksums ?? [])]).toEqual([['__proto__', 'c'.repeat(64)]]);
    expect(Object.getPrototypeOf(index.entries[0]?.checksums)).toBe(Map.prototype);
    expect(index.skipped).toEqual([
      {
        twine: 'twine2',
        position: 1,
        name: 'B',
        reason: '$.twine2[1].version repeats the field "version"; the last one is used',
      },
    ]);
  });

  it('ignores members it does not use, as the Story Formats Archive lists them', () => {
    const index = parse({
      generated: '2026-10-06',
      twine2: [{ name: 'A', author: 'X', description: 'D', repo: 'r', version: '1.0.0', files: ['format.js'] }],
    });
    expect(index.entries.map((e) => e.name)).toEqual(['A']);
    expect(index.skipped).toEqual([]);
  });

  it('names the line and column of JSON that does not parse', () => {
    expect(() => parseFormatIndex('{"twine2": [}', 'u', 'u')).toThrow(/^it is not JSON: .*line 1, column 13/);
  });

  it('fetches an index once per compile', async () => {
    const server = await startFormatServer({ '/index.json': '{}' });
    const url = `${server.origin}/index.json`;
    await fetchIndex(url);
    await fetchIndex(url);
    expect(server.log).toEqual(['/index.json']);
  });
});

describe('requests', () => {
  /** Stub fetch with a fixed answer for the format URL. */
  function answer(response: () => Response | Promise<Response>): void {
    vi.stubGlobal('fetch', () => response());
  }

  it('rejects at once with a signal that has already aborted', async () => {
    const server = await startFormatServer({ '/format.js': formatJs('Review', '1.0.0') });
    const reason = new Error('stop');
    await expect(fetchDirectFormat(`${server.origin}/format.js`, { signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    expect(server.log).toEqual([]);
  });

  describe('connection attempts end with the request limit (#376)', () => {
    const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

    /** Stands in for undici's Agent, the class of the global dispatcher. */
    class FakeAgent {
      static readonly made: FakeAgent[] = [];
      static destroyFails = false;
      destroyed = false;
      constructor(readonly options: unknown) {
        FakeAgent.made.push(this);
      }
      dispatch(): boolean {
        return true;
      }
      destroy(): Promise<void> {
        this.destroyed = true;
        return FakeAgent.destroyFails ? Promise.reject(new Error('already destroyed')) : Promise.resolve();
      }
    }

    let saved: unknown;
    beforeEach(() => {
      saved = Reflect.get(globalThis, GLOBAL_DISPATCHER);
      FakeAgent.made.length = 0;
      FakeAgent.destroyFails = false;
      Reflect.set(globalThis, GLOBAL_DISPATCHER, new FakeAgent({}));
      FakeAgent.made.length = 0;
    });
    afterEach(() => {
      Reflect.set(globalThis, GLOBAL_DISPATCHER, saved);
    });

    /** Stubs fetch with the format, logging what each request was given. */
    function serve(): { dispatchers: unknown[] } {
      const log = { dispatchers: [] as unknown[] };
      vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
        log.dispatchers.push(init?.dispatcher);
        return Promise.resolve(new Response(formatJs('Review', '1.0.0')));
      });
      return log;
    }

    it('gives a request a dispatcher whose connect timeout is its limit, and frees it afterwards', async () => {
      const log = serve();
      await fetchDirectFormat('https://example.test/format.js', { timeout: 1500 });
      const [agent] = FakeAgent.made;
      expect(FakeAgent.made).toHaveLength(1);
      expect(agent?.options).toEqual({ connect: { timeout: 1500 } });
      expect(log.dispatchers).toEqual([agent]);
      expect(agent?.destroyed).toBe(true);
    });

    it('frees the dispatcher when the request fails', async () => {
      vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
      await expect(fetchDirectFormat('https://example.test/format.js', { timeout: 1500 })).rejects.toThrow(
        'fetch failed',
      );
      expect(FakeAgent.made.map((agent) => agent.destroyed)).toEqual([true]);
    });

    it('does not mind a dispatcher that cannot be destroyed', async () => {
      const log = serve();
      FakeAgent.destroyFails = true;
      await expect(fetchDirectFormat('https://example.test/format.js', { timeout: 1500 })).resolves.toMatchObject({
        name: 'Review',
      });
      expect(log.dispatchers).toHaveLength(1);
      expect(FakeAgent.made.map((agent) => agent.destroyed)).toEqual([true]);
    });

    it.each([[30_000], [10_000], [0]])(
      'leaves a limit of %i ms to undici, which ends a connect after ten seconds',
      async (timeout) => {
        const log = serve();
        await fetchDirectFormat('https://example.test/format.js', { timeout });
        expect(log.dispatchers).toEqual([undefined]);
        expect(FakeAgent.made).toEqual([]);
      },
    );

    it.each([
      ['a global dispatcher whose class cannot be built', () => ({ constructor: () => 1 })],
      [
        'a class that builds something else',
        () => ({
          constructor: function builds() {
            return { dispatch: 1 };
          },
        }),
      ],
      ['a global dispatcher that is no object', () => 'agent'],
    ])('uses the global dispatcher when it finds %s', async (_label, make) => {
      Reflect.set(globalThis, GLOBAL_DISPATCHER, make());
      const log = serve();
      await expect(fetchDirectFormat('https://example.test/format.js', { timeout: 1500 })).resolves.toMatchObject({
        name: 'Review',
      });
      expect(log.dispatchers).toEqual([undefined]);
    });

    it.each([
      ['answers', () => Promise.resolve(new Response(null))],
      ['fails', () => Promise.reject(new TypeError('fetch failed'))],
    ])(
      'asks for a data: URL to create the global dispatcher when no request has yet, and the request %s',
      async (_label, answerWith) => {
        Reflect.set(globalThis, GLOBAL_DISPATCHER, undefined);
        const asked: string[] = [];
        await ensureGlobalDispatcher((url) => {
          asked.push(url);
          return answerWith();
        });
        expect(asked).toEqual(['data:,']);
      },
    );

    it('does not ask when the global dispatcher exists', async () => {
      const asked: string[] = [];
      await ensureGlobalDispatcher((url) => {
        asked.push(url);
        return Promise.resolve(new Response(null));
      });
      expect(asked).toEqual([]);
    });
  });

  it('refuses a URL it cannot fetch', async () => {
    await expect(fetchDirectFormat('ftp://example.test/format.js')).rejects.toThrow(
      'Cannot download a format from "ftp://example.test/format.js": only http: and https: URLs are supported',
    );
  });

  it('reads an empty body as no format', async () => {
    answer(() => new Response(null));
    await expect(fetchDirectFormat('https://example.test/format.js')).rejects.toThrow(
      // The decoder's reason follows; its wording belongs to src/format-decode.ts.
      /^Failed to read the story format at https:\/\/example\.test\/format\.js: \S/,
    );
  });

  it('reports a body that is not made of bytes', async () => {
    answer(
      () =>
        new Response(
          // A body of strings, which the type of fetch's body rules out: it stands for one gone wrong.
          new ReadableStream<string>({
            start(controller) {
              controller.enqueue('text');
              controller.close();
            },
          }) as unknown as ReadableStream<Uint8Array>,
        ),
    );
    await expect(fetchDirectFormat('https://example.test/format.js')).rejects.toThrow(
      'Failed to download format from https://example.test/format.js: the response body is not a byte stream',
    );
  });

  it('reports a body that breaks off', async () => {
    const server = await startFormatServer({
      '/format.js': (_req, res) => {
        res.setHeader('content-length', '1000');
        // The headers and the first bytes arrive; then the connection drops.
        res.write('window.storyFormat(', () => {
          res.destroy();
        });
      },
    });
    // Usually the body breaks off ("terminated"); on a slow machine the drop can come before the
    // headers are read ("fetch failed"). Either way the URL and the cause are named.
    await expect(fetchDirectFormat(`${server.origin}/format.js`)).rejects.toThrow(
      new RegExp(`^Failed to download format from ${server.origin}/format\\.js: (terminated|fetch failed)`),
    );
  });

  it('reports a thrown value that is not an Error', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test: a rejection that is not an Error
    answer(() => Promise.reject('no route'));
    await expect(fetchDirectFormat('https://example.test/format.js')).rejects.toThrow(
      'Failed to download format from https://example.test/format.js: no route',
    );
    expect(errorText(42)).toBe('42');
  });

  it('reports a fetch error whose cause has no code', async () => {
    answer(() => Promise.reject(new TypeError('fetch failed', { cause: new Error('bad port') })));
    await expect(fetchDirectFormat('https://example.test/format.js')).rejects.toThrow('fetch failed (bad port)');
  });

  it('refuses a redirect to another scheme', async () => {
    answer(() => new Response(null, { status: 302, headers: { location: 'ftp://example.test/format.js' } }));
    await expect(fetchDirectFormat('https://example.test/format.js')).rejects.toThrow(
      'redirected to ftp://example.test/format.js, which is not allowed',
    );
  });

  it('treats 304 to an unconditional request as a failure', async () => {
    answer(() => new Response(null, { status: 304, statusText: 'Not Modified' }));
    await expect(fetchDirectFormat('https://example.test/format.js')).rejects.toThrow('304 Not Modified');
  });

  it('asks with Last-Modified when the server gives no ETag', async () => {
    const seen: (string | undefined)[] = [];
    const server = await startFormatServer({
      '/format.js': (req, res) => {
        seen.push(req.headers['if-modified-since']);
        if (req.headers['if-modified-since'] !== undefined) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader('last-modified', 'Mon, 05 Oct 2026 10:00:00 GMT');
        res.end(formatJs('Review', '1.0.0'));
      },
    });
    await fetchDirectFormat(`${server.origin}/format.js`);
    const again = await fetchDirectFormat(`${server.origin}/format.js`);
    expect(again.version).toBe('1.0.0');
    expect(seen).toEqual([undefined, 'Mon, 05 Oct 2026 10:00:00 GMT']);
  });

  it('accepts http and https URLs, dropping the fragment and keeping the query', () => {
    expect(checkRemoteUrl('https://example.test/a/index.json?rev=2#top')).toEqual({
      ok: true,
      url: 'https://example.test/a/index.json?rev=2',
    });
  });
});

describe('selection details', () => {
  it('orders local folders an ID names by letter case, and a format without a version last', () => {
    const local = (folder: string, version: string, isTwine2: boolean) => ({
      name: folder,
      version,
      isTwine2,
      source: 'local' as const,
      rank: 0,
      folder,
    });
    const candidates = [local('fmt', '', false), local('Fmt', '1.0.0', true), local('FMT', '', false)];
    expect(selectFormat({ kind: 'id', id: 'FMT' }, candidates)?.choice.folder).toBe('Fmt');
    expect(
      selectFormat(
        { kind: 'id', id: 'fmt' },
        [candidates[0], candidates[2]].flatMap((c) => c ?? []),
      )?.choice.folder,
    ).toBe('fmt');
  });

  it('reaches no request kind it does not know', () => {
    const request = { kind: 'path' } as unknown as FormatRequest;
    const candidate = { name: 'A', version: '1.0.0', isTwine2: true, source: 'url' as const, rank: 1 };
    expect(() => judgeCandidate(request, candidate)).toThrow(/unhandled format request/);
    expect(() => describeFormatRequest(request)).toThrow(/unhandled format request/);
  });

  it('describes a Twine 1 format a name request cannot use', async () => {
    const formats = join(tempRoot(), 'formats');
    mkdirSync(join(formats, 'jonah'), { recursive: true });
    writeFileSync(join(formats, 'jonah', 'header.html'), '<html></html>');
    const diagnostics: Diagnostic[] = [];
    const info = await resolveStoryFormat(
      { kind: 'name', name: 'jonah', version: '1.0.0' },
      { formatPaths: [formats], useTweegoPath: false, noRemote: true },
      diagnostics,
    );
    expect(info).toBeUndefined();
    expect(diagnostics.map((d) => d.message).join('\n')).toContain(
      '(jonah without a version): a Twine 1 format (StoryData names Twine 2 formats)',
    );
  });

  it('lists at most ten candidates that do not answer', async () => {
    const versions = Array.from({ length: 12 }, (_, i) => `1.${i}.0`);
    const server = await startFormatServer({ '/index.json': indexJson(versions.map((v) => indexEntry('Review', v))) });
    guardNetwork();
    const diagnostics: Diagnostic[] = [];
    await resolveStoryFormat(
      { kind: 'name', name: 'Review', version: '2.0.0' },
      { formatPaths: [], useTweegoPath: false, formatIndices: [`${server.origin}/index.json`] },
      diagnostics,
    );
    const error = diagnostics.find((d) => d.level === 'error')?.message ?? '';
    expect(error.match(/another major version than 2/g)).toHaveLength(10);
    expect(error).toContain('; and 2 more.');
  });
});

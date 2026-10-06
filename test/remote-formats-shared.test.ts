import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearIndexCache,
  discoverCachedFormats,
  fetchDirectFormat,
  fetchIndex,
  obtainIndexEntry,
  parseFormatIndex,
} from '../src/remote-formats.js';
import { resolveStoryFormat } from '../src/format-resolution.js';
import type { Diagnostic, FormatRequest, RemoteFetchOptions, SFAIndexEntry, StoryFormatInfo } from '../src/types.js';

/** A request the local server has received and holds until the test answers it. */
interface HeldRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Answers the request. */
  readonly answer: (body: string | Uint8Array) => void;
  /** Resolves once the client has dropped the connection. */
  readonly closed: Promise<void>;
}

interface TestServer {
  readonly origin: string;
  /** Requests received so far, in order. */
  readonly requests: readonly string[];
  /** Resolves with the next request the server receives (or has received and nobody took yet). */
  readonly next: () => Promise<HeldRequest>;
}

const servers: Server[] = [];

/** Starts a local server that holds every request until the test answers it, or `route` answers it. */
async function startServer(route?: (url: string) => string | Uint8Array | undefined): Promise<TestServer> {
  const requests: string[] = [];
  const arrived: HeldRequest[] = [];
  const waiting: ((held: HeldRequest) => void)[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const routed = route?.(req.url ?? '');
    if (routed !== undefined) {
      res.end(routed);
      return;
    }
    const held: HeldRequest = {
      req,
      res,
      answer: (body) => res.end(body),
      closed: new Promise((done) =>
        res.once('close', () => {
          done();
        }),
      ),
    };
    const waiter = waiting.shift();
    if (waiter) waiter(held);
    else arrived.push(held);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    next: () => {
      const held = arrived.shift();
      return held ? Promise.resolve(held) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}

let root: string;
let origCache: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'twee-ts-remote-shared-'));
  origCache = process.env['XDG_CACHE_HOME'];
  process.env['XDG_CACHE_HOME'] = join(root, 'cache');
  clearIndexCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>(
          (done) => (
            s.closeAllConnections(),
            s.close(() => {
              done();
            })
          ),
        ),
    ),
  );
  if (origCache !== undefined) process.env['XDG_CACHE_HOME'] = origCache;
  else delete process.env['XDG_CACHE_HOME'];
  rmSync(root, { recursive: true, force: true });
});

function formatText(name: string, version: string): string {
  return `window.storyFormat(${JSON.stringify({ name, version, source: '<html>{{STORY_DATA}}</html>' })});`;
}

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function entry(name: string, version: string, checksum?: string): SFAIndexEntry {
  return {
    name,
    version,
    proofing: false,
    files: ['format.js'],
    checksums: checksum === undefined ? {} : { 'format.js': checksum },
  };
}

/**
 * Obtain an index entry's format.js from `url`'s server, as an index at that server's root lists
 * it (every path of the test servers answers the same).
 */
async function fetchAndCacheFormat(
  listed: SFAIndexEntry,
  url: string,
  options: RemoteFetchOptions = {},
): Promise<StoryFormatInfo> {
  const index = parseFormatIndex(
    JSON.stringify({ twine2: [listed] }),
    'https://index.test/index.json',
    new URL('/index.json', url).href,
  );
  const [parsed] = index.entries;
  if (!parsed) throw new Error(`the test entry is not usable: ${JSON.stringify(index.skipped)}`);
  return (await obtainIndexEntry(index, parsed, options)).info;
}

/** Resolve a request as a compile does, with no local formats, and fail with the diagnostics when nothing answers. */
async function resolveRequest(request: FormatRequest, formatIndices: readonly string[]): Promise<StoryFormatInfo> {
  const diagnostics: Diagnostic[] = [];
  const home = process.env['HOME'];
  process.env['HOME'] = root;
  try {
    const info = await resolveStoryFormat(
      request,
      { formatPaths: [], useTweegoPath: false, formatIndices },
      diagnostics,
    );
    if (!info) throw new Error(diagnostics.map((d) => d.message).join('\n'));
    return info;
  } finally {
    if (home === undefined) delete process.env['HOME'];
    else process.env['HOME'] = home;
  }
}

const BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
const withBom = (text: string): Buffer => Buffer.concat([BOM, Buffer.from(text)]);

describe('checksums cover the downloaded bytes (#204)', () => {
  it('accepts a BOM-prefixed format.js whose checksum is of the served bytes', async () => {
    const bytes = withBom(formatText('Review', '1.0.0'));
    const server = await startServer(() => bytes);
    const info = await fetchAndCacheFormat(entry('Review', '1.0.0', sha256(bytes)), `${server.origin}/format.js`);
    expect(info.name).toBe('Review');
    // The cached copy holds the bytes as served, so a later read checks them against the same hash.
    expect(readFileSync(info.filename)).toEqual(bytes);
  });

  it('rejects a BOM-prefixed format.js whose checksum is of the text without the BOM', async () => {
    const text = formatText('Review', '1.0.0');
    const server = await startServer(() => withBom(text));
    await expect(
      fetchAndCacheFormat(entry('Review', '1.0.0', sha256(text)), `${server.origin}/format.js`),
    ).rejects.toThrow(/Checksum mismatch for http:.*\/twine2\/Review\/1\.0\.0\/format\.js/);
    expect(discoverCachedFormats().size).toBe(0);
  });

  it('rejects a wrong checksum for a BOM-prefixed format.js', async () => {
    const server = await startServer(() => withBom(formatText('Review', '1.0.0')));
    await expect(
      fetchAndCacheFormat(entry('Review', '1.0.0', '0'.repeat(64)), `${server.origin}/format.js`),
    ).rejects.toThrow(/Checksum mismatch/);
  });

  it('accepts bytes that are not valid UTF-8 when the checksum is of those bytes', async () => {
    const bytes = Buffer.concat([
      Buffer.from('window.storyFormat({"name":"Review","version":"1.0.0","source":"caf'),
      Buffer.from([0xe9]),
      Buffer.from('"});'),
    ]);
    const server = await startServer(() => bytes);
    const info = await fetchAndCacheFormat(entry('Review', '1.0.0', sha256(bytes)), `${server.origin}/format.js`);
    expect(info.version).toBe('1.0.0');
  });
});

describe('each caller keeps its own timeout when requests are shared (#205)', () => {
  const TIMEOUT_20 = /timed out after 20 ms/;

  it('times out a short-limit caller although the first caller has no limit', async () => {
    const server = await startServer();
    const url = `${server.origin}/format.js`;
    const first = fetchDirectFormat(url, { timeout: 0 });
    const held = await server.next();
    const second = fetchDirectFormat(url, { timeout: 20 });

    await expect(second).rejects.toThrow(TIMEOUT_20);
    // The unlimited caller still waits on the shared download, which is still running.
    expect(held.res.destroyed).toBe(false);
    held.answer(formatText('Review', '1.0.0'));
    expect((await first).name).toBe('Review');
    expect(server.requests).toHaveLength(1);
  });

  it('keeps waiting for a long-limit caller after the first, shorter caller timed out', async () => {
    const server = await startServer();
    const url = `${server.origin}/format.js`;
    // Settled from the start: on a slow machine the first caller can time out before the server sees the request.
    const first = Promise.allSettled([fetchDirectFormat(url, { timeout: 20 })]);
    const second = fetchDirectFormat(url, { timeout: 0 });
    const held = await server.next();

    expect(await first).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringMatching(TIMEOUT_20) }) },
    ]);
    expect(held.res.destroyed).toBe(false);
    held.answer(formatText('Review', '1.0.0'));
    expect((await second).name).toBe('Review');
    expect(server.requests).toHaveLength(1);
  });

  it('stops the download once every caller has timed out', async () => {
    const server = await startServer();
    const url = `${server.origin}/format.js`;
    // Settled from the start: on a slow machine both can time out before the server sees the request.
    const settled = Promise.allSettled([
      fetchDirectFormat(url, { timeout: 10 }),
      fetchDirectFormat(url, { timeout: 20 }),
    ]);
    const held = await server.next();
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    await held.closed;
  });

  it('applies to downloads by index entry too', async () => {
    const server = await startServer();
    const url = `${server.origin}/format.js`;
    const unlimited = fetchAndCacheFormat(entry('Review', '1.0.0'), url, { timeout: 0 });
    const held = await server.next();
    const limited = fetchAndCacheFormat(entry('Review', '1.0.0'), url, { timeout: 20 });

    await expect(limited).rejects.toThrow(TIMEOUT_20);
    held.answer(formatText('Review', '1.0.0'));
    expect((await unlimited).name).toBe('Review');
  });

  it('applies to index requests', async () => {
    const server = await startServer();
    const url = `${server.origin}/index.json`;
    const unlimited = fetchIndex(url, { timeout: 0 });
    const held = await server.next();
    const limited = fetchIndex(url, { timeout: 20 });

    await expect(limited).rejects.toThrow(TIMEOUT_20);
    held.answer(JSON.stringify({ twine2: [entry('Review', '1.0.0')] }));
    expect((await unlimited).entries).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  });
});

describe('each caller keeps its own checksum check when downloads are shared (#206)', () => {
  const text = formatText('Review', '1.0.0');
  const good = sha256(text);
  const bad = '0'.repeat(64);

  /** Starts both calls before the server answers, so they share one download. */
  async function race(first: SFAIndexEntry, second: SFAIndexEntry) {
    const server = await startServer();
    const url = `${server.origin}/format.js`;
    const calls = [fetchAndCacheFormat(first, url), fetchAndCacheFormat(second, url)];
    (await server.next()).answer(text);
    const results = await Promise.allSettled(calls);
    expect(server.requests).toHaveLength(1);
    return results.map((r) => r.status);
  }

  it('rejects the checked caller when the unchecked one came first', async () => {
    expect(await race(entry('Review', '1.0.0'), entry('Review', '1.0.0', bad))).toEqual(['fulfilled', 'rejected']);
  });

  it('rejects the checked caller when the unchecked one came second', async () => {
    expect(await race(entry('Review', '1.0.0', bad), entry('Review', '1.0.0'))).toEqual(['rejected', 'fulfilled']);
  });

  it('judges conflicting checksums separately', async () => {
    expect(await race(entry('Review', '1.0.0', good), entry('Review', '1.0.0', bad))).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await race(entry('Review', '1.0.0', bad), entry('Review', '1.0.0', good))).toEqual([
      'rejected',
      'fulfilled',
    ]);
  });

  it('fulfils both callers when both checksums match', async () => {
    expect(await race(entry('Review', '1.0.0', good), entry('Review', '1.0.0', good))).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
  });
});

describe('a download must be the format its index entry names (#207)', () => {
  async function download(entryName: string, entryVersion: string, served: string) {
    const server = await startServer(() => served);
    return fetchAndCacheFormat(entry(entryName, entryVersion), `${server.origin}/format.js`);
  }

  it('rejects a different name, and caches nothing', async () => {
    await expect(download('Requested', '1.0.0', formatText('Actual', '1.0.0'))).rejects.toThrow(
      /mismatch.*Requested 1\.0\.0.*Actual 1\.0\.0/,
    );
    expect(existsSync(join(root, 'cache', 'twee-ts', 'storyformats'))).toBe(false);
  });

  it('rejects a different version', async () => {
    await expect(download('Review', '1.0.0', formatText('Review', '1.0.1'))).rejects.toThrow(/mismatch/);
  });

  it('rejects a different major version', async () => {
    await expect(download('Review', '1.0.0', formatText('Review', '2.0.0'))).rejects.toThrow(/mismatch/);
  });

  it('accepts the identity the entry names', async () => {
    const info = await download('Review', '1.0.0', formatText('Review', '1.0.0'));
    expect(info).toMatchObject({ name: 'Review', version: '1.0.0' });
  });

  it.each([
    ['a version without its zero parts', '1.0', '1.0.0'],
    ['a leading v', 'v1.0.0', '1.0.0'],
    ['build metadata', '1.0.0+build5', '1.0.0'],
    ['a name in other letter case', '1.0.0', '1.0.0'],
  ])('accepts normalized-equivalent identities: %s', async (label, entryVersion, servedVersion) => {
    const entryName = label.startsWith('a name') ? 'REVIEW' : 'Review';
    // The entry's version must be a safe cache directory name, which all of these are.
    const info = await download(entryName, entryVersion, formatText('Review', servedVersion));
    expect(info.version).toBe(servedVersion);
  });

  it('allows a format.js that names no format', async () => {
    const unnamed = `window.storyFormat(${JSON.stringify({ version: '1.0.0', source: '{{STORY_DATA}}' })});`;
    const info = await download('Review', '1.0.0', unnamed);
    // It keeps the identity its index entry gives it (#237).
    expect(info).toMatchObject({ name: 'Review', version: '1.0.0', id: 'review-1' });
    expect([...discoverCachedFormats().values()].map((f) => f.name)).toEqual(['Review']);
  });

  describe('when resolving a request through indices', () => {
    /** The default archive indices list no format, so the test never reaches the network. */
    beforeEach(() => {
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
        (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes(
          'videlais.github.io',
        )
          ? Promise.resolve(new Response(JSON.stringify({ twine1: [], twine2: [] })))
          : realFetch(input, init),
      );
    });

    function indexRoutes(served: string, entryName: string): (url: string) => string | undefined {
      return (url) =>
        url === '/index.json'
          ? JSON.stringify({ twine2: [entry(entryName, '1.0.0')] })
          : url.endsWith('/format.js')
            ? served
            : undefined;
    }

    it('fails instead of switching to the format the download turned out to be', async () => {
      const server = await startServer(
        indexRoutes(formatText('Actual Review Format', '1.0.0'), 'RequestedReviewFormat'),
      );
      await expect(
        resolveRequest({ kind: 'id', id: 'requestedreviewformat-1' }, [`${server.origin}/index.json`]),
      ).rejects.toThrow(/mismatch/);
      expect(discoverCachedFormats().size).toBe(0);
    });

    it('goes on to the next index after a mismatching download', async () => {
      const stale = await startServer(indexRoutes(formatText('Actual', '1.0.0'), 'Review'));
      const fresh = await startServer(indexRoutes(formatText('Review', '1.0.0'), 'Review'));
      const info = await resolveRequest({ kind: 'id', id: 'review-1' }, [
        `${stale.origin}/index.json`,
        `${fresh.origin}/index.json`,
      ]);
      expect(info).toMatchObject({ name: 'Review', version: '1.0.0' });
    });
  });
});

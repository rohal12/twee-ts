/**
 * Loopback HTTP servers and a network guard for story format tests: no test reaches the real
 * network, and every request is logged so tests can assert what was (not) fetched.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { clearIndexCache } from '../../src/remote-formats.js';

/**
 * Give each test of the calling file a temporary folder with its own format cache and an empty
 * home directory (so no installed story format answers), a network guard ({@link guardNetwork}),
 * and a fresh index cache; afterwards close the test servers and remove the folder. Returns a
 * getter for the folder.
 */
export function isolateFormatEnvironment(label: string): () => string {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `twee-ts-${label}-`));
    vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('USERPROFILE', join(root, 'home'));
    clearIndexCache();
    guardNetwork();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await closeFormatServers();
    rmSync(root, { recursive: true, force: true });
  });
  return () => root;
}

/** What a route answers: a body, or a handler that writes the response itself. */
export type Route = string | Uint8Array | ((req: IncomingMessage, res: ServerResponse) => void);

export interface FormatServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Path (with query) → route; tests may change it between requests. */
  readonly routes: Map<string, Route>;
  /** Every request's path (with query), in order. */
  readonly log: string[];
  readonly close: () => Promise<void>;
}

const servers = new Set<Server>();

/** Start a loopback server answering `routes` (by path and query); anything else is a 404. */
export async function startFormatServer(routes: Readonly<Record<string, Route>> = {}): Promise<FormatServer> {
  const table = new Map(Object.entries(routes));
  const log: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    log.push(path);
    const route = table.get(path);
    if (route === undefined) {
      res.statusCode = 404;
      res.end('not found');
    } else if (typeof route === 'function') {
      route(req, res);
    } else {
      res.end(route);
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.add(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server has no port');
  const { port } = address satisfies AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    routes: table,
    log,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  servers.delete(server);
  return new Promise((done) => {
    server.closeAllConnections();
    server.close(() => {
      done();
    });
  });
}

/** Close every server started by {@link startFormatServer}. */
async function closeFormatServers(): Promise<void> {
  await Promise.all([...servers].map(closeServer));
}

/** The Story Formats Archive indices every build consults last. */
export const SFA_OFFICIAL = 'https://videlais.github.io/story-formats-archive/official/index.json';
export const SFA_OFFICIAL_BASE = 'https://videlais.github.io/story-formats-archive/official';

/**
 * Replace `fetch` so loopback requests go through, and every other request is answered from
 * `remote` (an absolute URL → body table; a missing index answers an empty index, anything else
 * 404). With `offline`, every request fails as with no network at all, loopback ones included
 * (without waiting on a refused connection, which takes seconds on Windows). Returns the log of
 * non-loopback URLs requested.
 */
export function guardNetwork(remote: Readonly<Record<string, string>> = {}, { offline = false } = {}): string[] {
  const realFetch = globalThis.fetch;
  const external: string[] = [];
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (offline) return Promise.reject(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    external.push(url.href);
    const body = remote[url.href];
    if (body !== undefined) return Promise.resolve(new Response(body));
    if (url.pathname.endsWith('/index.json')) return Promise.resolve(new Response('{"twine1":[],"twine2":[]}'));
    return Promise.resolve(new Response('not found', { status: 404, statusText: 'Not Found' }));
  });
  return external;
}

/** A Twine 2 format.js whose output contains `marker`, so tests can tell copies apart. */
export function formatJs(name: string | undefined, version: string, marker = 'M'): string {
  const data: Record<string, unknown> = {
    version,
    source: `<html><head></head><body>${marker} {{STORY_DATA}}</body></html>`,
  };
  if (name !== undefined) data['name'] = name;
  return `window.storyFormat(${JSON.stringify(data)});`;
}

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** An index entry for a Twine 2 format.js, with its checksum unless `content` is undefined. */
export function indexEntry(
  name: string,
  version: string,
  content?: string | Uint8Array,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    name,
    version,
    proofing: false,
    files: ['format.js'],
    checksums: content === undefined ? {} : { 'format.js': sha256(content) },
    ...extra,
  };
}

/** An index.json body. */
export function indexJson(twine2: readonly unknown[], twine1: readonly unknown[] = []): string {
  return JSON.stringify({ twine1, twine2 });
}

/** The path below an index's folder where an entry's file is served. */
export function entryPath(name: string, version: string, file = 'format.js', twine = 'twine2'): string {
  return `${twine}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/${file}`;
}

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

/** An inline story whose StoryData names `format` at `version` (each optional). */
export function storySource(format?: string, version?: string): { filename: string; content: string }[] {
  const data: Record<string, string> = { ifid: IFID };
  if (format !== undefined) data['format'] = format;
  if (version !== undefined) data['format-version'] = version;
  return [
    { filename: 'story.tw', content: `:: StoryData\n${JSON.stringify(data)}\n\n:: StoryTitle\nT\n\n:: Start\nHello` },
  ];
}

/** The marker a {@link formatJs} format put into compiled output. */
export function markerOf(output: string): string | undefined {
  return /<body>(\S+) /.exec(output)?.[1];
}

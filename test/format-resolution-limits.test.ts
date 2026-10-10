/**
 * The limits on story format resolution as a whole (#248 suspicions 4 and 6): an overall time limit
 * (`formatResolutionTimeout`), and turning off the Story Formats Archive indices every build otherwise
 * consults (`useDefaultFormatIndices`). Loopback servers only; a route that never answers stands for a
 * hung server, and the limits under test are short.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { compile, TweeTsError } from '../src/compiler.js';
import { resolveRemoteFormat } from '../src/format-resolution.js';
import { clearIndexCache } from '../src/remote-formats.js';
import { validateConfig } from '../src/config.js';
import { parseCliArgs, resolveBuild } from '../src/cli-request.js';
import type { BuildRequest } from '../src/cli-request.js';
import type { CompileOptions, Diagnostic } from '../src/types.js';
import {
  isolateFormatEnvironment,
  entryPath,
  formatJs,
  guardNetwork,
  indexEntry,
  indexJson,
  markerOf,
  startFormatServer,
  storySource,
} from './helpers/format-server.js';

isolateFormatEnvironment('format-limits');

/** A route that accepts the request and never answers, as a hung server does. */
const hang = (_req: IncomingMessage, _res: ServerResponse): void => undefined;

interface Built {
  readonly marker: string | undefined;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

async function build(options: Partial<CompileOptions>): Promise<Built> {
  clearIndexCache();
  const summarise = (diagnostics: readonly Diagnostic[]) => ({
    warnings: diagnostics.filter((d) => d.level === 'warning').map((d) => d.message),
    errors: diagnostics.filter((d) => d.level === 'error').map((d) => d.message),
  });
  try {
    const result = await compile({ sources: storySource(), useTweegoPath: false, formatPaths: [], ...options });
    return { marker: markerOf(result.output), ...summarise(result.diagnostics) };
  } catch (e) {
    if (!(e instanceof TweeTsError)) throw e;
    return { marker: undefined, ...summarise(e.diagnostics) };
  }
}

/** The build request of a command line. */
function buildRequest(argv: readonly string[]): BuildRequest {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok || parsed.request.kind !== 'build') throw new Error(`expected a build for ${JSON.stringify(argv)}`);
  return parsed.request;
}

const DEADLINE = /stopped after 200 ms, the limit formatResolutionTimeout sets/;

describe('formatResolutionTimeout: one time limit for finding the story format', () => {
  it('stops a hung index request at the limit, and asks no later source', async () => {
    const external = guardNetwork();
    const server = await startFormatServer({ '/index.json': hang });
    const built = await build({
      formatIndices: [`${server.origin}/index.json`],
      formatFetchTimeout: 0,
      formatResolutionTimeout: 200,
    });
    expect(built.marker).toBeUndefined();
    expect(built.warnings.join('\n')).toMatch(DEADLINE);
    expect(built.errors.join('\n')).toContain('Story format "sugarcube-2" is not available');
    // The Story Formats Archive indices come after the custom index: they are not asked.
    expect(external).toEqual([]);
  });

  it('stops a hung format download at the limit', async () => {
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('SugarCube', '2.37.3')]),
      [`/${entryPath('SugarCube', '2.37.3')}`]: hang,
    });
    const built = await build({
      formatIndices: [`${server.origin}/index.json`],
      formatFetchTimeout: 60_000,
      formatResolutionTimeout: 200,
    });
    expect(built.marker).toBeUndefined();
    expect(built.warnings.join('\n')).toMatch(DEADLINE);
    // The index answered, so its request was seen; whether the hung download reached the server
    // before the limit depends on the machine. Nothing else was asked.
    expect(server.log[0]).toBe('/index.json');
    expect(['/index.json', `/${entryPath('SugarCube', '2.37.3')}`]).toEqual(expect.arrayContaining(server.log));
  });

  it('limits the sum of requests that each stay within formatFetchTimeout', async () => {
    const external = guardNetwork();
    const server = await startFormatServer({ '/a.js': hang, '/b.js': hang, '/c.js': hang });
    const urls = ['a', 'b', 'c'].map((n) => `${server.origin}/${n}.js`);
    const built = await build({ formatUrls: urls, formatFetchTimeout: 120, formatResolutionTimeout: 200 });
    expect(built.marker).toBeUndefined();
    expect(built.warnings.join('\n')).toMatch(DEADLINE);
    expect(built.warnings.join('\n')).toContain(`Failed to download format from ${urls[0]}: timed out after 120 ms`);
    expect(server.log).not.toContain('/c.js');
    expect(external).toEqual([]);
  });

  it('still answers from a download cached before, once the limit has passed', async () => {
    const js = formatJs('SugarCube', '2.37.3', 'CACHED');
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('SugarCube', '2.37.3', js)]),
      [`/${entryPath('SugarCube', '2.37.3')}`]: js,
    });
    const formatIndices = [`${server.origin}/index.json`];
    expect((await build({ formatIndices })).marker).toBe('CACHED');

    server.routes.set('/index.json', hang);
    const built = await build({ formatIndices, formatResolutionTimeout: 200 });
    expect(built.marker).toBe('CACHED');
    expect(built.warnings.join('\n')).toMatch(DEADLINE);
  });

  // Whether a request reaches a server within its own limit depends on the machine (a loaded CI
  // runner took more than 50 ms), so the warnings tell which sources were tried, not the server's
  // log. The second source accepts connections and never reads one, so its server never sees the
  // request at all: every source must be tried all the same.
  it.each([0, Number.POSITIVE_INFINITY])('has no overall limit at %s: every source is tried', async (limit) => {
    const server = await startFormatServer({ '/a.js': hang });
    const silent = createServer({ pauseOnConnect: true }, () => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const urls = [`${server.origin}/a.js`, `http://127.0.0.1:${(silent.address() as AddressInfo).port}/b.js`];
      const built = await build({ formatUrls: urls, formatFetchTimeout: 50, formatResolutionTimeout: limit });
      const warnings = built.warnings.join('\n');
      for (const url of urls)
        expect(warnings).toContain(`Failed to download format from ${url}: timed out after 50 ms`);
      expect(warnings).not.toContain('formatResolutionTimeout');
    } finally {
      silent.close();
    }
  });

  it('applies to resolveRemoteFormat as resolutionTimeout', async () => {
    const server = await startFormatServer({ '/index.json': hang });
    const lookup = resolveRemoteFormat('SugarCube', '2.37.3', {
      indices: [`${server.origin}/index.json`],
      timeout: 0,
      resolutionTimeout: 200,
    });
    await expect(lookup).rejects.toMatchObject({
      name: 'TweeTsError',
      code: 'FORMAT_UNAVAILABLE',
      message: expect.stringMatching(/stopped after 200 ms, the limit resolutionTimeout sets/),
    });
  });

  it('still rejects with the caller’s reason when the caller aborts first', async () => {
    const server = await startFormatServer({ '/index.json': hang });
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const compiling = compile({
      sources: storySource(),
      useTweegoPath: false,
      formatIndices: [`${server.origin}/index.json`],
      formatResolutionTimeout: 60_000,
      signal: controller.signal,
    });
    server.routes.set('/index.json', () => {
      controller.abort(reason);
    });
    await expect(compiling).rejects.toBe(reason);
  });

  it.each([-1, Number.NaN])('rejects %s', async (value) => {
    await expect(compile({ sources: storySource(), formatResolutionTimeout: value })).rejects.toThrow(
      '"formatResolutionTimeout" must be a number of milliseconds, 0 or more.',
    );
    await expect(resolveRemoteFormat('SugarCube', '2.0.0', { resolutionTimeout: value })).rejects.toMatchObject({
      name: 'TweeTsError',
      code: 'INVALID_OPTIONS',
      message: expect.stringContaining('resolutionTimeout must be 0 or more milliseconds'),
    });
    expect(validateConfig({ formatResolutionTimeout: value })).toContain(
      '"formatResolutionTimeout" must be a number of milliseconds, 0 or more.',
    );
  });

  it('is read from the config file', () => {
    expect(validateConfig({ formatResolutionTimeout: 0 })).toEqual([]);
    expect(
      resolveBuild(buildRequest(['a.tw']), { formatResolutionTimeout: 5000 }).options.formatResolutionTimeout,
    ).toBe(5000);
  });
});

describe('useDefaultFormatIndices: the Story Formats Archive can be left out', () => {
  it('asks only the configured index when it is false', async () => {
    const external = guardNetwork();
    const js = formatJs('SugarCube', '2.37.3', 'PRIVATE');
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('SugarCube', '2.37.3', js)]),
      [`/${entryPath('SugarCube', '2.37.3')}`]: js,
    });
    const built = await build({ formatIndices: [`${server.origin}/index.json`], useDefaultFormatIndices: false });
    expect(built.marker).toBe('PRIVATE');
    expect(external).toEqual([]);
  });

  it('asks nothing remote but the format URLs when nothing else answers', async () => {
    const external = guardNetwork();
    const server = await startFormatServer();
    const built = await build({ formatUrls: [`${server.origin}/x.js`], useDefaultFormatIndices: false });
    expect(built.marker).toBeUndefined();
    expect(server.log).toEqual(['/x.js']);
    expect(external).toEqual([]);
  });

  it('asks the archive by default', async () => {
    const external = guardNetwork();
    await build({});
    expect(external.length).toBeGreaterThan(0);
  });

  it('applies to resolveRemoteFormat as useDefaultIndices', async () => {
    const external = guardNetwork();
    expect(await resolveRemoteFormat('SugarCube', '2.37.3', { useDefaultIndices: false })).toBeUndefined();
    expect(external).toEqual([]);
  });

  it('is set by the config file and by --no-default-format-indices', () => {
    expect(validateConfig({ useDefaultFormatIndices: false })).toEqual([]);
    expect(validateConfig({ useDefaultFormatIndices: 'no' })).toContain('"useDefaultFormatIndices" must be a boolean.');
    const plain = buildRequest(['a.tw']);
    const off = buildRequest(['--no-default-format-indices', 'a.tw']);
    expect(resolveBuild(plain, null).options.useDefaultFormatIndices).toBe(true);
    expect(resolveBuild(plain, { useDefaultFormatIndices: false }).options.useDefaultFormatIndices).toBe(false);
    expect(resolveBuild(off, { useDefaultFormatIndices: true }).options.useDefaultFormatIndices).toBe(false);
  });
});

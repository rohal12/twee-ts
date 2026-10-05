import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compile, TweeTsError } from '../src/compiler.js';
import { getCacheDir } from '../src/remote-formats.js';
import type { CompileOptions, Diagnostic, SFAIndexEntry } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const TEST_FORMATS = join(FIXTURES_DIR, 'storyformats');
const HARLOWE_FORMATS = join(FIXTURES_DIR, 'storyformats-harlowe');
const SUGARCUBE_FORMATS = join(FIXTURES_DIR, 'storyformats-sugarcube');

const OFFICIAL_INDEX = 'https://videlais.github.io/story-formats-archive/official/index.json';
const UNOFFICIAL_INDEX = 'https://videlais.github.io/story-formats-archive/unofficial/index.json';
const OFFICIAL_BASE = 'https://videlais.github.io/story-formats-archive/official';
const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

function formatJs(name: string, version: string): string {
  return `window.storyFormat(${JSON.stringify({ name, version, proofing: false, source: `<html><!-- ${name} ${version} -->{{STORY_DATA}}</html>` })});`;
}

function sfaEntry(name: string, version: string): SFAIndexEntry {
  return { name, version, proofing: false, files: ['format.js'], checksums: {} };
}

function indexJson(...entries: SFAIndexEntry[]): string {
  return JSON.stringify({ twine1: [], twine2: entries });
}

/** Stub `fetch` with a URL → body table; unknown URLs answer 404. Returns the list of requested URLs. */
function stubFetch(routes: Readonly<Record<string, string>>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const body = routes[url];
      return body === undefined
        ? new Response('missing', { status: 404, statusText: 'Not Found' })
        : new Response(body);
    }),
  );
  return calls;
}

function stubOffline(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    throw new TypeError('offline');
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A story source with an IFID and a Start passage; `storyData` adds StoryData fields. */
function story(storyData: Record<string, string> = {}): CompileOptions['sources'] {
  return [
    {
      filename: 'story.tw',
      content: `:: StoryData\n${JSON.stringify({ ifid: IFID, ...storyData })}\n\n:: StoryTitle\nFormats\n\n:: Start\nHello.\n`,
    },
  ];
}

/** Compile options with no local format directories besides `formatPaths`. */
function options(extra: Partial<CompileOptions>): CompileOptions {
  return { sources: story(), formatPaths: [], useTweegoPath: false, ...extra };
}

/** Run a compile that must fail for lack of a format, and return its diagnostics. */
async function failingDiagnostics(opts: CompileOptions): Promise<Diagnostic[]> {
  try {
    await compile(opts);
  } catch (e) {
    expect(e).toBeInstanceOf(TweeTsError);
    return (e as TweeTsError).diagnostics;
  }
  throw new Error('expected compile to fail');
}

let cacheRoot = '';
let origCacheHome: string | undefined;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'twee-ts-resolve-'));
  origCacheHome = process.env['XDG_CACHE_HOME'];
  process.env['XDG_CACHE_HOME'] = cacheRoot;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (origCacheHome !== undefined) process.env['XDG_CACHE_HOME'] = origCacheHome;
  else delete process.env['XDG_CACHE_HOME'];
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe('default format resolved remotely (#89)', () => {
  it('translates the default sugarcube-2 ID to the SugarCube index name', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: indexJson(sfaEntry('SugarCube', '2.37.3'), sfaEntry('SugarCube', '1.0.35')),
      [`${OFFICIAL_BASE}/twine2/SugarCube/2.37.3/format.js`]: formatJs('SugarCube', '2.37.3'),
    });
    const result = await compile(options({}));
    expect(result.format?.name).toBe('SugarCube');
    expect(result.format?.version).toBe('2.37.3');
    expect(result.output).toContain('<!-- SugarCube 2.37.3 -->');
  });

  it('accepts a SugarCube direct URL for the default ID', async () => {
    const calls = stubFetch({ 'https://example.test/sugarcube.js': formatJs('SugarCube', '2.37.3') });
    const result = await compile(options({ formatUrls: ['https://example.test/sugarcube.js'] }));
    expect(result.format?.name).toBe('SugarCube');
    expect(calls).toEqual(['https://example.test/sugarcube.js']);
  });

  it('resolves an explicit format ID remotely', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: indexJson(sfaEntry('SugarCube', '2.37.3'), sfaEntry('Harlowe', '3.3.9')),
      [`${OFFICIAL_BASE}/twine2/Harlowe/3.3.9/format.js`]: formatJs('Harlowe', '3.3.9'),
    });
    const result = await compile(options({ formatId: 'harlowe-3' }));
    expect(result.format?.name).toBe('Harlowe');
  });
});

describe('requested format precedence (#90)', () => {
  it('does not swap a StoryData Harlowe request for the local default SugarCube', async () => {
    const diagnostics = await failingDiagnostics(
      options({
        sources: story({ format: 'Harlowe', 'format-version': '3.3.9' }),
        formatPaths: [SUGARCUBE_FORMATS],
        noRemote: true,
      }),
    );
    expect(diagnostics).toContainEqual({
      level: 'error',
      message: expect.stringMatching(/Story format "Harlowe" at version "3\.3\.9" is not available/),
    });
  });

  it('tries the StoryData format remotely before giving up', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: indexJson(sfaEntry('Harlowe', '3.3.9')),
      [`${OFFICIAL_BASE}/twine2/Harlowe/3.3.9/format.js`]: formatJs('Harlowe', '3.3.9'),
    });
    const result = await compile(
      options({ sources: story({ format: 'Harlowe', 'format-version': '3.3.9' }), formatPaths: [SUGARCUBE_FORMATS] }),
    );
    expect(result.format?.name).toBe('Harlowe');
  });

  it('keeps an explicit formatId during remote fallback even when StoryData names another format', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: indexJson(sfaEntry('SugarCube', '2.37.3')),
      [UNOFFICIAL_INDEX]: indexJson(),
      [`${OFFICIAL_BASE}/twine2/SugarCube/2.37.3/format.js`]: formatJs('SugarCube', '2.37.3'),
    });
    const diagnostics = await failingDiagnostics(
      options({ sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }), formatId: 'harlowe-3' }),
    );
    expect(diagnostics).toContainEqual({
      level: 'error',
      message: expect.stringContaining('Story format "harlowe-3" is not available'),
    });
  });

  it('selects the explicit formatId remotely when it is available', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: indexJson(sfaEntry('SugarCube', '2.37.3'), sfaEntry('Harlowe', '3.3.9')),
      [`${OFFICIAL_BASE}/twine2/Harlowe/3.3.9/format.js`]: formatJs('Harlowe', '3.3.9'),
      [`${OFFICIAL_BASE}/twine2/SugarCube/2.37.3/format.js`]: formatJs('SugarCube', '2.37.3'),
    });
    const result = await compile(
      options({ sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }), formatId: 'harlowe-3' }),
    );
    expect(result.format?.name).toBe('Harlowe');
  });

  it('prefers an explicit local formatId over StoryData', async () => {
    const result = await compile(
      options({
        sources: story({ format: 'SugarCube', 'format-version': '2.36.1' }),
        formatPaths: [SUGARCUBE_FORMATS, HARLOWE_FORMATS],
        formatId: 'harlowe-3',
        noRemote: true,
      }),
    );
    expect(result.format?.name).toBe('Harlowe');
  });

  it('falls back to an older installed version of the same format and major, with a warning', async () => {
    const result = await compile(
      options({
        sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }),
        formatPaths: [SUGARCUBE_FORMATS],
        noRemote: true,
      }),
    );
    expect(result.format?.version).toBe('2.36.1');
    expect(result.diagnostics).toContainEqual({
      level: 'warning',
      message: expect.stringContaining('using SugarCube 2.36.1 instead'),
    });
  });

  it('never falls back across major versions', async () => {
    const diagnostics = await failingDiagnostics(
      options({
        sources: story({ format: 'SugarCube', 'format-version': '1.0.35' }),
        formatPaths: [SUGARCUBE_FORMATS],
        noRemote: true,
      }),
    );
    expect(diagnostics.some((d) => d.level === 'error' && d.message.includes('"SugarCube" at version "1.0.35"'))).toBe(
      true,
    );
  });
});

describe('format written into compiled Twine 2 HTML (#91)', () => {
  it('writes the selected format when StoryData has no format fields', async () => {
    const result = await compile(options({ formatId: 'test-format-1', formatPaths: [TEST_FORMATS], noRemote: true }));
    expect(result.format?.name).toBe('Test Format');
    expect(result.output).toContain('format="Test Format" format-version="1.0.0"');
  });

  it('writes the selected format over a different StoryData format', async () => {
    const result = await compile(
      options({
        sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }),
        formatId: 'test-format-1',
        formatPaths: [TEST_FORMATS],
        noRemote: true,
      }),
    );
    expect(result.output).toContain('format="Test Format" format-version="1.0.0"');
    expect(result.output).not.toContain('format="SugarCube"');
  });

  it('writes the version actually selected when a newer same-major version satisfies StoryData', async () => {
    const result = await compile(
      options({
        sources: story({ format: 'SugarCube', 'format-version': '2.30.0' }),
        formatPaths: [SUGARCUBE_FORMATS],
        noRemote: true,
      }),
    );
    expect(result.output).toContain('format="SugarCube" format-version="2.36.1"');
  });

  it('keeps the source metadata in archive output', async () => {
    const result = await compile(
      options({
        sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }),
        formatId: 'test-format-1',
        outputMode: 'twine2-archive',
      }),
    );
    expect(result.output).toContain('format="SugarCube" format-version="2.37.3"');
  });
});

describe('download cache used without the network (#92)', () => {
  function seedCache(name: string, version: string): void {
    const dir = join(getCacheDir(), name, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'format.js'), formatJs(name, version));
  }

  it('compiles with noRemote from a cached format', async () => {
    seedCache('SugarCube', '2.37.3');
    const fetchSpy = stubOffline();
    const result = await compile(
      options({ sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }), noRemote: true }),
    );
    expect(result.format?.version).toBe('2.37.3');
    expect(result.output).toContain('<!-- SugarCube 2.37.3 -->');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('compiles offline from a cached format with remote fetching enabled', async () => {
    seedCache('SugarCube', '2.37.3');
    const fetchSpy = stubOffline();
    const result = await compile(options({ sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }) }));
    expect(result.format?.version).toBe('2.37.3');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the default ID from the cache', async () => {
    seedCache('SugarCube', '2.36.1');
    seedCache('SugarCube', '2.37.3');
    stubOffline();
    const result = await compile(options({ noRemote: true }));
    expect(result.format?.version).toBe('2.37.3');
  });

  it('caches a download and reuses it on a fresh offline compile', async () => {
    stubFetch({
      [OFFICIAL_INDEX]: indexJson(sfaEntry('SugarCube', '2.37.3')),
      [`${OFFICIAL_BASE}/twine2/SugarCube/2.37.3/format.js`]: formatJs('SugarCube', '2.37.3'),
    });
    const online = await compile(options({ sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }) }));
    expect(online.format?.version).toBe('2.37.3');

    stubOffline();
    const offline = await compile(options({ sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }) }));
    expect(offline.format?.version).toBe('2.37.3');
  });
});

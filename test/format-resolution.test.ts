import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compile, TweeTsError } from '../src/compiler.js';
import { getFormatSearchDirs } from '../src/formats.js';
import { resolveStoryFormat } from '../src/format-resolution.js';
import { fetchDirectFormat, getCacheDir } from '../src/remote-formats.js';
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

  it('prefers a cached release over a cached prerelease of the same version (#162)', async () => {
    seedCache('Pre', '2.0.0-beta.1');
    seedCache('Pre', '2.0.0');
    const fetchSpy = stubOffline();
    const result = await compile(options({ sources: story({ format: 'Pre', 'format-version': '2.0.0' }) }));
    expect(result.format?.version).toBe('2.0.0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not take a cached prerelease as an exact match for the release (#162)', async () => {
    seedCache('Pre', '2.0.0-beta.1');
    const calls = stubFetch({
      [OFFICIAL_INDEX]: indexJson(sfaEntry('Pre', '2.0.0')),
      [`${OFFICIAL_BASE}/twine2/Pre/2.0.0/format.js`]: formatJs('Pre', '2.0.0'),
    });
    const result = await compile(options({ sources: story({ format: 'Pre', 'format-version': '2.0.0' }) }));
    expect(result.format?.version).toBe('2.0.0');
    expect(calls).toContain(OFFICIAL_INDEX);
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

describe('format files wrapped in comments with braces (#221)', () => {
  const wrap = (js: string): string => `/* Copyright {license} */\n${js}\n// {end}\n`;

  it('compiles with a local format whose wrapper has brace comments', async () => {
    const formats = join(cacheRoot, 'formats');
    writeFormat(formats, 'wrapped-1', 'SugarCube', '2.37.3', 'LOCALWRAP');
    const file = join(formats, 'wrapped-1', 'format.js');
    writeFileSync(file, wrap(readFileSync(file, 'utf-8')));
    const result = await compile(
      options({ formatPaths: [formats], sources: story({ format: 'SugarCube', 'format-version': '2.37.3' }) }),
    );
    expect(markerOf(result.output ?? '')).toBe('LOCALWRAP');
  });

  it('downloads a wrapped format from a URL and compiles from the cache offline', async () => {
    const url = 'https://example.test/wrapped.js';
    stubFetch({ [url]: wrap(formatJs('SugarCube', '2.37.3')) });
    const online = await compile(options({ formatUrls: [url] }));
    expect(online.format?.name).toBe('SugarCube');

    stubOffline();
    const offline = await compile(options({ formatUrls: [url], noRemote: true }));
    expect(offline.format?.name).toBe('SugarCube');
    expect(offline.output).toContain('<!-- SugarCube 2.37.3 -->');
  });
});

/** Write `<root>/<id>/format.js` for a tiny format whose output contains `marker`. */
function writeFormat(root: string, id: string, name: string, version: string, marker: string): void {
  mkdirSync(join(root, id), { recursive: true });
  const source = `<html><head></head><body>${marker} {{STORY_DATA}}</body></html>`;
  writeFileSync(join(root, id, 'format.js'), `window.storyFormat(${JSON.stringify({ name, version, source })});`);
}

/** The marker of the format a compile used. */
const markerOf = (output: string): string | undefined => /<body>(\S+)/.exec(output)?.[1];

const warnings = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics.filter((d) => d.level === 'warning').map((d) => d.message);

describe('format names and IDs match the same way everywhere (#156)', () => {
  let formats = '';
  let calls: string[] = [];

  beforeEach(() => {
    formats = join(cacheRoot, 'formats');
    writeFormat(formats, 'sugarcube-2', 'SugarCube', '2.36.1', 'LOCAL');
    // A newer copy in the download cache, and a remote index that has one too.
    const cached = join(getCacheDir(), 'SugarCube', '2.37.3');
    mkdirSync(cached, { recursive: true });
    writeFileSync(join(cached, 'format.js'), formatJs('SugarCube', '2.37.3'));
    calls = stubFetch({
      [OFFICIAL_INDEX]: indexJson(sfaEntry('SugarCube', '2.36.1')),
      [`${OFFICIAL_BASE}/twine2/SugarCube/2.36.1/format.js`]: formatJs('SugarCube', '2.36.1'),
    });
  });

  const requests: ReadonlyArray<readonly [string, Partial<CompileOptions>]> = [
    ['StoryData "sugarcube" 2.36.1', { sources: story({ format: 'sugarcube', 'format-version': '2.36.1' }) }],
    ['StoryData "SUGARCUBE" 2.36.0', { sources: story({ format: 'SUGARCUBE', 'format-version': '2.36.0' }) }],
    ['formatId "SugarCube-2"', { formatId: 'SugarCube-2' }],
    ['formatId "SUGARCUBE-2"', { formatId: 'SUGARCUBE-2' }],
  ];

  for (const noRemote of [false, true]) {
    for (const [label, extra] of requests) {
      it(`resolves ${label} to the local format${noRemote ? ' with noRemote' : ''}, with no network and no warning`, async () => {
        const result = await compile(options({ formatPaths: [formats], noRemote, ...extra }));
        expect(markerOf(result.output)).toBe('LOCAL');
        expect(calls).toEqual([]);
        expect(warnings(result.diagnostics)).toEqual([]);
      });
    }
  }

  it('prefers the exact-case local format when two differ only in case', async () => {
    writeFormat(formats, 'other', 'sugarcube', '2.36.1', 'LOWER');
    const exact = await compile(
      options({ sources: story({ format: 'SugarCube', 'format-version': '2.36.1' }), formatPaths: [formats] }),
    );
    expect(markerOf(exact.output)).toBe('LOCAL');
    const lower = await compile(
      options({ sources: story({ format: 'sugarcube', 'format-version': '2.36.1' }), formatPaths: [formats] }),
    );
    expect(markerOf(lower.output)).toBe('LOWER');
  });
});

describe('explicit format IDs are looked up before pruning (#161)', () => {
  it('uses the requested folder although another holds a newer version of the same format and major', async () => {
    const formats = join(cacheRoot, 'formats');
    writeFormat(formats, 'fixture-1', 'Fixture', '1.0.0', 'PINNED');
    writeFormat(formats, 'fixture-1-new', 'Fixture', '1.2.0', 'NEWER');
    const byId = await compile(options({ formatId: 'fixture-1', formatPaths: [formats], noRemote: true }));
    expect(byId.format?.id).toBe('fixture-1');
    expect(markerOf(byId.output)).toBe('PINNED');

    // A request by name still takes the greatest suitable version.
    const byName = await compile(
      options({
        sources: story({ format: 'Fixture', 'format-version': '1.0.0' }),
        formatPaths: [formats],
        noRemote: true,
      }),
    );
    expect(markerOf(byName.output)).toBe('NEWER');
  });

  it('prefers the local folder over a cached copy with the same ID', async () => {
    const formats = join(cacheRoot, 'formats');
    writeFormat(formats, 'fixture-1', 'Fixture', '1.0.0', 'PINNED');
    writeFormat(formats, 'fixture-1-new', 'Fixture', '1.2.0', 'NEWER');
    const cached = join(getCacheDir(), 'Fixture', '1.3.0');
    mkdirSync(cached, { recursive: true });
    writeFileSync(join(cached, 'format.js'), formatJs('Fixture', '1.3.0'));
    const result = await compile(options({ formatId: 'fixture-1', formatPaths: [formats], noRemote: true }));
    expect(markerOf(result.output)).toBe('PINNED');
  });
});

describe('prerelease versions in local format folders (#162)', () => {
  // Both folder orders: the result must not depend on which one the directory listing returns first.
  for (const [betaId, releaseId] of [
    ['pre-a', 'pre-b'],
    ['pre-b', 'pre-a'],
  ] as const) {
    it(`keeps the release over the beta (beta in ${betaId})`, async () => {
      const formats = join(cacheRoot, 'formats');
      writeFormat(formats, betaId, 'Pre', '2.0.0-beta.1', 'BETA');
      writeFormat(formats, releaseId, 'Pre', '2.0.0', 'RELEASE');
      const byName = await compile(
        options({
          sources: story({ format: 'Pre', 'format-version': '2.0.0' }),
          formatPaths: [formats],
          noRemote: true,
        }),
      );
      expect(markerOf(byName.output)).toBe('RELEASE');
      const byReleaseId = await compile(options({ formatId: releaseId, formatPaths: [formats], noRemote: true }));
      expect(markerOf(byReleaseId.output)).toBe('RELEASE');
      const byBetaId = await compile(options({ formatId: betaId, formatPaths: [formats], noRemote: true }));
      expect(markerOf(byBetaId.output)).toBe('BETA');
    });
  }
});

describe('format directory precedence (#163)', () => {
  let home = '';
  let cwd = '';
  let tweegoPath = '';
  let projectFormats = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = join(cacheRoot, 'home');
    cwd = join(cacheRoot, 'cwd');
    tweegoPath = join(cacheRoot, 'global-formats');
    projectFormats = join(cacheRoot, 'project-formats');
    for (const key of ['HOME', 'USERPROFILE', 'TWEEGO_PATH']) saved[key] = process.env[key];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    process.env['TWEEGO_PATH'] = tweegoPath;
    mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const build = async (formatPaths: string[]): Promise<string | undefined> => {
    const result = await compile({
      sources: story(),
      formatId: 'fixture-1',
      formatPaths,
      noRemote: true,
    });
    return markerOf(result.output);
  };

  it('searches home, the working directory, TWEEGO_PATH, then formatPaths', () => {
    mkdirSync(join(home, 'storyformats'), { recursive: true });
    mkdirSync(join(cwd, 'storyformats'), { recursive: true });
    expect(getFormatSearchDirs([projectFormats])).toEqual([
      join(home, 'storyformats'),
      join(cwd, 'storyformats'),
      tweegoPath,
      projectFormats,
    ]);
  });

  it('lets formatPaths outrank TWEEGO_PATH for the same folder name', async () => {
    writeFormat(projectFormats, 'fixture-1', 'Fixture', '1.0.0', 'FORMATPATHS');
    writeFormat(tweegoPath, 'fixture-1', 'Fixture', '1.0.0', 'TWEEGO_PATH');
    expect(await build([projectFormats])).toBe('FORMATPATHS');
  });

  it('lets TWEEGO_PATH outrank the working directory, and the working directory outrank home', async () => {
    writeFormat(join(home, 'storyformats'), 'fixture-1', 'Fixture', '1.0.0', 'HOME');
    expect(await build([])).toBe('HOME');
    writeFormat(join(cwd, 'storyformats'), 'fixture-1', 'Fixture', '1.0.0', 'CWD');
    expect(await build([])).toBe('CWD');
    writeFormat(tweegoPath, 'fixture-1', 'Fixture', '1.0.0', 'TWEEGO_PATH');
    expect(await build([])).toBe('TWEEGO_PATH');
  });

  it('lets the higher-ranked folder win a name request for the same name and version', async () => {
    writeFormat(projectFormats, 'project-copy', 'Fixture', '1.0.0', 'FORMATPATHS');
    writeFormat(tweegoPath, 'global-copy', 'Fixture', '1.0.0', 'TWEEGO_PATH');
    const result = await compile({
      sources: story({ format: 'Fixture', 'format-version': '1.0.0' }),
      formatPaths: [projectFormats],
      noRemote: true,
    });
    expect(markerOf(result.output)).toBe('FORMATPATHS');
  });
});

describe('format versions such as v1.0.0 and 1.0 (#164)', () => {
  for (const [id, name, version] of [
    ['vprefix-1', 'VPrefix', 'v1.0.0'],
    ['twopart-1', 'TwoPart', '1.0'],
  ] as const) {
    it(`selects a ${version} format by ID and by StoryData name`, async () => {
      const formats = join(cacheRoot, 'formats');
      writeFormat(formats, id, name, version, name);
      const byId = await compile(options({ formatId: id, formatPaths: [formats], noRemote: true }));
      expect(markerOf(byId.output)).toBe(name);
      const byName = await compile(
        options({
          sources: story({ format: name, 'format-version': '1.0.0' }),
          formatPaths: [formats],
          noRemote: true,
        }),
      );
      expect(markerOf(byName.output)).toBe(name);
    });
  }
});

describe('formats that cannot be used are reported (#154, #164)', () => {
  it('warns about a skipped format during a compile', async () => {
    const formats = join(cacheRoot, 'formats');
    writeFormat(formats, 'fixture-1', 'Fixture', '1.0.0', 'OK');
    mkdirSync(join(formats, 'broken-1'));
    writeFileSync(join(formats, 'broken-1', 'format.js'), 'window.storyFormat({name: "B", source: nope});');
    const result = await compile(options({ formatId: 'fixture-1', formatPaths: [formats], noRemote: true }));
    expect(markerOf(result.output)).toBe('OK');
    expect(warnings(result.diagnostics)).toEqual([expect.stringMatching(/^format broken-1: Skipping format; /)]);
  });

  it('reports the encoding of a skipped non-UTF-8 format, and warns once about the encoding of the one used', async () => {
    const formats = join(cacheRoot, 'formats');
    const latin1 = (text: string): Buffer => Buffer.from(text, 'latin1');
    mkdirSync(join(formats, 'legacy-1'), { recursive: true });
    writeFileSync(
      join(formats, 'legacy-1', 'format.js'),
      latin1(
        'window.storyFormat({"name":"Legacy","version":"1.0.0","source":"<html><head></head><body>caf\xe9 {{STORY_DATA}}</body></html>"});',
      ),
    );
    mkdirSync(join(formats, 'broken-1'));
    writeFileSync(join(formats, 'broken-1', 'format.js'), latin1('window.storyFormat({name: "B\xe9", source: nope});'));
    const result = await compile(options({ formatId: 'legacy-1', formatPaths: [formats], noRemote: true }));
    expect(markerOf(result.output)).toBe('café');
    expect(warnings(result.diagnostics)).toEqual([
      expect.stringMatching(/^read .*broken-1.format\.js: Invalid UTF-8/),
      expect.stringMatching(/^format broken-1: Skipping format; /),
      expect.stringMatching(/^read .*legacy-1.format\.js: Invalid UTF-8/),
    ]);
  });
});

describe('resolveStoryFormat', () => {
  it('goes online by default and warns with the text of a failure that is not an Error', async () => {
    const fetchMock = vi.fn(async () => {
      throw 'connection reset';
    });
    vi.stubGlobal('fetch', fetchMock);
    const diagnostics: Diagnostic[] = [];
    const found = await resolveStoryFormat(
      { kind: 'id', id: 'nothing-1' },
      { formatPaths: [], useTweegoPath: false, formatUrls: ['https://example.com/format.js'] },
      diagnostics,
    );
    expect(found).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
    expect(diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining('Remote format fetch failed for'));
    expect(diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining('connection reset'));
  });

  it('never touches the network when noRemote is set', async () => {
    const fetchMock = stubOffline();
    const found = await resolveStoryFormat(
      { kind: 'id', id: 'nothing-1' },
      { formatPaths: [], useTweegoPath: false, noRemote: true, formatUrls: ['https://example.com/format.js'] },
      [],
    );
    expect(found).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('older fallback from format URLs', () => {
    const URL_OLDER = 'https://example.test/older/format.js';
    const request = { kind: 'name', name: 'Urlfmt', version: '1.1.0' } as const;

    it('selects a primed same-major older URL copy with the older-version warning and no network', async () => {
      stubFetch({ [URL_OLDER]: formatJs('Urlfmt', '1.0.0') });
      await fetchDirectFormat(URL_OLDER);
      const fetchMock = stubOffline();
      const diagnostics: Diagnostic[] = [];
      const found = await resolveStoryFormat(
        request,
        { formatPaths: [], useTweegoPath: false, noRemote: true, formatUrls: [URL_OLDER] },
        diagnostics,
      );
      expect(found?.version).toBe('1.0.0');
      expect(diagnostics).toEqual([
        { level: 'warning', message: expect.stringContaining('using Urlfmt 1.0.0 instead') },
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('selects an older copy on its first online download', async () => {
      stubFetch({ [URL_OLDER]: formatJs('Urlfmt', '1.0.0') });
      const diagnostics: Diagnostic[] = [];
      const found = await resolveStoryFormat(
        request,
        { formatPaths: [], useTweegoPath: false, formatUrls: [URL_OLDER] },
        diagnostics,
      );
      expect(found?.version).toBe('1.0.0');
      expect(diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining('using Urlfmt 1.0.0 instead'));
    });

    it('rejects a URL copy of another major version', async () => {
      stubFetch({ [URL_OLDER]: formatJs('Urlfmt', '0.9.0') });
      const diagnostics: Diagnostic[] = [];
      const found = await resolveStoryFormat(
        request,
        { formatPaths: [], useTweegoPath: false, formatUrls: [URL_OLDER] },
        diagnostics,
      );
      expect(found).toBeUndefined();
      expect(diagnostics.some((d) => d.level === 'error')).toBe(true);
    });
  });
});

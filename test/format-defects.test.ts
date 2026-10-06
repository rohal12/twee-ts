/**
 * Regression tests for the story format resolution audit (#248: F01–F18) and its siblings #237 and
 * #238. Each test goes through the public API (compile, resolveRemoteFormat, the cache functions)
 * against loopback HTTP servers and a temporary cache; nothing reaches the real network.
 */
import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { resolveRemoteFormat } from '../src/format-resolution.js';
import { clearCachedFormats, discoverCachedFormats, listCachedFormats } from '../src/format-cache.js';
import { clearIndexCache, MAX_RESPONSE_BYTES } from '../src/remote-formats.js';
import type { CompileOptions, Diagnostic } from '../src/types.js';
import {
  isolateFormatEnvironment,
  entryPath,
  formatJs,
  guardNetwork,
  indexEntry,
  indexJson,
  markerOf,
  SFA_OFFICIAL,
  SFA_OFFICIAL_BASE,
  sha256,
  startFormatServer,
  storySource,
} from './helpers/format-server.js';

const tempRoot = isolateFormatEnvironment('format-defects');

interface Built {
  readonly marker: string | undefined;
  readonly format: string | undefined;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

/** Compile with no local formats (unless given), and summarise the format chosen and the diagnostics. */
async function build(options: Partial<CompileOptions> = {}): Promise<Built> {
  clearIndexCache();
  const summarise = (diagnostics: readonly Diagnostic[]) => ({
    warnings: diagnostics.filter((d) => d.level === 'warning').map((d) => d.message),
    errors: diagnostics.filter((d) => d.level === 'error').map((d) => d.message),
  });
  try {
    const result = await compile({ sources: storySource(), useTweegoPath: false, formatPaths: [], ...options });
    return {
      marker: markerOf(result.output),
      format: result.format && `${result.format.name} ${result.format.version}`,
      ...summarise(result.diagnostics),
    };
  } catch (e) {
    const diagnostics: readonly Diagnostic[] =
      typeof e === 'object' && e !== null && 'diagnostics' in e && Array.isArray(e.diagnostics) ? e.diagnostics : [];
    return { marker: undefined, format: undefined, ...summarise(diagnostics) };
  }
}

const story = (format?: string, version?: string): Partial<CompileOptions> => ({
  sources: storySource(format, version),
});

describe('F01: online, the shared cache never changes the answer', () => {
  it('gives the same format on a fresh and a primed machine, by name, by ID and through resolveRemoteFormat', async () => {
    const versions = ['2.30.0', '2.36.1', '2.37.3'];
    const routes = Object.fromEntries(
      versions.map((v) => [`/${entryPath('SugarCube', v)}`, formatJs('SugarCube', v, `V${v}`)]),
    );
    const server = await startFormatServer({
      '/index.json': indexJson(versions.map((v) => indexEntry('SugarCube', v))),
      ...routes,
    });
    const formatIndices = [`${server.origin}/index.json`];

    expect((await build({ ...story('SugarCube', '2.30.0'), formatIndices })).format).toBe('SugarCube 2.30.0');
    // Another project caches 2.36.1, then 2.30.0 again: the exact version still wins, from the index.
    expect((await build({ ...story('SugarCube', '2.36.1'), formatIndices })).format).toBe('SugarCube 2.36.1');
    server.log.length = 0;
    expect((await build({ ...story('SugarCube', '2.30.0'), formatIndices })).format).toBe('SugarCube 2.30.0');
    expect(server.log).toEqual(['/index.json']);
    // The default build takes the greatest SugarCube 2 the index lists, whatever is cached.
    expect((await build({ formatIndices })).format).toBe('SugarCube 2.37.3');
    clearIndexCache();
    expect((await resolveRemoteFormat('SugarCube', '2.30.0', formatIndices))?.version).toBe('2.30.0');
  });
});

describe('F02: one project’s index never answers another project (sibling of #180)', () => {
  it('keeps a private index’s patched build to the projects that list that index', async () => {
    const genuine = formatJs('SugarCube', '2.37.3', 'GENUINE');
    const patched = formatJs('SugarCube', '2.37.3', 'PATCHED');
    guardNetwork({
      [SFA_OFFICIAL]: indexJson([indexEntry('SugarCube', '2.37.3', genuine)]),
      [`${SFA_OFFICIAL_BASE}/${entryPath('SugarCube', '2.37.3')}`]: genuine,
    });
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('SugarCube', '2.37.3', patched)]),
      [`/${entryPath('SugarCube', '2.37.3')}`]: patched,
    });

    expect((await build({ formatIndices: [`${server.origin}/index.json`] })).marker).toBe('PATCHED');
    // Project C: no configuration, no network. The private download is not one of its sources.
    const offline = await build({ noRemote: true });
    expect(offline.marker).toBeUndefined();
    expect(offline.errors.join('\n')).toContain(
      'Story format "sugarcube-2" is not available (remote fetching disabled)',
    );
    // Project B: the official archive, online.
    expect((await build()).marker).toBe('GENUINE');
    expect((await build({ noRemote: true })).marker).toBe('GENUINE');
    expect((await build({ formatIndices: [`${server.origin}/index.json`], noRemote: true })).marker).toBe('PATCHED');
  });

  it('keeps entries whose names differ only in case, and spellings of one version, apart', async () => {
    const a = await startFormatServer({
      '/index.json': indexJson([indexEntry('sugarcube', '2.37.3')]),
      [`/${entryPath('sugarcube', '2.37.3')}`]: formatJs('SugarCube', '2.37.3', 'LOWER'),
    });
    const b = await startFormatServer({
      '/index.json': indexJson([indexEntry('SugarCube', 'v2.37.3')]),
      [`/${entryPath('SugarCube', 'v2.37.3')}`]: formatJs('SugarCube', '2.37.3', 'UPPER'),
    });
    expect((await build({ formatIndices: [`${a.origin}/index.json`] })).marker).toBe('LOWER');
    expect((await build({ formatIndices: [`${b.origin}/index.json`] })).marker).toBe('UPPER');
    expect((await build({ formatIndices: [`${a.origin}/index.json`], noRemote: true })).marker).toBe('LOWER');
    expect((await build({ formatIndices: [`${b.origin}/index.json`], noRemote: true })).marker).toBe('UPPER');
    expect(listCachedFormats()).toHaveLength(2);
  });
});

describe('F03: the same-major older fallback works for a first online index lookup (sibling of #224)', () => {
  it.each([
    ['newer than the index has', '2.38.0', '2.37.3'],
    ['the release of a listed prerelease', '2.1.0', '2.1.0-rc.1'],
  ])('uses the older version when StoryData asks for %s, with a warning', async (_label, wanted, listed) => {
    const text = formatJs('SugarCube', listed, 'OLDER');
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('SugarCube', listed, text)]),
      [`/${entryPath('SugarCube', listed)}`]: text,
    });
    const result = await build({ ...story('SugarCube', wanted), formatIndices: [`${server.origin}/index.json`] });
    expect(result.marker).toBe('OLDER');
    expect(result.warnings).toEqual([
      `Story format "SugarCube" at version "${wanted}" is not available; using SugarCube ${listed} instead.`,
    ]);
  });
});

describe('F04: Twine 1 index entries are fetched by their files', () => {
  it('downloads header.html and code.js, checks them, and builds a Twine 1 story', async () => {
    const header = '<html><head></head><body>"JONAH"<div id="storeArea">"STORY"</div></body></html>';
    const code = 'JONAH-CODE';
    const server = await startFormatServer({
      '/index.json': indexJson(
        [],
        [
          {
            name: 'jonah',
            version: '1.4.2',
            files: ['LICENSE', 'code.js', 'header.html'],
            checksums: { 'code.js': sha256(code), 'header.html': sha256(header), LICENSE: sha256('L') },
          },
        ],
      ),
      [`/${entryPath('jonah', '1.4.2', 'header.html', 'twine1')}`]: header,
      [`/${entryPath('jonah', '1.4.2', 'code.js', 'twine1')}`]: code,
    });
    const result = await compile({
      sources: storySource(),
      useTweegoPath: false,
      formatPaths: [],
      formatId: 'jonah-1',
      formatIndices: [`${server.origin}/index.json`],
    });
    expect(result.format).toMatchObject({ name: 'jonah', version: '1.4.2', isTwine2: false });
    expect(result.output).toContain('JONAH-CODE');
    expect(server.log).not.toContain(`/${entryPath('jonah', '1.4.2', 'format.js', 'twine1')}`);
    expect(server.log).not.toContain(`/${entryPath('jonah', '1.4.2', 'LICENSE', 'twine1')}`);
  });

  it('never answers a StoryData (Twine 2) request with a Twine 1 entry', async () => {
    const server = await startFormatServer({
      '/index.json': indexJson([], [{ name: 'SugarCube', version: '2.36.1', files: ['header.html'], checksums: {} }]),
    });
    const result = await build({ ...story('SugarCube', '2.36.1'), formatIndices: [`${server.origin}/index.json`] });
    expect(result.format).toBeUndefined();
    expect(result.errors.join('\n')).toContain('a Twine 1 format (StoryData names Twine 2 formats)');
  });
});

describe('F05 and #238: download URLs are resolved against the index response URL', () => {
  const names = ['Review', 'Review Fmt', 'Review #?', 'Ré%view', 'a/b'];
  const indexPaths: readonly (readonly [string, string, string])[] = [
    ['plain', '/a/index.json', '/a/'],
    ['another file name', '/b/formats.json', '/b/'],
    ['a query', '/c/index.json?rev=1', '/c/'],
    ['upper case', '/e/INDEX.JSON', '/e/'],
    ['a deep prefix', '/deep/er/index.json', '/deep/er/'],
    ['the server root', '/index.json', '/'],
  ];
  for (const [label, indexPath, folder] of indexPaths) {
    it.each(names)(`fetches %j from beside an index with ${label}`, async (name) => {
      const path = `${folder}${entryPath(name, '1.0.0')}`;
      const server = await startFormatServer({
        [indexPath]: indexJson([indexEntry(name, '1.0.0')]),
        [path]: formatJs(name, '1.0.0', 'FOUND'),
      });
      const info = await resolveRemoteFormat(name, '1.0.0', [`${server.origin}${indexPath}`]);
      expect(info?.name).toBe(name);
      expect(server.log).toEqual([indexPath, path]);
    });
  }

  it('ignores a fragment, and resolves against the URL after a redirect', async () => {
    const server = await startFormatServer({
      '/old/index.json': (_req, res: ServerResponse) => {
        res.writeHead(301, { location: '/new/index.json' });
        res.end();
      },
      '/new/index.json': indexJson([indexEntry('Review', '1.0.0')]),
      [`/new/${entryPath('Review', '1.0.0')}`]: formatJs('Review', '1.0.0', 'MOVED'),
    });
    const info = await resolveRemoteFormat('Review', '1.0.0', [`${server.origin}/old/index.json#top`]);
    expect(info?.name).toBe('Review');
    expect(server.log).toEqual(['/old/index.json', '/new/index.json', `/new/${entryPath('Review', '1.0.0')}`]);
  });
});

describe('F06: a failure in one source is reported even when a later source answers', () => {
  it('warns about a checksum mismatch in the project’s index, naming the URL and both hashes', async () => {
    const pinned = formatJs('Review', '1.0.0', 'PINNED');
    const served = formatJs('Review', '1.0.0', 'TAMPERED');
    const own = await startFormatServer({
      '/index.json': indexJson([indexEntry('Review', '1.0.0', pinned)]),
      [`/${entryPath('Review', '1.0.0')}`]: served,
    });
    const other = await startFormatServer({
      '/index.json': indexJson([indexEntry('Review', '1.0.0')]),
      [`/${entryPath('Review', '1.0.0')}`]: formatJs('Review', '1.0.0', 'OTHER'),
    });
    const result = await build({
      ...story('Review', '1.0.0'),
      formatIndices: [`${own.origin}/index.json`, `${other.origin}/index.json`],
    });
    expect(result.marker).toBe('OTHER');
    const url = `${own.origin}/${entryPath('Review', '1.0.0')}`;
    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        `Checksum mismatch for ${url}: the format index ${own.origin}/index.json lists SHA-256 ${sha256(pinned)}, but the download has ${sha256(served)}`,
      ),
    );
  });
});

describe('F07: diagnostics carry the URL, the cause and every failure', () => {
  it('names the URL and the system error of a refused connection', async () => {
    const server = await startFormatServer();
    const url = `${server.origin}/index.json`;
    await server.close();
    const result = await build({ ...story('Review', '1.0.0'), formatIndices: [url] });
    expect(result.warnings).toContainEqual(
      expect.stringContaining(`Failed to fetch format index from ${url}: fetch failed (ECONNREFUSED)`),
    );
  });

  it.each([
    ['an HTML page', '<!doctype html><p>hi', /Failed to read format index http:\S+: .*JSON/],
    ['a JSON value that is not an index', '[1, 2]', /Failed to read format index http:\S+: it is not a format index/],
    ['a twine2 field that is not a list', '{"twine2": {}}', /its "twine2" field is not a list/],
  ])('names the index and the reason for %s', async (_label, body, message) => {
    const server = await startFormatServer({ '/index.json': body });
    const result = await build({ ...story('Review', '1.0.0'), formatIndices: [`${server.origin}/index.json`] });
    expect(result.warnings).toContainEqual(expect.stringMatching(message));
  });

  it.each([
    ['no source', '{"name":"Review","version":"1.0.0"}', 'has no "source" string'],
    ['a version that is not a version', '{"name":"Review","version":"latest","source":"x"}', 'is not a SemVer version'],
  ])('passes on why a downloaded format.js with %s cannot be used', async (_label, object, reason) => {
    const server = await startFormatServer({ '/format.js': `window.storyFormat(${object});` });
    const result = await build({ ...story('Review', '1.0.0'), formatUrls: [`${server.origin}/format.js`] });
    expect(result.warnings).toContainEqual(
      expect.stringContaining(`Failed to read the story format at ${server.origin}/format.js: `),
    );
    expect(result.warnings.join('\n')).toContain(reason);
  });

  it('reports every failing source, not only the last', async () => {
    const a = await startFormatServer({ '/index.json': '' });
    const b = await startFormatServer();
    const result = await build({
      ...story('Review', '1.0.0'),
      formatIndices: [`${a.origin}/index.json`, `${b.origin}/index.json`],
    });
    expect(result.warnings.filter((w) => w.includes(a.origin))).toHaveLength(1);
    expect(result.warnings.filter((w) => w.includes(b.origin))).toHaveLength(1);
  });

  it('lists the candidates with the requested name and why each does not answer', async () => {
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('SugarCube', '1.0.35'), { name: 'SugarCube', version: 'next' }]),
    });
    const result = await build({ ...story('SugarCube', '2.37.3'), formatIndices: [`${server.origin}/index.json`] });
    const error = result.errors.join('\n');
    expect(error).toContain('SugarCube 1.0.35): another major version than 2');
    expect(error).toContain('its version "next" is not a SemVer version');
  });
});

describe('F08: a format URL is checked again online', () => {
  it('downloads a changed format URL instead of using a stale copy', async () => {
    const server = await startFormatServer({ '/format.js': formatJs('Review', '1.0.0', 'OLD') });
    const formatUrls = [`${server.origin}/format.js`];
    expect((await build({ ...story('Review', '1.0.0'), formatUrls })).marker).toBe('OLD');
    server.routes.set('/format.js', formatJs('Review', '1.1.0', 'NEW'));
    const result = await build({ ...story('Review', '1.1.0'), formatUrls });
    expect(result.marker).toBe('NEW');
    expect(result.warnings).toEqual([]);
    server.routes.set('/format.js', formatJs('Review', '2.0.0', 'MAJOR'));
    expect((await build({ ...story('Review', '2.0.0'), formatUrls })).marker).toBe('MAJOR');
  });

  it('asks with the ETag of its copy, and uses the copy when the server says it has not changed', async () => {
    const etags: (string | undefined)[] = [];
    const server = await startFormatServer({
      '/format.js': (req, res) => {
        etags.push(req.headers['if-none-match']);
        if (req.headers['if-none-match'] === '"v1"') {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader('etag', '"v1"');
        res.end(formatJs('Review', '1.0.0', 'CACHED'));
      },
    });
    const formatUrls = [`${server.origin}/format.js`];
    expect((await build({ ...story('Review', '1.0.0'), formatUrls })).marker).toBe('CACHED');
    const again = await build({ ...story('Review', '1.0.0'), formatUrls });
    expect(again.marker).toBe('CACHED');
    expect(again.warnings).toEqual([]);
    expect(etags).toEqual([undefined, '"v1"']);
  });
});

describe('F09: a missing or unparseable format-version is warned about, as Tweego does', () => {
  function localFormats(): string {
    const dir = join(tempRoot(), 'formats');
    for (const [folder, version] of [
      ['sugarcube-1', '1.0.35'],
      ['sugarcube-2', '2.37.3'],
    ] as const) {
      mkdirSync(join(dir, folder), { recursive: true });
      writeFileSync(join(dir, folder, 'format.js'), formatJs('SugarCube', version, `V${version}`));
    }
    return dir;
  }

  it.each([
    ['1.x', 'Could not parse version "1.x".'],
    ['', 'StoryData gives no format-version.'],
  ])('warns for %j and takes the greatest version', async (version, reason) => {
    const result = await build({ ...story('SugarCube', version), formatPaths: [localFormats()], noRemote: true });
    expect(result.format).toBe('SugarCube 2.37.3');
    expect(result.warnings).toEqual([`format "SugarCube": Auto-selecting greatest version; ${reason}`]);
  });
});

describe('F10 and #237: a cached download has one identity everywhere', () => {
  it('keeps an indexed format that names no format resolvable offline, by ID and by name, and listed and cleared by that name', async () => {
    const nameless = formatJs(undefined, '1.0.0', 'NAMELESS');
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('Review', '1.0.0', nameless)]),
      [`/${entryPath('Review', '1.0.0')}`]: nameless,
    });
    const formatIndices = [`${server.origin}/index.json`];
    expect((await build({ formatId: 'review-1', formatIndices })).format).toBe('Review 1.0.0');
    server.log.length = 0;
    expect((await build({ formatId: 'review-1', formatIndices, noRemote: true })).marker).toBe('NAMELESS');
    expect((await build({ ...story('Review', '1.0.0'), formatIndices, noRemote: true })).marker).toBe('NAMELESS');
    expect((await build({ ...story('review', '1.0.0'), formatIndices, noRemote: true })).marker).toBe('NAMELESS');
    expect(server.log).toEqual([]);
    expect(listCachedFormats().map((e) => `${e.name} ${e.version}`)).toEqual(['Review 1.0.0']);
    expect([...discoverCachedFormats().values()].map((f) => f.id)).toEqual(['review-1']);
    expect(clearCachedFormats('REVIEW')).toBe(1);
  });
});

describe('F11: a cache that cannot be written does not fail the build', () => {
  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'uses the download for this build, with a warning',
    async () => {
      const text = formatJs('Review', '1.0.0', 'MEMORY');
      const server = await startFormatServer({
        '/index.json': indexJson([indexEntry('Review', '1.0.0', text)]),
        [`/${entryPath('Review', '1.0.0')}`]: text,
        '/format.js': formatJs('Direct', '1.0.0', 'DIRECT'),
      });
      const cache = join(tempRoot(), 'cache');
      mkdirSync(cache, { recursive: true });
      chmodSync(cache, 0o555);
      try {
        const indexed = await build({ ...story('Review', '1.0.0'), formatIndices: [`${server.origin}/index.json`] });
        expect(indexed.marker).toBe('MEMORY');
        expect(indexed.warnings).toEqual([
          expect.stringMatching(
            /^Could not save Review 1\.0\.0 from http:\S+ to the format cache .*used for this build only\.$/,
          ),
        ]);
        const direct = await build({ ...story('Direct', '1.0.0'), formatUrls: [`${server.origin}/format.js`] });
        expect(direct.marker).toBe('DIRECT');
        expect(direct.warnings).toHaveLength(1);
      } finally {
        chmodSync(cache, 0o755);
      }
    },
  );
});

describe('F12: response sizes are limited', () => {
  it('refuses a response that declares a size above the limit, before reading it', async () => {
    const server = await startFormatServer({
      '/index.json': (_req, res) => {
        res.setHeader('content-length', String(MAX_RESPONSE_BYTES + 1));
        res.write('{');
        // Never finishes: the client must give up on the declared size alone.
      },
    });
    const result = await build({ ...story('Review', '1.0.0'), formatIndices: [`${server.origin}/index.json`] });
    expect(result.warnings).toContainEqual(
      expect.stringContaining(`the response is larger than the limit of ${MAX_RESPONSE_BYTES} bytes`),
    );
  });

  it('stops reading a streamed response once it passes the limit', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let sent = 0;
    const server = await startFormatServer({
      '/format.js': (_req, res) => {
        const pump = (): void => {
          while (sent <= MAX_RESPONSE_BYTES * 2) {
            sent += chunk.length;
            if (!res.write(chunk)) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        res.on('close', () => {
          sent = Number.POSITIVE_INFINITY;
        });
        pump();
      },
    });
    const result = await build({ ...story('Review', '1.0.0'), formatUrls: [`${server.origin}/format.js`] });
    expect(result.warnings).toContainEqual(expect.stringContaining('the response is larger than the limit'));
  });
});

describe('F13: checksums match by exact file name and are validated', () => {
  it('uses the checksum of format.js, not of another file whose name ends the same', async () => {
    const text = formatJs('Review', '1.0.0', 'RIGHT');
    const server = await startFormatServer({
      '/index.json': indexJson([
        indexEntry('Review', '1.0.0', undefined, {
          checksums: { 'notformat.js': '0'.repeat(64), 'format.js': sha256(text) },
        }),
      ]),
      [`/${entryPath('Review', '1.0.0')}`]: text,
    });
    const result = await build({ ...story('Review', '1.0.0'), formatIndices: [`${server.origin}/index.json`] });
    expect(result.marker).toBe('RIGHT');
    expect(result.warnings).toEqual([]);
  });

  it('skips an entry whose checksum is not a string, and says why', async () => {
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('Review', '1.0.0', undefined, { checksums: { 'format.js': 12345 } })]),
    });
    const result = await build({ ...story('Review', '1.0.0'), formatIndices: [`${server.origin}/index.json`] });
    expect(result.errors.join('\n')).toContain('its checksum for "format.js" is not a string');
  });

  it('refuses a file whose listed checksum is not a SHA-256 digest, but not the entry for another file’s', async () => {
    const text = formatJs('Review', '1.0.0', 'RIGHT');
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('Review', '1.0.0', undefined, { checksums: { 'format.js': 'abc' } })]),
      '/other.json': indexJson([
        indexEntry('Review', '1.0.0', undefined, { checksums: { 'format.js': sha256(text), 'notformat.js': '00' } }),
      ]),
      [`/${entryPath('Review', '1.0.0')}`]: text,
    });
    const bad = await build({ ...story('Review', '1.0.0'), formatIndices: [`${server.origin}/index.json`] });
    expect(bad.warnings.join('\n')).toContain('lists "abc" as the checksum of');
    expect(bad.format).toBeUndefined();
    const good = await build({ ...story('Review', '1.0.0'), formatIndices: [`${server.origin}/other.json`] });
    expect(good.marker).toBe('RIGHT');
    expect(good.warnings).toEqual([]);
  });

  it('warns that a file the index lists no checksum for was not verified', async () => {
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('Review', '1.0.0')]),
      [`/${entryPath('Review', '1.0.0')}`]: formatJs('Review', '1.0.0'),
    });
    const result = await build({ ...story('Review', '1.0.0'), formatIndices: [`${server.origin}/index.json`] });
    expect(result.warnings).toEqual([
      `The format index ${server.origin}/index.json lists no checksum for ${server.origin}/${entryPath('Review', '1.0.0')}; it was used unverified.`,
    ]);
  });
});

describe('F14: an ID means the same in every source', () => {
  it('finds a local format by name and major version whatever its folder is called, without the network', async () => {
    const dir = join(tempRoot(), 'formats');
    mkdirSync(join(dir, 'sugarcube-2.37'), { recursive: true });
    writeFileSync(join(dir, 'sugarcube-2.37', 'format.js'), formatJs('SugarCube', '2.37.3', 'LOCAL'));
    const external = guardNetwork();
    expect((await build({ formatPaths: [dir], noRemote: true })).marker).toBe('LOCAL');
    expect((await build({ formatPaths: [dir] })).marker).toBe('LOCAL');
    expect(external).toEqual([]);
  });

  it('warns when an ID matches formats with different names', async () => {
    const server = await startFormatServer({
      '/index.json': indexJson([indexEntry('Sugar Cube', '2.9.0'), indexEntry('sugar-cube', '2.8.0')]),
      [`/${entryPath('Sugar Cube', '2.9.0')}`]: formatJs('Sugar Cube', '2.9.0', 'SPACED'),
    });
    const result = await build({ formatId: 'sugar-cube-2', formatIndices: [`${server.origin}/index.json`] });
    expect(result.marker).toBe('SPACED');
    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        'Story format ID "sugar-cube-2" matches formats with different names (Sugar Cube, sugar-cube)',
      ),
    );
  });
});

describe('F15: a format URL accepts any name a local folder accepts', () => {
  it('uses a format named AC/DC from a format URL', async () => {
    const server = await startFormatServer({ '/format.js': formatJs('AC/DC', '1.0.0', 'ROCK') });
    const result = await build({ ...story('AC/DC', '1.0.0'), formatUrls: [`${server.origin}/format.js`] });
    expect(result.marker).toBe('ROCK');
  });
});

describe('F16: the story format packages page documents what twee-ts does', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'docs', 'story-format-packages.md'), 'utf-8');

  it('documents no compile option or package discovery that does not exist', () => {
    expect(page).not.toMatch(/format:\s*myFormat/);
    expect(page).not.toMatch(/auto-discovers/);
    expect(page).not.toMatch(/from 'twee-ts'/);
  });

  it('builds with a packaged format through formatPaths, as the page shows', async () => {
    const scope = join(tempRoot(), 'node_modules', '@twine-formats');
    mkdirSync(join(scope, 'sugarcube-2'), { recursive: true });
    writeFileSync(join(scope, 'sugarcube-2', 'format.js'), formatJs('SugarCube', '2.37.3', 'PACKAGED'));
    expect(page).toContain("formatPaths: ['node_modules/@twine-formats']");
    expect((await build({ formatPaths: [scope], noRemote: true })).marker).toBe('PACKAGED');
  });
});

describe('F17: format URLs and indices are checked at the boundary', () => {
  it.each([
    [
      'a file: URL',
      'file:///tmp/format.js',
      ': file: URLs are not supported; put the format in a folder listed in formatPaths',
    ],
    ['a relative path', './formats/x/format.js', ' is not an absolute URL (for a local format, use formatPaths)'],
    ['another scheme', 'ftp://example.test/format.js', ': only http: and https: URLs are supported'],
    [
      'credentials',
      'https://user:secret@example.test/format.js',
      ': URLs with a user name or password are not supported',
    ],
  ])('rejects %s with an error naming the option', async (_label, url, reason) => {
    for (const option of ['formatUrls', 'formatIndices'] as const) {
      const result = await build({ ...story('Review', '1.0.0'), [option]: [url] });
      expect(result.errors).toContainEqual(`${option}: ${JSON.stringify(url)}${reason}`);
    }
    await expect(resolveRemoteFormat('Review', '1.0.0', [], [url])).rejects.toThrow(
      `urls: ${JSON.stringify(url)}${reason}`,
    );
  });

  it('refuses a redirect from https to http', async () => {
    const server = await startFormatServer({ '/format.js': formatJs('Review', '1.0.0') });
    guardNetwork();
    const realFetch = vi.mocked(globalThis.fetch);
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const response = await realFetch(`${server.origin}/format.js`, init);
      // As if https://secure.test/format.js had redirected to the plain-http server.
      Object.defineProperty(response, 'url', { value: `${server.origin}/format.js` });
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith('https://secure.test') ? response : realFetch(input, init);
    });
    const result = await build({ ...story('Review', '1.0.0'), formatUrls: ['https://secure.test/format.js'] });
    expect(result.warnings).toContainEqual(expect.stringContaining('never from https: to http:'));
  });
});

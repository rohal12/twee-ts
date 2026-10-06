import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, compileIncremental } from '../src/compiler.js';
import { parseFormatJSON } from '../src/formats.js';
import { createStory, storyAdd } from '../src/story.js';
import {
  clearIndexCache,
  fetchAndCacheFormat,
  findCachedFormat,
  resolveRemoteFormatRequest,
} from '../src/remote-formats.js';
import type { FileCacheEntry, SFAIndexEntry } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
let root: string;
let cacheHome: string | undefined;
const servers: Server[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'twee-review-'));
  cacheHome = process.env['XDG_CACHE_HOME'];
  process.env['XDG_CACHE_HOME'] = root;
  clearIndexCache();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((done) => {
          s.closeAllConnections();
          s.close(() => done());
        }),
    ),
  );
  if (cacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
  else process.env['XDG_CACHE_HOME'] = cacheHome;
  rmSync(root, { recursive: true, force: true });
});

describe('replacing StorySettings (#236)', () => {
  it.each(['', 'jquery:on', 'obfuscate:none\nmodernizr:on'])(
    'removes all absent settings and legacy IFID: %j',
    (replacement) => {
      const story = createStory();
      storyAdd(story, { name: 'StorySettings', tags: [], text: `ifid:${IFID}\nobfuscate:rot13\njquery:off` }, []);
      storyAdd(story, { name: 'StorySettings', tags: [], text: replacement }, []);
      expect(story.legacyIFID).toBe('');
      expect([...story.twine1.settings]).toEqual(
        replacement === ''
          ? []
          : replacement === 'jquery:on'
            ? [['jquery', 'on']]
            : [
                ['obfuscate', 'none'],
                ['modernizr', 'on'],
              ],
      );
    },
  );
  it('keeps archive Start readable in cold and warm compilations', async () => {
    const sources = [
      {
        filename: 'first.tw',
        content: `:: StoryData\n{"ifid":"${IFID}"}\n:: StorySettings\nobfuscate:rot13\n:: Start\nHello`,
      },
      { filename: 'second.tw', content: ':: StorySettings\njquery:on' },
    ];
    const options = { sources, outputMode: 'twine1-archive' as const };
    const cache = new Map<string, FileCacheEntry>();
    for (const result of [
      await compile(options),
      await compileIncremental(options, cache),
      await compileIncremental(options, cache),
    ]) {
      expect(result.output).toContain('tiddler="Start"');
      expect(result.output).toContain('Hello');
      expect(result.output).not.toContain('Fgneg');
    }
  });
});

describe('format wrapper line terminators (#221)', () => {
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('ends leading and inner comments at %j', (end) => {
    const source = `// license {${end}window.storyFormat(// wrapper${end}{name:'Review',version:'1.0.0',// field${end}source:'<html>{{STORY_DATA}}</html>'});`;
    expect(parseFormatJSON(source, 'review-1')?.name).toBe('Review');
  });
});

const entry = (name = 'Review'): SFAIndexEntry => ({
  name,
  version: '1.0.0',
  files: ['format.js'],
  checksums: {},
  proofing: false,
});
const format = (name?: string): string =>
  `window.storyFormat(${JSON.stringify({ name, version: '1.0.0', source: '<html>{{STORY_DATA}}</html>' })});`;

describe('indexed formats retain identity in the offline cache (#237)', () => {
  it('resolves a downloaded nameless format by name and ID and compiles offline', async () => {
    const server = createServer((_req, res) => res.end(format()));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address');
    await fetchAndCacheFormat(entry(), `http://127.0.0.1:${address.port}/format.js`);
    expect(findCachedFormat({ kind: 'name', name: 'Review', version: '1.0.0' })?.name).toBe('Review');
    expect(findCachedFormat({ kind: 'id', id: 'review-1' })?.name).toBe('Review');
    const result = await compile({
      sources: [{ filename: 'story.tw', content: `:: StoryData\n{"ifid":"${IFID}"}\n:: Start\nHello` }],
      formatId: 'review-1',
      formatPaths: [],
      useTweegoPath: false,
      noRemote: true,
    });
    expect(result.output).toContain('Hello');
  });
});

describe('index download URLs (#238)', () => {
  it.each([
    ['/archive/index.json', 'Review', '/archive/twine2/Review/1.0.0/format.js'],
    ['/archive/index.json?revision=1#part', 'Review', '/archive/twine2/Review/1.0.0/format.js?revision=1'],
    ['/archive/index.json', 'Review #?', '/archive/twine2/Review%20%23%3F/1.0.0/format.js'],
  ])('derives the path from %s and encodes %s', async (indexPath, name, expectedPath) => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      if ((req.url ?? '').startsWith('/archive/index.json')) res.end(JSON.stringify({ twine2: [entry(name)] }));
      else if (req.url === expectedPath) res.end(format(name));
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address');
    const origin = `http://127.0.0.1:${address.port}`;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string | URL | Request, options?: RequestInit) => {
      if (!String(url).startsWith(origin)) throw new Error('external network forbidden');
      return realFetch(url, options);
    });
    const result = await resolveRemoteFormatRequest({ kind: 'name', name, version: '1.0.0' }, [
      `${origin}${indexPath}`,
    ]);
    expect(result?.name).toBe(name);
    expect(requests[1]).toBe(expectedPath);
  });
});

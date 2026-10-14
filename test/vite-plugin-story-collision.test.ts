/**
 * The dev server reports a generated story route that another story or an entry asset of the same server also
 * claims, as the production build does, instead of serving whichever plugin comes first (#346).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { COMPILE, STORY, buildFiles, cleanUp, makeProject, startServer } from './helpers/plugins.js';

afterEach(cleanUp);

const STORY_B = STORY.replace(/[0-9A-F-]{36}/, 'D674C58C-DEFA-4F70-B7A2-27742230C0FD');

const story = (dir: string, name: string, outputFilename: string, entry?: string): ReturnType<typeof tweeTsPlugin> =>
  tweeTsPlugin({
    sources: [join(dir, name)],
    format: 'test-format-1',
    outputFilename,
    ...(entry === undefined ? {} : { entry: join(dir, entry) }),
    compileOptions: COMPILE,
  });

const project = (): string =>
  makeProject({
    'a/start.tw': STORY,
    'b/start.tw': STORY_B,
    'app/b.html': 'download-page-B',
    'app/main.js': "import url from './b.html?url&no-inline'; globalThis.assetUrl = url;",
  });

async function request(url: string, method: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { method });
  return { status: response.status, body: await response.text() };
}

describe('story routes of one dev server (#346)', () => {
  it.each([true, false])('rejects its own imported HTML resource (watcher: %s)', async (watcher) => {
    const dir = project();
    const { url } = await startServer({
      root: dir,
      publicDir: false,
      server: watcher ? {} : { watch: null },
      plugins: [story(dir, 'a', 'b.html', 'app/main.js')],
    });
    const response = await request(`${url}/b.html`, 'GET');
    expect(response.status).toBe(500);
    expect(response.body).toContain('distinct outputFilename');
    expect((await request(`${url}/b.html`, 'HEAD')).status).toBe(500);
  });
  it.each(['index.html', 'nested/index.html'])(
    'rejects its own entry asset at %s and recovers after edits',
    async (outputFilename) => {
      const dir = project();
      const entry = join(dir, 'app/main.js');
      const collision = `globalThis.assetUrl = '/game/${outputFilename}'; // downloadable-original`;
      writeFileSync(entry, collision);
      const { url } = await startServer({
        root: dir,
        base: '/game/',
        publicDir: false,
        server: { watch: null },
        plugins: [
          {
            name: 'download-resource',
            generateBundle() {
              if (readFileSync(entry, 'utf8').includes('downloadable-original')) {
                this.emitFile({ type: 'asset', fileName: outputFilename, source: 'downloadable-original' });
              }
            },
          },
          story(dir, 'a', outputFilename, 'app/main.js'),
        ],
      });
      const route = `${url}/game/${outputFilename}`;
      expect((await request(route, 'GET')).status).toBe(500);
      expect((await request(route, 'HEAD')).status).toBe(500);
      const alias = route.replace(/index\.html$/, '');
      expect((await request(alias, 'GET')).status).toBe(500);
      writeFileSync(entry, 'globalThis.assetUrl = "distinct";');
      expect((await request(route, 'GET')).status).toBe(200);
      writeFileSync(entry, collision);
      expect((await request(route, 'GET')).status).toBe(500);
    },
  );

  it.each([false, true])('rejects its own entry asset in production (separate build: %s)', async (separate) => {
    const dir = project();
    await expect(
      buildFiles({
        root: dir,
        publicDir: false,
        build: separate ? { rolldownOptions: { input: join(dir, 'app/b.html') } } : {},
        plugins: [story(dir, 'a', 'b.html', 'app/main.js')],
      }),
    ).rejects.toThrow(/already writes|entry asset/);
  });
  it.each([
    ['a then b', ['a', 'b']],
    ['b then a', ['b', 'a']],
  ] as const)('rejects two stories with one output name: %s', async (_name, order) => {
    const dir = project();
    const { url } = await startServer({
      root: dir,
      publicDir: false,
      server: { watch: null },
      plugins: order.map((name) => story(dir, name, 'index.html')),
    });
    for (const path of ['/index.html', '/']) {
      const get = await request(`${url}${path}`, 'GET');
      expect(get.status).toBe(500);
      expect(get.body).toContain('distinct outputFilename');
    }
    expect((await request(`${url}/index.html`, 'HEAD')).status).toBe(500);
  });

  it('rejects the folder alias of a nested index.html, under a base', async () => {
    const dir = project();
    const { url } = await startServer({
      root: dir,
      base: '/game/',
      publicDir: false,
      server: { watch: null },
      plugins: [story(dir, 'a', 'x/index.html'), story(dir, 'b', 'x/index.html')],
    });
    expect((await request(`${url}/game/x/`, 'GET')).status).toBe(500);
    expect((await request(`${url}/game/x/index.html`, 'GET')).status).toBe(500);
  });

  it.each([
    ['a then b', ['a', 'b']],
    ['b then a', ['b', 'a']],
  ] as const)('rejects a story at the path of an entry asset: %s', async (_name, order) => {
    const dir = project();
    const plugins = {
      a: story(dir, 'a', 'a.html', 'app/main.js'),
      b: story(dir, 'b', 'b.html'),
    };
    const { url } = await startServer({
      root: dir,
      publicDir: false,
      server: { watch: null },
      plugins: order.map((name) => plugins[name]),
    });
    const response = await request(`${url}/b.html`, 'GET');
    expect(response.status).toBe(500);
    expect(response.body).toContain('b.html');
  });

  it('serves stories with distinct output names', async () => {
    const dir = project();
    const { url } = await startServer({
      root: dir,
      publicDir: false,
      server: { watch: null },
      plugins: [story(dir, 'a', 'a.html'), story(dir, 'b', 'b.html')],
    });
    const [a, b] = await Promise.all([request(`${url}/a.html`, 'GET'), request(`${url}/b.html`, 'GET')]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it.each([
    ['a', 'b'],
    ['b', 'a'],
  ] as const)('refreshes competing entry assets before serving a story (%s, %s)', async (first, second) => {
    const dir = project();
    const entry = join(dir, 'app/main.js');
    const collision = readFileSync(entry, 'utf8');
    writeFileSync(entry, 'globalThis.assetUrl = "distinct";');
    const plugins = {
      a: story(dir, 'a', 'a.html', 'app/main.js'),
      b: story(dir, 'b', 'b.html'),
    };
    const { url } = await startServer({
      root: dir,
      base: '/game/',
      publicDir: false,
      server: { watch: null },
      plugins: [plugins[first], plugins[second]],
    });
    const route = `${url}/game/b.html`;
    expect((await request(route, 'GET')).status).toBe(200);
    writeFileSync(entry, collision);
    expect((await request(route, 'HEAD')).status).toBe(500);
    const response = await request(route, 'GET');
    expect(response.status).toBe(500);
    expect(response.body).toContain('distinct outputFilename');
    writeFileSync(entry, 'globalThis.assetUrl = "distinct";');
    expect((await request(route, 'GET')).status).toBe(200);
    expect((await request(route, 'HEAD')).status).toBe(200);
  });
});

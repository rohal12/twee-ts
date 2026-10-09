/**
 * The dev server serves the story and the files the entry's bundle emits
 * separately with the bytes a build writes, also where the public folder or the
 * root holds a file of the same name (#339). A build writes them over the copy of
 * a public file, and a static host serves nothing else at their paths; the dev
 * server once let Vite's own file serving answer first. The build written to disk
 * is the oracle; Vite's request checks still apply, and every other public file
 * is still served.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createHttpServer, request } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Connect, InlineConfig } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { installStoryRoute } from '../src/plugins/vite-dev.js';
import {
  buildFiles,
  cleanUp,
  COMPILE,
  makeProject,
  SETTLED,
  startServer,
  STORY,
  tempDir,
  writeFiles,
} from './helpers/plugins.js';

afterEach(cleanUp);

const IMPORTED = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11"><rect fill="red"/></svg>\n';
const SHADOW = '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21"><rect fill="blue"/></svg>\n';
const OTHER = '<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"></svg>\n';
const PAGE = '<!doctype html><html><head></head><body>PUBLIC PAGE</body></html>\n';
const ENTRY = "import logo from './logo.svg?no-inline';\nwindow.reviewLogo = logo;\n";

/** Fetches `url` with node:http, which lets a test set the Host header; the status and the body. */
function get(url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const req = request(
      { host: target.hostname, port: target.port, path: target.pathname, headers: host ? { host } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on('error', fail);
    req.end();
  });
}

/** One way a static file can sit at the path of what the plugin serves. */
interface ShadowCase {
  readonly name: string;
  /** The project's files besides the story and the entry. */
  readonly files: Readonly<Record<string, string>>;
  readonly base: string;
  readonly publicDir?: string | false;
  readonly outputFilename?: string;
}

const CASES: readonly ShadowCase[] = [
  { name: 'a public file at the asset path', files: { 'public/logo.svg': SHADOW }, base: '/' },
  {
    name: 'a file of a custom publicDir under a base',
    files: { 'static/logo.svg': SHADOW },
    base: '/game/',
    publicDir: 'static',
  },
  { name: 'a public file, with publicDir off', files: { 'public/logo.svg': SHADOW }, base: '/', publicDir: false },
  { name: 'a root file, with publicDir off', files: { 'logo.svg': SHADOW }, base: '/', publicDir: false },
  { name: 'a root file under a base', files: { 'logo.svg': SHADOW }, base: '/game/', publicDir: false },
  { name: 'the same bytes in the public folder', files: { 'public/logo.svg': IMPORTED }, base: '/' },
  {
    name: 'a public page at the story path',
    files: { 'public/index.html': PAGE, 'public/logo.svg': SHADOW },
    base: '/',
  },
  {
    name: 'a public page at a nested story path, under a base',
    files: { 'public/game/index.html': PAGE, 'public/logo.svg': SHADOW },
    base: '/play/',
    outputFilename: 'game/index.html',
  },
];

function config(dir: string, shadow: ShadowCase): InlineConfig {
  return {
    root: dir,
    base: shadow.base,
    ...(shadow.publicDir === undefined ? {} : { publicDir: shadow.publicDir && join(dir, shadow.publicDir) }),
    plugins: [
      tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'app/main.js'),
        compileOptions: COMPILE,
        ...(shadow.outputFilename === undefined ? {} : { outputFilename: shadow.outputFilename }),
      }),
    ],
  };
}

/** The paths below the base where the story is served, and the file the build writes for each. */
function storyPathsOf(shadow: ShadowCase): [string, string][] {
  const output = shadow.outputFilename ?? 'index.html';
  return [
    [output, output],
    [output.slice(0, -'index.html'.length), output],
  ];
}

describe('vite plugin dev requests: static files at the paths of the story and its assets (#339)', () => {
  it.each(CASES)('serves what the build writes: $name', { timeout: 60_000 }, async (shadow) => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.js': ENTRY,
      'app/logo.svg': IMPORTED,
      ...shadow.files,
    });
    const outDir = tempDir();
    await buildFiles({ ...config(dir, shadow), build: { write: true, outDir, emptyOutDir: true } });
    const { url } = await startServer(config(dir, shadow));
    expect(readFileSync(join(outDir, 'logo.svg'), 'utf8')).toBe(IMPORTED);
    expect(await get(`${url}${shadow.base}logo.svg`)).toEqual({ status: 200, body: IMPORTED });
    for (const [path, file] of storyPathsOf(shadow)) {
      // The dev server adds Vite's client to the story; both hold the story, neither the public page.
      expect(readFileSync(join(outDir, file), 'utf8'), path).toContain('Hello from the story.');
      const served = await get(`${url}${shadow.base}${path}`);
      expect(served.status, path).toBe(200);
      expect(served.body, path).toContain('Hello from the story.');
      expect(served.body, path).not.toContain('PUBLIC PAGE');
    }
  });

  it('still serves every other public file, and checks the Host header first', { timeout: 30_000 }, async () => {
    const shadow: ShadowCase = { name: '', files: { 'public/logo.svg': SHADOW, 'public/other.svg': OTHER }, base: '/' };
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.js': ENTRY,
      'app/logo.svg': IMPORTED,
      ...shadow.files,
    });
    const { url } = await startServer(config(dir, shadow));
    expect(await get(`${url}/other.svg`)).toEqual({ status: 200, body: OTHER });
    expect(await get(`${url}/logo.svg`)).toEqual({ status: 200, body: IMPORTED });
    for (const path of ['/', '/index.html', '/logo.svg']) {
      expect((await get(`${url}${path}`, 'attacker.example')).status, path).toBe(403);
    }
  });

  it('serves the asset whether a public file of its name comes or goes while the server runs', async () => {
    const shadow: ShadowCase = { name: '', files: {}, base: '/' };
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.js': ENTRY, 'app/logo.svg': IMPORTED });
    const { url } = await startServer(config(dir, shadow));
    expect((await get(`${url}/logo.svg`)).body).toBe(IMPORTED);
    // Vite lists public files as its watcher sees them: once it serves the probe, it knows the others too.
    writeFiles(dir, { 'public/logo.svg': SHADOW, 'public/index.html': PAGE, 'public/public-probe.svg': OTHER });
    await expect.poll(async () => (await get(`${url}/public-probe.svg`)).body, SETTLED).toBe(OTHER);
    expect((await get(`${url}/logo.svg`)).body).toBe(IMPORTED);
    expect((await get(`${url}/index.html`)).body).toContain('Hello from the story.');
    rmSync(join(dir, 'public'), { recursive: true });
    await expect.poll(async () => (await get(`${url}/public-probe.svg`)).status, SETTLED).not.toBe(200);
    expect((await get(`${url}/logo.svg`)).body).toBe(IMPORTED);
    expect(existsSync(join(dir, 'public'))).toBe(false);
  });

  it('serves the public file again once the entry stops emitting an asset of its name', async () => {
    const shadow: ShadowCase = { name: '', files: { 'public/logo.svg': SHADOW }, base: '/' };
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.js': ENTRY,
      'app/logo.svg': IMPORTED,
      ...shadow.files,
    });
    const { url } = await startServer(config(dir, shadow));
    expect((await get(`${url}/logo.svg`)).body).toBe(IMPORTED);
    writeFiles(dir, { 'app/main.js': 'window.reviewLogo = null;\n' });
    await expect.poll(async () => (await get(`${url}/logo.svg`)).body, SETTLED).toBe(SHADOW);
    writeFiles(dir, { 'app/main.js': ENTRY });
    await expect.poll(async () => (await get(`${url}/logo.svg`)).body, SETTLED).toBe(IMPORTED);
  });
});

describe('installStoryRoute', () => {
  const named = (name: string): Connect.NextHandleFunction =>
    Object.defineProperty(
      (_req: unknown, _res: unknown, next: Connect.NextFunction) => {
        next();
      },
      'name',
      { value: name },
    );
  const route = named('storyRoute');
  /** A middleware stack holding middlewares of these names, and a mounted server for each `null`. */
  const stackOf = (names: readonly (string | null)[]): Connect.Server => {
    const stack: Connect.ServerStackItem[] = names.map((name) => ({
      route: '',
      handle: name === null ? createHttpServer() : named(name),
    }));
    const use = (handle: Connect.NextHandleFunction): void => {
      stack.push({ route: '', handle });
    };
    return Object.assign(Object.create(null) as Connect.Server, { stack, use });
  };
  const names = (server: Connect.Server): (string | null)[] =>
    server.stack.map(({ handle }) => (typeof handle === 'function' ? handle.name : null));

  it.each([
    {
      before: [
        null,
        'viteBaseMiddleware',
        'viteHMRPingMiddleware',
        'viteServePublicMiddleware',
        'viteTransformMiddleware',
      ],
      at: 3,
    },
    { before: ['viteBaseMiddleware', 'viteTransformMiddleware', 'viteServeStaticMiddleware'], at: 1 },
    { before: ['viteHMRPingMiddleware', 'viteMemoryFilesMiddleware'], at: 1 },
    { before: ['viteBaseMiddleware', 'viteHMRPingMiddleware', null], at: 3 },
  ])('goes before the first middleware that serves files, else last: $before', ({ before, at }) => {
    const server = stackOf(before);
    installStoryRoute(server, route);
    expect(names(server)).toEqual([...before.slice(0, at), 'storyRoute', ...before.slice(at)]);
  });
});

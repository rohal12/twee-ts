/**
 * The dev server answers requests for the story as Vite answers them for a page
 * of its own (RC4: D8-D10). Vite itself is the oracle: for each base URL and
 * output file name, a plain dev server holding an HTML file where the build
 * writes the story gets the same requests, and the two must agree on the
 * status and on Vite's protections (host check, `server.headers`). The files
 * the entry's bundle emits separately are served under their decoded names.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createHttpServer, request } from 'node:http';
import { join } from 'node:path';
import { createServer, version } from 'vite';
import type { InlineConfig } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  buildFiles,
  cleanUp,
  COMPILE,
  hasEntry,
  makeProject,
  runEntry,
  startServer,
  STORY,
  textOf,
  userScript,
  writeFiles,
} from './helpers/plugins.js';

/** Whether the Vite under test checks the Host header (5.4.12, 6.0.9 and newer). */
const hasHostCheck = ((): boolean => {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return major >= 7 || (major === 6 && (minor > 0 || patch >= 9)) || (major === 5 && minor === 4 && patch >= 12);
})();

afterEach(cleanUp);

const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'X-Twee-Test': 'yes',
  'X-Twee-Number': 7,
  'X-Twee-List': ['a', 'b'],
};

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

/** Sends a request with node:http, which lets a test set the Host header. */
function send(url: string, method: string, host?: string): Promise<Answer> {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: { ...(host ? { host } : {}), accept: 'text/html' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', fail);
    req.end();
  });
}

/** `path` with its first letter percent-encoded, as a client may send it. */
function encodeFirstLetter(path: string): string {
  return path.replace(/[a-z]/, (letter) => `%${letter.charCodeAt(0).toString(16)}`);
}

/** The paths a request for the story may take, below the (encoded) base. */
function storyRequests(outputFilename: string): string[] {
  const name = encodeURI(outputFilename);
  const folder = outputFilename.endsWith('index.html') ? [name.slice(0, -'index.html'.length)] : [];
  return [name, `${name}?v=1`, encodeFirstLetter(name), ...folder];
}

const BASES = ['/', '/game/', '/my game/'];
const NAMES = ['index.html', 'story.html', 'game/index.html', 'my story/ü.html'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT'];

describe('vite plugin dev requests: the story, against what Vite serves for a page (D8, D10)', () => {
  describe.each(BASES)('base %j', (base) => {
    it.each(NAMES)('outputFilename %j', { timeout: 30_000 }, async (outputFilename) => {
      const dir = makeProject({ 'story/start.tw': STORY });
      const oracleDir = makeProject({ [outputFilename]: '<!doctype html><html><head></head><body>PAGE</body></html>' });
      const shared: InlineConfig = { base, server: { headers: HEADERS } };
      const story = await startServer({
        ...shared,
        root: dir,
        plugins: [
          tweeTsPlugin({
            sources: [join(dir, 'story')],
            format: 'test-format-1',
            outputFilename,
            compileOptions: COMPILE,
          }),
        ],
      });
      const oracle = await startServer({ ...shared, root: oracleDir });
      const encodedBase = encodeURI(base);
      for (const path of storyRequests(outputFilename)) {
        for (const method of METHODS) {
          for (const host of [undefined, 'attacker.example']) {
            const label = `${method} ${encodedBase}${path} host=${host ?? 'loopback'}`;
            // The story is served for GET and HEAD only; another method gets what Vite answers for a missing page.
            const readable = method === 'GET' || method === 'HEAD';
            const oraclePath = readable ? path : 'missing.html';
            const expected = await send(`${oracle.url}${encodedBase}${oraclePath}`, method, host);
            const actual = await send(`${story.url}${encodedBase}${path}`, method, host);
            expect(actual.status, label).toBe(expected.status);
            if (actual.status !== 200) continue;
            expect(actual.headers['content-type'], label).toBe('text/html; charset=utf-8');
            expect(actual.headers['cache-control'], label).toBe('no-cache');
            for (const name of Object.keys(HEADERS)) {
              expect(expected.headers[name.toLowerCase()], label).toBeDefined();
              expect(actual.headers[name.toLowerCase()], label).toEqual(expected.headers[name.toLowerCase()]);
            }
            // A HEAD request gets the headers only.
            expect(actual.body.toString(), label).toBe(method === 'HEAD' ? '' : actual.body.toString());
            expect(method === 'HEAD' || actual.body.toString().includes('Hello from the story.'), label).toBe(true);
          }
        }
      }
      // A path the build doesn't write is left to Vite, which has nothing there either.
      for (const path of ['nope.html', `${outputFilename}x`]) {
        expect((await send(`${story.url}${encodedBase}${encodeURI(path)}`, 'GET')).status).toBe(404);
      }
    });
  });

  it.skipIf(!hasHostCheck)(
    'refuses the story to a request for another host, as Vite refuses its own pages',
    async () => {
      const dir = makeProject({ 'story/start.tw': STORY });
      const { url } = await startServer({
        root: dir,
        plugins: [tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE })],
      });
      expect((await send(`${url}/`, 'GET', 'attacker.example')).status).toBe(403);
    },
  );
});

describe.skipIf(!hasEntry)('vite plugin dev requests: files the entry emits separately (D9)', () => {
  it.each(BASES)('serves them under their decoded names below base %j, where the build writes them', async (base) => {
    const names = ['keep file.png', 'ünï.png', 'a+b%2.png'];
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.js': names.map((name, i) => `import f${i} from './${name}?no-inline';\nout.f${i} = f${i};\n`).join(''),
    });
    writeFiles(dir, Object.fromEntries(names.map((name, i) => [`app/${name}`, new Uint8Array(32).fill(i + 1)])));
    const config = (): InlineConfig => ({
      root: dir,
      base,
      plugins: [
        tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'test-format-1',
          entry: join(dir, 'app/main.js'),
          compileOptions: COMPILE,
        }),
      ],
    });
    const built = await buildFiles(config());
    const builtUrls = runEntry(userScript(textOf(built.get('index.html'))));
    const { url } = await startServer(config());
    const html = await (await fetch(`${url}${encodeURI(base)}`)).text();
    const devUrls = runEntry(userScript(html));
    // The script refers to each file by the same URL in dev as in the build.
    expect(devUrls).toEqual(builtUrls);
    for (const [i, name] of names.entries()) {
      const assetUrl = String(Reflect.get(Object(devUrls), `f${String(i)}`));
      const expected = new Uint8Array(32).fill(i + 1);
      // The build writes the file at the URL's path below the base, decoded.
      const written = built.get(decodeURIComponent(assetUrl).slice(base.length));
      expect(written === undefined ? undefined : new Uint8Array(Buffer.from(written)), name).toEqual(expected);
      // As a browser requests it: characters a URL can't hold encoded, escapes kept.
      const answer = await send(new URL(assetUrl, url).href, 'GET');
      expect(answer.status, name).toBe(200);
      expect(answer.headers['content-type'], name).toBe('image/png');
      expect(new Uint8Array(answer.body), name).toEqual(expected);
    }
  });
});

describe('vite plugin dev requests: in middleware mode', () => {
  it('serves the story below the base and leaves every other request to the app that mounts Vite', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const vite = await createServer({
      configFile: false,
      root: dir,
      base: '/game/',
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, watch: null },
      plugins: [tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE })],
    });
    // The app answers what Vite leaves to it.
    const app = createHttpServer((req, res) => {
      vite.middlewares(req, res, () => {
        res.statusCode = 418;
        res.end('app');
      });
    });
    await new Promise<void>((done) => app.listen(0, '127.0.0.1', done));
    try {
      const address = app.address();
      const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? String(address.port) : ''}`;
      expect((await send(`${url}/game/`, 'GET')).body.toString()).toContain('Hello from the story.');
      expect((await send(`${url}/index.html`, 'GET')).status).toBe(418);
      expect((await send(`${url}/game/%E0%A4%A.html`, 'GET')).status).not.toBe(200);
    } finally {
      await new Promise((done) => app.close(done));
      await vite.close();
    }
  });
});

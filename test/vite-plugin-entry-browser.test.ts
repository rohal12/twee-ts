/**
 * An entry's worker in a real browser (#290): Chromium loads the story page, which runs the Story JavaScript as a
 * story format does, and the worker the entry starts with `new Worker(new URL('./worker.js', import.meta.url))`
 * loads, imports a module of its own and posts its message back. This covers what the script-level checks in
 * vite-plugin-entry-urls.test.ts cannot: the worker's media type, the URL as a real `document.baseURI` resolves
 * it, and the worker's own imports. It runs for a build (the entry bundled inside it, and in a build of its own)
 * and for the dev server, under the default, an absolute and a relative base.
 *
 * The browser is the one at `CHROME_PATH`, else Playwright's own Chromium, else an installed Google Chrome (which
 * the CI runners have). Without any, the tests are skipped, except in CI, where they fail.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { InlineConfig } from 'vite';
import { launchChromium } from './helpers/chromium.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { COMPILE, STORY, buildFiles, cleanUp, makeProject, startServer, storyWith } from './helpers/plugins.js';

afterEach(cleanUp);

const browser = await launchChromium();
afterAll(async () => {
  await browser?.close();
});

/** A story format whose page runs the Story JavaScript when it loads, as SugarCube and Harlowe do. */
const RUNNER_FORMAT = `window.storyFormat(${JSON.stringify({
  name: 'Runner',
  version: '1.0.0',
  source:
    '<html><head><title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}' +
    '<script>(0, eval)(document.getElementById("twine-user-script").textContent);</script></body></html>',
})});`;

const FILES = {
  'story/start.tw': STORY,
  'formats/runner-1/format.js': RUNNER_FORMAT,
  'answer.js': 'export const answer = 42;',
  'worker.js': 'import { answer } from "./answer.js";\npostMessage(answer);',
  'extra.js': 'globalThis.extra = 1;',
  'entry.js': [
    'const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });',
    'worker.onmessage = (event) => { document.title = "worker:" + String(event.data); };',
    'worker.onerror = (event) => { document.title = "error:" + (event.message || "the worker did not load"); };',
  ].join('\n'),
};

/** Serves the files of a build under `base`, each with the media type its extension gives. */
async function serveBuild(files: ReadonlyMap<string, string | Uint8Array>, base: string): Promise<string> {
  const types: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const content = path.startsWith(base) ? files.get(path.slice(base.length)) : undefined;
    if (content === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(content);
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((closed) => s.close(closed))));
});

/** The page's title once the worker answered or failed (or after 15 s). */
async function workerOutcome(pageUrl: string): Promise<string> {
  if (browser === undefined) throw new Error('No Chromium could be launched: set CHROME_PATH.');
  const page = await browser.newPage();
  try {
    // Well inside the 30 s of the polls that call this, so a load that never ends fails here, naming the step.
    await page.goto(pageUrl, { timeout: 10_000 });
    // A string, as it is evaluated in the page (the tests are type-checked without the DOM's types).
    await page.waitForFunction('/^(worker|error):/.test(document.title)', undefined, { timeout: 15_000 });
    return await page.title();
  } finally {
    await page.close();
  }
}

type Branch = 'inside the build' | 'a build of its own' | 'the dev server';
const BRANCHES: readonly Branch[] = ['inside the build', 'a build of its own', 'the dev server'];

const SETUPS = [
  { base: '/', outputFilename: 'index.html' },
  { base: '/app/', outputFilename: 'index.html' },
  { base: './', outputFilename: 'nested/story.html' },
] as const;

// A test builds the story and loads it in Chromium, waiting up to 15 s for the worker; the first of them also pays
// for the browser's first page, so the default 5 s limit is shorter than the wait inside it.
describe.runIf(browser !== undefined || process.env['CI'] !== undefined)(
  'an entry’s worker in Chromium (#290)',
  { timeout: 60_000 },
  () => {
    describe.each(SETUPS)('under base $base, as $outputFilename', ({ base, outputFilename }) => {
      it.each(BRANCHES)('loads and posts its message back: %s', async (branch) => {
        const dir = makeProject(FILES);
        const plugin = tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'runner-1',
          entry: join(dir, 'entry.js'),
          outputFilename,
          compileOptions: { formatPaths: [join(dir, 'formats')], useTweegoPath: false, noRemote: true },
        });
        const common: InlineConfig = { root: dir, base, publicDir: false, plugins: [plugin], logLevel: 'silent' };
        // A relative base deploys the story at the site root.
        const deployedAt = base === './' ? '/' : base;
        let origin: string;
        if (branch === 'the dev server') {
          origin = (await startServer({ ...common, server: { watch: null } })).url;
        } else {
          const own = branch === 'a build of its own' ? { rolldownOptions: { input: join(dir, 'extra.js') } } : {};
          origin = await serveBuild(await buildFiles({ ...common, build: own }), deployedAt);
        }
        expect(await workerOutcome(`${origin}${deployedAt}${outputFilename}`)).toBe('worker:42');
      });
    });
  },
);

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

/** An HMR client of the dev server, as Vite's client in a page is one. */
interface HmrClient {
  /** The type of each message the server sent it, in order. */
  readonly received: readonly string[];
  /** How many of them were a full-reload. */
  readonly reloads: () => number;
  readonly socket: WebSocket;
}

/**
 * Connects to the HMR socket of the dev server at `origin` (base `/`) as Vite's client does, and records the
 * messages it receives from then on. Resolves once the socket is open, so the server counts it as a page; rejects
 * when it closes or fails first.
 */
async function hmrClient(origin: string): Promise<HmrClient> {
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/`, 'vite-hmr');
  sockets.push(socket);
  const received: string[] = [];
  socket.addEventListener('message', (event) => {
    const message: unknown = JSON.parse(String(event.data));
    const type = typeof message === 'object' && message !== null && 'type' in message ? message.type : undefined;
    received.push(String(type));
  });
  await new Promise((open, fail) => {
    socket.addEventListener('open', open);
    socket.addEventListener('error', () => {
      fail(new Error('the HMR socket failed before it opened'));
    });
    socket.addEventListener('close', () => {
      fail(new Error('the HMR socket closed before it opened'));
    });
  });
  return { received, reloads: () => received.filter((type) => type === 'full-reload').length, socket };
}

/** A page function, as source (the tests have no DOM types), that tells whether the first passage reads `text`. */
const passageIs = (text: string): string =>
  `document.querySelector('tw-passagedata')?.textContent === ${JSON.stringify(text)}`;

// An open story page reloads after an edit under every base, including ones Vite encodes (#329).
describe.runIf(browser !== undefined || process.env['CI'] !== undefined)(
  'a story page reloading after an edit in Chromium (#329)',
  { timeout: 60_000 },
  () => {
    it.each([
      ['/', 'story.html'],
      ['/game/', 'nested/index.html'],
      ['/my game/', 'story.html'],
      ['/café/', 'story.html'],
      ['/café/', 'nested/index.html'],
      ['/my%20game/', 'index.html'],
    ])('under base %s, as %s', async (base, outputFilename) => {
      if (browser === undefined) throw new Error('No Chromium could be launched: set CHROME_PATH.');
      const dir = makeProject({ 'story.tw': storyWith('Before edit') });
      const plugin = tweeTsPlugin({
        sources: [join(dir, 'story.tw')],
        outputFilename,
        format: 'test-format-1',
        compileOptions: COMPILE,
      });
      const { server, url } = await startServer({ root: dir, base, publicDir: false, plugins: [plugin] });
      const page = await browser.newPage();
      try {
        await page.goto(`${url}${server.config.base}${outputFilename}`);
        await page.waitForFunction(passageIs('Before edit'));
        writeFileSync(join(dir, 'story.tw'), storyWith('After edit'));
        await page.waitForFunction(passageIs('After edit'), undefined, { timeout: 15_000 });
        expect(await page.locator('tw-passagedata').textContent()).toBe('After edit');
      } finally {
        await page.close();
      }
    });
  },
);

// A worker of the story page that is still served keeps starting while the story fails to compile (#360).
describe.runIf(browser !== undefined || process.env['CI'] !== undefined)(
  'a retained story page after a failed story compile in Chromium (#360)',
  { timeout: 60_000 },
  () => {
    it('starts its worker from the bundle it was compiled with, and the new one once the story compiles', async () => {
      const dir = makeProject(FILES);
      const plugin = tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'runner-1',
        entry: join(dir, 'entry.js'),
        compileOptions: { formatPaths: [join(dir, 'formats')], useTweegoPath: false, noRemote: true },
      });
      const { url } = await startServer({ root: dir, publicDir: false, plugins: [plugin], server: { watch: null } });
      const pageUrl = `${url}/index.html`;
      // The server's messages to its pages, received by a client of its own that stays connected. Vite holds a
      // full-reload sent while no page is connected for the next one that connects, which then loads twice; with this
      // client connected, the reload after the story compiles again is received here, and is the signal to wait on.
      const client = await hmrClient(url);
      expect(await workerOutcome(pageUrl)).toBe('worker:42');

      // The story no longer compiles, then a module of the worker changes: the bundle succeeds, the story does not.
      writeFileSync(join(dir, 'story/start.tw'), `${STORY}\n:: Incomplete [\n`);
      await fetch(pageUrl);
      writeFileSync(join(dir, 'answer.js'), 'export const answer = 84;');
      await fetch(pageUrl);
      // A bundle the server repeats for a file whose timestamp is too coarse to tell it changed reloads an open
      // page, so a page is opened again until one stays.
      await expect.poll(() => workerOutcome(pageUrl), { timeout: 30_000 }).toBe('worker:42');

      writeFileSync(join(dir, 'story/start.tw'), STORY);
      const before = client.reloads();
      await fetch(pageUrl);
      await expect.poll(() => client.reloads(), { timeout: 10_000 }).toBeGreaterThan(before);
      await expect.poll(() => workerOutcome(pageUrl), { timeout: 30_000 }).toBe('worker:84');
    });

    // A story compiled while no page is connected sends a full-reload that Vite holds for the next page to connect,
    // which then loads twice: once as it opens, once as the reload arrives. The story page must come through that.
    it('loads the new worker on a page reloaded by a reload held while no page was connected', async () => {
      if (browser === undefined) throw new Error('No Chromium could be launched: set CHROME_PATH.');
      const dir = makeProject(FILES);
      const plugin = tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'runner-1',
        entry: join(dir, 'entry.js'),
        compileOptions: { formatPaths: [join(dir, 'formats')], useTweegoPath: false, noRemote: true },
      });
      const { server, url } = await startServer({
        root: dir,
        publicDir: false,
        plugins: [plugin],
        server: { watch: null },
      });
      const pageUrl = `${url}/index.html`;

      // The reload is held, and a client connecting afterwards receives it after `connected`.
      writeFileSync(join(dir, 'answer.js'), 'export const answer = 63;');
      await fetch(pageUrl);
      const client = await hmrClient(url);
      await expect.poll(() => client.received, { timeout: 10_000 }).toEqual(['connected', 'full-reload']);
      client.socket.close();
      await expect.poll(() => server.ws.clients.size, { timeout: 10_000 }).toBe(0);

      // Held again, for the story page this time.
      writeFileSync(join(dir, 'answer.js'), 'export const answer = 84;');
      await fetch(pageUrl);
      const page = await browser.newPage();
      let navigations = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations++;
      });
      try {
        await page.goto(pageUrl, { timeout: 10_000 });
        await expect.poll(() => navigations, { timeout: 10_000 }).toBe(2);
        await page.waitForFunction('/^(worker|error):/.test(document.title)', undefined, { timeout: 15_000 });
        expect(await page.title()).toBe('worker:84');
        expect(await page.evaluate('performance.getEntriesByType("navigation")[0].type')).toBe('reload');
      } finally {
        await page.close();
      }
    });
  },
);

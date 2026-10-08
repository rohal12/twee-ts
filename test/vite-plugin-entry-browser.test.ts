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
import { chromium } from 'playwright-core';
import type { Browser, LaunchOptions } from 'playwright-core';
import type { InlineConfig } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { COMPILE, STORY, buildFiles, cleanUp, makeProject, startServer, storyWith } from './helpers/plugins.js';

afterEach(cleanUp);

/** Launches the first Chromium that starts, or gives undefined. */
async function launchChromium(): Promise<Browser | undefined> {
  const path = process.env['CHROME_PATH'];
  const attempts: LaunchOptions[] = [
    ...(path === undefined || path === '' ? [] : [{ executablePath: path }]),
    {},
    { channel: 'chrome' },
  ];
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch {
      // Not installed there: try the next.
    }
  }
  return undefined;
}

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
    await page.goto(pageUrl);
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

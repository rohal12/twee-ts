import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { makeProject, cleanUp, serverUrl, watcherReady, STORY, storyWith, COMPILE } from './helpers/plugins.js';

let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await cleanUp();
});

const BROKEN_STORY = `${STORY}\n:: Incomplete [\n`;
const ENTRY = [
  'new Worker(new URL("./worker.js", import.meta.url), { type: "module" });',
  'import note from "./note.txt?url&no-inline";',
  'globalThis.noteUrl = note;',
  '',
].join('\n');

interface Dev {
  readonly url: string;
  /** How many errors the plugin has reported so far. */
  readonly errors: () => number;
}

async function start(root: string, watcher: boolean): Promise<Dev> {
  const logger = createLogger('silent');
  let errors = 0;
  logger.error = (message) => {
    if (message.includes('[twee-ts]')) errors++;
  };
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    customLogger: logger,
    server: { host: '127.0.0.1', port: 0, ...(watcher ? {} : { watch: null }) },
    plugins: [
      tweeTsPlugin({
        sources: [join(root, 'story')],
        format: 'test-format-1',
        entry: join(root, 'app/entry.js'),
        compileOptions: COMPILE,
      }),
    ],
  });
  await server.listen();
  await watcherReady(server);
  return { url: `${serverUrl(server)}/`, errors: () => errors };
}

/** The story page, after the server has caught up with every edit made so far. */
async function page(dev: Dev): Promise<string> {
  return (await fetch(dev.url)).text();
}

/**
 * Edits `file`, then catches the server up with it. With a watcher and an edit that leaves a failure to report,
 * it first waits for the plugin to report the rebuild the watcher started.
 */
async function edit(dev: Dev, watcher: boolean, file: string, content: string, fails = true): Promise<void> {
  const reported = dev.errors();
  writeFileSync(file, content);
  if (watcher && fails) await expect.poll(dev.errors, { timeout: 10_000, interval: 50 }).toBeGreaterThan(reported);
  await page(dev);
}

/** The URL, below the server, of the first file in `html` whose name matches `pattern`. */
function assetIn(html: string, pattern: RegExp): string {
  const found = pattern.exec(html)?.[0];
  if (found === undefined) throw new Error(`no ${String(pattern)} in the page`);
  return found.replace(/^\.?\//, '');
}

const WORKER = /assets\/worker-[^"'\s)\\]+\.js/;
const NOTE = /\/note\.txt(?=")/;

/** What the server answers for `asset`, as its status and a marker if the body holds it (else the body). */
async function served(dev: Dev, asset: string, marker: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${dev.url}${asset}`);
  const body = await response.text();
  return { status: response.status, body: body.includes(marker) ? marker : body };
}

describe.each([
  ['with a watcher', true],
  ['with no watcher', false],
])('vite plugin dev: the assets of the last good story (#360), %s', (_name, watcher) => {
  const project = (): string =>
    makeProject({
      'story/start.tw': STORY,
      'app/entry.js': ENTRY,
      'app/worker.js': 'postMessage(42);\n',
      'app/note.txt': 'old-version\n',
    });

  it('serves the worker and the asset of the page it still serves while the story fails to compile', async () => {
    const root = project();
    const dev = await start(root, watcher);
    const first = await page(dev);
    const worker = assetIn(first, WORKER);
    const note = assetIn(first, NOTE);
    expect(await served(dev, worker, 'postMessage(42);')).toEqual({ status: 200, body: 'postMessage(42);' });

    await edit(dev, watcher, join(root, 'story/start.tw'), BROKEN_STORY);
    await edit(dev, watcher, join(root, 'app/worker.js'), 'postMessage(84);\n');
    await edit(dev, watcher, join(root, 'app/note.txt'), 'new-version\n');

    expect(await page(dev)).toBe(first);
    expect(await served(dev, worker, 'postMessage(42);')).toEqual({ status: 200, body: 'postMessage(42);' });
    expect(await served(dev, note, 'old-version')).toEqual({ status: 200, body: 'old-version' });
  }, 30_000);

  it('keeps them through repeated failures and serves the new ones with the corrected story', async () => {
    const root = project();
    const dev = await start(root, watcher);
    const first = await page(dev);
    const worker = assetIn(first, WORKER);

    await edit(dev, watcher, join(root, 'story/start.tw'), BROKEN_STORY);
    await edit(dev, watcher, join(root, 'app/worker.js'), 'postMessage(84);\n');
    await edit(dev, watcher, join(root, 'app/note.txt'), 'new-version\n');
    await edit(dev, watcher, join(root, 'story/start.tw'), `${BROKEN_STORY}\n:: Another [\n`);
    expect(await served(dev, worker, 'postMessage(42);')).toEqual({ status: 200, body: 'postMessage(42);' });

    await edit(dev, watcher, join(root, 'story/start.tw'), storyWith('Recovered.'), false);
    const recovered = await page(dev);
    expect(recovered).toContain('Recovered.');
    const newWorker = assetIn(recovered, WORKER);
    expect(newWorker).not.toBe(worker);
    expect(await served(dev, newWorker, 'postMessage(84);')).toEqual({ status: 200, body: 'postMessage(84);' });
    expect(await served(dev, assetIn(recovered, NOTE), 'new-version')).toEqual({ status: 200, body: 'new-version' });
  }, 30_000);

  it('keeps them when the entry then fails to bundle, and recovers once it bundles again', async () => {
    const root = project();
    const dev = await start(root, watcher);
    const first = await page(dev);
    const worker = assetIn(first, WORKER);

    await edit(dev, watcher, join(root, 'story/start.tw'), BROKEN_STORY);
    await edit(dev, watcher, join(root, 'app/worker.js'), 'postMessage(84);\n');
    await edit(dev, watcher, join(root, 'app/entry.js'), 'globalThis.probe = ;\n');
    expect(await page(dev)).toBe(first);
    expect(await served(dev, worker, 'postMessage(42);')).toEqual({ status: 200, body: 'postMessage(42);' });

    await edit(dev, watcher, join(root, 'app/entry.js'), ENTRY, false);
    await edit(dev, watcher, join(root, 'story/start.tw'), storyWith('Recovered.'), false);
    const recovered = await page(dev);
    expect(await served(dev, assetIn(recovered, WORKER), 'postMessage(84);')).toEqual({
      status: 200,
      body: 'postMessage(84);',
    });
  }, 30_000);

  it('recovers from a story that fails to compile at the start', async () => {
    const root = project();
    writeFileSync(join(root, 'story/start.tw'), BROKEN_STORY);
    const dev = await start(root, watcher);
    expect(await page(dev)).not.toContain('tw-storydata');

    await edit(dev, watcher, join(root, 'story/start.tw'), STORY, false);
    const recovered = await page(dev);
    expect(await served(dev, assetIn(recovered, WORKER), 'postMessage(42);')).toEqual({
      status: 200,
      body: 'postMessage(42);',
    });
  }, 30_000);
});

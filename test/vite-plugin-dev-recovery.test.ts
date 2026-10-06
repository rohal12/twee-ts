import { describe, it, expect, afterEach } from 'vitest';
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { makeProject, cleanUp, serverUrl, watcherReady, STORY, storyWith, COMPILE } from './helpers/plugins.js';

let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await cleanUp();
});

/** Starts a dev server for the project at `root`; with `watcher: false`, `server.watch` is null. */
async function start(root: string, entry: string, watcher = true): Promise<string> {
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, ...(watcher ? {} : { watch: null }) },
    plugins: [
      tweeTsPlugin({ sources: [join(root, 'story')], format: 'test-format-1', entry, compileOptions: COMPILE }),
    ],
  });
  await server.listen();
  await watcherReady(server);
  return `${serverUrl(server)}/`;
}

async function page(url: string): Promise<string> {
  return (await fetch(url)).text();
}

const BROKEN = 'globalThis.probe = ;\n';
const FIXED = 'globalThis.probe = "RECOVERED";\n';

describe('vite plugin dev: an entry that fails its first bundle (#269)', () => {
  it('recovers when an entry outside the root is corrected', async () => {
    const root = makeProject({ 'story/start.tw': STORY });
    const outside = makeProject({ 'main.js': BROKEN });
    const entry = join(outside, 'main.js');
    const url = await start(root, entry);
    expect(await page(url)).not.toContain('tw-storydata');
    writeFileSync(entry, FIXED);
    await expect.poll(() => page(url), { timeout: 10_000, interval: 100 }).toContain('RECOVERED');
  }, 30_000);

  it('recovers on the next request when nothing watches the files and the entry is corrected', async () => {
    const root = makeProject({ 'story/start.tw': STORY, 'app/main.js': BROKEN });
    const entry = join(root, 'app/main.js');
    const url = await start(root, entry, false);
    expect(await page(url)).not.toContain('tw-storydata');
    writeFileSync(entry, FIXED);
    expect(await page(url)).toContain('RECOVERED');
  });
});

describe('vite plugin dev: a timestamp-preserving edit with no watcher (#270)', () => {
  const stamp = new Date('2026-01-01T00:00:00Z');

  /** Replaces the file's content with `content` (the same length) and restores its modification time. */
  const replaceKeepingTime = (file: string, content: string): void => {
    const before = statSync(file);
    writeFileSync(file, content);
    utimesSync(file, stamp, stamp);
    const after = statSync(file);
    expect([after.mtimeMs, after.size, after.ino]).toEqual([before.mtimeMs, before.size, before.ino]);
  };

  it('serves a story source changed in place', async () => {
    const root = makeProject({ 'story/start.tw': storyWith('ORIGINAL'), 'app/main.js': FIXED });
    const source = join(root, 'story/start.tw');
    utimesSync(source, stamp, stamp);
    const url = await start(root, join(root, 'app/main.js'), false);
    expect(await page(url)).toContain('ORIGINAL');
    replaceKeepingTime(source, storyWith('REPLACED'));
    expect(await page(url)).toContain('REPLACED');
  });

  it('serves an entry changed in place', async () => {
    const root = makeProject({ 'story/start.tw': STORY, 'app/main.js': FIXED });
    const entry = join(root, 'app/main.js');
    utimesSync(entry, stamp, stamp);
    const url = await start(root, entry, false);
    expect(await page(url)).toContain('RECOVERED');
    replaceKeepingTime(entry, FIXED.replace('RECOVERED', 'REPLACEDX'));
    expect(await page(url)).toContain('REPLACEDX');
  });
});

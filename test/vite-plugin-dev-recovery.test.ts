import { describe, it, expect, afterEach } from 'vitest';
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
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

describe('vite plugin dev: an entry file edited while it is bundled, with no watcher (#286)', () => {
  /** Whether a module id names `file`: Vite's ids use forward slashes, also on Windows. */
  const names = (id: string, file: string): boolean => id.replaceAll('\\', '/') === file.replaceAll('\\', '/');

  /** A plugin that, the first time it sees `file` loaded, writes `text` to `target` (an editor save during the build). */
  function editDuring(file: string, target: string, text: string): Plugin {
    let done = false;
    return {
      name: 'edit-during-bundle',
      transform(_code: string, id: string) {
        if (names(id, file) && !done) {
          done = true;
          writeFileSync(target, text);
        }
        return null;
      },
    };
  }

  async function startWith(root: string, entry: string, extra: Plugin[]): Promise<string> {
    server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, watch: null },
      plugins: [
        ...extra,
        tweeTsPlugin({ sources: [join(root, 'story')], format: 'test-format-1', entry, compileOptions: COMPILE }),
      ],
    });
    await server.listen();
    return `${serverUrl(server)}/`;
  }

  it('serves the edited entry on the next request after the first bundle', async () => {
    const root = makeProject({ 'story/start.tw': STORY, 'app/main.js': 'globalThis.probe = "BEFORE";\n' });
    const entry = join(root, 'app/main.js');
    const url = await startWith(root, entry, [editDuring(entry, entry, 'globalThis.probe = "AFTER";\n')]);
    expect(await page(url)).toContain('AFTER');
    // An ordinary edit after the bundle is still seen.
    writeFileSync(entry, 'globalThis.probe = "CONTROL";\n');
    expect(await page(url)).toContain('CONTROL');
  });

  it('serves the edited entry after a later bundle, too', async () => {
    const root = makeProject({ 'story/start.tw': STORY, 'app/main.js': 'globalThis.probe = "ONE";\n' });
    const entry = join(root, 'app/main.js');
    let armed = false;
    const plugin: Plugin = {
      name: 'edit-during-later-bundle',
      transform(_code: string, id: string) {
        if (names(id, entry) && armed) {
          armed = false;
          writeFileSync(entry, 'globalThis.probe = "THREE";\n');
        }
        return null;
      },
    };
    const url = await startWith(root, entry, [plugin]);
    expect(await page(url)).toContain('ONE');
    armed = true;
    writeFileSync(entry, 'globalThis.probe = "TWO";\n');
    // This request's bundle read TWO before the edit; the next request must notice the edit it missed.
    expect(await page(url)).toContain('TWO');
    expect(await page(url)).toContain('THREE');
  });

  it('serves an import edited while the bundle is made, found by that bundle itself', async () => {
    const root = makeProject({
      'story/start.tw': STORY,
      'app/main.js': 'import { value } from "./dep.js"; globalThis.probe = value;\n',
      'app/dep.js': 'export const value = "BEFORE";\n',
    });
    const entry = join(root, 'app/main.js');
    const dep = join(root, 'app/dep.js');
    const url = await startWith(root, entry, [editDuring(dep, dep, 'export const value = "AFTER";\n')]);
    expect(await page(url)).toContain('AFTER');
  });
});

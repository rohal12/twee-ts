import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
  return startWith(root, entry, undefined, watcher);
}

/** Like start(), with `extra` among the user's plugins, which the entry build runs too. */
async function startWith(root: string, entry: string, extra?: Plugin, watcher = false): Promise<string> {
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, ...(watcher ? {} : { watch: null }) },
    plugins: [
      ...(extra === undefined ? [] : [extra]),
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

describe('vite plugin dev: a module imported by an entry that fails its first bundle (#269)', () => {
  const ENTRY = 'import { value } from "./dep.js"; globalThis.probe = value;\n';

  it.each([
    ['inside the root, with a watcher', true, true],
    ['inside the root, with no watcher', true, false],
    ['outside the root, with no watcher', false, false],
  ])('recovers when the imported module is corrected (%s)', async (_name, inside, watcher) => {
    const root = makeProject({
      'story/start.tw': STORY,
      ...(inside ? { 'app/main.js': ENTRY, 'app/dep.js': 'export const value = ;\n' } : {}),
    });
    const app = inside ? join(root, 'app') : makeProject({ 'main.js': ENTRY, 'dep.js': 'export const value = ;\n' });
    const url = await start(root, join(app, 'main.js'), watcher);
    expect(await page(url)).not.toContain('tw-storydata');
    writeFileSync(join(app, 'dep.js'), 'export const value = "RECOVERED";\n');
    await expect.poll(() => page(url), { timeout: 10_000, interval: 100 }).toContain('RECOVERED');
  });
});

describe('vite plugin dev: an import that does not exist when the entry is bundled (#269)', () => {
  const ENTRY = 'import { value } from "./later.js"; globalThis.probe = value;\n';
  const CREATED = 'export const value = "RECOVERED";\n';

  it.each([
    ['inside the root, with a watcher', true, true],
    ['inside the root, with no watcher', true, false],
    ['outside the root, with a watcher', false, true],
    ['outside the root, with no watcher', false, false],
  ])(
    'recovers when the import is created (%s)',
    async (_name, inside, watcher) => {
      const root = makeProject({ 'story/start.tw': STORY, ...(inside ? { 'app/main.js': ENTRY } : {}) });
      const app = inside ? join(root, 'app') : makeProject({ 'main.js': ENTRY });
      const url = await start(root, join(app, 'main.js'), watcher);
      expect(await page(url)).not.toContain('tw-storydata');
      writeFileSync(join(app, 'later.js'), CREATED);
      await expect.poll(() => page(url), { timeout: 10_000, interval: 100 }).toContain('RECOVERED');
    },
    30_000,
  );

  it('recovers when the import is created in a folder that did not exist, with no watcher', async () => {
    const root = makeProject({
      'story/start.tw': STORY,
      'app/main.js': 'import "./lib/deep/later.js";\n',
    });
    const url = await start(root, join(root, 'app/main.js'), false);
    expect(await page(url)).not.toContain('tw-storydata');
    mkdirSync(join(root, 'app/lib/deep'), { recursive: true });
    writeFileSync(join(root, 'app/lib/deep/later.js'), 'globalThis.probe = "RECOVERED";\n');
    expect(await page(url)).toContain('RECOVERED');
  });

  it('recovers when an import added after a good bundle is created, with no watcher', async () => {
    const root = makeProject({ 'story/start.tw': STORY, 'app/main.js': 'globalThis.probe = "GOOD";\n' });
    const entry = join(root, 'app/main.js');
    const url = await start(root, entry, false);
    expect(await page(url)).toContain('GOOD');
    writeFileSync(entry, ENTRY);
    expect(await page(url)).toContain('GOOD'); // the last good story stays while the new bundle fails
    writeFileSync(join(root, 'app/later.js'), CREATED);
    expect(await page(url)).toContain('RECOVERED');
  });
});

describe('vite plugin dev: a file a plugin watches while the entry fails its first bundle (#269)', () => {
  it('recovers when that file is corrected, with no watcher', async () => {
    const root = makeProject({
      'story/start.tw': STORY,
      'app/main.js': 'import data from "virtual:data"; globalThis.probe = data;\n',
      'data.txt': 'BROKEN',
    });
    const data = join(root, 'data.txt');
    const url = await startWith(root, join(root, 'app/main.js'), {
      name: 'test-failing-data',
      resolveId: (id) => (id === 'virtual:data' ? '\0virtual:data' : undefined),
      load(id) {
        if (id !== '\0virtual:data') return undefined;
        this.addWatchFile(data);
        const text = readFileSync(data, 'utf-8').trim();
        if (text === 'BROKEN') throw new Error('data is broken');
        return `export default ${JSON.stringify(text)};`;
      },
    });
    expect(await page(url)).not.toContain('tw-storydata');
    writeFileSync(data, 'RECOVERED');
    expect(await page(url)).toContain('RECOVERED');
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

describe.skipIf(process.platform === 'win32')('vite plugin dev: a retargeted link in the entry graph (#320)', () => {
  const marker = (name: string): string => `globalThis.probe = "ENTRY_${name}";\n`;
  const seen = async (url: string): Promise<string[]> => {
    const html = await page(url);
    return ['A', 'B', 'C'].filter((name) => html.includes(`ENTRY_${name}`));
  };
  const retarget = (link: string, target: string): void => {
    unlinkSync(link);
    symlinkSync(target, link);
  };

  const layouts: readonly (readonly [string, Readonly<Record<string, string>>, string, string])[] = [
    // name, files, the link to retarget (relative to the project), what it points at after
    ['the entry itself is a link', { 'a.js': marker('A'), 'b.js': marker('B') }, 'entry.js', 'b.js'],
    [
      'a module the entry imports is a link',
      { 'a.js': marker('A'), 'b.js': marker('B'), 'entry.js': "import './dependency.js';\n" },
      'dependency.js',
      'b.js',
    ],
    [
      'a folder the entry imports through is a link',
      {
        'one/lib.js': marker('A'),
        'two/lib.js': marker('B'),
        'entry.js': "import './lib/lib.js';\n",
      },
      'lib',
      'two',
    ],
  ];

  it.each(layouts.flatMap((layout) => [true, false].map((watcher) => [...layout, watcher] as const)))(
    'bundles the new target when %s (watcher: %s)',
    async (_name, files, link, after, watcher) => {
      const root = makeProject({ 'story/start.tw': STORY, ...files });
      const initial = link === 'entry.js' ? 'a.js' : link === 'dependency.js' ? 'a.js' : 'one';
      symlinkSync(initial, join(root, link));
      const url = await start(root, join(root, 'entry.js'), watcher);
      expect(await seen(url)).toEqual(['A']);
      retarget(join(root, link), after);
      // A request after the retarget is served the new bundle, with no other edit and no restart.
      await expect.poll(() => seen(url), { timeout: 10_000, interval: 200 }).toEqual(['B']);
      writeFileSync(join(root, 'story/start.tw'), storyWith('Changed.'));
      await expect.poll(async () => (await page(url)).includes('Changed.'), { timeout: 10_000 }).toBe(true);
      expect(await seen(url)).toEqual(['B']);
    },
    60_000,
  );
});

/**
 * A folder a plugin of the entry build watches with `this.addWatchFile(folder)` (#393): a file added to it,
 * removed from it, renamed or changed in it, at any depth, bundles the entry again, in the dev server (with the
 * watcher, and through the request catch-up without one) as `vite build --watch` builds again. A fresh read of
 * the folder is the oracle.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  buildWatchSeesFolders,
  cleanUp,
  COMPILE,
  runEntry,
  SETTLED,
  startBuildWatch,
  startServer,
  STORY,
  tempDir,
  textOf,
  userScript,
  writeFiles,
} from './helpers/plugins.js';

afterEach(cleanUp);

/** Every file in `folder`, at any depth, as `name=content`, sorted: what the plugin below serves. */
function listing(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((name) => statSync(join(folder, name)).isFile())
    .map((name) => `${name.replaceAll('\\', '/')}=${readFileSync(join(folder, name), 'utf8')}`)
    .sort();
}

/** A plugin that serves `virtual:data`, the listing of `folder`, and watches the folder alone (not its files). */
function folderPlugin(folder: string): Plugin {
  return {
    name: 'test-data-folder',
    resolveId: (id) => (id === 'virtual:data' ? '\0virtual:data' : undefined),
    load(id) {
      if (id !== '\0virtual:data') return undefined;
      this.addWatchFile(folder);
      return `export default ${JSON.stringify(listing(folder))};`;
    },
  };
}

/** Where the watched folder lies: returns the root to give Vite and the folder as the plugin names it. */
interface Place {
  readonly name: string;
  readonly layout: (base: string) => { root: string; folder: string };
}

const PLACES: readonly Place[] = [
  { name: 'inside the root', layout: (base) => ({ root: join(base, 'pkg'), folder: join(base, 'pkg', 'data') }) },
  { name: 'outside the root', layout: (base) => ({ root: join(base, 'pkg'), folder: join(base, 'shared', 'data') }) },
  ...(process.platform === 'win32'
    ? []
    : [
        {
          name: 'outside the root, named through a link inside it',
          layout: (base: string) => {
            mkdirSync(join(base, 'shared', 'data'), { recursive: true });
            mkdirSync(join(base, 'pkg'), { recursive: true });
            symlinkSync(join('..', 'shared', 'data'), join(base, 'pkg', 'data'));
            return { root: join(base, 'pkg'), folder: join(base, 'pkg', 'data') };
          },
        },
      ]),
];

/** One change to the folder, made through its path `folder`. */
interface Change {
  readonly name: string;
  readonly apply: (folder: string) => void;
}

const CHANGES: readonly Change[] = [
  {
    name: 'a file added',
    apply: (folder) => {
      writeFiles(folder, { 'new.yaml': 'new' });
    },
  },
  {
    name: 'a file removed',
    apply: (folder) => {
      rmSync(join(folder, 'a.yaml'));
    },
  },
  {
    name: 'a file renamed',
    apply: (folder) => {
      renameSync(join(folder, 'a.yaml'), join(folder, 'renamed.yaml'));
    },
  },
  {
    name: 'a file changed',
    apply: (folder) => {
      writeFiles(folder, { 'a.yaml': 'edited' });
    },
  },
  {
    name: 'a file added to a subfolder',
    apply: (folder) => {
      writeFiles(folder, { 'sub/new.yaml': 'deep' });
    },
  },
  {
    name: 'a file in a subfolder changed',
    apply: (folder) => {
      writeFiles(folder, { 'sub/b.yaml': 'edited' });
    },
  },
  {
    name: 'a subfolder with a file added',
    apply: (folder) => {
      writeFiles(folder, { 'more/c.yaml': 'c' });
    },
  },
  {
    name: 'a subfolder removed',
    apply: (folder) => {
      rmSync(join(folder, 'sub'), { recursive: true });
    },
  },
  {
    name: 'everything in it removed',
    apply: (folder) => {
      for (const name of readdirSync(folder)) rmSync(join(folder, name), { recursive: true });
    },
  },
];

/** Lays out the project for `place`; returns what the tests need. */
function project(place: Place, outputFilename = 'index.html') {
  const base = tempDir();
  const { root, folder } = place.layout(base);
  writeFiles(root, { 'story/start.tw': STORY, 'app/main.js': "import data from 'virtual:data';\nout.v = data;\n" });
  writeFiles(folder, { 'a.yaml': 'a', 'sub/b.yaml': 'b' });
  const plugins: Plugin[] = [
    folderPlugin(folder),
    tweeTsPlugin({
      sources: [join(root, 'story')],
      format: 'test-format-1',
      outputFilename,
      entry: join(root, 'app', 'main.js'),
      compileOptions: COMPILE,
    }),
  ];
  return { root, folder, plugins };
}

/** What the entry served in dev found. */
async function served(url: string): Promise<unknown> {
  return Reflect.get(Object(runEntry(userScript(await (await fetch(url)).text()))), 'v');
}

function reloads(send: { mock: { calls: unknown[][] } }): number {
  return send.mock.calls.filter(([payload]) => Reflect.get(Object(payload), 'type') === 'full-reload').length;
}

describe('vite plugin dev: a folder an entry-build plugin watches (#393)', { timeout: 30_000 }, () => {
  describe.each(PLACES)('$name', (place) => {
    it.each(CHANGES)('$name: the watcher bundles the entry again and reloads the page', async (change) => {
      const { root, folder, plugins } = project(place);
      const { server, url } = await startServer({ root, plugins });
      expect(await served(url)).toEqual(listing(folder));
      const send = vi.spyOn(server.ws, 'send');
      change.apply(folder);
      // The watcher's event must bring the reload: no request is made before it.
      await vi.waitFor(() => {
        expect(reloads(send)).toBeGreaterThan(0);
      }, SETTLED);
      await vi.waitFor(async () => {
        expect(await served(url)).toEqual(listing(folder));
      }, SETTLED);
    });

    it.each(CHANGES)('$name: a request catches up with no watcher at all', async (change) => {
      const { root, folder, plugins } = project(place);
      const { url } = await startServer({ root, plugins, server: { watch: null } });
      const before = listing(folder);
      expect(await served(url)).toEqual(before);
      change.apply(folder);
      const after = listing(folder);
      expect(after).not.toEqual(before);
      expect(await served(url)).toEqual(after);
    });
  });

  it.each([
    ['with a watcher', {}],
    ['with no watcher', { watch: null }],
  ])('bundles again when a watched folder that did not exist is created (%s)', async (_how, watch) => {
    const place = PLACES[0];
    if (place === undefined) throw new Error('no such place');
    const { root, folder, plugins } = project(place);
    rmSync(folder, { recursive: true });
    const { url } = await startServer({ root, plugins, server: watch });
    expect(await served(url)).toEqual([]);
    writeFiles(folder, { 'late.yaml': 'late' });
    await vi.waitFor(async () => {
      expect(await served(url)).toEqual(['late.yaml=late']);
    }, SETTLED);
  });

  it('bundles and reloads nothing more for a watcher event a request already caught up with', async () => {
    const place = PLACES[0];
    if (place === undefined) throw new Error('no such place');
    const { root, folder, plugins } = project(place);
    const { server, url } = await startServer({ root, plugins });
    writeFiles(folder, { 'new.yaml': 'new' });
    expect(await served(url)).toEqual(listing(folder));
    // Settled: the real event, if it came after the request, has been handled.
    await new Promise((done) => setTimeout(done, 500));
    const send = vi.spyOn(server.ws, 'send');
    // An event that arrives later still, for a folder that is as the bundle found it.
    server.watcher.emit('all', 'add', join(folder, 'new.yaml'));
    server.watcher.emit('all', 'change', join(folder, 'sub', 'b.yaml'));
    await new Promise((done) => setTimeout(done, 500));
    expect(send).not.toHaveBeenCalled();
    // A real change after it is still bundled.
    writeFiles(folder, { 'sub/b.yaml': 'later' });
    server.watcher.emit('all', 'change', join(folder, 'sub', 'b.yaml'));
    await vi.waitFor(() => {
      expect(reloads(send)).toBeGreaterThan(0);
    }, SETTLED);
    expect(await served(url)).toEqual(listing(folder));
  });
});

describe('vite plugin build --watch: a folder an entry-build plugin watches (#393)', { timeout: 30_000 }, () => {
  it.runIf(buildWatchSeesFolders).each([
    ['inside the user’s build', false],
    ['by a build of its own', true],
  ])('builds again for a file added to it, with the entry bundled %s', async (_how, ownInput) => {
    const place = PLACES[1];
    if (place === undefined) throw new Error('no such place');
    const { root, folder, plugins } = project(place, 'story.html');
    writeFiles(root, { 'index.html': '<html><head></head><body>page</body></html>' });
    const outDir = join(root, 'dist');
    await startBuildWatch({
      root,
      plugins,
      build: { outDir, ...(ownInput ? { rolldownOptions: { input: join(root, 'index.html') } } : {}) },
    });
    const story = (): unknown =>
      Reflect.get(Object(runEntry(userScript(textOf(readFileSync(join(outDir, 'story.html')))))), 'v');
    expect(story()).toEqual(listing(folder));
    await vi.waitFor(() => {
      // The watcher may not be ready right after the first build; the file is written again until it is built.
      const built = JSON.stringify(story()).includes('new.yaml=new');
      if (!built) writeFiles(folder, { 'new.yaml': `new` });
      expect(story()).toEqual(listing(folder));
      expect(listing(folder)).toContain('new.yaml=new');
    }, SETTLED);
  });
});

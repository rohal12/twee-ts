/**
 * Every file a compile or an entry bundle read is a dependency whose change
 * rebuilds the story (RC2: D4, #242). The dev server's watcher watches each of
 * them, wherever it lies (inside the root, outside it, behind a link), and its
 * events are matched to them by file identity, not by spelling; a request
 * also catches up with a change no event announced. `vite build --watch`
 * registers them too.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
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

/** A plugin that loads `virtual:data` from a file it reads itself, which it adds with addWatchFile. */
function dataPlugin(file: string): Plugin {
  return {
    name: 'test-data-file',
    resolveId: (id) => (id === 'virtual:data' ? '\0virtual:data' : undefined),
    load(id) {
      if (id !== '\0virtual:data') return undefined;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(readFileSync(file, 'utf-8').trim())};`;
    },
  };
}

/** How the entry depends on the file `dep` (an absolute path, extension left out). */
interface Kind {
  readonly name: string;
  readonly extension: string;
  readonly content: (value: string) => string | Uint8Array;
  readonly entry: (dep: string) => string;
  /** What the entry observed, from the value written. */
  readonly observed: (value: string) => unknown;
}

const KINDS: readonly Kind[] = [
  {
    name: 'a module it imports',
    extension: '.js',
    content: (value) => `export const value = ${JSON.stringify(value)};\n`,
    entry: (dep) => `import { value } from ${JSON.stringify(dep + '.js')};\nout.v = value;\n`,
    observed: (value) => value,
  },
  {
    name: 'a stylesheet its CSS @imports',
    extension: '.css',
    content: (value) => `.dep { --value: "${value}"; }\n`,
    entry: () => `import css from './style.css?inline';\nout.v = /--value: ?"([^"]*)"/.exec(css)[1];\n`,
    observed: (value) => value,
  },
  {
    name: 'a file its CSS points at with url()',
    extension: '.png',
    content: (value) => new TextEncoder().encode(value),
    entry: () => `import css from './style.css?inline';\nout.v = /url\\("?data:[^,]*,([^")]*)/.exec(css)[1];\n`,
    observed: (value) => Buffer.from(value).toString('base64'),
  },
  {
    name: 'a file a plugin adds with addWatchFile',
    extension: '.txt',
    content: (value) => value,
    entry: () => "import data from 'virtual:data';\nout.v = data;\n",
    observed: (value) => value,
  },
];

/** Where the dependency lies, and how the root is reached. */
interface Place {
  readonly name: string;
  /**
   * Lays out the project in `base`: returns the root to give Vite, the
   * dependency's path as the entry names it (without extension), and the path
   * the test edits it at.
   */
  readonly layout: (base: string) => { root: string; dep: string; edit: string };
}

const PLACES: readonly Place[] = [
  {
    name: 'inside the root',
    layout: (base) => ({
      root: join(base, 'pkg'),
      dep: join(base, 'pkg', 'app', 'dep'),
      edit: join(base, 'pkg', 'app', 'dep'),
    }),
  },
  {
    name: 'outside the root (a shared package of a monorepo)',
    layout: (base) => ({
      root: join(base, 'pkg'),
      dep: join(base, 'shared', 'dep'),
      edit: join(base, 'shared', 'dep'),
    }),
  },
  ...(process.platform === 'win32'
    ? []
    : [
        {
          name: 'outside the root, reached through a link inside it (a workspace link)',
          layout: (base: string) => {
            mkdirSync(join(base, 'shared'), { recursive: true });
            mkdirSync(join(base, 'pkg', 'app'), { recursive: true });
            symlinkSync(join('..', '..', 'shared'), join(base, 'pkg', 'app', 'linked'));
            return {
              root: join(base, 'pkg'),
              dep: join(base, 'pkg', 'app', 'linked', 'dep'),
              edit: join(base, 'shared', 'dep'),
            };
          },
        },
        {
          name: 'inside a root given through a link to it (#242)',
          layout: (base: string) => {
            mkdirSync(join(base, 'real'), { recursive: true });
            symlinkSync('real', join(base, 'alias'));
            return {
              root: join(base, 'alias'),
              dep: join(base, 'alias', 'app', 'dep'),
              edit: join(base, 'real', 'app', 'dep'),
            };
          },
        },
      ]),
];

/** Writes the project for `kind` and `place`; returns what the test needs. */
function project(kind: Kind, place: Place, outputFilename = 'index.html') {
  const base = tempDir();
  const { root, dep, edit } = place.layout(base);
  writeFiles(root, { 'story/start.tw': STORY, 'app/main.js': kind.entry(dep) });
  writeFiles(join(root, 'app'), {
    'style.css': `@import ${JSON.stringify(dep + '.css')};\n.bg { background: url(${JSON.stringify(dep + '.png')}); }\n`,
  });
  const write = (value: string): void => {
    writeFiles(join(edit, '..'), { [`dep${kind.extension}`]: kind.content(value) });
    // The stylesheet kinds need both files; the one not under test stays as it is.
    for (const other of ['.css', '.png']) {
      if (other !== kind.extension)
        writeFiles(join(edit, '..'), { [`dep${other}`]: other === '.css' ? '.dep {}\n' : 'x' });
    }
  };
  write('one');
  const plugins: Plugin[] = [
    dataPlugin(`${dep}.txt`),
    tweeTsPlugin({
      sources: [join(root, 'story')],
      format: 'test-format-1',
      outputFilename,
      entry: join(root, 'app', 'main.js'),
      compileOptions: COMPILE,
    }),
  ];
  if (kind.extension !== '.txt') writeFiles(join(edit, '..'), { 'dep.txt': 'unused' });
  return { root, plugins, write };
}

/** What the entry served in dev observed. */
async function served(url: string): Promise<unknown> {
  return Reflect.get(Object(runEntry(userScript(await (await fetch(url)).text()))), 'v');
}

function reloads(send: { mock: { calls: unknown[][] } }): number {
  return send.mock.calls.filter(([payload]) => Reflect.get(Object(payload), 'type') === 'full-reload').length;
}

describe('vite plugin dependencies: dev (D4, #242)', { timeout: 30_000 }, () => {
  describe.each(PLACES)('$name', (place) => {
    it.each(KINDS)('$name: an edit reloads the page with the new content', async (kind) => {
      const { root, plugins, write } = project(kind, place);
      const { server, url } = await startServer({ root, plugins });
      expect(await served(url)).toBe(kind.observed('one'));
      const send = vi.spyOn(server.ws, 'send');
      write('two');
      // The watcher's event must bring the reload: no request is made before it.
      await vi.waitFor(() => {
        expect(reloads(send)).toBeGreaterThan(0);
      }, SETTLED);
      expect(await served(url)).toBe(kind.observed('two'));
    });
  });

  it('serves the new content of an edited dependency outside the root with no watcher at all', async () => {
    const kind = KINDS[0];
    const place = PLACES[1];
    if (kind === undefined || place === undefined) throw new Error('no such case');
    const { root, plugins, write } = project(kind, place);
    const { url } = await startServer({ root, plugins, server: { watch: null } });
    expect(await served(url)).toBe('one');
    write('two');
    expect(await served(url)).toBe('two');
  });

  it('stops watching a file outside the root the entry no longer uses', async () => {
    const kind = KINDS[0];
    const place = PLACES[1];
    if (kind === undefined || place === undefined) throw new Error('no such case');
    const { root, plugins } = project(kind, place);
    const { server, url } = await startServer({ root, plugins });
    const shared = join(root, '..', 'shared', 'dep.js');
    const watched = (s: ViteDevServer): string[] =>
      Object.entries(s.watcher.getWatched()).flatMap(([dir, names]) => names.map((n) => join(dir, n)));
    expect(watched(server)).toContain(shared);
    writeFileSync(join(root, 'app', 'main.js'), "out.v = 'own';\n");
    await vi.waitFor(async () => {
      expect(await served(url)).toBe('own');
    }, SETTLED);
    expect(watched(server)).not.toContain(shared);
  });
});

describe('vite plugin dependencies: build --watch (D4)', { timeout: 30_000 }, () => {
  it.each([
    ['inside the user’s build', false],
    ['by a build of its own', true],
  ])('rebuilds for an edit to a dependency outside the root when the entry is bundled %s', async (_how, ownInput) => {
    const kind = KINDS[0];
    const place = PLACES[1];
    if (kind === undefined || place === undefined) throw new Error('no such case');
    const { root, plugins, write } = project(kind, place, 'story.html');
    writeFiles(root, { 'index.html': '<html><head></head><body>page</body></html>' });
    const outDir = join(root, 'dist');
    await startBuildWatch({
      root,
      plugins,
      build: { outDir, ...(ownInput ? { rolldownOptions: { input: join(root, 'index.html') } } : {}) },
    });
    const story = (): unknown =>
      Reflect.get(Object(runEntry(userScript(textOf(readFileSync(join(outDir, 'story.html')))))), 'v');
    expect(story()).toBe('one');
    await vi.waitFor(() => {
      // The watcher may not be ready right after the first build; the edit is saved again until it is built.
      if (story() !== 'two') write('two');
      expect(story()).toBe('two');
    }, SETTLED);
  });
});

describe('vite plugin dependencies: a dependency that goes away', () => {
  it('reports the failed bundle when an imported file is deleted, with no watcher at all', async () => {
    const kind = KINDS[0];
    const place = PLACES[1];
    if (kind === undefined || place === undefined) throw new Error('no such case');
    const { root, plugins } = project(kind, place);
    const { server, url } = await startServer({ root, plugins, server: { watch: null } });
    expect(await served(url)).toBe('one');
    const send = vi.spyOn(server.ws, 'send');
    rmSync(join(root, '..', 'shared', 'dep.js'));
    // The last good story is still served, and the overlay shows why the new one failed.
    expect(await served(url)).toBe('one');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

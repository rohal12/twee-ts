/**
 * A Web Worker the entry starts (#424): Vite bundles it in a build of its own, nested in the entry's, and the files
 * its `import.meta.glob()` calls select and the links its imports go through count as the entry's own. The dev
 * server (with a watcher and with `server.watch: null`) and `vite build --watch` (the entry bundled inside the build
 * and in a build of its own) bundle again when a matching file is added, removed or renamed, or a link is
 * retargeted, for every way of starting a worker: `new Worker(new URL(…))`, `new SharedWorker(new URL(…))`, a
 * `?worker` import and a `?worker&inline` import.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from 'vite';
import type { Plugin } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  buildFiles,
  buildWatchSeesFolders,
  cleanUp,
  COMPILE,
  makeProject,
  SETTLED,
  startBuildWatch,
  startServer,
  STORY,
  textOf,
} from './helpers/plugins.js';

afterEach(async () => {
  await cleanUp();
});

/** The entry's code for each way of starting the worker `./worker.js`; none of them runs it. */
const WORKERS = {
  'new Worker(new URL())':
    "globalThis.start = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });\n",
  'new SharedWorker(new URL())':
    "globalThis.start = () => new SharedWorker(new URL('./worker.js', import.meta.url), { type: 'module' });\n",
  '?worker': "import Started from './worker.js?worker';\nglobalThis.start = () => new Started();\n",
  '?worker&inline': "import Started from './worker.js?worker&inline';\nglobalThis.start = () => new Started();\n",
} as const;

/** The worker's code for each form of glob call. */
const GLOBS = {
  staticOptions: "self.found = import.meta.glob('./data/*.js', { base: './wrong', ['base']: `./` });\n",
  eager: "self.found = import.meta.glob('./data/*.js', { eager: true, import: 'default' });\n",
  lazy: "self.found = import.meta.glob('./data/*.js');\n",
  keys: "self.found = Object.keys(import.meta.glob('./data/*.js'));\n",
} as const;

/** The data files the glob selects, as the worker's bundle names them. */
const selected = (text: string): string[] => ['a', 'b', 'c'].filter((name) => text.includes(`data/${name}.js`));

/** The markers of the worker's linked dependency the bundle holds. */
const markers = (text: string): string[] => ['A', 'B', 'C'].filter((name) => text.includes(`WORKER_${name}`));

const write = (file: string, content: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

/** A project whose entry, `app/entry.js`, starts the worker `app/worker.js` as `start` says. */
function workerProject(start: string, worker: string, files: Record<string, string> = {}): string {
  return makeProject({
    'story/start.tw': STORY,
    'outer.js': 'globalThis.outer = 1;',
    'app/entry.js': start,
    'app/worker.js': worker,
    ...files,
  });
}

/** Every file a build may emit: the names of the entry's assets in `text`. */
const ASSET_NAME = /assets\/[\w.-]+\.js/g;

const plugin = (root: string, outputFilename?: string) =>
  tweeTsPlugin({
    sources: [join(root, 'story')],
    format: 'test-format-1',
    entry: join(root, 'app/entry.js'),
    compileOptions: COMPILE,
    ...(outputFilename === undefined ? {} : { outputFilename }),
  });

/** Starts a dev server for `root`; returns a reader of the story page and every asset of the entry it names. */
async function serve(root: string, watcher: boolean): Promise<() => Promise<string>> {
  const { url } = await startServer({ root, server: watcher ? {} : { watch: null }, plugins: [plugin(root)] });
  return async () => {
    const texts = [await (await fetch(`${url}/`)).text()];
    const fetched = new Set<string>();
    // Each asset fetched is read for the assets it names in turn (a worker's chunks), as the loop reaches it.
    for (const text of texts) {
      for (const [name] of text.matchAll(ASSET_NAME)) {
        if (fetched.has(name)) continue;
        fetched.add(name);
        const response = await fetch(`${url}/${name}`);
        if (response.ok) texts.push(await response.text());
      }
    }
    return texts.join('\n');
  };
}

/** Every file below `dir`, read as text and joined. */
function textBelow(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf-8'))
    .join('\n');
}

/** Starts `vite build --watch` for `root`; `separate` bundles the entry in a build of its own. */
async function watchBuild(root: string, separate: boolean): Promise<() => string> {
  await startBuildWatch({
    root,
    plugins: [plugin(root, 'story.html')],
    build: {
      outDir: join(root, 'out'),
      ...(separate ? { rolldownOptions: { input: join(root, 'outer.js') } } : {}),
    },
  });
  return () => textBelow(join(root, 'out'));
}

/** The four ways of running the entry: dev with and without a watcher, build watch inside the build or separate. */
type Mode = 'dev, watcher' | 'dev, no watcher' | 'build watch, inside' | 'build watch, separate';
const DEV_MODES: readonly Mode[] = ['dev, watcher', 'dev, no watcher'];
// The bundler's watcher of Vite 8.0 and 8.1 reports no change inside a registered folder.
const BUILD_MODES: readonly Mode[] = buildWatchSeesFolders ? ['build watch, inside', 'build watch, separate'] : [];
const MODES: readonly Mode[] = [...DEV_MODES, ...BUILD_MODES];

/** Runs the entry of `root` as `mode` says; returns a reader of all the text it made and a waiter on that text. */
async function run(
  root: string,
  mode: Mode,
): Promise<{ read: () => Promise<string>; settle: <T>(of: (text: string) => T, expected: T) => Promise<void> }> {
  if (mode === 'dev, watcher' || mode === 'dev, no watcher') {
    const read = await serve(root, mode === 'dev, watcher');
    return {
      read,
      settle: async (of, expected) => {
        await expect.poll(async () => of(await read()), { timeout: 10_000, interval: 100 }).toEqual(expected);
      },
    };
  }
  const read = await watchBuild(root, mode === 'build watch, separate');
  return {
    read: () => Promise.resolve(read()),
    settle: async (of, expected) => {
      await vi.waitFor(() => {
        expect(of(read())).toEqual(expected);
      }, SETTLED);
    },
  };
}

const combinations = Object.entries(WORKERS).flatMap(([worker, start]) =>
  Object.entries(GLOBS).map(([glob, code]) => [worker, glob, start, code] as const),
);

describe('vite build: a worker glob, fresh (control for #424)', () => {
  it.each(combinations)('bundles every matching file (%s, %s glob)', async (_worker, _glob, start, code) => {
    const root = workerProject(start, code, {
      'app/data/a.js': "export default 'A';",
      'app/data/b.js': "export default 'B';",
    });
    const files = await buildFiles({ root, plugins: [plugin(root, 'story.html')] });
    expect(selected([...files.values()].map(textOf).join('\n'))).toEqual(['a', 'b']);
  });
});

describe.each(MODES)('a worker glob gains a matching file (#424): %s', (mode) => {
  it.each(combinations)(
    'bundles the new file (%s, %s glob)',
    async (_worker, _glob, start, code) => {
      const root = workerProject(start, code, { 'app/data/a.js': "export default 'A';" });
      const { read, settle } = await run(root, mode);
      expect(selected(await read())).toEqual(['a']);
      write(join(root, 'app/data/b.js'), "export default 'B';");
      await settle(selected, ['a', 'b']);
    },
    60_000,
  );
});

describe.each(MODES)('a worker glob loses or renames a matching file (#424): %s', (mode) => {
  it.each(Object.keys(WORKERS))(
    'bundles without it (%s)',
    async (worker) => {
      const root = workerProject(WORKERS[worker as keyof typeof WORKERS], GLOBS.lazy, {
        'app/data/a.js': "export default 'A';",
        'app/data/b.js': "export default 'B';",
      });
      const { read, settle } = await run(root, mode);
      expect(selected(await read())).toEqual(['a', 'b']);
      unlinkSync(join(root, 'app/data/b.js'));
      await settle(selected, ['a']);
      renameSync(join(root, 'app/data/a.js'), join(root, 'app/data/c.js'));
      await settle(selected, ['c']);
    },
    60_000,
  );
});

/** A worker importing `spelling`, a link the test retargets; the files besides it, the link, and its two targets. */
const LINKS = {
  'a relative import': {
    files: {
      'app/a.js': "export const marker = 'WORKER_A';",
      'app/b.js': "export const marker = 'WORKER_B';",
    },
    spelling: './dependency.js',
    link: 'app/dependency.js',
    initial: 'a.js',
    after: 'b.js',
    edit: 'app/b.js',
  },
  'a bare package name': {
    files: {
      'packages/v1/package.json': JSON.stringify({ name: 'dependency', type: 'module', exports: './index.js' }),
      'packages/v1/index.js': "export const marker = 'WORKER_A';",
      'packages/v2/package.json': JSON.stringify({ name: 'dependency', type: 'module', exports: './index.js' }),
      'packages/v2/index.js': "export const marker = 'WORKER_B';",
    },
    spelling: 'dependency',
    link: 'node_modules/dependency',
    initial: '../packages/v1',
    after: '../packages/v2',
    edit: 'packages/v2/index.js',
  },
} as const;

// Linux only for the build watch, as for the sources: the bundler's watcher on macOS reports no replacement of a link.
describe.skipIf(process.platform === 'win32').each(MODES)(
  'a link a worker imports through is retargeted (#424): %s',
  (mode) => {
    it
      .skipIf(!DEV_MODES.includes(mode) && process.platform !== 'linux')
      .each(
        Object.entries(WORKERS).flatMap(([worker, start]) => Object.keys(LINKS).map((name) => [worker, name, start])),
      )(
      'bundles the new target (%s, %s)',
      async (_worker, name, start) => {
        const linkCase = LINKS[name as keyof typeof LINKS];
        const root = workerProject(
          start,
          `import { marker } from ${JSON.stringify(linkCase.spelling)};\nself.marker = marker;\n`,
          linkCase.files,
        );
        const link = join(root, linkCase.link);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(linkCase.initial, link);
        const { read, settle } = await run(root, mode);
        expect(markers(await read())).toEqual(['A']);
        unlinkSync(link);
        symlinkSync(linkCase.after, link);
        await settle(markers, ['B']);
        const edited = join(root, linkCase.edit);
        writeFileSync(edited, readFileSync(edited, 'utf-8').replace('WORKER_B', 'WORKER_C'));
        await settle(markers, ['C']);
      },
      60_000,
    );
  },
);

describe("the user's worker.plugins (#424)", () => {
  const marking: Plugin = {
    name: 'mark-worker',
    transform: (code, id) => (id.endsWith('worker.js') ? code.replace('UNMARKED', 'MARKED_BY_USER_PLUGIN') : undefined),
  };

  it.each(DEV_MODES)('still transform the worker in the entry build (%s)', async (mode) => {
    const root = workerProject(WORKERS['?worker&inline'], "self.mark = 'UNMARKED';\n");
    const { url } = await startServer({
      root,
      server: mode === 'dev, watcher' ? {} : { watch: null },
      worker: { plugins: () => [marking] },
      plugins: [plugin(root)],
    });
    expect(await (await fetch(`${url}/`)).text()).toContain('MARKED_BY_USER_PLUGIN');
  });
});

/** What a Vite version without what twee-ts calls to let go of a worker's bundle would leave. */
const WORKER_PLUGIN_GONE: Readonly<Record<string, readonly [(worker: Plugin) => void, readonly string[]]>> = {
  // Vite's own worker plugin still lets go of the worker's bundle when one of its modules changes.
  'no vite:worker plugin': [
    (worker) => {
      worker.name = 'vite:worker (hidden)';
    },
    ['a', 'b', 'c'],
  ],
  // Without the hook nothing lets go of it, so the worker stays as it was first bundled.
  'a vite:worker plugin with no watchChange hook': [
    (worker) => {
      Reflect.deleteProperty(worker, 'watchChange');
    },
    ['a'],
  ],
};

describe.runIf(buildWatchSeesFolders).each(Object.entries(WORKER_PLUGIN_GONE))(
  'vite build watch under a Vite with %s (#424)',
  (_gone, [remove, afterEdit]) => {
    it('warns once that a file added to a worker glob waits for a change to a worker module', async () => {
      const root = workerProject(WORKERS['?worker'], GLOBS.keys, { 'app/data/a.js': "export default 'A';" });
      const hide: Plugin = {
        name: 'hide-vite-worker',
        configResolved(config) {
          const worker = config.plugins.find((candidate) => candidate.name === 'vite:worker');
          if (worker !== undefined) remove(worker);
        },
      };
      const warnings: string[] = [];
      const logger = createLogger('warn');
      logger.warn = (message) => {
        warnings.push(message);
      };
      await startBuildWatch({
        root,
        logLevel: 'warn',
        customLogger: logger,
        plugins: [hide, plugin(root, 'story.html')],
        build: { outDir: join(root, 'out') },
      });
      const read = (): string[] => selected(textBelow(join(root, 'out')));
      expect(read()).toEqual(['a']);
      write(join(root, 'app/data/b.js'), "export default 'B';");
      write(join(root, 'app/data/c.js'), "export default 'C';");
      await vi.waitFor(() => {
        expect(
          warnings.filter((warning) => warning.includes('no vite:worker plugin with a watchChange hook')),
        ).toHaveLength(1);
      }, SETTLED);
      writeFileSync(join(root, 'app/worker.js'), `${GLOBS.keys}// edited\n`);
      await vi.waitFor(() => {
        expect(read()).toEqual(afterEdit);
      }, SETTLED);
    }, 60_000);
  },
);

// A recursive worker glob reaches into a folder linked in after the first build: a file added to that folder lets go
// of the worker's bundle too, as one added to the glob's own folder does.
describe.skipIf(process.platform !== 'linux' || !buildWatchSeesFolders)(
  'vite build watch: a recursive worker glob through a folder linked in later (#424)',
  () => {
    it('bundles a file added to the linked folder', async () => {
      const root = workerProject(
        WORKERS['?worker'],
        "self.found = Object.keys(import.meta.glob('./data/**/*.js'));\n",
        {
          'app/data/a.js': "export default 'A';",
        },
      );
      const shared = makeProject({ 'b.js': "export default 'B';" });
      await startBuildWatch({ root, plugins: [plugin(root, 'story.html')], build: { outDir: join(root, 'out') } });
      const read = (): string => textBelow(join(root, 'out'));
      const found = (text: string): string[] =>
        ['data/a.js', 'data/shared/b.js', 'data/shared/c.js'].filter((name) => text.includes(name));
      expect(found(read())).toEqual(['data/a.js']);
      symlinkSync(shared, join(root, 'app/data/shared'));
      await vi.waitFor(() => {
        expect(found(read())).toEqual(['data/a.js', 'data/shared/b.js']);
      }, SETTLED);
      writeFileSync(join(shared, 'c.js'), "export default 'C';");
      await vi.waitFor(() => {
        expect(found(read())).toEqual(['data/a.js', 'data/shared/b.js', 'data/shared/c.js']);
      }, SETTLED);
    }, 60_000);
  },
);

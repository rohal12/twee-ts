/** A dev server's watcher is shared by all story instances (#517). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { toPosix } from '../src/plugins/paths.js';
import {
  cleanUp,
  COMPILE,
  runEntry,
  SETTLED,
  startServer,
  STORY,
  tempDir,
  userScript,
  writeFiles,
} from './helpers/plugins.js';

afterEach(cleanUp);

const ORDERS = [
  { name: 'A then B, A releases first', order: ['a', 'b'], drop: 'a', keep: 'b' },
  { name: 'A then B, B releases first', order: ['a', 'b'], drop: 'b', keep: 'a' },
  { name: 'B then A, A releases first', order: ['b', 'a'], drop: 'a', keep: 'b' },
  { name: 'B then A, B releases first', order: ['b', 'a'], drop: 'b', keep: 'a' },
] as const;

/** What the watcher currently lists, without depending on path separators. */
function listed(server: ViteDevServer, path: string): boolean {
  return server.watcher.getWatched()[dirname(path)]?.includes(basename(path)) ?? false;
}

/** The value the story's bundled entry produces. */
async function value(url: string): Promise<unknown> {
  return Reflect.get(Object(runEntry(userScript(await (await fetch(url)).text()))), 'v');
}

/** Establish that the native event stream is running before making the one-shot edit under test. */
async function primeWatcher(server: ViteDevServer, root: string): Promise<void> {
  const probe = join(root, 'ready.txt');
  let seen = false;
  let attempt = 0;
  const observe = (_event: string, path: string): void => {
    if (path === probe) seen = true;
  };
  server.watcher.on('all', observe);
  try {
    await vi.waitFor(() => {
      writeFileSync(probe, String(++attempt));
      expect(seen).toBe(true);
    }, SETTLED);
  } finally {
    server.watcher.off('all', observe);
  }
}

/** A plugin watching a folder rather than individual files, as a content plugin does. */
function folderPlugin(folder: string, readContents = false): Plugin {
  return {
    name: 'shared-folder-data',
    resolveId: (id) => (id === 'virtual:shared' ? '\0virtual:shared' : undefined),
    load(id) {
      if (id !== '\0virtual:shared') return undefined;
      this.addWatchFile(folder);
      const values = readdirSync(folder)
        .sort()
        .map((name) => (readContents ? readFileSync(join(folder, name), 'utf8') : name));
      return `export default ${JSON.stringify(values.join(','))};`;
    },
  };
}

interface Dependency {
  readonly name: string;
  readonly file: string;
  readonly initial: string;
  readonly entry: (folder: string) => string;
  readonly target: (folder: string) => string;
  readonly edit: (folder: string) => void;
  readonly before: string;
  readonly after: string;
  readonly plugin?: (folder: string) => Plugin;
}

const DEPENDENCIES: readonly Dependency[] = [
  {
    name: 'imported JavaScript',
    file: 'shared.js',
    initial: 'export default "one";',
    entry: (folder) => `import v from ${JSON.stringify(toPosix(join(folder, 'shared.js')))}; out.v = v;`,
    target: (folder) => join(folder, 'shared.js'),
    edit: (folder) => {
      writeFileSync(join(folder, 'shared.js'), 'export default "two";');
    },
    before: 'one',
    after: 'two',
  },
  {
    name: 'CSS addWatchFile dependency',
    file: 'shared.css',
    initial: '.shared { --value: one; }',
    entry: () => "import css from './style.css?inline'; out.v = css.includes('two') ? 'two' : 'one';",
    target: (folder) => join(folder, 'shared.css'),
    edit: (folder) => {
      writeFileSync(join(folder, 'shared.css'), '.shared { --value: two; }');
    },
    before: 'one',
    after: 'two',
  },
  {
    name: 'glob folder',
    file: 'one.js',
    initial: 'export default "one";',
    entry: () =>
      "out.v = Object.values(import.meta.glob('../shared/*.js', " +
      "{ eager: true, import: 'default' })).sort().join(',');",
    target: (folder) => folder,
    edit: (folder) => {
      writeFileSync(join(folder, 'two.js'), 'export default "two";');
    },
    before: 'one',
    after: 'one,two',
  },
  {
    name: 'addWatchFile folder',
    file: 'one.txt',
    initial: 'one',
    entry: () => "import v from 'virtual:shared'; out.v = v;",
    target: (folder) => folder,
    edit: (folder) => {
      writeFileSync(join(folder, 'two.txt'), 'two');
    },
    before: 'one.txt',
    after: 'one.txt,two.txt',
    plugin: folderPlugin,
  },
];

describe.each(ORDERS)('shared entry watches: $name (#517)', ({ order, drop, keep }) => {
  it.each(DEPENDENCIES)(
    '$name survives until the final entry releases it',
    async (dep) => {
      const base = tempDir();
      const root = join(base, 'project');
      const shared = join(base, 'shared');
      writeFiles(shared, { [dep.file]: dep.initial });
      writeFiles(root, {
        'a.tw': STORY,
        'b.tw': STORY,
        'a.js': dep.entry(shared),
        'b.js': dep.entry(shared),
        'style.css': `@import ${JSON.stringify(toPosix(join(shared, 'shared.css')))};`,
      });
      const { server, url } = await startServer({
        root,
        plugins: [
          ...(dep.plugin === undefined ? [] : [dep.plugin(shared)]),
          ...order.map((name) =>
            tweeTsPlugin({
              sources: [join(root, `${name}.tw`)],
              entry: join(root, `${name}.js`),
              outputFilename: `${name}.html`,
              format: 'test-format-1',
              compileOptions: COMPILE,
            }),
          ),
        ],
      });
      expect(await value(`${url}/${keep}.html`)).toBe(dep.before);
      await vi.waitFor(() => {
        expect(listed(server, dep.target(shared))).toBe(true);
      }, SETTLED);
      await primeWatcher(server, root);

      writeFileSync(join(root, `${drop}.js`), 'out.v = "independent";');
      expect(await value(`${url}/${drop}.html`)).toBe('independent');
      expect(listed(server, dep.target(shared))).toBe(true);
      const send = vi.spyOn(server.ws, 'send');
      dep.edit(shared);
      // The surviving story reloads before any request can catch it up.
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: `/${keep}.html` });
      }, SETTLED);
      expect(await value(`${url}/${keep}.html`)).toBe(dep.after);

      writeFileSync(join(root, `${keep}.js`), 'out.v = "independent";');
      expect(await value(`${url}/${keep}.html`)).toBe('independent');
      await vi.waitFor(() => {
        expect(listed(server, dep.target(shared))).toBe(false);
      }, SETTLED);
    },
    30_000,
  );
});

const INPUTS = [
  {
    name: 'source file',
    file: 'shared.js',
    one: 'globalThis.shared = "SHARED_ONE";',
    two: 'globalThis.shared = "SHARED_TWO";',
  },
  {
    name: 'source folder',
    file: 'shared.js',
    one: 'globalThis.shared = "SHARED_ONE";',
    two: 'globalThis.shared = "SHARED_TWO";',
  },
  {
    name: 'head file',
    file: 'shared.html',
    one: '<meta name="shared" content="SHARED_ONE">',
    two: '<meta name="shared" content="SHARED_TWO">',
  },
  {
    name: 'module',
    file: 'shared.js',
    one: 'globalThis.shared = "SHARED_ONE";',
    two: 'globalThis.shared = "SHARED_TWO";',
  },
] as const;

describe.each(ORDERS)('entry and story input watches: $name (#517)', ({ order, drop, keep }) => {
  it.each(INPUTS)(
    'preserves the other story’s $name',
    async (input) => {
      const base = tempDir();
      const root = join(base, 'project');
      const shared = join(base, 'shared', input.file);
      writeFiles(join(base, 'shared'), { [input.file]: input.one });
      writeFiles(root, {
        'a.tw': STORY,
        'b.tw': STORY,
        [`${drop}.js`]: `import v from ${JSON.stringify(toPosix(shared) + '?raw')}; out.v = v;`,
      });
      const { server, url } = await startServer({
        root,
        plugins: order.map((name) =>
          tweeTsPlugin({
            sources: [
              join(root, `${name}.tw`),
              ...(name === keep && input.name.startsWith('source')
                ? [input.name === 'source folder' ? dirname(shared) : shared]
                : []),
            ],
            ...(name === drop ? { entry: join(root, `${drop}.js`) } : {}),
            outputFilename: `${name}.html`,
            format: 'test-format-1',
            compileOptions: {
              ...COMPILE,
              ...(name === keep && input.name === 'head file' ? { headFile: shared } : {}),
              ...(name === keep && input.name === 'module' ? { modules: [shared] } : {}),
            },
          }),
        ),
      });
      expect(await (await fetch(`${url}/${keep}.html`)).text()).toContain('SHARED_ONE');
      await vi.waitFor(() => {
        expect(listed(server, shared)).toBe(true);
      }, SETTLED);
      await primeWatcher(server, root);
      writeFileSync(join(root, `${drop}.js`), 'out.v = "independent";');
      expect(await value(`${url}/${drop}.html`)).toBe('independent');
      expect(listed(server, shared)).toBe(true);
      const send = vi.spyOn(server.ws, 'send');
      writeFileSync(shared, input.two);
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: `/${keep}.html` });
      }, SETTLED);
      expect(await (await fetch(`${url}/${keep}.html`)).text()).toContain('SHARED_TWO');
    },
    30_000,
  );
});

// A glob owns both its selected files and its folder. The other entry owns only the file. Neither release
// may suppress the survivor, and the folder retained for the file must still be cleaned up at the final release.
describe.each([
  { name: 'folder then file', order: ['folder', 'file'] },
  { name: 'file then folder', order: ['file', 'folder'] },
])('overlapping watches: $name', ({ order }) => {
  for (const first of ['folder', 'file'] as const) {
    it(`preserves overlapping folder/file subscriptions when the ${first} releases first (#517)`, async () => {
      const base = tempDir();
      const root = join(base, 'project');
      const shared = join(base, 'shared');
      writeFiles(shared, { 'one.js': 'export default "one";' });
      writeFiles(root, {
        'folder.tw': STORY,
        'file.tw': STORY,
        'folder.js':
          "out.v = Object.values(import.meta.glob('../shared/*.js', { eager: true, import: 'default' })).join(',');",
        'file.js': "import v from '../shared/one.js'; out.v = v;",
      });
      const { server, url } = await startServer({
        root,
        plugins: [
          folderPlugin(shared, true),
          ...order.map((name) =>
            tweeTsPlugin({
              sources: [join(root, `${name}.tw`)],
              entry: join(root, `${name}.js`),
              outputFilename: `${name}.html`,
              format: 'test-format-1',
              compileOptions: COMPILE,
            }),
          ),
        ],
      });
      const keep = first === 'folder' ? 'file' : 'folder';
      expect(await value(`${url}/${keep}.html`)).toBe('one');
      await vi.waitFor(() => {
        expect(listed(server, join(shared, 'one.js'))).toBe(true);
      }, SETTLED);
      await primeWatcher(server, root);
      writeFileSync(join(root, `${first}.js`), 'out.v = "independent";');
      expect(await value(`${url}/${first}.html`)).toBe('independent');
      expect(listed(server, shared)).toBe(true);
      expect(listed(server, join(shared, 'one.js'))).toBe(true);
      const send = vi.spyOn(server.ws, 'send');
      writeFileSync(join(shared, 'one.js'), 'export default "two";');
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: `/${keep}.html` });
      }, SETTLED);
      expect(await value(`${url}/${keep}.html`)).toBe('two');
      writeFileSync(join(root, `${keep}.js`), 'out.v = "independent";');
      expect(await value(`${url}/${keep}.html`)).toBe('independent');
      expect(listed(server, shared)).toBe(false);
      expect(listed(server, join(shared, 'one.js'))).toBe(false);
      // A released folder must not keep suppressing a later subscription to just one of its children.
      writeFileSync(join(root, 'file.js'), "import v from '../shared/one.js'; out.v = v;");
      expect(await value(`${url}/file.html`)).toBe('two');
      await vi.waitFor(() => {
        expect(listed(server, join(shared, 'one.js'))).toBe(true);
      }, SETTLED);
      send.mockClear();
      writeFileSync(join(shared, 'one.js'), 'export default "three";');
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '/file.html' });
      }, SETTLED);
      expect(await value(`${url}/file.html`)).toBe('three');
      writeFileSync(join(root, 'file.js'), 'out.v = "independent";');
      expect(await value(`${url}/file.html`)).toBe('independent');
      expect(listed(server, join(shared, 'one.js'))).toBe(false);
      // Conversely, watching the parent again must clear a released child's individual ignore.
      writeFileSync(join(root, 'folder.js'), "import v from 'virtual:shared'; out.v = v;");
      expect(await value(`${url}/folder.html`)).toBe('export default "three";');
      await vi.waitFor(() => {
        expect(listed(server, join(shared, 'one.js'))).toBe(true);
      }, SETTLED);
      send.mockClear();
      writeFileSync(join(shared, 'one.js'), 'export default "four";');
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '/folder.html' });
      }, SETTLED);
      expect(await value(`${url}/folder.html`)).toBe('export default "four";');
    }, 30_000);
  }
});

it.each([
  { name: 'without a watcher', watch: null, watches: false },
  { name: 'with a watcher', watch: {}, watches: true },
])(
  'catches up shared entries after release and reimport $name (#517)',
  async ({ watch, watches }) => {
    const base = tempDir();
    const root = join(base, 'project');
    const shared = join(base, 'shared.js');
    const imported = "import v from '../shared.js'; out.v = v;";
    writeFiles(base, { 'shared.js': 'export default "one";' });
    writeFiles(root, { 'a.tw': STORY, 'b.tw': STORY, 'a.js': imported, 'b.js': imported });
    const { server, url } = await startServer({
      root,
      server: { watch },
      plugins: ['a', 'b'].map((name) =>
        tweeTsPlugin({
          sources: [join(root, `${name}.tw`)],
          entry: join(root, `${name}.js`),
          outputFilename: `${name}.html`,
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ),
    });
    expect(await value(`${url}/b.html`)).toBe('one');
    for (const name of ['a', 'b']) {
      writeFileSync(join(root, `${name}.js`), 'out.v = "independent";');
      expect(await value(`${url}/${name}.html`)).toBe('independent');
    }
    expect(listed(server, shared)).toBe(false);
    writeFileSync(join(root, 'b.js'), imported);
    expect(await value(`${url}/b.html`)).toBe('one');
    await vi.waitFor(() => {
      expect(listed(server, shared)).toBe(watches);
    }, SETTLED);
    writeFileSync(shared, 'export default "two";');
    expect(await value(`${url}/b.html`)).toBe('two');
    expect(await value(`${url}/a.html`)).toBe('independent');
  },
  30_000,
);

it.skipIf(process.platform === 'win32')(
  'releases a retained watch when an input-only story retargets its source (#517)',
  async () => {
    const base = tempDir();
    const root = join(base, 'project');
    const old = join(base, 'shared', 'one.js');
    const link = join(base, 'source.js');
    writeFiles(base, {
      'shared/one.js': 'globalThis.shared = "SHARED_ONE";',
      'other.js': 'globalThis.shared = "SHARED_TWO";',
    });
    writeFiles(root, { 'a.tw': STORY, 'b.tw': STORY, 'a.js': "import v from '../shared/one.js?raw'; out.v = v;" });
    symlinkSync(old, link);
    const { server, url } = await startServer({
      root,
      plugins: [
        tweeTsPlugin({
          sources: [join(root, 'a.tw')],
          entry: join(root, 'a.js'),
          outputFilename: 'a.html',
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
        tweeTsPlugin({
          sources: [join(root, 'b.tw'), link],
          outputFilename: 'b.html',
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    });
    expect(await (await fetch(`${url}/b.html`)).text()).toContain('SHARED_ONE');
    await vi.waitFor(() => {
      expect(listed(server, old)).toBe(true);
    }, SETTLED);
    writeFileSync(join(root, 'a.js'), 'out.v = "independent";');
    expect(await value(`${url}/a.html`)).toBe('independent');
    expect(listed(server, old)).toBe(true);
    unlinkSync(link);
    symlinkSync(join(base, 'other.js'), link);
    expect(await (await fetch(`${url}/b.html`)).text()).toContain('SHARED_TWO');
    expect(listed(server, old)).toBe(false);
  },
  30_000,
);

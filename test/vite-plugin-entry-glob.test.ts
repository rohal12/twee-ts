/**
 * An entry whose `import.meta.glob()` gains, loses or renames a matching file (#341): the dev server and
 * `vite build --watch` bundle it again, as a fresh build would, though the new file was in no earlier bundle.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { build } from 'vite';
import type { Plugin } from 'vite';
import type { BuildWatcher } from './helpers/plugins.js';
import { toPosix } from '../src/plugins/paths.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  buildWatchSeesFolders,
  cleanUp,
  COMPILE,
  makeProject,
  runEntry,
  SETTLED,
  startServer,
  STORY,
  userScript,
} from './helpers/plugins.js';

const watchers: BuildWatcher[] = [];
afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
  await cleanUp();
});

/** An entry that reports, in `out.found`, what the glob call `call` selects (its keys, or its values sorted). */
const entryWith = (call: string): string => `
const found = ${call};
out.found = Array.isArray(found) ? found.slice().sort() : Object.keys(found).sort();
`;

/** Each form of the call: eager values, lazy loaders, keys only; nested, negated and `base` patterns. */
const FORMS = {
  eager: {
    call: "Object.values(import.meta.glob('./widgets/*.js', { eager: true, import: 'default' }))",
    initial: ['A', 'SKIP'],
    added: ['A', 'B', 'SKIP'],
  },
  lazy: {
    call: "import.meta.glob('./widgets/*.js')",
    initial: ['./widgets/a.js', './widgets/skip.js'],
    added: ['./widgets/a.js', './widgets/b.js', './widgets/skip.js'],
  },
  keys: {
    call: "Object.keys(import.meta.glob('./widgets/*.js'))",
    initial: ['./widgets/a.js', './widgets/skip.js'],
    added: ['./widgets/a.js', './widgets/b.js', './widgets/skip.js'],
  },
  nested: {
    call: "import.meta.glob('./widgets/**/*.js')",
    initial: ['./widgets/a.js', './widgets/skip.js'],
    added: ['./widgets/a.js', './widgets/b.js', './widgets/skip.js'],
  },
  negated: {
    call: "import.meta.glob(['./widgets/*.js', '!./widgets/skip.js'])",
    initial: ['./widgets/a.js'],
    added: ['./widgets/a.js', './widgets/b.js'],
  },
  base: {
    call: "import.meta.glob('./*.js', { base: './widgets' })",
    initial: ['./a.js', './skip.js'],
    added: ['./a.js', './b.js', './skip.js'],
  },
  absolute: {
    call: "import.meta.glob('/app/widgets/*.js')",
    initial: ['/app/widgets/a.js', '/app/widgets/skip.js'],
    added: ['/app/widgets/a.js', '/app/widgets/b.js', '/app/widgets/skip.js'],
  },
} as const;

/** A project whose entry, `app/entry.js`, globs `app/widgets`. */
function globProject(call: string, widgets: Record<string, string> = { 'a.js': "export default 'A';" }): string {
  return makeProject({
    'story/start.tw': STORY,
    'app/entry.js': entryWith(call),
    'app/widgets/skip.js': "export default 'SKIP';",
    ...Object.fromEntries(Object.entries(widgets).map(([name, content]) => [`app/widgets/${name}`, content])),
  });
}

/**
 * Starts a dev server for `root` with `app/entry.js` as the entry, and `extra` before twee-ts among the user's
 * plugins (which the entry build runs too); returns a reader of what the entry found.
 */
async function serve(root: string, watcher: boolean, extra: Plugin[] = []): Promise<() => Promise<unknown>> {
  const { url } = await startServer({
    root,
    server: watcher ? {} : { watch: null },
    plugins: [
      ...extra,
      tweeTsPlugin({
        sources: [join(root, 'story')],
        format: 'test-format-1',
        entry: join(root, 'app/entry.js'),
        compileOptions: COMPILE,
      }),
    ],
  });
  return async () => {
    const html = await (await fetch(`${url}/`)).text();
    const script = userScript(html);
    return script === '' ? undefined : (runEntry(script) as { found?: unknown }).found;
  };
}

const write = (file: string, content: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

describe.each([
  ['with a watcher', true],
  ['with no watcher', false],
])('vite plugin dev: an entry glob gains a matching file (#341) %s', (_name, watcher) => {
  /** Waits for what the entry found to settle at `expected`: at once with no watcher, which catches up per request. */
  const expectFound = async (read: () => Promise<unknown>, expected: unknown): Promise<void> => {
    if (watcher) await expect.poll(read, { timeout: 10_000, interval: 100 }).toEqual(expected);
    else expect(await read()).toEqual(expected);
  };

  it.each(Object.entries(FORMS))(
    'includes the new file (%s)',
    async (form, { call, initial, added }) => {
      const root = globProject(call);
      const read = await serve(root, watcher);
      expect(await read()).toEqual(initial);
      write(join(root, 'app/widgets/b.js'), "export default 'B';");
      if (form === 'nested') {
        write(join(root, 'app/widgets/deep/c.js'), "export default 'C';");
        await expectFound(read, [...added, './widgets/deep/c.js'].sort());
      } else {
        await expectFound(read, added);
      }
    },
    30_000,
  );

  it('includes the first file of a glob that matched none, and of a folder that did not exist', async () => {
    const root = globProject("Object.keys(import.meta.glob(['./widgets/*.js', './later/*.js']))", {});
    const read = await serve(root, watcher);
    expect(await read()).toEqual(['./widgets/skip.js']);
    write(join(root, 'app/later/first.js'), 'export default 1;');
    await expectFound(read, ['./later/first.js', './widgets/skip.js']);
  }, 30_000);

  it('follows a matching file deleted and renamed', async () => {
    const root = globProject(FORMS.lazy.call, { 'a.js': "export default 'A';", 'b.js': "export default 'B';" });
    const read = await serve(root, watcher);
    expect(await read()).toEqual(['./widgets/a.js', './widgets/b.js', './widgets/skip.js']);
    unlinkSync(join(root, 'app/widgets/b.js'));
    await expectFound(read, ['./widgets/a.js', './widgets/skip.js']);
    renameSync(join(root, 'app/widgets/a.js'), join(root, 'app/widgets/renamed.js'));
    await expectFound(read, ['./widgets/renamed.js', './widgets/skip.js']);
  }, 30_000);

  it('globs a folder outside the root', async () => {
    const shared = makeProject({ 'a.js': "export default 'A';" });
    const root = makeProject({ 'story/start.tw': STORY });
    const folder = toPosix(relative(join(root, 'app'), shared));
    write(join(root, 'app/entry.js'), entryWith(`Object.keys(import.meta.glob(${JSON.stringify(`${folder}/*.js`)}))`));
    const read = await serve(root, watcher);
    expect(await read()).toEqual([`${folder}/a.js`]);
    write(join(shared, 'b.js'), "export default 'B';");
    await expectFound(read, [`${folder}/a.js`, `${folder}/b.js`]);
  }, 30_000);
});

describe.each([
  ['with a watcher', true],
  ['with no watcher', false],
])('vite plugin dev: files an entry glob cannot match (#341) %s', (_name, watcher) => {
  it('bundles the entry again only for a file the glob may match', async () => {
    const root = globProject(FORMS.lazy.call);
    let bundles = 0;
    const events: string[] = [];
    const counter: Plugin = {
      name: 'count-entry-bundles',
      buildStart() {
        bundles += 1;
      },
      configureServer(server) {
        server.watcher.on('all', (event, path) => events.push(`${event} ${toPosix(relative(root, path))}`));
      },
    };
    const read = await serve(root, watcher, [counter]);
    expect(await read()).toEqual(['./widgets/a.js', './widgets/skip.js']);
    // With a watcher, until the count holds still: macOS FSEvents may report the project's own files, written just
    // before the watcher started, a moment later, and an event for a file the entry uses bundles it again.
    const pause = (): Promise<void> => new Promise((done) => setTimeout(done, watcher ? 1000 : 0));
    let initial = -1;
    while (initial !== bundles) {
      initial = bundles;
      await pause();
    }
    events.length = 0;
    // Another extension, an editor's swap file, a folder the glob does not reach into, a folder elsewhere.
    for (const file of ['widgets/notes.md', 'widgets/.a.js.swp', 'widgets/sub/c.js', 'other/x.js']) {
      write(join(root, 'app', file), 'export default 1;');
    }
    // Long enough for the watcher to report them, and for a rebuild they started to begin.
    await pause();
    expect(await read()).toEqual(['./widgets/a.js', './widgets/skip.js']);
    expect(bundles, `bundled again after ${JSON.stringify(events)}`).toBe(initial);
    write(join(root, 'app/widgets/b.js'), "export default 'B';");
    await expect
      .poll(read, { timeout: 10_000, interval: 100 })
      .toEqual(['./widgets/a.js', './widgets/b.js', './widgets/skip.js']);
    // A late watcher event for a file the bundle already read bundles nothing more (#343, see
    // vite-plugin-dev-late-events.test.ts), but the watcher may report the file created and then written: the count
    // only has to grow.
    expect(bundles).toBeGreaterThan(initial);
  }, 30_000);
});

/** Starts `vite build --watch` for `dir`; `separate` bundles the entry in a build of its own. */
async function watchBuild(dir: string, separate: boolean, after: Plugin[] = []): Promise<() => unknown> {
  const started: unknown = await build({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    plugins: [
      tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'app/entry.js'),
        outputFilename: 'story.html',
        compileOptions: COMPILE,
      }),
      ...after,
    ],
    build: {
      watch: {},
      outDir: join(dir, 'out'),
      ...(separate ? { rolldownOptions: { input: join(dir, 'outer.js') } } : {}),
    },
  });
  const watcher = started as BuildWatcher;
  watchers.push(watcher);
  const events: string[] = [];
  watcher.on('event', (event) => {
    events.push(event.code);
    if (event.code === 'BUNDLE_END') void event.result?.close();
  });
  await vi.waitFor(() => {
    if (!events.includes('END') && !events.includes('ERROR')) throw new Error('the first build has not finished');
  }, SETTLED);
  return () => (runEntry(userScript(readFileSync(join(dir, 'out/story.html'), 'utf-8'))) as { found?: unknown }).found;
}

describe.each([
  ['inside the build', false],
  ['in a build of its own', true],
])('vite build watch: an entry glob gains a matching file, the entry bundled %s (#341)', (_name, separate) => {
  it.runIf(buildWatchSeesFolders)(
    'builds again with the new file',
    async () => {
      const dir = globProject(FORMS.lazy.call);
      write(join(dir, 'outer.js'), 'globalThis.outer = 1;');
      const found = await watchBuild(dir, separate);
      expect(found()).toEqual(['./widgets/a.js', './widgets/skip.js']);
      write(join(dir, 'app/widgets/b.js'), "export default 'B';");
      await vi.waitFor(() => {
        expect(found()).toEqual(['./widgets/a.js', './widgets/b.js', './widgets/skip.js']);
      }, SETTLED);
    },
    30_000,
  );

  // A component-like file that a plugin after twee-ts makes JavaScript: inside the build, twee-ts sees its text
  // before that plugin does, and reads the glob call in it on its own, with its TypeScript type argument.
  it.runIf(buildWatchSeesFolders)(
    'builds again for a glob in a module that is JavaScript only after a later plugin',
    async () => {
      const dir = globProject('list');
      write(join(dir, 'outer.js'), 'globalThis.outer = 1;');
      write(join(dir, 'app/entry.js'), "import list from './list.component'; out.found = list;");
      write(
        join(dir, 'app/list.component'),
        "<component>\nexport default Object.keys(import.meta.glob<string>('./widgets/*.js')).sort();\n</component>\n",
      );
      const component: Plugin = {
        name: 'component',
        transform(code, id) {
          if (!id.endsWith('.component')) return undefined;
          return {
            code: code.replace(/<\/?component>/g, '').replace('<string>', ''),
            moduleType: 'js',
          };
        },
      };
      const found = await watchBuild(dir, separate, [component]);
      expect(found()).toEqual(['./widgets/a.js', './widgets/skip.js']);
      write(join(dir, 'app/widgets/b.js'), "export default 'B';");
      await vi.waitFor(() => {
        expect(found()).toEqual(['./widgets/a.js', './widgets/b.js', './widgets/skip.js']);
      }, SETTLED);
    },
    30_000,
  );
});

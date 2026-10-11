/**
 * A link in the entry's graph that is pointed at another file or folder (#320): the dev server (with a watcher and
 * with `server.watch: null`) and `vite build --watch` (the entry bundled inside the build and in a build of its own)
 * bundle the new target, whichever way the import that reaches the link is spelled: relative, absolute,
 * root-relative, without its extension, a folder's index, an alias, a bare package name (also scoped, a subpath of
 * the package, a package outside the root) or a package's `#` subpath import.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  buildWatchSeesFolders,
  cleanUp,
  COMPILE,
  makeProject,
  SETTLED,
  startBuildWatch,
  startServer,
  STORY,
  storyWith,
  writeFiles,
} from './helpers/plugins.js';

afterEach(async () => {
  await cleanUp();
});

const marker = (name: string): string => `globalThis.probe = "ENTRY_${name}";\n`;
const exported = (name: string): string => `export const marker = "ENTRY_${name}";\n`;
const IMPORTING = (spelling: string): string =>
  `import { marker } from ${JSON.stringify(spelling)};\nglobalThis.probe = marker;\n`;
const pkg = (name: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, version: '1.0.0', type: 'module', ...extra });

/**
 * One way the entry reaches a link. In `files`, a name starting with `outside/` is written to a folder outside the
 * project, and `<root>` and `<outside>` in a file's content or a link's target stand for the two folders. The link
 * at `link` first points at `initial`, then at `after`; `edit` is the file the new target reads from (relative to
 * the project, or to the outside folder with `outside/`), whose later edit is bundled too. `alias` is the
 * configuration's `resolve.alias`; `chain` holds links made first, which never change (a link to the link that is
 * retargeted).
 */
interface LinkCase {
  readonly files: Readonly<Record<string, string>>;
  readonly link: string;
  readonly initial: string;
  readonly after: string;
  readonly edit: string;
  readonly alias?: Readonly<Record<string, string>>;
  readonly chain?: Readonly<Record<string, string>>;
}

const PACKAGE_FILES = {
  'packages/v1/package.json': pkg('dependency', { exports: './index.js' }),
  'packages/v1/index.js': exported('A'),
  'packages/v2/package.json': pkg('dependency', { exports: './index.js' }),
  'packages/v2/index.js': exported('B'),
};

const CASES: Readonly<Record<string, LinkCase>> = {
  'the entry itself is a link': {
    files: { 'a.js': marker('A'), 'b.js': marker('B') },
    link: 'entry.js',
    initial: 'a.js',
    after: 'b.js',
    edit: 'b.js',
  },
  'a relative import is a link': {
    files: { 'a.js': exported('A'), 'b.js': exported('B'), 'entry.js': IMPORTING('./dependency.js') },
    link: 'dependency.js',
    initial: 'a.js',
    after: 'b.js',
    edit: 'b.js',
  },
  'an import without its extension is a link to a TypeScript file': {
    files: { 'a.ts': exported('A'), 'b.ts': exported('B'), 'entry.js': IMPORTING('./dependency') },
    link: 'dependency.ts',
    initial: 'a.ts',
    after: 'b.ts',
    edit: 'b.ts',
  },
  'an import without its extension is a link to a JavaScript file': {
    files: { 'a.js': exported('A'), 'b.js': exported('B'), 'entry.js': IMPORTING('./dependency') },
    link: 'dependency.js',
    initial: 'a.js',
    after: 'b.js',
    edit: 'b.js',
  },
  'an absolute import is a link': {
    files: { 'a.js': exported('A'), 'b.js': exported('B'), 'entry.js': IMPORTING('<root>/dependency.js') },
    link: 'dependency.js',
    initial: 'a.js',
    after: 'b.js',
    edit: 'b.js',
  },
  'a root-relative import is a link': {
    files: { 'a.js': exported('A'), 'b.js': exported('B'), 'entry.js': IMPORTING('/dependency.js') },
    link: 'dependency.js',
    initial: 'a.js',
    after: 'b.js',
    edit: 'b.js',
  },
  'a folder an import goes through is a link': {
    files: { 'one/lib.js': exported('A'), 'two/lib.js': exported('B'), 'entry.js': IMPORTING('./lib/lib.js') },
    link: 'lib',
    initial: 'one',
    after: 'two',
    edit: 'two/lib.js',
  },
  'a folder an import takes the index of is a link': {
    files: { 'one/index.js': exported('A'), 'two/index.js': exported('B'), 'entry.js': IMPORTING('./lib') },
    link: 'lib',
    initial: 'one',
    after: 'two',
    edit: 'two/index.js',
  },
  'a folder outside the root an import goes through is a link': {
    files: {
      'outside/one/lib.js': exported('A'),
      'outside/two/lib.js': exported('B'),
      'entry.js': IMPORTING('./lib/lib.js'),
    },
    link: 'lib',
    initial: '<outside>/one',
    after: '<outside>/two',
    edit: 'outside/two/lib.js',
  },
  'an alias leads to a link': {
    files: { 'a.js': exported('A'), 'b.js': exported('B'), 'entry.js': IMPORTING('@dependency') },
    link: 'dependency.js',
    initial: 'a.js',
    after: 'b.js',
    edit: 'b.js',
    alias: { '@dependency': '<root>/dependency.js' },
  },
  'an alias leads into a linked folder': {
    files: { 'one/lib.js': exported('A'), 'two/lib.js': exported('B'), 'entry.js': IMPORTING('@lib/lib.js') },
    link: 'lib',
    initial: 'one',
    after: 'two',
    edit: 'two/lib.js',
    alias: { '@lib': '<root>/lib' },
  },
  'a bare package name is a linked package folder': {
    files: { ...PACKAGE_FILES, 'entry.js': IMPORTING('dependency') },
    link: 'node_modules/dependency',
    initial: '../packages/v1',
    after: '../packages/v2',
    edit: 'packages/v2/index.js',
  },
  'a bare package name is a linked package folder outside the root': {
    files: {
      'outside/packages/v1/package.json': PACKAGE_FILES['packages/v1/package.json'],
      'outside/packages/v1/index.js': exported('A'),
      'outside/packages/v2/package.json': PACKAGE_FILES['packages/v2/package.json'],
      'outside/packages/v2/index.js': exported('B'),
      'entry.js': IMPORTING('dependency'),
    },
    link: 'node_modules/dependency',
    initial: '<outside>/packages/v1',
    after: '<outside>/packages/v2',
    edit: 'outside/packages/v2/index.js',
  },
  'a scoped package name is a linked package folder': {
    files: {
      'packages/v1/package.json': pkg('@scope/dependency', { exports: './index.js' }),
      'packages/v1/index.js': exported('A'),
      'packages/v2/package.json': pkg('@scope/dependency', { exports: './index.js' }),
      'packages/v2/index.js': exported('B'),
      'entry.js': IMPORTING('@scope/dependency'),
    },
    link: 'node_modules/@scope/dependency',
    initial: '../../packages/v1',
    after: '../../packages/v2',
    edit: 'packages/v2/index.js',
  },
  'a subpath of a package is reached through a linked package folder': {
    files: {
      'packages/v1/package.json': pkg('dependency'),
      'packages/v1/lib/extra.js': exported('A'),
      'packages/v2/package.json': pkg('dependency'),
      'packages/v2/lib/extra.js': exported('B'),
      'entry.js': IMPORTING('dependency/lib/extra.js'),
    },
    link: 'node_modules/dependency',
    initial: '../packages/v1',
    after: '../packages/v2',
    edit: 'packages/v2/lib/extra.js',
  },
  'a file of a package folder is a link': {
    files: {
      'node_modules/dependency/package.json': pkg('dependency', { exports: './index.js' }),
      'a.js': exported('A'),
      'b.js': exported('B'),
      'entry.js': IMPORTING('dependency'),
    },
    link: 'node_modules/dependency/index.js',
    initial: '<root>/a.js',
    after: '<root>/b.js',
    edit: 'b.js',
  },
  "a package's # subpath import is a link": {
    files: {
      'package.json': pkg('project', { imports: { '#dependency': './dependency.js' } }),
      'a.js': exported('A'),
      'b.js': exported('B'),
      'entry.js': IMPORTING('#dependency'),
    },
    link: 'dependency.js',
    initial: 'a.js',
    after: 'b.js',
    edit: 'b.js',
  },
  // The retarget changes the file the import resolves to, not only the file behind the same path.
  'a folder whose index changes from JavaScript to TypeScript is a link': {
    files: { 'one/index.js': exported('A'), 'two/index.ts': exported('B'), 'entry.js': IMPORTING('./lib') },
    link: 'lib',
    initial: 'one',
    after: 'two',
    edit: 'two/index.ts',
  },
  'an import without its extension reaches a file of another extension in a linked folder': {
    files: {
      'one/dependency.js': exported('A'),
      'two/dependency.ts': exported('B'),
      'entry.js': IMPORTING('./lib/dependency'),
    },
    link: 'lib',
    initial: 'one',
    after: 'two',
    edit: 'two/dependency.ts',
  },
  'a linked package folder whose exports change': {
    files: {
      'packages/v1/package.json': pkg('dependency', { exports: './index.js' }),
      'packages/v1/index.js': exported('A'),
      'packages/v2/package.json': pkg('dependency', { exports: './main.js' }),
      'packages/v2/main.js': exported('B'),
      'entry.js': IMPORTING('dependency'),
    },
    link: 'node_modules/dependency',
    initial: '../packages/v1',
    after: '../packages/v2',
    edit: 'packages/v2/main.js',
  },
  'a linked package folder whose main field changes': {
    files: {
      'packages/v1/package.json': pkg('dependency', { main: './index.js' }),
      'packages/v1/index.js': exported('A'),
      'packages/v2/package.json': pkg('dependency', { main: './lib/main.js' }),
      'packages/v2/lib/main.js': exported('B'),
      'entry.js': IMPORTING('dependency'),
    },
    link: 'node_modules/dependency',
    initial: '../packages/v1',
    after: '../packages/v2',
    edit: 'packages/v2/lib/main.js',
  },
  // A chain of links: the import's own link stays, the one it leads to is retargeted.
  'a link to a file link that is retargeted': {
    files: { 'a.js': exported('A'), 'b.js': exported('B'), 'entry.js': IMPORTING('./dependency.js') },
    chain: { 'dependency.js': 'mid.js' },
    link: 'mid.js',
    initial: 'a.js',
    after: 'b.js',
    edit: 'b.js',
  },
  'a folder link to a folder link that is retargeted': {
    files: { 'one/lib.js': exported('A'), 'two/lib.js': exported('B'), 'entry.js': IMPORTING('./lib/lib.js') },
    chain: { lib: 'mid' },
    link: 'mid',
    initial: 'one',
    after: 'two',
    edit: 'two/lib.js',
  },
};

/** A project for `linkCase`, with its link pointing at the initial target; returns the two folders. */
function linkProject(linkCase: LinkCase): { root: string; outside: string } {
  const outside = makeProject({});
  const root = makeProject({ 'story/start.tw': STORY, 'outer.js': 'globalThis.outer = 1;' });
  const fill = (text: string): string => text.replaceAll('<root>', root).replaceAll('<outside>', outside);
  for (const [name, content] of Object.entries(linkCase.files)) {
    const [dir, file] = name.startsWith('outside/') ? [outside, name.slice('outside/'.length)] : [root, name];
    writeFiles(dir, { [file]: fill(content) });
  }
  for (const [path, target] of Object.entries(linkCase.chain ?? {})) symlinkSync(fill(target), join(root, path));
  const link = join(root, linkCase.link);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(fill(linkCase.initial), link);
  return { root, outside };
}

/** Points the case's link at its other target. */
function retarget(root: string, outside: string, linkCase: LinkCase): void {
  const link = join(root, linkCase.link);
  unlinkSync(link);
  symlinkSync(linkCase.after.replaceAll('<root>', root).replaceAll('<outside>', outside), link);
}

/** The file the new target reads from. */
function editedFile(root: string, outside: string, linkCase: LinkCase): string {
  return linkCase.edit.startsWith('outside/')
    ? join(outside, linkCase.edit.slice('outside/'.length))
    : join(root, linkCase.edit);
}

function aliasPlugin(root: string, alias: Readonly<Record<string, string>> | undefined): Plugin[] {
  if (alias === undefined) return [];
  const entries = Object.fromEntries(Object.entries(alias).map(([find, to]) => [find, to.replaceAll('<root>', root)]));
  return [{ name: 'alias', config: () => ({ resolve: { alias: entries } }) }];
}

const seen = (html: string): string[] => ['A', 'B', 'C'].filter((name) => html.includes(`ENTRY_${name}`));

const cases = Object.entries(CASES);

describe.skipIf(process.platform === 'win32').each([
  ['with a watcher', true],
  ['with no watcher', false],
])('vite plugin dev: a retargeted link in the entry graph (#320) %s', (_mode, watcher) => {
  it.each(cases)(
    'bundles the new target when %s',
    async (_name, linkCase) => {
      const { root, outside } = linkProject(linkCase);
      const { url } = await startServer({
        root,
        server: watcher ? {} : { watch: null },
        plugins: [
          ...aliasPlugin(root, linkCase.alias),
          tweeTsPlugin({
            sources: [join(root, 'story')],
            format: 'test-format-1',
            entry: join(root, 'entry.js'),
            compileOptions: COMPILE,
          }),
        ],
      });
      const page = async (): Promise<string> => (await fetch(`${url}/`)).text();
      expect(seen(await page())).toEqual(['A']);
      retarget(root, outside, linkCase);
      // A request after the retarget is served the new bundle, with no other edit and no restart.
      await expect.poll(async () => seen(await page()), { timeout: 10_000, interval: 200 }).toEqual(['B']);
      writeFileSync(join(root, 'story/start.tw'), storyWith('Changed.'));
      await expect.poll(async () => (await page()).includes('Changed.'), { timeout: 10_000 }).toBe(true);
      expect(seen(await page())).toEqual(['B']);
      // The new target is the one followed from now on.
      const edited = editedFile(root, outside, linkCase);
      writeFileSync(edited, readFileSync(edited, 'utf-8').replace('ENTRY_B', 'ENTRY_C'));
      await expect.poll(async () => seen(await page()), { timeout: 10_000, interval: 200 }).toEqual(['C']);
    },
    60_000,
  );
});

// Linux only, as for the sources: the bundler's watcher on macOS reports no replacement of a link. A link to a
// folder is registered as a folder, whose replacement Vite 8.0 and 8.1 do not report.
describe.runIf(process.platform === 'linux' && buildWatchSeesFolders).each([
  ['inside the build', false],
  ['in a build of its own', true],
])('vite build watch: a retargeted link in the entry graph, the entry bundled %s (#320)', (_mode, separate) => {
  it.each(cases)(
    'builds the new target when %s',
    async (_name, linkCase) => {
      const { root, outside } = linkProject(linkCase);
      await startBuildWatch({
        root,
        plugins: [
          ...aliasPlugin(root, linkCase.alias),
          tweeTsPlugin({
            sources: [join(root, 'story')],
            format: 'test-format-1',
            entry: join(root, 'entry.js'),
            outputFilename: 'story.html',
            compileOptions: COMPILE,
          }),
        ],
        build: {
          outDir: join(root, 'out'),
          ...(separate ? { rolldownOptions: { input: join(root, 'outer.js') } } : {}),
        },
      });
      const story = (): string => readFileSync(join(root, 'out/story.html'), 'utf-8');
      expect(seen(story())).toEqual(['A']);
      retarget(root, outside, linkCase);
      await vi.waitFor(() => {
        expect(seen(story())).toEqual(['B']);
      }, SETTLED);
      const edited = editedFile(root, outside, linkCase);
      writeFileSync(edited, readFileSync(edited, 'utf-8').replace('ENTRY_B', 'ENTRY_C'));
      await vi.waitFor(() => {
        expect(seen(story())).toEqual(['C']);
      }, SETTLED);
    },
    60_000,
  );
});

/**
 * A plugin of the user's that resolves an import itself decides the module, whatever a link on the way of Vite's own
 * resolution leads to: the plugin resolves `dependency` to `packages/v1` while `node_modules/dependency` is relinked
 * to `packages/v2`. Every mode keeps the plugin's choice, as a fresh build does (#320 review).
 */
describe.skipIf(process.platform === 'win32').each([
  ['dev, watcher', 'dev'],
  ['dev, no watcher', 'dev'],
  ['build watch, inside the build', 'inside'],
  ['build watch, in a build of its own', 'separate'],
] as const)('a plugin that resolves an import itself, %s', (mode, kind) => {
  it.skipIf(kind !== 'dev' && (process.platform !== 'linux' || !buildWatchSeesFolders))(
    "keeps the plugin's module after the package folder's link is relinked",
    async () => {
      const root = makeProject({
        ...PACKAGE_FILES,
        'story/start.tw': STORY,
        'outer.js': 'globalThis.outer = 1;',
        'entry.js': IMPORTING('dependency'),
      });
      mkdirSync(join(root, 'node_modules'));
      symlinkSync('../packages/v1', join(root, 'node_modules/dependency'));
      const chooser: Plugin = {
        name: 'choose-dependency',
        enforce: 'pre',
        resolveId: (source) => (source === 'dependency' ? join(root, 'packages/v1/index.js') : undefined),
      };
      const plugins = [
        chooser,
        tweeTsPlugin({
          sources: [join(root, 'story')],
          format: 'test-format-1',
          entry: join(root, 'entry.js'),
          outputFilename: 'story.html',
          compileOptions: COMPILE,
        }),
      ];
      let read: () => Promise<string>;
      if (kind === 'dev') {
        const { url } = await startServer({ root, server: mode === 'dev, watcher' ? {} : { watch: null }, plugins });
        read = async () => (await fetch(`${url}/story.html`)).text();
      } else {
        await startBuildWatch({
          root,
          plugins,
          build: {
            outDir: join(root, 'out'),
            ...(kind === 'separate' ? { rolldownOptions: { input: join(root, 'outer.js') } } : {}),
          },
        });
        read = () => Promise.resolve(readFileSync(join(root, 'out/story.html'), 'utf-8'));
      }
      expect(seen(await read())).toEqual(['A']);
      unlinkSync(join(root, 'node_modules/dependency'));
      symlinkSync('../packages/v2', join(root, 'node_modules/dependency'));
      writeFileSync(join(root, 'story/start.tw'), storyWith('Changed.'));
      await expect.poll(async () => (await read()).includes('Changed.'), SETTLED).toBe(true);
      expect(seen(await read())).toEqual(['A']);
    },
    60_000,
  );
});

/**
 * What the compiler and the Vite plugin put into a story format's page, and the plugin's entry
 * builds, as the build in dist/ does them. Matrix groups HEAD, VITE and DEPS (see cases.ts).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build, createServer, version } from 'vite';
import type { InlineConfig, Plugin } from 'vite';
import { expect } from 'vitest';
import { compile, decompileHTML } from '@rohal12/twee-ts';
import { tweeTsPlugin } from '@rohal12/twee-ts/vite';
import type { TweeTsVitePluginOptions } from '@rohal12/twee-ts/vite';
import { attr, elements, scriptTexts, textContent } from '../../test/helpers/html.js';
import { compileJavaScript } from '../../test/helpers/javascript.js';
import { defineContracts, devHtml, inline, localFormat, page, story, write } from './harness.js';

/** A template whose head is preceded by `prefix` (a look-alike of a head tag), or opens with `head`. */
interface HeadTemplate {
  readonly prefix: string;
  readonly head: string;
}

const TEMPLATES = {
  'ordinary head': { prefix: '', head: '<head>' },
  'comment look-alike': { prefix: '<!-- example <head></head> -->', head: '<head>' },
  'script look-alike': { prefix: '<script>const example="<head></head>";</script>', head: '<head>' },
  'attribute look-alike': { prefix: '<meta data-example="<head></head>">', head: '<head>' },
  'quoted head attribute': { prefix: '', head: '<head data-example="<head>" data-other=">">' },
} as const satisfies Record<string, HeadTemplate>;

const MODULE_CODE = 'globalThis.validationModule = 42;';

/** A module is injected as a real script element, and the template's look-alike text is kept as it was. */
async function expectModuleInjected(root: string, template: HeadTemplate): Promise<void> {
  const { formatId, options } = localFormat(root, page(template.prefix, template.head));
  const module = write(join(root, 'injected.js'), MODULE_CODE);
  const html = (await compile({ ...options, formatId, sources: [inline()], modules: [module] })).output;
  const injected = elements(html, (e) => e.tagName === 'script' && attr(e, 'id') === 'script-module-injected');
  expect(injected.map(textContent)).toEqual([MODULE_CODE]);
  expectTemplateKept(html, template);
}

/** The development server's page has one Vite client script element, and the look-alike text is kept. */
async function expectClientInjected(root: string, template: HeadTemplate): Promise<void> {
  const { formatId, options } = localFormat(root, page(template.prefix, template.head));
  const storyFile = write(join(root, 'story.tw'), story());
  const html = await devHtml(root, { sources: [storyFile], format: formatId, compileOptions: options });
  const clients = elements(html, (e) => e.tagName === 'script' && attr(e, 'src') === '/@vite/client');
  expect(clients).toHaveLength(1);
  expectTemplateKept(html, template);
}

function expectTemplateKept(html: string, template: HeadTemplate): void {
  expect(html).toContain(template.prefix === '' ? template.head : template.prefix);
  for (const script of scriptTexts(html)) {
    expect(() => {
      compileJavaScript(script);
    }).not.toThrow();
  }
}

const t = TEMPLATES;
defineContracts('HEAD', {
  'module: ordinary head': (root) => expectModuleInjected(root, t['ordinary head']),
  'module: comment look-alike': (root) => expectModuleInjected(root, t['comment look-alike']),
  'module: script look-alike': (root) => expectModuleInjected(root, t['script look-alike']),
  'module: attribute look-alike': (root) => expectModuleInjected(root, t['attribute look-alike']),
  'module: quoted head attribute': (root) => expectModuleInjected(root, t['quoted head attribute']),
  'client: ordinary head': (root) => expectClientInjected(root, t['ordinary head']),
  'client: comment look-alike': (root) => expectClientInjected(root, t['comment look-alike']),
  'client: script look-alike': (root) => expectClientInjected(root, t['script look-alike']),
  'client: attribute look-alike': (root) => expectClientInjected(root, t['attribute look-alike']),
  'client: quoted head attribute': (root) => expectClientInjected(root, t['quoted head attribute']),
});

const MARKER = 'VALIDATION_INLINE_ENTRY';

/** How a VITE case sets up its entry: the entry's code, the inline config and the plugins before twee-ts. */
interface EntrySetup {
  readonly code: string;
  readonly config?: InlineConfig;
  readonly plugins?: readonly Plugin[];
}

const defineMarker = { define: { __VALIDATION_MARKER__: JSON.stringify(MARKER) } };

defineContracts('VITE', {
  'ordinary inline config': (root) =>
    expectEntryConfigKept(root, () => ({ code: `globalThis.validationEntry = ${JSON.stringify(MARKER)};` })),
  'inline define': (root) =>
    expectEntryConfigKept(root, () => ({
      code: 'globalThis.validationEntry = __VALIDATION_MARKER__;',
      config: defineMarker,
    })),
  'inline alias': (root) =>
    expectEntryConfigKept(root, () => {
      const target = write(join(root, 'value.js'), `export default ${JSON.stringify(MARKER)};`);
      return {
        code: 'import value from "validation-alias"; globalThis.validationEntry = value;',
        config: { resolve: { alias: { 'validation-alias': target } } },
      };
    }),
  'inline virtual-module plugin': (root) =>
    expectEntryConfigKept(root, () => ({
      code: 'import value from "virtual:validation"; globalThis.validationEntry = value;',
      plugins: [
        {
          name: 'validation-virtual',
          resolveId: (id) => (id === 'virtual:validation' ? '\0virtual:validation' : undefined),
          load: (id) => (id === '\0virtual:validation' ? `export default ${JSON.stringify(MARKER)};` : undefined),
        },
      ],
    })),
  'file config with inline define override': (root) =>
    expectEntryConfigKept(root, () => ({
      code: 'globalThis.validationEntry = __VALIDATION_MARKER__;',
      config: {
        ...defineMarker,
        configFile: write(
          join(root, 'vite.config.mjs'),
          'export default { define: { __VALIDATION_MARKER__: JSON.stringify("VALIDATION_FILE_ENTRY") } };',
        ),
      },
    })),
});

/**
 * The production build and the development server both bundle the entry with the user's
 * configuration: the marker the configuration supplies reaches the page, and an inline value wins
 * over the config file's.
 */
async function expectEntryConfigKept(root: string, setup: () => EntrySetup): Promise<void> {
  const { formatId, options } = localFormat(root);
  const storyFile = write(join(root, 'story.tw'), story());
  const { code, config = {}, plugins = [] } = setup();
  const entry = write(join(root, 'entry.js'), code);
  const pluginOptions: TweeTsVitePluginOptions = {
    sources: [storyFile],
    format: formatId,
    entry,
    compileOptions: options,
  };
  const bundle = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    ...config,
    plugins: [...plugins, tweeTsPlugin(pluginOptions)],
    build: { write: false },
  });
  const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((b) => ('output' in b ? b.output : []));
  const index = outputs.find((item) => item.fileName === 'index.html');
  const production = index?.type === 'asset' ? index.source : undefined;
  expect(typeof production).toBe('string');
  expect(String(production), 'production did not keep the user configuration').toContain(MARKER);
  const development = await devHtml(root, pluginOptions, config, plugins);
  expect(development, 'development did not keep the user configuration').toContain(MARKER);
  expect(development, 'the config file replaced the inline value').not.toContain('VALIDATION_FILE_ENTRY');
}

/** An entry that leaves, in `globalThis.found`, what its glob call `call` selects: its keys, or its values sorted. */
const globEntry = (call: string): string =>
  `const found = ${call}; globalThis.found = Array.isArray(found) ? found.slice().sort() : Object.keys(found).sort();`;

/** What the entry of a story page left in `globalThis.found`, running its Story JavaScript. */
function foundIn(html: string): unknown {
  const script = decompileHTML(html)
    .story.passages.filter((passage) => passage.tags.includes('script'))
    .map((passage) => passage.text)
    .join('\n');
  const context: { found?: unknown } = {};
  runInNewContext(script, context);
  return context.found;
}

/** A project whose entry, `app/entry.js`, makes the glob call `call`, with `widgets` in `app/widgets`. */
function globProject(root: string, call: string, widgets: readonly string[]): TweeTsVitePluginOptions {
  const { formatId, options } = localFormat(root);
  const storyFile = write(join(root, 'story', 'story.tw'), story());
  for (const widget of widgets)
    write(join(root, 'app', 'widgets', widget), `export default ${JSON.stringify(widget)};`);
  const entry = write(join(root, 'app', 'entry.js'), globEntry(call));
  return { sources: [storyFile], format: formatId, entry, compileOptions: options };
}

/**
 * Starts a development server for `root` (with no watcher unless `watcher`), reads what the entry found, makes
 * `change`, and expects the entry to find `before`, then `after`: at once with no watcher, which the server catches
 * up with before it serves the story, and with one once the server has noticed.
 */
async function expectDevFollows(
  root: string,
  pluginOptions: TweeTsVitePluginOptions,
  change: () => void,
  before: unknown,
  after: unknown,
  watcher = false,
  readStory: (html: string) => unknown = foundIn,
): Promise<void> {
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [tweeTsPlugin(pluginOptions)],
    server: { host: '127.0.0.1', port: 0, ...(watcher ? {} : { watch: null }) },
  });
  try {
    await server.listen();
    const [url] = server.resolvedUrls?.local ?? [];
    const read = async (): Promise<unknown> => readStory(await (await fetch(String(url))).text());
    expect(await read()).toEqual(before);
    change();
    if (watcher) await expect.poll(read, { timeout: 20_000, interval: 100 }).toEqual(after);
    else expect(await read(), 'the story kept the files the glob selected before').toEqual(after);
  } finally {
    await server.close();
  }
}

/** Expects `vite build --watch` to build the story again with the file a glob gains. */
function expectBuildWatchFollows(root: string): Promise<void> {
  const pluginOptions = globProject(root, "Object.keys(import.meta.glob('./widgets/*.js'))", ['a.js']);
  return expectBuildWatchSees(
    root,
    pluginOptions,
    () => write(join(root, 'app', 'widgets', 'b.js'), 'export default "b";'),
    foundIn,
    ['./widgets/a.js'],
    ['./widgets/a.js', './widgets/b.js'],
  );
}

/**
 * Starts `vite build --watch` for `root` (the entry bundled inside the build), reads the story with `read`, makes
 * `change`, and expects `before`, then `after`.
 */
async function expectBuildWatchSees(
  root: string,
  pluginOptions: TweeTsVitePluginOptions,
  change: () => void,
  read: (html: string) => unknown,
  before: unknown,
  after: unknown,
  separate = false,
): Promise<void> {
  // A separate entry: the build has an input of its own, and bundles the entry in a build of its own.
  const input = separate ? { rolldownOptions: { input: write(join(root, 'outer.js'), 'globalThis.outer = 1;') } } : {};
  const started: unknown = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [tweeTsPlugin({ ...pluginOptions, outputFilename: 'story.html' })],
    build: { watch: {}, outDir: join(root, 'out'), ...input },
  });
  const watcher = started as {
    on(event: 'event', listener: (event: { code: string }) => void): void;
    close(): Promise<void>;
  };
  const ended: string[] = [];
  watcher.on('event', (event) => {
    if (event.code === 'END' || event.code === 'ERROR') ended.push(event.code);
  });
  try {
    const found = (): unknown => read(readFileSync(join(root, 'out', 'story.html'), 'utf-8'));
    await expect.poll(() => ended.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(found()).toEqual(before);
    change();
    await expect.poll(found, { timeout: 20_000, interval: 100 }).toEqual(after);
  } finally {
    await watcher.close();
  }
}

const widget = (root: string, name: string): string => join(root, 'app', 'widgets', name);

/**
 * Expects the dev server (with no watcher unless `watcher`) to follow a file added to a folder that a recursive glob
 * of `app/widgets` reaches through a link, `app/widgets/shared`, to `shared` (a junction on Windows).
 */
function expectDevFollowsLink(root: string, watcher = false): Promise<void> {
  const pluginOptions = globProject(root, "Object.keys(import.meta.glob('./widgets/**/*.js'))", ['a.js']);
  const shared = join(root, 'shared');
  mkdirSync(shared);
  write(join(shared, 'one.js'), 'export default 1;');
  symlinkSync(shared, widget(root, 'shared'), 'junction');
  return expectDevFollows(
    root,
    pluginOptions,
    () => write(join(shared, 'two.js'), 'export default 2;'),
    ['./widgets/a.js', './widgets/shared/one.js'],
    ['./widgets/a.js', './widgets/shared/one.js', './widgets/shared/two.js'],
    watcher,
  );
}

/** A link to a folder: a junction on Windows, which needs no privilege. */
function linkFolder(target: string, path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  symlinkSync(target, path, 'junction');
}

/**
 * A project whose entry, `app/entry.js`, imports the bare package `dependency`, whose folder in `node_modules` is a
 * link to `packages/v1`; `retarget` points it at `packages/v2` (#320).
 */
function packageLinkProject(root: string): { pluginOptions: TweeTsVitePluginOptions; retarget: () => void } {
  const { formatId, options } = localFormat(root);
  const storyFile = write(join(root, 'story', 'story.tw'), story());
  for (const version of ['v1', 'v2']) {
    write(
      join(root, 'packages', version, 'package.json'),
      JSON.stringify({ name: 'dependency', type: 'module', exports: './index.js' }),
    );
    write(join(root, 'packages', version, 'index.js'), `export default ${JSON.stringify(version)};`);
  }
  const link = join(root, 'node_modules', 'dependency');
  linkFolder(join(root, 'packages', 'v1'), link);
  const entry = write(join(root, 'app', 'entry.js'), 'import found from "dependency"; globalThis.found = found;');
  return {
    pluginOptions: { sources: [storyFile], format: formatId, entry, compileOptions: options },
    retarget: () => {
      rmSync(link);
      linkFolder(join(root, 'packages', 'v2'), link);
    },
  };
}

/** Expects the dev server to bundle the new target of a package folder link the entry imports through. */
function expectDevFollowsPackageLink(root: string, watcher = false): Promise<void> {
  const { pluginOptions, retarget } = packageLinkProject(root);
  return expectDevFollows(root, pluginOptions, retarget, 'v1', 'v2', watcher);
}

/** The data files of `app/data` the worker's glob selected, as the story names them (#424). */
const workerFound = (html: string): string[] => ['a', 'b'].filter((name) => html.includes(`data/${name}.js`));

/**
 * A project whose entry, `app/entry.js`, starts an inline worker, `app/worker.js`, whose glob selects `app/data`
 * (holding `a.js`); `add` adds `b.js` there.
 */
function workerProject(
  root: string,
  start = "import Started from './worker.js?worker&inline'; globalThis.start = () => new Started();",
): { pluginOptions: TweeTsVitePluginOptions; add: () => void } {
  const { formatId, options } = localFormat(root);
  const storyFile = write(join(root, 'story', 'story.tw'), story());
  write(join(root, 'app', 'data', 'a.js'), 'export default "a";');
  write(join(root, 'app', 'worker.js'), "self.found = Object.keys(import.meta.glob('./data/*.js'));");
  const entry = write(join(root, 'app', 'entry.js'), start);
  return {
    pluginOptions: { sources: [storyFile], format: formatId, entry, compileOptions: options },
    add: () => write(join(root, 'app', 'data', 'b.js'), 'export default "b";'),
  };
}

/**
 * Expects the dev server (with no watcher) to bundle a file added to the glob of a worker started with
 * `new Worker(new URL(…))`, a file of its own the story names and the server serves.
 */
async function expectDevFollowsUrlWorkerGlob(root: string): Promise<void> {
  const { pluginOptions, add } = workerProject(
    root,
    "globalThis.start = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
  );
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [tweeTsPlugin(pluginOptions)],
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  try {
    await server.listen();
    const [url = ''] = server.resolvedUrls?.local ?? [];
    // The story, and the worker files it names.
    const read = async (): Promise<string[]> => {
      const html = await (await fetch(url)).text();
      const names = [...html.matchAll(/assets\/[\w.-]+\.js/g)].map(([name]) => name);
      const workers = await Promise.all(names.map(async (name) => (await fetch(`${url}${name}`)).text()));
      return workerFound([html, ...workers].join('\n'));
    };
    expect(await read()).toEqual(['a']);
    add();
    expect(await read(), 'the worker kept the files its glob selected before').toEqual(['a', 'b']);
  } finally {
    await server.close();
  }
}

function expectDevFollowsWorkerGlob(root: string, watcher = false): Promise<void> {
  const { pluginOptions, add } = workerProject(root);
  return expectDevFollows(root, pluginOptions, add, ['a'], ['a', 'b'], watcher, workerFound);
}

defineContracts(
  'DEPS',
  {
    'dev eager glob gains a file': (root) =>
      expectDevFollows(
        root,
        globProject(root, "Object.values(import.meta.glob('./widgets/*.js', { eager: true, import: 'default' }))", [
          'a.js',
        ]),
        () => write(widget(root, 'b.js'), 'export default "b.js";'),
        ['a.js'],
        ['a.js', 'b.js'],
      ),
    'dev lazy glob loses a file': (root) =>
      expectDevFollows(
        root,
        globProject(root, "import.meta.glob('./widgets/*.js')", ['a.js', 'b.js']),
        () => {
          unlinkSync(widget(root, 'b.js'));
        },
        ['./widgets/a.js', './widgets/b.js'],
        ['./widgets/a.js'],
      ),
    'dev keys-only glob renames a file': (root) =>
      expectDevFollows(
        root,
        globProject(root, "Object.keys(import.meta.glob('./widgets/*.js'))", ['a.js']),
        () => {
          renameSync(widget(root, 'a.js'), widget(root, 'renamed.js'));
        },
        ['./widgets/a.js'],
        ['./widgets/renamed.js'],
      ),
    'dev glob folder created': (root) =>
      expectDevFollows(
        root,
        globProject(root, "Object.keys(import.meta.glob(['./widgets/*.js', './later/**/*.js']))", ['a.js']),
        () => write(join(root, 'app', 'later', 'deep', 'first.js'), 'export default 1;'),
        ['./widgets/a.js'],
        ['./later/deep/first.js', './widgets/a.js'],
      ),
    'dev watcher glob gains a file': (root) =>
      expectDevFollows(
        root,
        globProject(root, "Object.keys(import.meta.glob('./widgets/*.js'))", ['a.js']),
        () => write(widget(root, 'b.js'), 'export default "b.js";'),
        ['./widgets/a.js'],
        ['./widgets/a.js', './widgets/b.js'],
        true,
      ),
    'build watch glob gains a file': expectBuildWatchFollows,
    'dev recursive glob gains a file in a linked folder': (root) => expectDevFollowsLink(root),
    'dev watcher recursive glob gains a file in a linked folder': (root) => expectDevFollowsLink(root, true),
    'dev bare package link retargeted': (root) => expectDevFollowsPackageLink(root),
    'dev watcher bare package link retargeted': (root) => expectDevFollowsPackageLink(root, true),
    'build watch bare package link retargeted': (root) => {
      const { pluginOptions, retarget } = packageLinkProject(root);
      return expectBuildWatchSees(root, pluginOptions, retarget, foundIn, 'v1', 'v2');
    },
    'dev worker glob gains a file': (root) => expectDevFollowsWorkerGlob(root),
    'dev watcher worker glob gains a file': (root) => expectDevFollowsWorkerGlob(root, true),
    'build watch worker glob gains a file': (root) => {
      const { pluginOptions, add } = workerProject(root);
      return expectBuildWatchSees(root, pluginOptions, add, workerFound, ['a'], ['a', 'b']);
    },
    'dev URL worker glob gains a file': expectDevFollowsUrlWorkerGlob,
    'build watch separate entry worker glob gains a file': (root) => {
      const { pluginOptions, add } = workerProject(root);
      return expectBuildWatchSees(root, pluginOptions, add, workerFound, ['a'], ['a', 'b'], true);
    },
    'build watch separate entry bare package link retargeted': (root) => {
      const { pluginOptions, retarget } = packageLinkProject(root);
      return expectBuildWatchSees(root, pluginOptions, retarget, foundIn, 'v1', 'v2', true);
    },
  },
  // The watcher of Vite 8.0 and 8.1 reports no change inside a folder the build registers.
  {
    skip: (variant) => {
      if (variant.startsWith('build watch') && variant.endsWith('link retargeted') && process.platform !== 'linux') {
        // The bundler's watcher on macOS reports no replacement of a link (docs/plugins.md, Build watch).
        return 'Linux only';
      }
      // A folder registered with it (a glob's, a linked package folder) reports nothing under Vite 8.0 and 8.1.
      return variant.startsWith('build watch') && /^8\.[01]\./.test(version) ? 'Vite 8.0/8.1' : undefined;
    },
  },
);

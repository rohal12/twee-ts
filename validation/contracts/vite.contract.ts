/**
 * What the compiler and the Vite plugin put into a story format's page, and the plugin's entry
 * builds, as the build in dist/ does them. Matrix groups HEAD, VITE and DEPS (see cases.ts).
 */
import { readFileSync, renameSync, unlinkSync } from 'node:fs';
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
    const read = async (): Promise<unknown> => foundIn(await (await fetch(String(url))).text());
    expect(await read()).toEqual(before);
    change();
    if (watcher) await expect.poll(read, { timeout: 20_000, interval: 100 }).toEqual(after);
    else expect(await read(), 'the story kept the files the glob selected before').toEqual(after);
  } finally {
    await server.close();
  }
}

/** Expects `vite build --watch` to build the story again with the file a glob gains. */
async function expectBuildWatchFollows(root: string): Promise<void> {
  const pluginOptions = globProject(root, "Object.keys(import.meta.glob('./widgets/*.js'))", ['a.js']);
  const started: unknown = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [tweeTsPlugin({ ...pluginOptions, outputFilename: 'story.html' })],
    build: { watch: {}, outDir: join(root, 'out') },
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
    const found = (): unknown => foundIn(readFileSync(join(root, 'out', 'story.html'), 'utf-8'));
    await expect.poll(() => ended.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(found()).toEqual(['./widgets/a.js']);
    write(join(root, 'app', 'widgets', 'b.js'), 'export default "b";');
    await expect.poll(found, { timeout: 20_000, interval: 100 }).toEqual(['./widgets/a.js', './widgets/b.js']);
  } finally {
    await watcher.close();
  }
}

const widget = (root: string, name: string): string => join(root, 'app', 'widgets', name);

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
  },
  // The watcher of Vite 8.0 and 8.1 reports no change inside a folder the build registers.
  {
    skip: (variant) =>
      variant === 'build watch glob gains a file' && /^8\.[01]\./.test(version) ? 'Vite 8.0/8.1' : undefined,
  },
);

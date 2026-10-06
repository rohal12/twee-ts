/**
 * What the compiler and the Vite plugin put into a story format's page, and the plugin's entry
 * builds, as the build in dist/ does them. Matrix groups HEAD and VITE (see cases.ts).
 */
import { join } from 'node:path';
import { build } from 'vite';
import type { InlineConfig, Plugin } from 'vite';
import { expect } from 'vitest';
import { compile } from '@rohal12/twee-ts';
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

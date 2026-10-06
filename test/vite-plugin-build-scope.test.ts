/**
 * The plugin takes part in the user's build without taking it over (RC3): it
 * builds the story in the client environment only (D6), leaves the user's own
 * inputs and outputs alone and refuses to write over them (D7), and each
 * instance carries its own entry and state (D5).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vite from 'vite';
import type { InlineConfig, Plugin } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  buildFiles,
  cleanUp,
  COMPILE,
  makeProject,
  runEntry,
  startServer,
  storyWith,
  textOf,
  writeFiles,
  userScript,
} from './helpers/plugins.js';

afterEach(cleanUp);

const LANDING =
  '<!doctype html><html><head></head><body>LANDING<script type="module" src="./land.js"></script></body></html>';

/** A project with two stories, two entries and a landing page of the user's own. */
function twoStories(): string {
  return makeProject({
    'a/start.tw': storyWith('Story A'),
    'b/start.tw': storyWith('Story B'),
    'appA/main.js': "out.who = 'ENTRY-A';\n",
    'appB/main.js': "out.who = 'ENTRY-B';\n",
    'index.html': LANDING,
    'land.js': "globalThis.landing = 'LAND';\n",
  });
}

function storyPlugin(dir: string, name: 'a' | 'b', extra: Record<string, unknown> = {}) {
  return tweeTsPlugin({
    sources: [join(dir, name)],
    format: 'test-format-1',
    outputFilename: `${name}.html`,
    compileOptions: COMPILE,
    ...extra,
  });
}

const entryOf = (dir: string, name: 'a' | 'b') => ({ entry: join(dir, `app${name.toUpperCase()}`, 'main.js') });

type BundlerInput = NonNullable<NonNullable<NonNullable<InlineConfig['build']>['rolldownOptions']>['input']>;

/** The input setting naming the user's own page. */
function landingInput(dir: string, input: BundlerInput = join(dir, 'index.html')): NonNullable<InlineConfig['build']> {
  return { rolldownOptions: { input } };
}

describe('vite plugin: several instances in one build (D5)', () => {
  it('writes each story, and leaves the page of the user’s own input alone', async () => {
    const dir = twoStories();
    const files = await buildFiles({
      root: dir,
      build: landingInput(dir),
      plugins: [storyPlugin(dir, 'a'), storyPlugin(dir, 'b')],
    });
    expect(textOf(files.get('a.html'))).toContain('Story A');
    expect(textOf(files.get('b.html'))).toContain('Story B');
    expect(textOf(files.get('index.html'))).toContain('LANDING');
  });

  it('bundles each instance’s own entry into its own story', async () => {
    const dir = twoStories();
    for (const withInput of [false, true]) {
      const files = await buildFiles({
        root: dir,
        ...(withInput ? { build: landingInput(dir) } : {}),
        plugins: [storyPlugin(dir, 'a', entryOf(dir, 'a')), storyPlugin(dir, 'b', entryOf(dir, 'b'))],
      });
      expect(runEntry(userScript(textOf(files.get('a.html'))))).toEqual({ who: 'ENTRY-A' });
      expect(runEntry(userScript(textOf(files.get('b.html'))))).toEqual({ who: 'ENTRY-B' });
      expect(files.has('twee-ts-entry.js')).toBe(false);
      // With an input of its own, the user's page is still there.
      expect(textOf(files.get('index.html')).includes('LANDING')).toBe(withInput);
    }
  });

  it('serves each instance’s story with its own entry in dev', async () => {
    const dir = twoStories();
    const { url } = await startServer({
      root: dir,
      plugins: [storyPlugin(dir, 'a', entryOf(dir, 'a')), storyPlugin(dir, 'b', entryOf(dir, 'b'))],
    });
    for (const name of ['a', 'b'] as const) {
      const html = await (await fetch(`${url}/${name}.html`)).text();
      expect(html).toContain(`Story ${name.toUpperCase()}`);
      expect(runEntry(userScript(html))).toEqual({ who: `ENTRY-${name.toUpperCase()}` });
    }
  });

  it('fails when two instances write the same file', async () => {
    const dir = twoStories();
    await expect(
      buildFiles({
        root: dir,
        plugins: [
          storyPlugin(dir, 'a', { outputFilename: 'story.html' }),
          storyPlugin(dir, 'b', { outputFilename: 'story.html' }),
        ],
      }),
    ).rejects.toThrow(/already writes a file named story\.html/);
  });
});

describe('vite plugin: the user’s own inputs and outputs (D7)', () => {
  it('fails, naming the file, when the user’s input writes the story’s file name', async () => {
    const dir = twoStories();
    await expect(
      buildFiles({
        root: dir,
        build: landingInput(dir),
        plugins: [storyPlugin(dir, 'a', { outputFilename: 'index.html' })],
      }),
    ).rejects.toThrow(/already writes a file named index\.html .*set the plugin's outputFilename to another name/s);
  });

  it('fails the same with an entry, instead of dropping the user’s page', async () => {
    const dir = twoStories();
    await expect(
      buildFiles({
        root: dir,
        build: landingInput(dir),
        plugins: [storyPlugin(dir, 'a', { outputFilename: 'index.html', ...entryOf(dir, 'a') })],
      }),
    ).rejects.toThrow(/already writes a file named index\.html/);
  });

  it('keeps the user’s input whatever its form, with an entry', async () => {
    const dir = twoStories();
    const page = join(dir, 'index.html');
    for (const input of [page, [page], { landing: page }]) {
      const files = await buildFiles({
        root: dir,
        build: landingInput(dir, input),
        plugins: [storyPlugin(dir, 'a', entryOf(dir, 'a'))],
      });
      expect(textOf(files.get('index.html'))).toContain('LANDING');
      expect([...files.keys()].some((name) => name.endsWith('.js') && textOf(files.get(name)).includes('LAND'))).toBe(
        true,
      );
      expect(runEntry(userScript(textOf(files.get('a.html'))))).toEqual({ who: 'ENTRY-A' });
    }
  });

  it('keeps the top-level input of the Vite 8 releases that have one', async (context) => {
    const dir = twoStories();
    // Not every Vite 8 release has the top-level `input` option (set without types for that
    // reason); a build without the plugin tells whether this one reads it.
    const config: InlineConfig = { root: dir };
    writeFiles(dir, { 'page.html': LANDING });
    Reflect.set(config, 'input', join(dir, 'page.html'));
    if (!(await buildFiles(config)).has('page.html')) context.skip();
    const files = await buildFiles({ ...config, plugins: [storyPlugin(dir, 'a')] });
    expect(textOf(files.get('page.html'))).toContain('LANDING');
    expect(textOf(files.get('a.html'))).toContain('Story A');
  });

  it('writes the story with its entry into every output of an output array', async () => {
    const dir = twoStories();
    await vite.build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      build: { rolldownOptions: { output: [{ dir: join(dir, 'one') }, { dir: join(dir, 'two') }] } },
      plugins: [storyPlugin(dir, 'a', entryOf(dir, 'a'))],
    });
    for (const out of ['one', 'two']) {
      expect(runEntry(userScript(readFileSync(join(dir, out, 'a.html'), 'utf-8')))).toEqual({ who: 'ENTRY-A' });
    }
  });

  it('fails, naming the file, when the entry emits a file the build already writes', async () => {
    const dir = makeProject({
      'a/start.tw': storyWith('Story A'),
      'appA/main.js': "import k from './keep.png?no-inline';\nout.k = k;\n",
      'appA/keep.png': new Uint8Array(16),
      'index.html': LANDING,
      'land.js': '',
    });
    const emitsKeep: Plugin = {
      name: 'emits-keep',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'keep.png', source: 'other' });
      },
    };
    await expect(
      buildFiles({
        root: dir,
        build: landingInput(dir),
        plugins: [emitsKeep, storyPlugin(dir, 'a', entryOf(dir, 'a'))],
      }),
    ).rejects.toThrow(/the entry emits keep\.png, a file the build already writes/);
  });
});

describe('vite plugin: environments (D6)', () => {
  it('builds the story in the client environment only, once', async () => {
    const dir = makeProject({
      'a/start.tw': storyWith('Story A'),
      'server.js': 'export const handler = () => "ssr";\n',
    });
    let compiles = 0;
    const plugin = storyPlugin(dir, 'a');
    // Runs after the story is emitted: a post hook of a later plugin.
    const counting: Plugin = {
      name: 'count-story',
      generateBundle: {
        order: 'post',
        handler: (_options, bundle) => void (compiles += 'a.html' in bundle ? 1 : 0),
      },
    };
    const builder = await vite.createBuilder({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [plugin, counting],
      environments: {
        client: {},
        ssr: { build: { outDir: join(dir, 'dist', 'server'), rolldownOptions: { input: join(dir, 'server.js') } } },
      },
      builder: {},
    });
    await builder.buildApp();
    expect(existsSync(join(dir, 'dist', 'a.html'))).toBe(true);
    expect(readdirSync(join(dir, 'dist', 'server'))).not.toContain('a.html');
    expect(compiles).toBe(1);
  });

  it('builds no story in an SSR build', async () => {
    const dir = makeProject({
      'a/start.tw': storyWith('Story A'),
      'server.js': 'export const handler = () => "ssr";\n',
    });
    const files = await buildFiles({
      root: dir,
      build: { ssr: join(dir, 'server.js') },
      plugins: [storyPlugin(dir, 'a')],
    });
    expect(files.has('a.html')).toBe(false);
  });
});

describe('vite plugin: an entry bundled by a build of its own', () => {
  it('writes the files the entry still emits next to the story, beside the user’s own page', async () => {
    const dir = makeProject({
      'a/start.tw': storyWith('Story A'),
      'appA/main.js': "import k from './keep.png?no-inline';\nout.k = k;\n",
      'appA/keep.png': new Uint8Array(16).fill(5),
      'index.html': LANDING,
      'land.js': '',
    });
    const files = await buildFiles({
      root: dir,
      build: landingInput(dir),
      plugins: [storyPlugin(dir, 'a', entryOf(dir, 'a'))],
    });
    expect(runEntry(userScript(textOf(files.get('a.html'))))).toEqual({ k: '/keep.png' });
    expect(new Uint8Array(Buffer.from(files.get('keep.png') ?? ''))).toEqual(new Uint8Array(16).fill(5));
    expect(textOf(files.get('index.html'))).toContain('LANDING');
  });

  it('fails the build, naming the entry’s error', async () => {
    const dir = makeProject({
      'a/start.tw': storyWith('Story A'),
      'appA/main.js': 'const = ;\n',
      'index.html': LANDING,
      'land.js': '',
    });
    await expect(
      buildFiles({ root: dir, build: landingInput(dir), plugins: [storyPlugin(dir, 'a', entryOf(dir, 'a'))] }),
    ).rejects.toThrow(/main\.js/);
  });
});

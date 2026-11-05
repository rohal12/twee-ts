/**
 * Two things between story instances and story scripts of a Vite build: the entry must run after a story
 * script that ends without a semicolon (#334), and two instances' entries may not emit different files under one
 * name without the dev server saying so (#335).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import type { InlineConfig } from 'vite';
import { runInNewContext } from 'node:vm';
import { createLogger } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  COMPILE,
  STORY,
  buildFiles,
  cleanUp,
  makeProject,
  startServer,
  textOf,
  userScript,
} from './helpers/plugins.js';

afterEach(cleanUp);

const FILES = {
  'story/start.tw': STORY,
  'story/setup.js': 'globalThis.storySetting = 1',
  'story/later.js': 'globalThis.later = 2',
  'entry.js': 'globalThis.entryRan = true;',
  'extra.js': 'globalThis.extra = 1;',
};

const BRANCHES = ['inside the build', 'a build of its own', 'the dev server'] as const;

describe('the entry after a story script without a final semicolon (#334)', () => {
  it.each(BRANCHES)('runs the script and the entry: %s', async (branch) => {
    const dir = makeProject(FILES);
    const common: InlineConfig = {
      root: dir,
      publicDir: false,
      build: { minify: false },
      plugins: [
        tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'test-format-1',
          entry: join(dir, 'entry.js'),
          compileOptions: COMPILE,
        }),
      ],
    };
    let html: string;
    if (branch === 'the dev server') {
      const { url } = await startServer({ ...common, server: { watch: null } });
      html = await (await fetch(`${url}/index.html`)).text();
    } else {
      const files = await buildFiles({
        ...common,
        build: branch === 'a build of its own' ? { rolldownOptions: { input: join(dir, 'extra.js') } } : {},
      });
      html = textOf(files.get('index.html'));
    }
    const globals: Record<string, unknown> = {};
    runInNewContext(userScript(html), {
      globalThis: globals,
      document: { URL: 'http://localhost/', baseURI: 'http://localhost/' },
      window: {},
    });
    expect([globals['storySetting'], globals['later'], globals['entryRan']]).toEqual([1, 2, true]);
  });
});

it('escapes terminal controls in dev-server story collision logs (#458)', async () => {
  const dir = makeProject(FILES);
  const errors: string[] = [];
  const filename = '雪\u009b31m.html';
  const options = {
    sources: [join(dir, 'story')],
    format: 'test-format-1',
    outputFilename: filename,
    compileOptions: COMPILE,
  };
  const { url } = await startServer({
    root: dir,
    server: { watch: null },
    customLogger: { ...createLogger('silent'), error: (message) => errors.push(message) },
    plugins: [tweeTsPlugin(options), tweeTsPlugin(options)],
  });
  expect((await fetch(`${url}/${encodeURIComponent(filename)}`)).status).toBe(500);
  expect(errors.join('')).toContain('more than one generated file');
  expect(errors.join('')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
});

describe('two instances emitting one file name in the dev server (#335)', () => {
  const instance = (dir: string, name: string): ReturnType<typeof tweeTsPlugin> =>
    tweeTsPlugin({
      sources: [join(dir, name)],
      format: 'test-format-1',
      entry: join(dir, `${name}.js`),
      outputFilename: `${name}.html`,
      compileOptions: COMPILE,
    });
  const project = (a: string, b: string): string =>
    makeProject({
      'a/start.tw': STORY,
      'b/start.tw': STORY.replace(/[0-9A-F-]{36}/, 'D674C58C-DEFA-4F70-B7A2-27742230C0FD'),
      'a.js': "import url from './a/message.txt?url&no-inline'; globalThis.u = url;",
      'b.js': "import url from './b/message.txt?url&no-inline'; globalThis.u = url;",
      'a/message.txt': a,
      'b/message.txt': b,
    });

  it.each([
    ['a then b', ['a', 'b']],
    ['b then a', ['b', 'a']],
  ] as const)('reports different bytes under one name, whatever the order: %s', async (_name, order) => {
    const dir = project('story-A', 'story-B');
    const { url } = await startServer({
      root: dir,
      publicDir: false,
      server: { watch: null },
      plugins: order.map((name) => instance(dir, name)),
    });
    const response = await fetch(`${url}/message.txt`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('message.txt');
  });

  it('serves a name both instances emit with the same bytes', async () => {
    const dir = project('same', 'same');
    const { url } = await startServer({
      root: dir,
      publicDir: false,
      server: { watch: null },
      plugins: [instance(dir, 'a'), instance(dir, 'b')],
    });
    const response = await fetch(`${url}/message.txt`);
    expect(await response.text()).toBe('same');
  });
});

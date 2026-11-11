import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { cleanUp, COMPILE, makeProject, startServer, STORY, writeFiles } from './helpers/plugins.js';

afterEach(cleanUp);

const BASE = '<base href="https://elsewhere.invalid/">';
const IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
const STYLE = 'body { background-image: url("./image.svg?no-inline"); }';
const DIAGNOSTIC = 'a document base element with relative entry stylesheet URLs is unsupported';

const project = (head = '', style = STYLE): string =>
  makeProject({
    'story.tw': STORY,
    'head.html': head,
    'entry.js': 'import "./style.css";',
    'style.css': style,
    'image.svg': IMAGE,
  });

async function start(root: string, watcher = false) {
  const logger = createLogger('silent');
  const errors = vi.spyOn(logger, 'error');
  const dev = await startServer({
    root,
    publicDir: false,
    customLogger: logger,
    server: watcher ? {} : { watch: null },
    plugins: [
      tweeTsPlugin({
        sources: [join(root, 'story.tw')],
        entry: join(root, 'entry.js'),
        format: 'test-format-1',
        compileOptions: { ...COMPILE, headFile: join(root, 'head.html') },
      }),
    ],
  });
  return { ...dev, errors, send: vi.spyOn(dev.server.ws, 'send') };
}

const page = async (url: string): Promise<string> => (await fetch(url)).text();

describe('development entry stylesheet document bases (#555)', { timeout: 30_000 }, () => {
  it.each([
    { where: 'head file', value: 'url("./image.svg?no-inline")' },
    { where: 'head file', value: 'image-set("./image.svg?no-inline" 1x)' },
    { where: 'format template', value: 'url("./image.svg?no-inline")' },
  ])('rejects $value at startup with a base in the $where', async ({ where, value }) => {
    const root = project(where === 'head file' ? BASE : '', `body { background-image: ${value}; }`);
    const format = `window.storyFormat(${JSON.stringify({
      name: 'Base',
      version: '1.0.0',
      source: `<html><head>${BASE}</head><body>{{STORY_DATA}}</body></html>`,
    })});`;
    writeFiles(root, { 'formats/base/format.js': format });
    const logger = createLogger('silent');
    const errors = vi.spyOn(logger, 'error');
    const { url } = await startServer({
      root,
      publicDir: false,
      customLogger: logger,
      server: { watch: null },
      plugins: [
        tweeTsPlugin({
          sources: [join(root, 'story.tw')],
          entry: join(root, 'entry.js'),
          format: where === 'head file' ? 'test-format-1' : 'base',
          compileOptions: {
            ...COMPILE,
            formatPaths: [...COMPILE.formatPaths, join(root, 'formats')],
            headFile: join(root, 'head.html'),
          },
        }),
      ],
    });
    expect(await page(url)).toContain('The story has not compiled yet.');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(DIAGNOSTIC));
  });

  it.each([false, true])('retains the page and assets and recovers (watcher: %s)', async (watcher) => {
    const root = project();
    const { url, errors, send } = await start(root, watcher);
    const first = await page(url);
    expect(first).toContain('tw-storydata');

    writeFileSync(join(root, 'head.html'), BASE);
    if (!watcher) await page(url);
    await expect.poll(() => errors.mock.calls.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await page(url)).toBe(first);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(DIAGNOSTIC));
    expect(send).toHaveBeenCalledWith({
      type: 'error',
      err: expect.objectContaining({ message: expect.stringContaining(DIAGNOSTIC) }),
    });

    // A successful entry bundle must not replace assets belonging to the retained page.
    writeFileSync(join(root, 'image.svg'), IMAGE.replace('width="1"', 'width="2"'));
    expect(await page(url)).toBe(first);
    expect(await page(`${url}/image.svg`)).toBe(IMAGE);

    writeFileSync(join(root, 'head.html'), '<base href="/elsewhere/">');
    const recovered = await page(url);
    expect(recovered).toContain('tw-storydata');
    expect(recovered).toContain('<base href="/elsewhere/">');
    expect(await page(`${url}/image.svg`)).toBe(IMAGE.replace('width="1"', 'width="2"'));
    expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '/index.html' });
  });

  it('recovers from an invalid initial document base', async () => {
    const root = project(BASE);
    const { url, errors, send } = await start(root);
    expect(await page(url)).toContain('The story has not compiled yet.');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(DIAGNOSTIC));
    writeFileSync(join(root, 'head.html'), '');
    expect(await page(url)).toContain('tw-storydata');
    expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '/index.html' });
  });

  it.each([
    { name: 'same-origin base', head: '<base href="/elsewhere/">', style: STYLE },
    { name: 'full URL', head: BASE, style: 'body { background: url("https://cdn.invalid/image.svg"); }' },
    { name: 'data URL', head: BASE, style: 'body { background: url("data:image/svg+xml;base64,PHN2Zy8+"); }' },
    { name: 'inlined asset', head: BASE, style: STYLE.replace('?no-inline', '') },
    { name: 'no entry stylesheet', head: BASE, style: '' },
  ])('accepts the $name control', async ({ head, style }) => {
    const { url, errors } = await start(project(head, style));
    expect(await page(url)).toContain('tw-storydata');
    expect(errors).not.toHaveBeenCalled();
  });
});

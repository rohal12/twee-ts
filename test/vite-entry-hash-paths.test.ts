/** Literal hashes belong to physical module paths, including their glob importers (#548). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { cleanUp, COMPILE, makeProject, SETTLED, startBuildWatch, startServer, STORY } from './helpers/plugins.js';
import { build } from 'vite';

afterEach(cleanUp);

const PATHS = ['dependency.js', 'dependency#chapter.js', 'chapter#one/dependency.js', 'chapter#one/dependency#two.js'];

function project(path: string): string {
  return makeProject({
    'story.tw': STORY,
    'outer.js': 'globalThis.outer = true;',
    'entry.js': `import { value } from './${path}'; globalThis.value = value;`,
    [path]: 'export const value = "FIRST_VALUE";',
  });
}

function plugin(dir: string) {
  return tweeTsPlugin({
    sources: [join(dir, 'story.tw')],
    entry: join(dir, 'entry.js'),
    format: 'test-format-1',
    outputFilename: 'story.html',
    compileOptions: COMPILE,
  });
}

describe.each([false, true])('literal hash module paths, dev watcher %s', (watcher) => {
  it.each(PATHS)('refreshes after an edit to %s', async (path) => {
    const dir = project(path);
    const { server, url } = await startServer({
      root: dir,
      server: { ...(watcher ? {} : { watch: null }) },
      plugins: [plugin(dir)],
    });
    const read = async (): Promise<string> => (await fetch(`${url}/story.html`)).text();
    expect(await read()).toContain('FIRST_VALUE');
    const reloaded: string[] = [];
    const send = server.ws.send.bind(server.ws);
    vi.spyOn(server.ws, 'send').mockImplementation((payload: unknown, ...args: unknown[]) => {
      if (typeof payload === 'object' && payload !== null && 'type' in payload && payload.type === 'full-reload') {
        reloaded.push(payload.type);
      }
      Reflect.apply(send, server.ws, [payload, ...args]);
    });
    writeFileSync(join(dir, path), 'export const value = "SECOND_VALUE";');
    if (watcher) {
      await vi.waitFor(() => {
        if (!reloaded.includes('full-reload')) throw new Error('the watcher has not reloaded the story');
      }, SETTLED);
    }
    await expect.poll(read, SETTLED).toContain('SECOND_VALUE');
  });
});

describe.each([false, true])('literal hash inputs, separate entry build %s', (separate) => {
  it.each(['raw', 'url'])('keeps ordinary ?%s input protection working', async (query) => {
    const dir = makeProject({
      'story.tw': STORY,
      'entry.js': `import value from './input.txt?${query}'; globalThis.value = value;`,
      'input.txt': 'authored query input',
      'outer.js': 'globalThis.outer = true;',
    });
    linkSync(join(dir, 'input.txt'), join(dir, 'story.html'));
    await expect(
      build({
        root: dir,
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: dir,
          emptyOutDir: false,
          ...(separate ? { rolldownOptions: { input: join(dir, 'outer.js') } } : {}),
        },
        plugins: [plugin(dir)],
      }),
    ).rejects.toThrow('Output file cannot be an input source');
    expect(readFileSync(join(dir, 'input.txt'), 'utf8')).toBe('authored query input');
  });

  it.each(PATHS)('protects an output hard link to %s', async (path) => {
    const dir = project(path);
    linkSync(join(dir, path), join(dir, 'story.html'));
    await expect(
      build({
        root: dir,
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: dir,
          emptyOutDir: false,
          ...(separate ? { rolldownOptions: { input: join(dir, 'outer.js') } } : {}),
        },
        plugins: [plugin(dir)],
      }),
    ).rejects.toThrow('Output file cannot be an input source');
    expect(readFileSync(join(dir, path), 'utf8')).toBe('export const value = "FIRST_VALUE";');
  });

  it('rebuilds after a literal-hash dependency changes', async () => {
    const path = 'chapter#one/dependency#two.js';
    const dir = project(path);
    await startBuildWatch({
      root: dir,
      build: {
        outDir: join(dir, 'out'),
        ...(separate ? { rolldownOptions: { input: join(dir, 'outer.js') } } : {}),
      },
      plugins: [plugin(dir)],
    });
    expect(readFileSync(join(dir, 'out/story.html'), 'utf8')).toContain('FIRST_VALUE');
    writeFileSync(join(dir, path), 'export const value = "SECOND_VALUE";');
    await vi.waitFor(() => {
      expect(readFileSync(join(dir, 'out/story.html'), 'utf8')).toContain('SECOND_VALUE');
    }, SETTLED);
  });
});

it('tracks new glob matches relative to a hash-containing importer directory', async () => {
  const dir = project('chapter#one/dependency.js');
  writeFileSync(
    join(dir, 'chapter#one/dependency.js'),
    'export const value = Object.keys(import.meta.glob("./*.txt")).sort();',
  );
  const { url } = await startServer({ root: dir, server: { watch: null }, plugins: [plugin(dir)] });
  const read = async (): Promise<string> => (await fetch(`${url}/story.html`)).text();
  expect(await read()).not.toContain('new-match.txt');
  writeFileSync(join(dir, 'chapter#one/new-match.txt'), 'new glob input');
  await expect.poll(read, SETTLED).toContain('new-match.txt');
});

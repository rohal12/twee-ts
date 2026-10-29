/** Generated stories must preserve the outer bundler's authored inputs (#547). */
import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { rollup } from 'rollup';
import { build } from 'vite';
import { tweeTsPlugin as rollupStory } from '../src/plugins/rollup.js';
import { tweeTsPlugin as viteStory } from '../src/plugins/vite.js';
import { cleanUp, COMPILE, makeProject, STORY } from './helpers/plugins.js';

afterEach(cleanUp);

const FILES = {
  'story.tw': STORY,
  'outer.js': 'import { value } from "./dependency.js"; import "./unused.js"; globalThis.value = value;',
  'dependency.js': 'export const value = "AUTHORED";',
  'unused.js': 'export const unused = 123;',
  'watched.txt': 'authored watch input',
  'rendered.txt': 'authored render input',
  'generated.txt': 'authored late input',
  'entry.js': 'globalThis.storyEntry = true;',
};

describe.each(['rollup', 'rollup in vite', 'vite', 'vite with entry'] as const)(
  'outer input protection: %s',
  (bundler) => {
    async function run(
      dir: string,
      outputFilename: string,
      outDir = dir,
      watchedFile = 'watched.txt',
      outputPlugin = false,
    ): Promise<unknown> {
      const options = {
        sources: [join(dir, 'story.tw')],
        outputFilename,
        compileOptions: { ...COMPILE, outputMode: 'twee3' as const },
      };
      const watchInput = {
        name: 'outer-input-reader',
        buildStart(this: { addWatchFile(file: string): void }) {
          this.addWatchFile(join(dir, watchedFile));
        },
        renderStart(this: { addWatchFile(file: string): void }) {
          this.addWatchFile(join(dir, 'rendered.txt'));
        },
      };
      const lateReader = Object.freeze({
        name: 'late-input-reader',
        generateBundle: {
          order: 'post' as const,
          handler(this: { addWatchFile(file: string): void }) {
            this.addWatchFile(join(dir, 'generated.txt'));
            readFileSync(join(dir, 'generated.txt'), 'utf8');
          },
        },
      });
      const readers = [watchInput, ...(outputPlugin ? [] : [lateReader])];
      const outputPlugins = outputPlugin ? [lateReader] : [];
      if (bundler === 'rollup') {
        const bundle = await rollup({ input: join(dir, 'outer.js'), plugins: [rollupStory(options), ...readers] });
        try {
          return await bundle.write({ dir: outDir, entryFileNames: 'bundle.js', format: 'es', plugins: outputPlugins });
        } finally {
          await bundle.close();
        }
      }
      return build({
        root: dir,
        configFile: false,
        publicDir: false,
        logLevel: 'silent',
        build: {
          outDir,
          emptyOutDir: false,
          rolldownOptions: { input: join(dir, 'outer.js'), output: { plugins: outputPlugins } },
        },
        plugins: [
          bundler === 'rollup in vite'
            ? rollupStory(options)
            : viteStory({ ...options, ...(bundler === 'vite with entry' ? { entry: join(dir, 'entry.js') } : {}) }),
          ...readers,
        ],
      });
    }

    it.each(['outer.js', 'dependency.js', 'unused.js', 'watched.txt', 'rendered.txt', 'generated.txt'])(
      'rejects story output over %s and preserves all inputs',
      async (victim) => {
        const dir = makeProject(FILES);
        await expect(run(dir, victim)).rejects.toThrow('Output file cannot be an input source');
        expect(
          Object.fromEntries(Object.keys(FILES).map((file) => [file, readFileSync(join(dir, file), 'utf8')])),
        ).toEqual(FILES);
      },
    );

    it('protects inputs read by an output plugin after the story is emitted', async () => {
      const dir = makeProject(FILES);
      await expect(run(dir, 'generated.txt', dir, 'watched.txt', true)).rejects.toThrow(
        'Output file cannot be an input source',
      );
      expect(readFileSync(join(dir, 'generated.txt'), 'utf8')).toBe(FILES['generated.txt']);
    });

    it.each(['hard link', 'directory link'] as const)('protects outer inputs through a %s', async (kind) => {
      const dir = makeProject(FILES);
      const outDir = join(dir, 'output');
      let name = 'story.html';
      if (kind === 'hard link') {
        mkdirSync(outDir);
        linkSync(join(dir, 'dependency.js'), join(outDir, name));
      } else {
        symlinkSync(dir, outDir, 'junction');
        name = 'dependency.js';
      }
      await expect(run(dir, name, outDir)).rejects.toThrow('Output file cannot be an input source');
      expect(readFileSync(join(dir, 'dependency.js'), 'utf8')).toBe(FILES['dependency.js']);
    });

    it('preserves hash characters in raw outer watch paths', async () => {
      const dir = makeProject({ ...FILES, 'watched#input.txt': 'literal hash watch input' });
      // The watch path can use a hash even though outputFilename must be URL-portable.
      linkSync(join(dir, 'watched#input.txt'), join(dir, 'story.html'));
      await expect(run(dir, 'story.html', dir, 'watched#input.txt')).rejects.toThrow(
        'Output file cannot be an input source',
      );
      expect(readFileSync(join(dir, 'watched#input.txt'), 'utf8')).toBe('literal hash watch input');
    });

    it('allows repeated nonoverlapping story writes', async () => {
      const dir = makeProject(FILES);
      await run(dir, 'story.html');
      await run(dir, 'story.html');
      expect(readFileSync(join(dir, 'story.html'), 'utf8')).toContain('Hello from the story.');
    });
  },
);

it('keeps a custom Rollup filesystem when protecting story writes', async () => {
  const dir = makeProject(FILES);
  const writes: string[] = [];
  const storyWritten = Promise.withResolvers<undefined>();
  let directories = 0;
  const io = Object.freeze({
    ...fs,
    async mkdir(path: string, options?: { recursive?: boolean; mode?: string | number }): Promise<void> {
      directories += 1;
      // Let the story finish before the chunk's write starts, while Rollup still owns neither output.
      if (directories === 1) await storyWritten.promise;
      await fs.mkdir(path, options);
    },
    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      writes.push(path);
      await fs.writeFile(path, data);
      if (path === join(dir, 'index.html')) storyWritten.resolve(undefined);
    },
  });
  const config = {
    input: join(dir, 'outer.js'),
    plugins: [
      rollupStory({ sources: [join(dir, 'story.tw')], compileOptions: { outputMode: 'twee3' } }),
      {
        name: 'directory-reader',
        buildStart(this: { addWatchFile(path: string): void }) {
          this.addWatchFile(dir);
        },
      },
    ],
  };
  // Node's current readFile overloads exceed Rollup's filesystem declaration; use its JavaScript config boundary.
  Reflect.set(config, 'fs', io);
  const bundle = await rollup(config);
  try {
    await bundle.write({ dir, entryFileNames: 'bundle.js', format: 'es' });
  } finally {
    storyWritten.resolve(undefined);
    await bundle.close();
  }
  expect(writes.sort()).toEqual([join(dir, 'bundle.js'), join(dir, 'index.html')].sort());
  expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('Hello from the story.');
});

it.each([false, true])('rejects a late Rollup overlap before concurrent writes, plugin IO %s', async (pluginIO) => {
  const dir = makeProject(FILES);
  const writes: string[] = [];
  const config = {
    input: join(dir, 'outer.js'),
    plugins: [
      rollupStory({
        sources: [join(dir, 'story.tw')],
        outputFilename: 'generated.txt',
        compileOptions: { outputMode: 'twee3' as const },
      }),
    ],
  };
  Reflect.set(config, 'fs', {
    ...fs,
    mkdir: () => Promise.resolve(),
    writeFile: (path: string): Promise<void> => {
      writes.push(path);
      return Promise.resolve();
    },
  });
  const bundle = await rollup(config);
  try {
    await expect(
      bundle.write({
        dir,
        entryFileNames: 'bundle.js',
        format: 'es',
        plugins: [
          {
            name: 'late-reader',
            generateBundle: {
              order: 'post',
              async handler() {
                if (pluginIO) {
                  await this.fs.mkdir(join(dir, 'cache'), { recursive: true });
                  await this.fs.writeFile(join(dir, 'cache', 'data'), 'cached data');
                }
                this.addWatchFile(join(dir, 'generated.txt'));
              },
            },
          },
        ],
      }),
    ).rejects.toThrow('Output file cannot be an input source');
  } finally {
    await bundle.close();
  }
  expect(writes).toEqual(pluginIO ? [join(dir, 'cache', 'data')] : []);
  expect(readFileSync(join(dir, 'generated.txt'), 'utf8')).toBe(FILES['generated.txt']);
});

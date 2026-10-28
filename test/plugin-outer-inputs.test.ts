/** Generated stories must preserve the outer bundler's authored inputs (#547). */
import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
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
  'entry.js': 'globalThis.storyEntry = true;',
};

describe.each(['rollup', 'vite', 'vite with entry'] as const)('outer input protection: %s', (bundler) => {
  async function run(dir: string, outputFilename: string, outDir = dir, watchedFile = 'watched.txt'): Promise<unknown> {
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
    if (bundler === 'rollup') {
      const bundle = await rollup({ input: join(dir, 'outer.js'), plugins: [watchInput, rollupStory(options)] });
      try {
        return await bundle.write({ dir: outDir, entryFileNames: 'bundle.js', format: 'es' });
      } finally {
        await bundle.close();
      }
    }
    return build({
      root: dir,
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: false, rolldownOptions: { input: join(dir, 'outer.js') } },
      plugins: [
        watchInput,
        viteStory({ ...options, ...(bundler === 'vite with entry' ? { entry: join(dir, 'entry.js') } : {}) }),
      ],
    });
  }

  it.each(['outer.js', 'dependency.js', 'unused.js', 'watched.txt', 'rendered.txt'])(
    'rejects story output over %s and preserves all inputs',
    async (victim) => {
      const dir = makeProject(FILES);
      await expect(run(dir, victim)).rejects.toThrow('Output file cannot be an input source');
      expect(
        Object.fromEntries(Object.keys(FILES).map((file) => [file, readFileSync(join(dir, file), 'utf8')])),
      ).toEqual(FILES);
    },
  );

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
});

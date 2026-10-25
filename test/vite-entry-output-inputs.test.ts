/** A story must never replace a file its entry read, in either bundling path (#525). */
import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import type { Plugin } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { cleanUp, COMPILE, makeProject, STORY, trackBuildWatch } from './helpers/plugins.js';

afterEach(cleanUp);

const FILES = {
  'story.tw': STORY,
  'entry.js': `import { value } from './dependency.js';
import './unused.js';
import './theme.css';
import image from './image.svg';
globalThis.value = [value, image];
globalThis.worker = new Worker(new URL('./worker.js', import.meta.url));`,
  'dependency.js': 'export const value = 42;',
  'unused.js': 'export const unused = 123;',
  'theme.css': '@import "./imported.css"; body { background: url("./background.svg"); }',
  'imported.css': 'body { color: red; }',
  'image.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'background.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="2"></svg>',
  'worker.js': 'import { value } from "./worker-dependency.js"; postMessage(value);',
  'worker-dependency.js': 'export const value = 7;',
  'watched.txt': 'plugin input',
  'rendered.txt': 'render input',
  'other.js': 'globalThis.other = true;',
};

function watchInput(dir: string): Plugin {
  return {
    name: 'read-extra-input',
    buildStart() {
      this.addWatchFile(join(dir, 'watched.txt'));
      this.addWatchFile(join(dir, 'watched#input.txt'));
    },
    renderStart() {
      this.addWatchFile(join(dir, 'rendered.txt'));
      readFileSync(join(dir, 'rendered.txt'), 'utf8');
    },
  };
}

describe.each(['inside the build', 'a separate build'] as const)('entry input protection: %s', (branch) => {
  async function run(dir: string, outputFilename: string, outDir = dir): Promise<unknown> {
    return build({
      configFile: false,
      root: dir,
      publicDir: false,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: false,
        ...(branch === 'a separate build' ? { rolldownOptions: { input: join(dir, 'other.js') } } : {}),
      },
      plugins: [
        watchInput(dir),
        tweeTsPlugin({
          sources: [join(dir, 'story.tw')],
          entry: join(dir, 'entry.js'),
          outputFilename,
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    });
  }

  it.each(Object.keys(FILES).filter((file) => file !== 'story.tw' && file !== 'other.js'))(
    'rejects story output over %s and preserves every input',
    async (victim) => {
      const dir = makeProject(FILES);
      await expect(run(dir, victim)).rejects.toThrow('Output file cannot be an input source');
      expect(
        Object.fromEntries(Object.keys(FILES).map((file) => [file, readFileSync(join(dir, file), 'utf8')])),
      ).toEqual(FILES);
    },
  );

  it.each(['hard link', 'directory link'] as const)('protects an input reached through a %s', async (kind) => {
    const dir = makeProject(FILES);
    let outDir: string;
    let name: string;
    if (kind === 'hard link') {
      outDir = join(dir, 'output');
      mkdirSync(outDir);
      name = 'story.html';
      linkSync(join(dir, 'dependency.js'), join(outDir, name));
    } else {
      outDir = join(dir, 'alias');
      symlinkSync(dir, outDir, 'junction');
      name = 'dependency.js';
    }
    await expect(run(dir, name, outDir)).rejects.toThrow('Output file cannot be an input source');
    expect(readFileSync(join(dir, 'dependency.js'), 'utf8')).toBe(FILES['dependency.js']);
    expect(readFileSync(join(outDir, name), 'utf8')).toBe(FILES['dependency.js']);
  });

  it('preserves literal hash characters in a watched filename through an output alias', async () => {
    const dir = makeProject({ ...FILES, 'watched#input.txt': 'literal hash input' });
    linkSync(join(dir, 'watched#input.txt'), join(dir, 'story.html'));
    await expect(run(dir, 'story.html')).rejects.toThrow('Output file cannot be an input source');
    expect(readFileSync(join(dir, 'watched#input.txt'), 'utf8')).toBe('literal hash input');
  });

  it('can replace the previous story without treating it as an entry input', async () => {
    const dir = makeProject(FILES);
    await run(dir, 'story.html');
    await run(dir, 'story.html');
    expect(readFileSync(join(dir, 'story.html'), 'utf8')).toContain('Hello from the story.');
    expect(readFileSync(join(dir, 'entry.js'), 'utf8')).toBe(FILES['entry.js']);
  });
});

describe('entry input protection across build-watch generations', () => {
  it.each(['module', 'plugin watch file'] as const)(
    'releases a removed %s before the next story write',
    { timeout: 30_000 },
    async (kind) => {
      const dir = makeProject({
        'story.tw': STORY,
        'entry.js': 'import "./former.js"; globalThis.value = 1;',
        'former.js': 'globalThis.former = true;',
        'side.txt': 'watch input',
      });
      const outDir = join(dir, 'output');
      mkdirSync(outDir);
      const victim = kind === 'module' ? 'former.js' : 'side.txt';
      linkSync(join(dir, victim), join(outDir, 'story.html'));
      const result = await build({
        configFile: false,
        root: dir,
        publicDir: false,
        logLevel: 'silent',
        build: { outDir, emptyOutDir: false, watch: {} },
        plugins: [
          {
            name: 'module-owned-watch',
            transform(code, id) {
              if (id.endsWith('/former.js')) this.addWatchFile(join(dir, 'side.txt'));
              return code;
            },
          },
          tweeTsPlugin({
            sources: [join(dir, 'story.tw')],
            entry: join(dir, 'entry.js'),
            outputFilename: 'story.html',
            format: 'test-format-1',
            compileOptions: COMPILE,
          }),
        ],
      });
      if (Array.isArray(result) || !('on' in result)) throw new Error('expected a build watcher');
      const watcher = trackBuildWatch(result);
      const outcomes: string[] = [];
      let ended = 0;
      await new Promise<void>((done, fail) => {
        result.on('event', (event) => {
          if (event.code === 'ERROR') outcomes.push(event.error.message);
          if (event.code === 'BUNDLE_END') outcomes.push('built');
          if (event.code !== 'END') return;
          ended++;
          if (ended === 1) writeFileSync(join(dir, 'entry.js'), 'globalThis.value = 2;');
          if (ended === 2) void watcher.close().then(done, fail);
        });
      });
      expect(outcomes).toEqual([expect.stringContaining('Output file cannot be an input source'), 'built']);
      expect(readFileSync(join(outDir, 'story.html'), 'utf8')).toContain('Hello from the story.');
    },
  );
});

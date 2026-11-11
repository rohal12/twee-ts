import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanUp, makeProject, STORY, COMPILE } from './helpers/plugins.js';

afterEach(cleanUp);

const api = pathToFileURL(join(import.meta.dirname, '../src/compiler.ts')).href;
const loader = pathToFileURL(join(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs')).href;

/** A real working directory is needed: discovery opens the display paths it produces. */
function run(cwd: string, code: string): unknown {
  const result = spawnSync(
    process.execPath,
    ['--import', loader, '--input-type=module', '-e', `import * as api from ${JSON.stringify(api)};\n${code}`],
    { cwd, encoding: 'utf8', timeout: 20_000 },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout, code).not.toBe('');
  return JSON.parse(result.stdout) as unknown;
}

describe.skipIf(process.platform === 'win32')('file symlink input names (#563)', () => {
  it.each(['txt', 'tw'])('loads named and discovered .tw links to a .%s target across cached builds', (extension) => {
    const root = makeProject({ [`project/source.${extension}`]: STORY });
    const project = join(root, 'project');
    mkdirSync(join(root, 'aliases'));
    symlinkSync(`../project/source.${extension}`, join(root, 'aliases/story.tw'));
    symlinkSync(`source.${extension}`, join(project, 'story.tw'));
    symlinkSync(project, join(root, 'project-alias'));
    const sources = ['story.tw', '../aliases/story.tw', '../aliases', '../project-alias/story.tw'];
    const results = run(
      project,
      `
      const results = [];
      for (const source of ${JSON.stringify(sources)}) {
        const options = { sources: [source], outputMode: 'json' };
        const cache = new Map();
        for (const result of [await api.compile(options),
          await api.compileIncremental(options, cache), await api.compileIncremental(options, cache)]) {
          results.push({ text: result.story.passages.find(p => p.name === 'Start')?.text,
            diagnostics: result.diagnostics });
        }
      }
      console.log(JSON.stringify(results));
    `,
    );
    expect(results).toEqual(
      Array.from({ length: sources.length * 3 }, () => ({
        text: 'Hello from the story.',
        diagnostics: [],
      })),
    );
  });

  it('keeps generated media names in cold, incremental and warm builds', () => {
    const root = makeProject({ 'project/real.png': 'image bytes' });
    mkdirSync(join(root, 'aliases'));
    symlinkSync('../project/real.png', join(root, 'aliases/cover.png'));
    const results = run(
      join(root, 'project'),
      `
      const results = [];
      for (const source of ['../aliases/cover.png', '../aliases']) {
        const options = { sources: [source], outputMode: 'json' };
        const cache = new Map();
        for (const result of [await api.compile(options),
          await api.compileIncremental(options, cache), await api.compileIncremental(options, cache)]) {
          results.push(result.story.passages.map(p => p.name));
        }
      }
      console.log(JSON.stringify(results));
    `,
    );
    expect(results).toEqual(Array.from({ length: 6 }, () => ['cover']));
  });

  it('loads named and discovered module aliases using their own extensions', () => {
    const root = makeProject({ 'project/module.txt': 'globalThis.ALIAS_MODULE = true;' });
    mkdirSync(join(root, 'aliases'));
    symlinkSync('../project/module.txt', join(root, 'aliases/module.js'));
    const results = run(
      join(root, 'project'),
      `
      const results = [];
      for (const module of ['../aliases/module.js', '../aliases']) {
        const result = await api.compile({ ...${JSON.stringify(COMPILE)}, formatId: 'test-format-1',
          sources: [{ filename: 'story.tw', content: ${JSON.stringify(STORY)} }], modules: [module] });
        results.push({ included: result.output.includes('globalThis.ALIAS_MODULE = true;'),
          diagnostics: result.diagnostics });
      }
      console.log(JSON.stringify(results));
    `,
    );
    expect(results).toEqual(Array.from({ length: 2 }, () => ({ included: true, diagnostics: [] })));
  });

  it.each(['html', 'twee3', 'twee1', 'twine2-archive', 'twine1-archive', 'json'])(
    'protects authored targets reached through a folder-discovered alias in %s output',
    (outputMode) => {
      const root = makeProject({ 'project/source.txt': STORY });
      mkdirSync(join(root, 'aliases'));
      symlinkSync('../project/source.txt', join(root, 'aliases/story.tw'));
      const result = run(
        join(root, 'project'),
        `
        import { readFileSync } from 'node:fs';
        let code;
        try {
          await api.compileToFile({ ...${JSON.stringify(COMPILE)}, formatId: 'test-format-1',
            sources: ['../aliases'], outputMode: ${JSON.stringify(outputMode)}, outFile: 'source.txt' });
        } catch (error) { code = error.code; }
        console.log(JSON.stringify({ code, bytes: readFileSync('source.txt', 'utf8') }));
      `,
      );
      expect(result).toEqual({ code: 'OUTPUT_IS_INPUT', bytes: STORY });
    },
  );
});

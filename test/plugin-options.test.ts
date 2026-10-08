/**
 * The options both bundler plugins take go through one resolver (D10, D11): the
 * same input is accepted or refused the same way by both, means the same, and
 * an output file name is a plain relative path that a build writes inside its
 * output folder and the dev server serves under the base URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { posix, win32 } from 'node:path';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rollup } from 'rollup';
import { TweeTsError } from '../src/compiler.js';
import { outputFilenameProblem, resolvePluginOptions } from '../src/plugins/options.js';
import { tweeTsPlugin as rollupPlugin } from '../src/plugins/rollup.js';
import { tweeTsPlugin as vitePlugin } from '../src/plugins/vite.js';
import { pathBelowBase, storyPaths } from '../src/plugins/vite-dev.js';
import { buildFiles, cleanUp, COMPILE, makeProject, STORY, textOf } from './helpers/plugins.js';

afterEach(cleanUp);

/** Calls a plugin factory with options of any shape, as a JavaScript caller may pass them. */
function callWith(factory: (options: never) => unknown, options: unknown): unknown {
  const plugin: unknown = Reflect.apply(factory, undefined, [options]);
  return plugin;
}

/** Each plugin's factory. */
const PLUGINS: readonly (readonly [string, (options: unknown) => unknown])[] = [
  ['vite', (options) => callWith(vitePlugin, options)],
  ['rollup', (options) => callWith(rollupPlugin, options)],
];

describe.each(PLUGINS)('%s plugin options', (kind, create) => {
  it.each([
    ['not an object', null, /the options must be an object/],
    ['an array', [], /the options must be an object/],
    ['a misspelt option', { sources: ['s'], outputFileName: 'x.html' }, /unknown option `outputFileName`/],
    ['no sources', {}, /`sources` must be an array of non-empty strings/],
    ['sources as a string', { sources: 'story' }, /`sources` must be an array/],
    ['an empty source', { sources: [''] }, /`sources` must be an array of non-empty strings/],
    ['a source that is no string', { sources: [1] }, /`sources` must be an array/],
    ['format as a number', { sources: ['s'], format: 2 }, /`format` must be a non-empty string/],
    ['an empty format', { sources: ['s'], format: '' }, /`format` must be a non-empty string/],
    [
      'outputFilename as a number',
      { sources: ['s'], outputFilename: 1 },
      /`outputFilename` must be a non-empty string/,
    ],
    ['compileOptions as an array', { sources: ['s'], compileOptions: [] }, /`compileOptions` must be an object/],
    [
      'compileOptions.sources',
      { sources: ['s'], compileOptions: { sources: ['other'] } },
      /`compileOptions.sources` is not accepted; set the plugin's `sources` option instead/,
    ],
    [
      'compileOptions.formatId',
      { sources: ['s'], compileOptions: { formatId: 'harlowe-3' } },
      /`compileOptions.formatId` is not accepted; set the plugin's `format` option instead/,
    ],
    ['exclude as a string', { sources: ['s'], compileOptions: { exclude: '*.png' } }, /`compileOptions.exclude`/],
    [
      'an exclude object without a glob',
      { sources: ['s'], compileOptions: { exclude: [{ base: 'p' }] } },
      /`compileOptions.exclude` must be an array of non-empty strings or `\{ base, glob \}` objects/,
    ],
    [
      'an exclude object with an empty base',
      { sources: ['s'], compileOptions: { exclude: [{ base: '', glob: '*.png' }] } },
      /`compileOptions.exclude`/,
    ],
    [
      'an exclude object with another key',
      { sources: ['s'], compileOptions: { exclude: [{ base: 'p', glob: '*.png', extra: 1 }] } },
      /`compileOptions.exclude`/,
    ],
    ['modules with a number', { sources: ['s'], compileOptions: { modules: [1] } }, /`compileOptions.modules`/],
    ['an empty headFile', { sources: ['s'], compileOptions: { headFile: '' } }, /`compileOptions.headFile`/],
  ])('refuses %s with a TweeTsError naming the option', (_case, options, message) => {
    expect(() => create(options)).toThrow(TweeTsError);
    expect(() => create(options)).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    expect(() => create(options)).toThrow(message);
    expect(() => create(options)).toThrow(`twee-ts ${kind} plugin:`);
  });

  it('refuses an output file name that is not a plain relative path', () => {
    expect(() => create({ sources: ['s'], outputFilename: '../index.html' })).toThrow(
      /`outputFilename` "..\/index.html" can't be used: it has a "." or ".." segment/,
    );
  });

  it('accepts mixed string and { base, glob } excludes, as loadConfigFile() returns them (#323)', () => {
    const options = {
      sources: ['s'],
      compileOptions: { exclude: ['**/*.png', { base: '/tmp/project[1]', glob: '**/draft.tw' }] },
    };
    expect(create(options)).toHaveProperty('name', 'twee-ts');
  });

  it('accepts the documented options', () => {
    const options = {
      sources: ['story'],
      format: 'sugarcube-2',
      outputFilename: 'game/index.html',
      compileOptions: { exclude: ['**/*.png'], modules: ['m.js'], headFile: 'head.html', trim: true },
    };
    expect(create(options)).toHaveProperty('name', 'twee-ts');
  });
});

describe('plugin options: excludes with a literal base (#323)', () => {
  it.each(['vite', 'rollup'] as const)('the %s plugin leaves out what an { base, glob } exclude matches', (kind) => {
    const base = mkdtempSync(join(tmpdir(), 'twee-ts-exclude-[1]-'));
    try {
      const resolved = resolvePluginOptions(kind, {
        sources: [base],
        compileOptions: { exclude: [{ base, glob: 'draft.tw' }] },
      });
      expect(resolved.excluded(join(base, 'draft.tw'))).toBe(true);
      expect(resolved.excluded(join(base, 'start.tw'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('plugin options: what only one plugin takes', () => {
  it('the Rollup plugin has no entry option', () => {
    expect(() => callWith(rollupPlugin, { sources: ['s'], entry: 'main.js' })).toThrow(/unknown option `entry`/);
  });

  it('the Vite plugin refuses an entry that is no string', () => {
    expect(() => callWith(vitePlugin, { sources: ['s'], entry: 1 })).toThrow(/`entry` must be a non-empty string/);
  });
});

describe('plugin options: one meaning for both plugins (D11)', () => {
  it('compiles the sources and the format of the top-level options, with the other compile options as given', () => {
    for (const kind of ['vite', 'rollup'] as const) {
      const resolved = resolvePluginOptions(kind, {
        sources: ['story', 'more.tw'],
        format: 'harlowe-3',
        compileOptions: { startPassage: 'Intro', trim: false },
      });
      expect(resolved.compile([{ filename: 'x.js', content: '' }])).toEqual({
        sources: ['story', 'more.tw', { filename: 'x.js', content: '' }],
        formatId: 'harlowe-3',
        startPassage: 'Intro',
        trim: false,
      });
    }
  });

  it('leaves the head file and the modules out of exclude in both plugins', () => {
    const resolved = resolvePluginOptions('rollup', {
      sources: ['story'],
      compileOptions: { exclude: ['**/*.js'], modules: ['story/mod.js'], headFile: 'story/head.js' },
    });
    const cwd = process.cwd().replace(/\\/g, '/');
    expect(resolved.excluded(`${cwd}/story/other.js`)).toBe(true);
    expect(resolved.excluded(`${cwd}/story/mod.js`)).toBe(false);
    expect(resolved.excluded(`${cwd}/story/head.js`)).toBe(false);
    expect(resolved.excluded(`${cwd}/story/start.tw`)).toBe(false);
  });

  it('writes the same story from the same options in a Vite and in a Rollup build', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'story/art/x.png': 'png', 'entry.js': 'export {};' });
    const options = {
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      outputFilename: 'out/story.html',
      compileOptions: { ...COMPILE, startPassage: 'Start' },
    };
    const viteFiles = await buildFiles({ root: dir, plugins: [vitePlugin(options)] });
    const bundle = await rollup({ input: join(dir, 'entry.js'), plugins: [rollupPlugin(options)], logLevel: 'silent' });
    const { output } = await bundle.generate({ dir: join(dir, 'dist') });
    await bundle.close();
    const rollupStory = output.find((item) => item.fileName === 'out/story.html');
    expect(rollupStory?.type).toBe('asset');
    const fromRollup = rollupStory?.type === 'asset' ? textOf(rollupStory.source) : '';
    expect(fromRollup).toContain('Hello from the story.');
    expect(textOf(viteFiles.get('out/story.html'))).toBe(fromRollup);
  });
});

/** Output file names, accepted or refused, and why. */
const NAMES: readonly (readonly [string, RegExp | undefined])[] = [
  ['index.html', undefined],
  ['story.html', undefined],
  ['game/index.html', undefined],
  ['a b/ünïcode story.htm', undefined],
  ['.hidden.html', undefined],
  ['', /empty/],
  ['./index.html', /"\." or "\.\." segment/],
  ['a/../index.html', /"\." or "\.\." segment/],
  ['../index.html', /"\." or "\.\." segment/],
  ['/index.html', /absolute/],
  ['a//index.html', /empty name between slashes/],
  ['game/', /empty name between slashes, or ends with a slash/],
  ['a\\b.html', /not portable/],
  ['C:story.html', /not portable/],
  ['story?.html', /not portable/],
  ['story#1.html', /not portable/],
  ['50%.html', /not portable/],
  ['tab\t.html', /not portable/],
  ['nul\u0000.html', /not portable/],
  ['story.html.', /ends with "\." or a space/],
  ['dir /index.html', /ends with "\." or a space/],
  ['con.html', /reserved on Windows/],
  ['LPT1', /reserved on Windows/],
  ['game/aux.html', /reserved on Windows/],
];

describe('plugin options: output file names (D10)', () => {
  it.each(NAMES.filter(([, problem]) => problem === undefined))('accepts %j', (name) => {
    expect(outputFilenameProblem(name)).toBeUndefined();
  });

  it.each(NAMES.filter(([, problem]) => problem !== undefined))('refuses %j: %s', (name, problem) => {
    expect(outputFilenameProblem(name)).toMatch(problem ?? /never/);
  });

  it('accepts only names that stay inside the output folder on POSIX and on Windows', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc
            .array(fc.constantFrom('a', 'b.html', '.', '..', '', ' ', 'c:', '\\', '%', 'con', 'ü'), { maxLength: 4 })
            .map((parts) => parts.join('/')),
        ),
        (name) => {
          if (outputFilenameProblem(name) !== undefined) return;
          for (const flavour of [posix, win32]) {
            const outDir = flavour === posix ? '/out' : 'C:\\out';
            const written = flavour.resolve(outDir, name);
            expect(written.startsWith(outDir + flavour.sep)).toBe(true);
            expect(flavour.relative(outDir, written).split(flavour.sep).join('/')).toBe(name);
          }
        },
      ),
    );
  });

  it('serves an accepted name at the path a static host serves it at, under any base', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NAMES.filter(([, problem]) => problem === undefined).map(([name]) => name)),
        fc.constantFrom('/', '/game/', '/my game/', '/ü/'),
        (name, base) => {
          const url = encodeURI(`${base}${name}`);
          expect(storyPaths(name)).toContain(pathBelowBase(url, base));
          // A static host also serves an index.html at its folder.
          const folders = name.endsWith('index.html') ? [name.slice(0, -'index.html'.length)] : [];
          for (const folder of folders) {
            expect(storyPaths(name)).toContain(pathBelowBase(`${encodeURI(base + folder)}?query=1#hash`, base));
          }
        },
      ),
    );
  });

  it('reads no request outside the base, nor one that is not valid percent-encoding', () => {
    expect(pathBelowBase('/other/index.html', '/game/')).toBeUndefined();
    expect(pathBelowBase('/game/%E0%A4%A.html', '/game/')).toBeUndefined();
    expect(pathBelowBase('/game/%69ndex.html', '/game/')).toBe('index.html');
  });

  it.each(['/my%20game/', '/my%3Fgame/', '/my%23game/', '/my%2Fgame/', '/my%25game/', '/'])(
    'reads a request below the encoded base %s the way Vite does',
    (base) => {
      expect(pathBelowBase(`${base}index.html?q=1#h`, base)).toBe('index.html');
      expect(pathBelowBase('/elsewhere/index.html', base === '/' ? '/x/' : base)).toBeUndefined();
    },
  );
});

describe('plugin options: an output file name another file of the build has (D7)', () => {
  it('fails a Rollup build in which two instances write the same file', async () => {
    const dir = makeProject({ 'a/start.tw': STORY, 'b/start.tw': STORY, 'entry.js': 'export {};' });
    const instance = (name: string) =>
      rollupPlugin({
        sources: [join(dir, name)],
        format: 'test-format-1',
        outputFilename: 'story.html',
        compileOptions: COMPILE,
      });
    const bundle = await rollup({
      input: join(dir, 'entry.js'),
      plugins: [instance('a'), instance('b')],
      logLevel: 'silent',
    });
    try {
      await expect(bundle.generate({ dir: join(dir, 'dist') })).rejects.toThrow(
        /already holds a file named story\.html/,
      );
    } finally {
      await bundle.close();
    }
  });
});

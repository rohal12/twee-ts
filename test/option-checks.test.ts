/**
 * One check of the options, wherever they are set (#389): every option a config file also sets holds the same
 * values from the API (compile(), compileToFile(), watch(), compileIncremental(), lint()), from a plugin's
 * `compileOptions` and from the config file, as CONFIG_SPEC says; the command line refuses an empty value or
 * source. The options only JavaScript can set are checked too. The cases are derived from CONFIG_SPEC, so a key
 * added there is covered here, and a differential property compares the API check with validateConfig().
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_KEYS, CONFIG_SPEC, validateConfig } from '../src/config.js';
import { compileOptionErrors } from '../src/compile-options.js';
import { compile, compileIncremental, compileToFile, watch } from '../src/compiler.js';
import { lint } from '../src/lint.js';
import { parseCliArgs } from '../src/cli-request.js';
import { tweeTsPlugin as rollupPlugin } from '../src/plugins/rollup.js';
import { tweeTsPlugin as vitePlugin } from '../src/plugins/vite.js';
import type { TweeTsConfig } from '../src/types.js';

const SOURCES = [{ filename: 's.tw', content: ':: StoryTitle\nT\n\n:: Start\nHi\n' }];

/** The config keys the compile options share, with the meaning the config gives them. */
const SHARED = CONFIG_KEYS.filter((key) => key !== 'sources' && key !== 'output');

/** Values the config spec of `key` refuses: a wrong type for each kind, and an empty string where it is refused. */
function invalidValues(key: keyof TweeTsConfig): unknown[] {
  const { spec } = CONFIG_SPEC[key];
  switch (spec.kind) {
    case 'string':
      return [5, null, ['x'], ...(spec.minLength === undefined ? [] : [''])];
    case 'boolean':
      return ['no', 1, null];
    case 'number':
      return [-1, Number.NaN, '5', null];
    case 'enum':
      return ['nope', 5];
    case 'string-array':
      return ['x', [5], [''], { 0: 'x' }];
    case 'tag-map':
      return [['a'], 'x', { a: 'two words' }, { a: 5 }];
    default: {
      const _exhaustive: never = spec;
      throw new Error(`unhandled kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** A value the config spec of `key` accepts. */
function validValue(key: keyof TweeTsConfig): unknown {
  const { spec } = CONFIG_SPEC[key];
  switch (spec.kind) {
    case 'string':
      return 'x';
    case 'boolean':
      return true;
    case 'number':
      return 5;
    case 'enum':
      return spec.values[0];
    case 'string-array':
      return ['x'];
    case 'tag-map':
      return { lib: 'script' };
    default: {
      const _exhaustive: never = spec;
      throw new Error(`unhandled kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

const SHARED_CASES = SHARED.flatMap((key) => invalidValues(key).map((value) => [key, value] as const));

/** Creates a plugin as JavaScript may, whatever the options' type says. */
function createPlugin(factory: (options: never) => unknown, options: unknown): unknown {
  return Reflect.apply(factory, undefined, [options]);
}

/** Calls `fn` as JavaScript may, whatever its parameter types say. */
async function callAsync(fn: (...args: never[]) => Promise<unknown>, args: readonly unknown[]): Promise<unknown> {
  const result: unknown = await Reflect.apply(fn, undefined, args);
  return result;
}

describe('an option holds the same values from the API, the plugins and the config file', () => {
  it.each(SHARED_CASES)('%s: %j is refused everywhere', async (key, value) => {
    expect(validateConfig({ [key]: value }).join('\n')).toContain(`"${key}`);
    await expect(compile({ sources: SOURCES, [key]: value })).rejects.toMatchObject({
      name: 'TweeTsError',
      code: 'INVALID_OPTIONS',
      message: expect.stringContaining(`"${key}`),
    });
    // A plugin sets formatId with its own `format` option, which holds the same values.
    const [pluginOptions, named] =
      key === 'formatId'
        ? [{ sources: ['s'], format: value }, '`format`']
        : [{ sources: ['s'], compileOptions: { [key]: value } }, `"compileOptions.${key}`];
    for (const factory of [rollupPlugin, vitePlugin]) {
      expect(() => createPlugin(factory, pluginOptions)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTIONS', message: expect.stringContaining(named) }),
      );
    }
  });

  it.each(SHARED)('%s: a valid value is accepted everywhere', (key) => {
    const value = validValue(key);
    expect(validateConfig({ [key]: value })).toEqual([]);
    expect(compileOptionErrors({ sources: [], [key]: value }, ['sources'])).toEqual([]);
    expect(compileOptionErrors({ [key]: value }, [], 'compileOptions.')).toEqual([]);
  });

  it('gives the same verdict as validateConfig() for any JSON value of a shared option', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SHARED), fc.jsonValue(), (key, value) => {
        const api = compileOptionErrors({ sources: [], [key]: value }, ['sources']);
        expect(api.length === 0).toBe(validateConfig({ [key]: value }).length === 0);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('the options only JavaScript can set', () => {
  it.each([
    ['no options', undefined, 'The compile options must be an object.'],
    ['null', null, 'The compile options must be an object.'],
    ['no sources', {}, '"sources" must be set.'],
    ['sources as a string', { sources: 'a.twee' }, '"sources" must be an array'],
    ['sources as null', { sources: null }, '"sources" must be an array'],
    ['a number as a source', { sources: [1] }, '"sources" must be an array'],
    ['an empty source', { sources: [''] }, '"sources" must be an array of non-empty paths'],
    ['an inline source without content', { sources: [{ filename: 'a.tw' }] }, '"sources" must be an array'],
    ['an inline source without a name', { sources: [{ filename: '', content: 'x' }] }, '"sources" must be'],
    ['exclude as a string', { sources: SOURCES, exclude: 'x' }, '"exclude" must be an array'],
    ['an empty exclude', { sources: SOURCES, exclude: [''] }, '"exclude" must be an array'],
    ['an exclude object without a glob', { sources: SOURCES, exclude: [{ base: 'p' }] }, '"exclude" must be'],
    ['a signal that is no AbortSignal', { sources: SOURCES, signal: {} }, '"signal" must be an AbortSignal.'],
    ['Infinity as a format id', { sources: SOURCES, formatId: Number.POSITIVE_INFINITY }, '"formatId"'],
  ])('refuses %s', async (_case, options, message) => {
    await expect(callAsync(compile, [options])).rejects.toMatchObject({
      name: 'TweeTsError',
      code: 'INVALID_OPTIONS',
      message: expect.stringContaining(message),
    });
  });

  it('accepts inline sources with a Buffer, { base, glob } excludes, a signal and Infinity as a time limit', () => {
    expect(
      compileOptionErrors(
        {
          sources: ['a.tw', { filename: 'b.tw', content: Buffer.from(':: B\n') }],
          exclude: ['*.png', { base: 'art', glob: '**' }],
          signal: new AbortController().signal,
          formatFetchTimeout: Number.POSITIVE_INFINITY,
          formatResolutionTimeout: Number.POSITIVE_INFINITY,
          formatId: undefined,
        },
        ['sources'],
      ),
    ).toEqual([]);
  });

  it('names every option that is wrong in one error', async () => {
    await expect(callAsync(compile, [{ sources: SOURCES, trim: 'no', formatPaths: '/tmp' }])).rejects.toThrow(
      'Invalid compile options:\n  "formatPaths" must be an array.\n  "trim" must be a boolean.',
    );
  });

  it('checks the options of compileIncremental() and lint() too', async () => {
    await expect(callAsync(compileIncremental, [{ sources: 'a' }, new Map()])).rejects.toThrow(
      '"sources" must be an array',
    );
    await expect(callAsync(lint, [undefined])).rejects.toThrow('"sources" must be set.');
  });
});

describe('the output file of compileToFile() and watch() (#388)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-options-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['no outFile', {}, '"outFile" must be set.'],
    ['an empty outFile', { outFile: '' }, '"outFile" must be a non-empty string.'],
    ['outFile as a number', { outFile: 5 }, '"outFile" must be a non-empty string.'],
  ])('refuses %s, writing nothing', async (_case, extra, message) => {
    const options = { sources: SOURCES, ...extra };
    await expect(callAsync(compileToFile, [options])).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
      message: expect.stringContaining(message),
    });
    await expect(callAsync(watch, [options])).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
      message: expect.stringContaining(message),
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses callbacks that are no functions', async () => {
    const options = { sources: SOURCES, outFile: join(dir, 'out.html'), onBuild: 5, onError: 'x' };
    await expect(callAsync(watch, [options])).rejects.toThrow(
      'Invalid compile options:\n  "onBuild" must be a function.\n  "onError" must be a function.',
    );
  });

  it('reports an output folder that does not exist before the build, naming the output', async () => {
    const outFile = join(dir, 'missing', 'out.html');
    await expect(
      compileToFile({ sources: SOURCES, outFile, outputMode: 'twee3', formatUrls: ['http://127.0.0.1:9/never.js'] }),
    ).rejects.toMatchObject({
      code: 'ENOENT',
      message: `Cannot write ${outFile}: ENOENT: the folder ${join(dir, 'missing')} does not exist`,
    });
  });
});

describe('the command line refuses an empty source, as an empty option value', () => {
  it.each([[['']], [['a.tw', '']], [['--', '']]])('%j', (argv) => {
    const parsed = parseCliArgs(argv);
    expect(parsed).toMatchObject({ ok: false, error: { message: 'a source must not be empty' } });
  });
});

/**
 * The pure parts of entry bundling: how the entry is taken out of a bundle,
 * which output options it gets, and how loud its own build may be.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { toPosix } from '../src/plugins/paths.js';
import type { ImportHookContext } from '../src/plugins/vite-entry.js';
import {
  entryBuildLogLevel,
  entryOutput,
  importSpellings,
  takeEntryFromBundle,
  withWorkerPlugin,
  type BundleItem,
} from '../src/plugins/vite-entry.js';

const chunk = (name: string, isEntry: boolean, code: string): BundleItem => ({
  type: 'chunk',
  code,
  isEntry,
  name,
  moduleIds: [`/p/${name}.js`, '\0virtual'],
});

describe('takeEntryFromBundle', () => {
  it('takes the entry chunk named for the instance, every stylesheet and the maps, and leaves the rest', () => {
    const bundle: Record<string, BundleItem> = {
      'mine.js': chunk('twee-ts-entry-1', true, 'MINE\n//# sourceMappingURL=mine.js.map'),
      'other.js': chunk('other', true, 'OTHER'),
      'lazy.js': chunk('lazy', false, 'LAZY'),
      'a.css': { type: 'asset', source: '.a{}' },
      'b.css': { type: 'asset', source: new TextEncoder().encode('.b{}\n/*# sourceMappingURL=b.css.map */') },
      'mine.js.map': { type: 'asset', source: '{}' },
      'keep.png': { type: 'asset', source: new Uint8Array([1, 2]) },
    };
    const entry = takeEntryFromBundle(bundle, 'twee-ts-entry-1');
    expect(entry.script).toBe('MINE');
    expect(entry.style).toBe('.a{}\n.b{}');
    expect([...entry.files]).toEqual(['/p/twee-ts-entry-1.js']);
    expect([...entry.assets.keys()]).toEqual(['keep.png']);
    expect(Object.keys(bundle).sort()).toEqual(['keep.png', 'lazy.js', 'other.js']);
  });

  it('keeps a CSS file imported as a URL as an asset, and takes the stylesheet the bundler made', () => {
    const bundle: Record<string, BundleItem> = {
      'style.css': { type: 'asset', source: '.own{}', originalFileNames: ['style.css'] },
      'theme.css': { type: 'asset', source: '.theme{}', originalFileNames: ['/p/theme.css', '/p/theme.css'] },
      'win.css': { type: 'asset', source: '.win{}', originalFileNames: ['C:\\p\\win.css'] },
    };
    const entry = takeEntryFromBundle(bundle);
    expect(entry.style).toBe('.own{}');
    expect([...entry.assets.keys()]).toEqual(['theme.css', 'win.css']);
    expect(Object.keys(bundle)).toEqual(['theme.css', 'win.css']);
  });

  it('takes the only entry chunk of the entry’s own build, keeping an inline source map', () => {
    const inline = 'X\n//# sourceMappingURL=data:application/json;base64,e30=';
    const bundle: Record<string, BundleItem> = { 'twee-ts-entry.js': chunk('main', true, inline) };
    expect(takeEntryFromBundle(bundle).script).toBe(inline);
    expect(bundle).toEqual({});
  });
});

describe('entryOutput', () => {
  it("takes one output's options of the user's, with the entry's format and names on top", () => {
    expect(entryOutput({ banner: '/* b */', format: 'es', entryFileNames: 'x.js' })).toEqual({
      banner: '/* b */',
      format: 'iife',
      entryFileNames: 'twee-ts-entry.js',
      assetFileNames: '[name][extname]',
    });
  });

  it('takes none of an output array, which describes the user’s own files', () => {
    expect(entryOutput([{ banner: 'a' }, { banner: 'b' }])).toEqual({
      format: 'iife',
      entryFileNames: 'twee-ts-entry.js',
      assetFileNames: '[name][extname]',
    });
    expect(entryOutput(undefined)).toEqual(entryOutput([]));
  });
});

describe('entryBuildLogLevel', () => {
  it.each([
    [undefined, 'warn'],
    ['info', 'warn'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['silent', 'silent'],
  ] as const)('%s → %s: never the progress lines, never louder than the outer level', (outer, inner) => {
    expect(entryBuildLogLevel(outer)).toBe(inner);
  });
});

describe('withWorkerPlugin', () => {
  const own: Plugin = { name: 'own' };
  const added: Plugin = { name: 'added' };

  it.each([
    ['a function', { plugins: () => [own] }, [[own], added]],
    ['nothing', {}, [undefined, added]],
    ['no worker options', undefined, [undefined, added]],
  ])('puts the plugin after the user’s worker plugins given as %s', (_form, worker, expected) => {
    const result = withWorkerPlugin(worker, () => added);
    expect(result.plugins?.()).toEqual(expected);
  });

  it('keeps a list of worker plugins, which older Vite versions took and Vite still reads (and flattens)', () => {
    const listed: unknown = { plugins: [own] };
    const result = withWorkerPlugin(listed as Parameters<typeof withWorkerPlugin>[0], () => added);
    expect(result.plugins?.()).toEqual([[own], added]);
  });

  it('keeps the other worker options', () => {
    expect(withWorkerPlugin({ format: 'es' }, () => added).format).toBe('es');
  });
});

describe('importSpellings', () => {
  // An environment Vite's resolver cannot run in: it fails, and only the written paths are known.
  const failing = { environment: { config: {} } } as unknown as ImportHookContext;
  const root = resolve('/project');
  const importer = toPosix(resolve('/project/app/entry.js'));
  const at = (path: string): string => toPosix(resolve(path));

  it.each([
    ['a relative path', './dependency.js', [at('/project/app/dependency.js')]],
    ['a path up', '../shared/dependency.js', [at('/project/shared/dependency.js')]],
    ['the importer’s own folder', '.', [at('/project/app')]],
    [
      'a path from the root, then from the file system’s',
      '/dependency.js',
      [at('/project/dependency.js'), '/dependency.js'],
    ],
    ['a path inside the root, given whole', '/project/app/dependency.js', [at('/project/app/dependency.js')]],
    ['a bare name', 'dependency', []],
    ['an alias', '@/dependency', []],
  ])('takes %s as written, with no resolver', async (_form, source, expected) => {
    expect(await importSpellings(failing, source, importer, root)).toEqual({ spellings: expected, kept: undefined });
  });

  it('takes an absolute path that reaches a file outside the root as it is, and as the file it reaches', async () => {
    const file = toPosix(fileURLToPath(import.meta.url));
    expect(await importSpellings(failing, file, importer, root)).toEqual({ spellings: [file], kept: file });
  });

  it.each([
    ['a virtual module', '\0virtual:x', importer],
    ['an import from a virtual module', './dependency.js', '\0virtual:x'],
  ])('has none for %s', async (_form, source, from) => {
    expect(await importSpellings(failing, source, from, root)).toEqual({ spellings: [], kept: undefined });
  });
});

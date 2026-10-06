/**
 * The pure parts of entry bundling: how the entry is taken out of a bundle,
 * which output options it gets, and how loud its own build may be.
 */
import { describe, it, expect } from 'vitest';
import { entryBuildLogLevel, entryOutput, takeEntryFromBundle, type BundleItem } from '../src/plugins/vite-entry.js';

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

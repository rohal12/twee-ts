import { describe, it, expect } from 'vitest';
import { isInside, isViteConfigTemp, outputLocations, toPosix } from '../src/plugins/paths.js';

describe('vite plugin path helpers', () => {
  it('turns Windows separators into forward slashes', () => {
    expect(toPosix('C:\\game\\src\\app\\index.ts')).toBe('C:/game/src/app/index.ts');
    expect(toPosix('/game/src/app/index.ts')).toBe('/game/src/app/index.ts');
  });

  it('tells whether a file is inside one of the given folders', () => {
    expect(isInside('C:/game/src/a.ts', ['C:/game/src'])).toBe(true);
    expect(isInside('C:/game/src', ['C:/game/src'])).toBe(true);
    expect(isInside('C:/game/srcs/a.ts', ['C:/game/src'])).toBe(false);
    expect(isInside('/other/a.ts', ['C:/game/src', '/game'])).toBe(false);
  });

  it('reads a folder that is written with a trailing slash, or the root, as holding its files', () => {
    expect(isInside('/game/src/a.ts', ['/game/src/'])).toBe(true);
    expect(isInside('/game/srcs/a.ts', ['/game/src/'])).toBe(false);
    expect(isInside('/a.ts', ['/'])).toBe(true);
  });

  it('reads the locations an output option names, one or several', () => {
    expect(outputLocations({ dir: 'dist' })).toEqual([{ dir: 'dist' }]);
    expect(outputLocations({ file: 'dist/bundle.js' })).toEqual([{ file: 'dist/bundle.js' }]);
    expect(outputLocations([{ dir: 'a' }, { file: 'b.js' }, { dir: 'c', file: 'd.js' }])).toEqual([
      { dir: 'a' },
      { file: 'b.js' },
      { dir: 'c', file: 'd.js' },
    ]);
  });

  it('leaves out outputs that name neither a folder nor a file, and values that are no output', () => {
    expect(outputLocations(undefined)).toEqual([]);
    expect(outputLocations(null)).toEqual([]);
    expect(outputLocations('dist')).toEqual([]);
    expect(outputLocations({ format: 'es' })).toEqual([]);
    expect(outputLocations({ dir: 3, file: false })).toEqual([]);
  });

  it("recognises Vite's temporary config files", () => {
    expect(isViteConfigTemp('/game/vite.config.ts.timestamp-1727270000000-0a1b2c3d4e5f.mjs')).toBe(true);
    expect(isViteConfigTemp('C:/game/vite.config.mjs.timestamp-1727270000000-9f8e.mjs')).toBe(true);
    expect(isViteConfigTemp('/game/src/main.ts')).toBe(false);
    expect(isViteConfigTemp('/game/src/timestamp-notes.mjs')).toBe(false);
  });
});

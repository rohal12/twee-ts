import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath, fileKey, isViteConfigTemp, keyWithin, outputLocations, toPosix } from '../src/plugins/paths.js';

describe('vite plugin path helpers', () => {
  it('turns Windows separators into forward slashes', () => {
    expect(toPosix('C:\\game\\src\\app\\index.ts')).toBe('C:/game/src/app/index.ts');
    expect(toPosix('/game/src/app/index.ts')).toBe('/game/src/app/index.ts');
  });

  it('compares files by identity: a folder reached through a link holds the files of its real folder', () => {
    const real = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-paths-')));
    const holder = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-paths-')));
    try {
      mkdirSync(join(real, 'src'));
      writeFileSync(join(real, 'src', 'a.ts'), '');
      symlinkSync(real, join(holder, 'link'), 'junction');
      const linked = join(holder, 'link', 'src', 'a.ts');
      expect(fileKey(linked)).toBe(fileKey(join(real, 'src', 'a.ts')));
      expect(canonicalPath(linked)).toBe(toPosix(join(real, 'src', 'a.ts')));
      expect(keyWithin(fileKey(linked), [fileKey(join(real, 'src'))])).toBe(true);
      expect(keyWithin(fileKey(join(real, 'src')), [fileKey(join(real, 'src'))])).toBe(true);
      expect(keyWithin(fileKey(join(real, 'srcs', 'a.ts')), [fileKey(join(real, 'src'))])).toBe(false);
      expect(keyWithin(fileKey(linked), [])).toBe(false);
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(holder, { recursive: true, force: true });
    }
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

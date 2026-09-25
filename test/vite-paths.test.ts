import { describe, it, expect } from 'vitest';
import { isInside, isViteConfigTemp, toPosix } from '../src/plugins/paths.js';

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

  it("recognises Vite's temporary config files", () => {
    expect(isViteConfigTemp('/game/vite.config.ts.timestamp-1727270000000-0a1b2c3d4e5f.mjs')).toBe(true);
    expect(isViteConfigTemp('C:/game/vite.config.mjs.timestamp-1727270000000-9f8e.mjs')).toBe(true);
    expect(isViteConfigTemp('/game/src/main.ts')).toBe(false);
    expect(isViteConfigTemp('/game/src/timestamp-notes.mjs')).toBe(false);
  });
});

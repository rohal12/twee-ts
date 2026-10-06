/**
 * The Vite plugin as it behaves on Vite 5, which has no environments: the
 * stand-in input goes in through the config hook, and an SSR build gets none.
 * The installed Vite is newer, so its version is replaced here. (The
 * peer-version CI job runs the integration tests against the real Vite 5.)
 */
import { describe, it, expect, vi } from 'vitest';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import type * as Vite from 'vite';

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof Vite>();
  return { ...actual, version: '5.4.21' };
});

interface Hooks {
  config(userConfig: Record<string, unknown>, env: { command: string; mode: string }): unknown;
}

const BUILD = { command: 'build', mode: 'production' };

describe('vite plugin on Vite 5', () => {
  it('gives a client build without input the stand-in input through the config hook', () => {
    const hooks = tweeTsPlugin({ sources: ['story'] }) as unknown as Hooks;
    expect(hooks.config({}, BUILD)).toEqual({ build: { rollupOptions: { input: 'virtual:twee-ts-empty-input' } } });
  });

  it('gives an SSR build, a build with an input of its own, and the dev server nothing', () => {
    const hooks = tweeTsPlugin({ sources: ['story'] }) as unknown as Hooks;
    expect(hooks.config({ build: { ssr: 'server.js' } }, BUILD)).toBeUndefined();
    expect(hooks.config({ build: { rollupOptions: { input: 'main.js' } } }, BUILD)).toBeUndefined();
    expect(hooks.config({}, { command: 'serve', mode: 'development' })).toBeUndefined();
  });
});

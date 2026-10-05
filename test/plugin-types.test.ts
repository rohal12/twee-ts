/**
 * The plugins as users type them: assigned to each bundler's own Plugin type and
 * passed to its defineConfig. `pnpm run typecheck` checks this file, so a plugin
 * whose hooks no longer fit the bundler's types fails the build; the assertions
 * only keep the values in use.
 */
import { describe, it, expect } from 'vitest';
import { defineConfig as defineRollupConfig } from 'rollup';
import type { Plugin as RollupPlugin } from 'rollup';
import { defineConfig as defineViteConfig } from 'vite';
import type { Plugin as VitePlugin } from 'vite';
import { tweeTsPlugin as tweeTsRollupPlugin } from '../src/plugins/rollup.js';
import { tweeTsPlugin as tweeTsVitePlugin } from '../src/plugins/vite.js';

describe('plugin types', () => {
  it('the Rollup plugin is a Rollup Plugin and fits a typed Rollup config', () => {
    const plugin: RollupPlugin = tweeTsRollupPlugin({ sources: ['story'] });
    const config = defineRollupConfig({ input: 'entry.js', plugins: [tweeTsRollupPlugin({ sources: ['story'] })] });
    expect(plugin.name).toBe('twee-ts');
    expect(config.plugins).toHaveLength(1);
  });

  it('the Rollup plugin fits a Vite config, as it runs inside vite build', () => {
    const plugin: VitePlugin = tweeTsRollupPlugin({ sources: ['story'] });
    expect(plugin.name).toBe('twee-ts');
  });

  it('the Vite plugin is a Vite Plugin and fits a typed Vite config', () => {
    const plugin: VitePlugin = tweeTsVitePlugin({ sources: ['story'] });
    const config = defineViteConfig({ plugins: [tweeTsVitePlugin({ sources: ['story'] })] });
    expect(plugin.name).toBe('twee-ts');
    expect(config.plugins).toHaveLength(1);
  });
});

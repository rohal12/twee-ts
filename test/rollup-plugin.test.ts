import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { tweeTsPlugin } from '../src/plugins/rollup.js';

/** Runs the plugin's buildStart with a stand-in for Rollup's context; returns the files it registered. */
function watchFiles(plugin: ReturnType<typeof tweeTsPlugin>, watchMode: boolean): string[] {
  const added: string[] = [];
  plugin.buildStart.call({ addWatchFile: (id: string) => added.push(id), meta: { watchMode } });
  return added;
}

describe('rollup plugin', () => {
  it('registers the sources, head file and modules for rollup --watch', () => {
    const plugin = tweeTsPlugin({
      sources: [join('story'), join('extra', 'one.tw')],
      compileOptions: { headFile: 'head.html', modules: [join('lib', 'mod.js')] },
    });
    expect(watchFiles(plugin, true)).toEqual([
      resolve('story'),
      resolve('extra', 'one.tw'),
      resolve('head.html'),
      resolve('lib', 'mod.js'),
    ]);
  });

  it('registers nothing outside watch mode', () => {
    expect(watchFiles(tweeTsPlugin({ sources: ['story'] }), false)).toEqual([]);
  });
});

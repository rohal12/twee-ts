/** Rollup's concurrent output IO must not multiply input validation by asset count (#552). */
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { rollup } from 'rollup';
import { tweeTsPlugin } from '../src/plugins/rollup.js';
import { cleanUp, makeProject, STORY } from './helpers/plugins.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

afterEach(cleanUp);

it.each([false, true])('bounds input validation as modules and assets grow, custom filesystem %s', async (custom) => {
  async function write(modules: number, assets: number): Promise<number> {
    const dir = makeProject({
      'story.tw': STORY,
      'entry.js': Array.from({ length: modules }, (_, i) => `import './module${i}.js';`).join('\n'),
      ...Object.fromEntries(
        Array.from({ length: modules }, (_, i) => [`module${i}.js`, `globalThis.value${i} = ${i};`]),
      ),
    });
    const config = {
      input: join(dir, 'entry.js'),
      plugins: [
        tweeTsPlugin({ sources: [join(dir, 'story.tw')], compileOptions: { outputMode: 'twee3' } }),
        {
          name: 'assets',
          buildStart(this: {
            addWatchFile(path: string): void;
            emitFile(asset: { type: 'asset'; fileName: string; source: string }): void;
          }) {
            // Include directory-watch discovery as well as graph inputs in the work bound.
            this.addWatchFile(dir);
            for (let i = 0; i < assets; i++) {
              this.emitFile({ type: 'asset', fileName: `assets/asset${i}.txt`, source: 'asset' });
            }
          },
        },
      ],
    };
    // As with JavaScript Rollup configs, accept Node's wider readFile overloads at the config boundary.
    if (custom) Reflect.set(config, 'fs', Object.freeze({ ...fs }));
    const bundle = await rollup(config);
    try {
      vi.mocked(statSync).mockClear();
      const result = await bundle.write({ dir: join(dir, 'output'), format: 'es' });
      const calls = vi.mocked(statSync).mock.calls.length;
      expect(result.output).toHaveLength(assets + 2);
      expect(readFileSync(join(dir, 'output', 'index.html'), 'utf8')).toContain('Hello from the story.');
      return calls;
    } finally {
      await bundle.close();
    }
  }

  const small = await write(8, 8);
  const moreAssets = await write(8, 64);
  const moreInputs = await write(64, 8);
  const both = await write(64, 64);
  // Asset writes may add bookkeeping but must not cause another full scan per asset.
  expect(moreAssets).toBeLessThan(small * 2);
  expect(both).toBeLessThan(moreInputs * 2);
  // Increasing both dimensions eightfold must remain well below their 64-fold product.
  expect(both).toBeLessThan(small * 12);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from 'rollup';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { tweeTsPlugin as rollupPlugin } from '../src/plugins/rollup.js';
import { resolvePluginOptions } from '../src/plugins/options.js';
import {
  buildFiles,
  trackBuildWatch,
  cleanUp,
  COMPILE,
  makeProject,
  startBuildWatch,
  startServer,
  storyWith,
  textOf,
} from './helpers/plugins.js';

afterEach(cleanUp);

function fixture(competing = true): string {
  const dir = makeProject({
    'real/a.tw': storyWith('RIGHT_FIRST'),
    'real/entry.js': 'globalThis.marker="RIGHT_ENTRY";',
    'real/module.js': 'globalThis.extra="RIGHT_MODULE";',
    'real/head.html': '<meta name="right" content="RIGHT_HEAD">',
    ...(competing ? { 'a.tw': storyWith('WRONG_STORY'), 'entry.js': 'globalThis.marker="WRONG_ENTRY";' } : {}),
  });
  mkdirSync(join(dir, 'real/deep'));
  symlinkSync(join(dir, 'real/deep'), join(dir, 'pivot'), 'junction');
  return dir;
}

describe.skipIf(process.platform === 'win32')('plugin authored parent steps (#466)', () => {
  it.each([false, true])('bundles the selected entry, lexical competitor: %s', async (competing) => {
    const dir = fixture(competing);
    const files = await buildFiles({
      root: dir,
      plugins: [
        tweeTsPlugin({
          sources: [join(dir, 'real/a.tw')],
          entry: `${dir}/pivot/../entry.js`,
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    });
    expect(textOf(files.get('index.html'))).toContain('RIGHT_ENTRY');
    expect(textOf(files.get('index.html'))).not.toContain('WRONG_ENTRY');
  });

  it.each([false, true])('refreshes files, modules and head with dev watcher enabled: %s', async (watcher) => {
    const dir = fixture();
    const { url } = await startServer({
      root: dir,
      server: { watch: watcher ? {} : null },
      plugins: [
        tweeTsPlugin({
          sources: [`${dir}/pivot/../a.tw`],
          format: 'test-format-1',
          compileOptions: {
            ...COMPILE,
            modules: [`${dir}/pivot/../module.js`],
            headFile: `${dir}/pivot/../head.html`,
          },
        }),
      ],
    });
    const first = await (await fetch(url)).text();
    expect(first).toContain('RIGHT_FIRST');
    writeFileSync(join(dir, 'real/a.tw'), storyWith('RIGHT_SECOND'));
    writeFileSync(join(dir, 'real/module.js'), 'globalThis.extra="SECOND_MODULE";');
    writeFileSync(join(dir, 'real/head.html'), '<meta name="right" content="SECOND_HEAD">');
    const second = await (await fetch(url)).text();
    expect(second).toContain('RIGHT_SECOND');
    expect(second).toContain('SECOND_MODULE');
    expect(second).toContain('SECOND_HEAD');
  });

  it.each(['vite', 'rollup'] as const)(
    'rebuilds %s for an edit under an authored source folder',
    { timeout: 30_000 },
    async (kind) => {
      const dir = fixture();
      mkdirSync(join(dir, 'real/story'));
      writeFileSync(join(dir, 'real/story/a.tw'), storyWith('RIGHT_FIRST'));
      const options = { sources: [`${dir}/pivot/../story`], format: 'test-format-1', compileOptions: COMPILE };
      const outDir = join(dir, 'dist');
      const startRollup = () => {
        const watcher = trackBuildWatch(
          watch({
            input: join(dir, 'entry.js'),
            plugins: [rollupPlugin(options)],
            output: { dir: outDir, format: 'es' },
          }),
        );
        return watcher;
      };
      const watcher =
        kind === 'vite'
          ? await startBuildWatch({ root: dir, build: { outDir }, plugins: [tweeTsPlugin(options)] })
          : startRollup();
      const text = (): string => readFileSync(join(outDir, 'index.html'), 'utf8');
      try {
        await vi.waitFor(
          () => {
            expect(text()).toContain('RIGHT_FIRST');
          },
          { timeout: 10_000 },
        );
        writeFileSync(join(dir, 'real/story/a.tw'), storyWith('RIGHT_SECOND'));
        await vi.waitFor(
          () => {
            expect(text()).toContain('RIGHT_SECOND');
          },
          { timeout: 10_000 },
        );
      } finally {
        await watcher.close();
      }
    },
  );

  it('does not map an excluded real file to the lexical source folder', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'other/a.tw'), storyWith('EXCLUDED'));
    symlinkSync(join(dir, 'other'), join(dir, 'real/alias'), 'junction');
    const resolved = resolvePluginOptions('vite', {
      sources: [`${dir}/pivot/../alias`],
      compileOptions: { exclude: [join(dir, 'real/alias/a.tw')] },
    });
    expect(resolved.excluded(join(dir, 'other/a.tw'))).toBe(true);
  });

  it('rejects an entry reached through a missing intermediate folder', async () => {
    const dir = fixture();
    await expect(
      buildFiles({
        root: dir,
        plugins: [
          tweeTsPlugin({
            sources: [join(dir, 'real/a.tw')],
            entry: `${dir}/missing/../entry.js`,
            format: 'test-format-1',
            compileOptions: COMPILE,
          }),
        ],
      }),
    ).rejects.toThrow();
  });

  it('follows a retargeted parent link during dev request catch-up', async () => {
    const dir = fixture();
    const { url } = await startServer({
      root: dir,
      server: { watch: null },
      plugins: [
        tweeTsPlugin({
          sources: [`${dir}/pivot/../a.tw`],
          entry: `${dir}/pivot/../entry.js`,
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    });
    expect(await (await fetch(url)).text()).toContain('RIGHT_FIRST');
    mkdirSync(join(dir, 'next/deep'), { recursive: true });
    writeFileSync(join(dir, 'next/a.tw'), storyWith('RETARGETED_STORY'));
    writeFileSync(join(dir, 'next/entry.js'), 'globalThis.marker="RETARGETED_ENTRY";');
    rmSync(join(dir, 'pivot'));
    symlinkSync(join(dir, 'next/deep'), join(dir, 'pivot'), 'junction');
    const changed = await (await fetch(url)).text();
    expect(changed).toContain('RETARGETED_STORY');
    expect(changed).toContain('RETARGETED_ENTRY');
  });
});

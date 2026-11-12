import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { watch } from 'rollup';
import type { ViteDevServer } from 'vite';
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

/** A native stream may start reporting after getWatched() lists the files (macOS FSEvents). */
async function primeWatcher(server: ViteDevServer): Promise<void> {
  const probe = join(server.config.root, 'ready.txt');
  let seen = false;
  let attempt = 0;
  const observe = (_event: string, path: string): void => {
    if (path === probe) seen = true;
  };
  server.watcher.on('all', observe);
  try {
    await expect
      .poll(
        () => {
          writeFileSync(probe, String(++attempt));
          return seen;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    server.watcher.off('all', observe);
  }
}

async function waitForMessage(messages: () => unknown, type: 'error' | 'full-reload'): Promise<void> {
  await expect.poll(messages, { timeout: 10_000 }).toContainEqual([expect.objectContaining({ type })]);
}

describe.skipIf(process.platform === 'win32')('plugin authored parent steps (#466)', { timeout: 30_000 }, () => {
  it.each(
    (['file', 'folder', 'module', 'head'] as const).flatMap((role) =>
      [false, true].map((parentStep) => ({ role, parentStep })),
    ),
  )('automatically reloads an external $role, parent step: $parentStep', async ({ role, parentStep }) => {
    const dir = makeProject({
      'project/story.tw': storyWith('LOCAL_STORY'),
      'external/story/a.tw': storyWith('EXTERNAL_FIRST'),
      'external/module.js': 'globalThis.extra="EXTERNAL_FIRST";',
      'external/head.html': '<meta name="probe" content="EXTERNAL_FIRST">',
    });
    mkdirSync(join(dir, 'external/deep'));
    symlinkSync(join(dir, 'external/deep'), join(dir, 'pivot'), 'junction');
    const name = role === 'head' ? 'head.html' : role === 'module' ? 'module.js' : 'story/a.tw';
    const selected = role === 'folder' ? 'story' : name;
    const input = parentStep ? `${dir}/pivot/../${selected}` : join(dir, 'external', selected);
    const { server, url } = await startServer({
      root: join(dir, 'project'),
      plugins: [
        tweeTsPlugin({
          sources: [role === 'file' || role === 'folder' ? input : join(dir, 'project/story.tw')],
          format: 'test-format-1',
          compileOptions: {
            ...COMPILE,
            ...(role === 'module' ? { modules: [input] } : {}),
            ...(role === 'head' ? { headFile: input } : {}),
          },
        }),
      ],
    });
    expect(await (await fetch(url)).text()).toContain('EXTERNAL_FIRST');
    const real = join(dir, 'external', name);
    await expect.poll(() => server.watcher.getWatched()[dirname(real)], { timeout: 10_000 }).toContain(basename(real));
    await primeWatcher(server);
    const send = vi.spyOn(server.ws, 'send');
    const content = readFileSync(real, 'utf8').replace('EXTERNAL_FIRST', 'EXTERNAL_SECOND');
    writeFileSync(real, content);
    // No request may catch up until the watcher itself has rebuilt and sent the reload.
    await waitForMessage(() => send.mock.calls, 'full-reload');
    expect(await (await fetch(url)).text()).toContain('EXTERNAL_SECOND');
  });

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

  it.each([false, true])(
    'automatically follows an external parent link retarget and later saves, missing interval: %s',
    async (missingInterval) => {
      const dir = makeProject({
        'first/story.tw': storyWith('FIRST_TARGET'),
        'second/story.tw': storyWith('SECOND_TARGET'),
        'project/local.txt': '',
      });
      for (const target of ['first', 'second']) mkdirSync(join(dir, target, 'deep'));
      mkdirSync(join(dir, 'links'));
      const pivot = join(dir, 'links/pivot');
      symlinkSync(join(dir, 'first/deep'), pivot, 'junction');
      const { server, url } = await startServer({
        root: join(dir, 'project'),
        plugins: [
          tweeTsPlugin({ sources: [`${pivot}/../story.tw`], format: 'test-format-1', compileOptions: COMPILE }),
        ],
      });
      expect(await (await fetch(url)).text()).toContain('FIRST_TARGET');
      await primeWatcher(server);
      const send = vi.spyOn(server.ws, 'send');
      rmSync(pivot);
      if (missingInterval) {
        await waitForMessage(() => send.mock.calls, 'error');
        send.mockClear();
      }
      symlinkSync(join(dir, 'second/deep'), pivot, 'junction');
      await waitForMessage(() => send.mock.calls, 'full-reload');
      expect(await (await fetch(url)).text()).toContain('SECOND_TARGET');
      const real = join(dir, 'second/story.tw');
      await expect
        .poll(() => server.watcher.getWatched()[dirname(real)], { timeout: 10_000 })
        .toContain(basename(real));
      await primeWatcher(server);
      send.mockClear();
      writeFileSync(real, storyWith('SECOND_SAVED'));
      await waitForMessage(() => send.mock.calls, 'full-reload');
      expect(await (await fetch(url)).text()).toContain('SECOND_SAVED');
    },
  );

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

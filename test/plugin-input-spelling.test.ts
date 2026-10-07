/**
 * How the bundler plugins register and follow inputs whose spelling is unusual on POSIX: a literal backslash in a
 * name (#308) and a link that is replaced or retargeted (#307). Each case runs the public plugins in a real watch
 * (Vite build, Rollup) or the dev server's request catch-up, and is paired with an ordinary-path control.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { watch } from 'rollup';
import type { RollupWatcher } from 'rollup';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { tweeTsPlugin as rollupTweeTs } from '../src/plugins/rollup.js';
import {
  cleanUp,
  COMPILE,
  makeProject,
  recorderPlugin,
  registeredFor,
  startBuildWatch,
  startServer,
  storyWith,
} from './helpers/plugins.js';

afterEach(cleanUp);

const settled = { timeout: 20_000, interval: 100 };
const posixOnly = process.platform === 'win32';

/** Applies `change` every 250 ms until `check` passes: a watcher may not be ready right after the first build. */
async function applyUntil(change: () => void, check: () => void): Promise<void> {
  change();
  const again = setInterval(change, 250);
  try {
    await vi.waitFor(check, settled);
  } finally {
    clearInterval(again);
  }
}

/** Points the link `at` to `target`, replacing a link or leaving none behind when `target` is undefined. */
function relink(at: string, target: string | undefined): void {
  rmSync(at, { force: true });
  if (target !== undefined) symlinkSync(target, at);
}

const text = (file: string): string => readFileSync(file, 'utf-8');

interface Sources {
  /** Source paths relative to the project. */
  readonly sources: readonly string[];
  readonly modules?: readonly string[];
  readonly headFile?: string;
}

/** A Vite build watch of `layout` in the project at `dir`; resolves to the story's path. */
async function watchStory(dir: string, layout: Sources, extra: Plugin[] = []): Promise<string> {
  const outDir = join(dir, 'dist');
  await startBuildWatch({
    root: dir,
    build: { outDir },
    plugins: [
      tweeTsPlugin({
        sources: layout.sources.map((source) => join(dir, source)),
        format: 'test-format-1',
        compileOptions: {
          ...COMPILE,
          ...(layout.modules === undefined ? {} : { modules: layout.modules.map((m) => join(dir, m)) }),
          ...(layout.headFile === undefined ? {} : { headFile: join(dir, layout.headFile) }),
        },
      }),
      ...extra,
    ],
  });
  return join(outDir, 'index.html');
}

describe('plugin build watch: names with a literal backslash (#308)', { timeout: 40_000 }, () => {
  // Each variant is an ordinary spelling (control) and the same input with a backslash in its name.
  it.skipIf(posixOnly).each([
    ['ordinary source folder', 'story/folder', 'story/folder/part.tw'],
    ['source folder', 'story\\folder', 'story\\folder/part.tw'],
  ])('rebuilds for an edit in a %s', async (_name, folder, child) => {
    const dir = makeProject({ [child]: storyWith('FIRST') });
    const out = await watchStory(dir, { sources: [folder] });
    await applyUntil(
      () => {
        writeFileSync(join(dir, child), storyWith('SECOND'));
      },
      () => {
        expect(text(out)).toContain('SECOND');
      },
    );
  });

  it.skipIf(posixOnly).each([
    ['ordinary module', 'script/part.js'],
    ['module', 'script\\part.js'],
  ])('rebuilds for an edit to a %s', async (_name, module) => {
    const dir = makeProject({ 'story/start.tw': storyWith('x'), [module]: 'window.marker = "ONE";' });
    const out = await watchStory(dir, { sources: ['story'], modules: [module] });
    await applyUntil(
      () => {
        writeFileSync(join(dir, module), 'window.marker = "TWO";');
      },
      () => {
        expect(text(out)).toContain('"TWO"');
      },
    );
  });

  it.skipIf(posixOnly).each([
    ['ordinary head file', 'head/part.html'],
    ['head file', 'head\\part.html'],
  ])('rebuilds for an edit to a %s', async (_name, headFile) => {
    const dir = makeProject({ 'story/start.tw': storyWith('x'), [headFile]: '<meta name="m" content="one">' });
    const out = await watchStory(dir, { sources: ['story'], headFile });
    await applyUntil(
      () => {
        writeFileSync(join(dir, headFile), '<meta name="m" content="two">');
      },
      () => {
        expect(text(out)).toContain('content="two"');
      },
    );
  });

  /** A Rollup watch of the story at `source`; the logs it reports go to `logs`. */
  async function rollupWatch(source: string, logs: string[]): Promise<{ dir: string; stop: () => Promise<void> }> {
    const dir = makeProject({ [source]: storyWith('FIRST'), 'entry.js': 'export const a = 1;\n' });
    const watcher: RollupWatcher = watch({
      input: join(dir, 'entry.js'),
      plugins: [rollupTweeTs({ sources: [join(dir, source)], format: 'test-format-1', compileOptions: COMPILE })],
      output: { dir: join(dir, 'dist'), format: 'es' },
      watch: { buildDelay: 50 },
      onLog: (_level, log) => logs.push(log.message),
    });
    watcher.on('event', (event) => {
      if (event.code === 'BUNDLE_END') void event.result.close();
    });
    await vi.waitFor(() => {
      expect(text(join(dir, 'dist/index.html'))).toContain('FIRST');
    }, settled);
    return { dir, stop: () => watcher.close() };
  }

  it.skipIf(posixOnly)('rebuilds a Rollup watch for an edit to an ordinary source file', async () => {
    const logs: string[] = [];
    const { dir, stop } = await rollupWatch('story/part.tw', logs);
    try {
      await applyUntil(
        () => {
          writeFileSync(join(dir, 'story/part.tw'), storyWith('SECOND'));
        },
        () => {
          expect(text(join(dir, 'dist/index.html'))).toContain('SECOND');
        },
      );
    } finally {
      await stop();
    }
    expect(logs).toEqual([]);
  });

  it.skipIf(posixOnly)(
    'reads a source file with a backslash in its name in a Rollup watch, and warns that Rollup cannot watch it',
    async () => {
      const logs: string[] = [];
      const { stop } = await rollupWatch('story\\part.tw', logs);
      await stop();
      expect(logs).toEqual([expect.stringMatching(/cannot watch .*story\\\\part\.tw.* backslash/)]);
    },
  );
});

describe(
  'vite dev request catch-up with no watcher: names with a literal backslash (#308)',
  { timeout: 40_000 },
  () => {
    it.skipIf(posixOnly).each([
      ['ordinary', 'story/part.tw'],
      ['backslash', 'story\\part.tw'],
    ])('serves an edit to a source file with a %s name on the next request', async (_name, source) => {
      const dir = makeProject({ [source]: storyWith('FIRST'), 'app/main.js': 'globalThis.a = 1;\n' });
      const { url } = await startServer({
        root: dir,
        server: { watch: null },
        plugins: [
          tweeTsPlugin({
            sources: [join(dir, source)],
            format: 'test-format-1',
            entry: join(dir, 'app/main.js'),
            compileOptions: COMPILE,
          }),
        ],
      });
      expect(await (await fetch(`${url}/`)).text()).toContain('FIRST');
      writeFileSync(join(dir, source), storyWith('SECOND'));
      expect(await (await fetch(`${url}/`)).text()).toContain('SECOND');
    });
  },
);

describe('vite build watch: links to inputs (#307)', { timeout: 40_000 }, () => {
  // EXPERIMENT E2 (temporary, macOS investigation): the fixture and steps of the single-link test of
  // vite-plugin.test.ts, run in this file with this file's helper.
  it.skipIf(posixOnly)('EXPERIMENT E2: the single-link fixture, retargeted once, then an edit', async () => {
    const dir = makeProject({ 'first.tw': storyWith('FIRST_TEXT'), 'second.tw': storyWith('SECOND_TEXT') });
    symlinkSync(join(dir, 'first.tw'), join(dir, 'story.tw'));
    const probe: string[] = [];
    const out = await watchStory(dir, { sources: ['story.tw'] }, [recorderPlugin(probe)]);
    expect(text(out)).toContain('FIRST_TEXT');
    probe.push('first build done', registeredFor(join(dir, 'story.tw'), join(dir, 'dist')));
    await applyUntil(
      () => {
        relink(join(dir, 'story.tw'), join(dir, 'second.tw'));
      },
      () => {
        expect(text(out)).toContain('SECOND_TEXT');
      },
    );
    console.log(`PROBE E2@plugin-input-spelling.test.ts ${JSON.stringify(probe)}`);
    await applyUntil(
      () => {
        writeFileSync(join(dir, 'second.tw'), storyWith('SECOND_EDITED'));
      },
      () => {
        expect(text(out)).toContain('SECOND_EDITED');
      },
    );
  });

  it.skipIf(posixOnly)('follows a source file link through repeated retargets, a dangling link and edits', async () => {
    const dir = makeProject({
      'one.tw': storyWith('ONE_TEXT'),
      'two.tw': storyWith('TWO_TEXT'),
      'three.tw': storyWith('THREE_TEXT'),
    });
    symlinkSync(join(dir, 'one.tw'), join(dir, 'story.tw'));
    const probe: string[] = [];
    const out = await watchStory(dir, { sources: ['story.tw'] }, [recorderPlugin(probe)]);
    expect(text(out)).toContain('ONE_TEXT');
    probe.push('first build done', registeredFor(join(dir, 'story.tw'), join(dir, 'dist')));

    const retarget = (name: string, expected: string) =>
      applyUntil(
        () => {
          relink(join(dir, 'story.tw'), join(dir, name));
        },
        () => {
          expect(text(out)).toContain(expected);
        },
      );
    await retarget('two.tw', 'TWO_TEXT');
    console.log(`PROBE fuller@plugin-input-spelling.test.ts (after the first retarget) ${JSON.stringify(probe)}`);
    await retarget('three.tw', 'THREE_TEXT');

    // A link that dangles fails the build; pointing it at a story again recovers, and the old targets stay quiet.
    relink(join(dir, 'story.tw'), join(dir, 'missing.tw'));
    await new Promise((done) => setTimeout(done, 500));
    await retarget('one.tw', 'ONE_TEXT');

    await applyUntil(
      () => {
        writeFileSync(join(dir, 'one.tw'), storyWith('ONE_EDITED'));
      },
      () => {
        expect(text(out)).toContain('ONE_EDITED');
      },
    );
  });

  it.skipIf(posixOnly)(
    'rebuilds when a source folder link is retargeted, then for edits in the new folder',
    async () => {
      const dir = makeProject({ 'first/start.tw': storyWith('FIRST_DIR'), 'second/start.tw': storyWith('SECOND_DIR') });
      symlinkSync(join(dir, 'first'), join(dir, 'current'));
      const out = await watchStory(dir, { sources: ['current'] });
      expect(text(out)).toContain('FIRST_DIR');
      await applyUntil(
        () => {
          relink(join(dir, 'current'), join(dir, 'second'));
        },
        () => {
          expect(text(out)).toContain('SECOND_DIR');
        },
      );
      await applyUntil(
        () => {
          writeFileSync(join(dir, 'second/start.tw'), storyWith('SECOND_EDITED'));
        },
        () => {
          expect(text(out)).toContain('SECOND_EDITED');
        },
      );
    },
  );

  it.skipIf(posixOnly)('rebuilds when a module link or a head file link is retargeted', async () => {
    const dir = makeProject({
      'story/start.tw': storyWith('x'),
      'mod-a.js': 'window.marker = "MOD_A";',
      'mod-b.js': 'window.marker = "MOD_B";',
      'head-a.html': '<meta name="m" content="head-a">',
      'head-b.html': '<meta name="m" content="head-b">',
    });
    symlinkSync(join(dir, 'mod-a.js'), join(dir, 'mod.js'));
    symlinkSync(join(dir, 'head-a.html'), join(dir, 'head.html'));
    const out = await watchStory(dir, { sources: ['story'], modules: ['mod.js'], headFile: 'head.html' });
    expect(text(out)).toContain('"MOD_A"');
    await applyUntil(
      () => {
        relink(join(dir, 'mod.js'), join(dir, 'mod-b.js'));
      },
      () => {
        expect(text(out)).toContain('"MOD_B"');
      },
    );
    await applyUntil(
      () => {
        relink(join(dir, 'head.html'), join(dir, 'head-b.html'));
      },
      () => {
        expect(text(out)).toContain('content="head-b"');
      },
    );
  });

  it.skipIf(posixOnly)('rebuilds when a link above the source folder is retargeted', async () => {
    const dir = makeProject({ 'a/story/start.tw': storyWith('UNDER_A'), 'b/story/start.tw': storyWith('UNDER_B') });
    mkdirSync(join(dir, 'x'));
    symlinkSync(join(dir, 'a'), join(dir, 'x/parent'));
    const out = await watchStory(dir, { sources: ['x/parent/story'] });
    expect(text(out)).toContain('UNDER_A');
    await applyUntil(
      () => {
        relink(join(dir, 'x/parent'), join(dir, 'b'));
      },
      () => {
        expect(text(out)).toContain('UNDER_B');
      },
    );
  });

  it.skipIf(posixOnly)('control: an ordinary source file rebuilds for an edit', async () => {
    const dir = makeProject({ 'story.tw': storyWith('PLAIN_ONE') });
    const out = await watchStory(dir, { sources: ['story.tw'] });
    await applyUntil(
      () => {
        writeFileSync(join(dir, 'story.tw'), storyWith('PLAIN_TWO'));
      },
      () => {
        expect(text(out)).toContain('PLAIN_TWO');
      },
    );
  });
});

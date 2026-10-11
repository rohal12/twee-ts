/**
 * A story source, head file or module that is reached through a chain of links (#434): a link to a link, or a folder
 * link that leads through another. Retargeting any hop changes compiler input, so a bundler's build watch must start a
 * build for it, and for the edits to the new target after. Each case runs the public Vite and Rollup plugins in a real
 * watch, and the registered paths are checked on their own.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from 'rollup';
import type { RollupWatcher } from 'rollup';
import { outputPaths } from '../src/filesystem.js';
import { tweeTsPlugin as viteTweeTs } from '../src/plugins/vite.js';
import { tweeTsPlugin as rollupTweeTs } from '../src/plugins/rollup.js';
import { toPosix } from '../src/plugins/paths.js';
import { createLinkWatch } from '../src/plugins/link-watch.js';
import { watchPlan, watchTargets } from '../src/plugins/watch-targets.js';
import { cleanUp, COMPILE, makeProject, startBuildWatch, storyWith } from './helpers/plugins.js';

afterEach(cleanUp);

const settled = { timeout: 20_000, interval: 100 };
// On macOS the bundler's watcher reports no replacement of a link (see "Build watch" in docs/plugins.md); Windows
// links need a privilege the runners may lack.
const noRelinkWatch = process.platform !== 'linux';
const noLinks = process.platform === 'win32';

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

/** Points the link `at` to `target` in one step, so that the link never lacks (as `ln -sfn` and `mv` do). */
function replaceLink(at: string, target: string): void {
  symlinkSync(target, `${at}.new`);
  renameSync(`${at}.new`, at);
}

const text = (file: string): string => readFileSync(file, 'utf-8');

type Bundler = 'vite' | 'rollup';
const BUNDLERS: readonly Bundler[] = ['vite', 'rollup'];

interface Inputs {
  /** Source paths relative to the project. */
  readonly sources: readonly string[];
  readonly modules?: readonly string[];
  readonly headFile?: string;
}

/** A build watch of `inputs` in the project at `dir` with the bundler; resolves to the story's path. */
async function watchStory(bundler: Bundler, dir: string, inputs: Inputs): Promise<string> {
  const outDir = join(dir, 'dist');
  const options = {
    sources: inputs.sources.map((source) => join(dir, source)),
    format: 'test-format-1',
    compileOptions: {
      ...COMPILE,
      ...(inputs.modules === undefined ? {} : { modules: inputs.modules.map((m) => join(dir, m)) }),
      ...(inputs.headFile === undefined ? {} : { headFile: join(dir, inputs.headFile) }),
    },
  };
  if (bundler === 'vite') {
    await startBuildWatch({ root: dir, build: { outDir }, plugins: [viteTweeTs(options)] });
    return join(outDir, 'index.html');
  }
  writeFileSync(join(dir, 'entry.js'), 'export const a = 1;\n');
  const watcher: RollupWatcher = watch({
    input: join(dir, 'entry.js'),
    plugins: [rollupTweeTs(options)],
    output: { dir: outDir, format: 'es' },
    watch: { buildDelay: 50 },
    onLog: () => undefined,
  });
  watcher.on('event', (event) => {
    if (event.code === 'BUNDLE_END') void event.result.close();
  });
  watchers.push(watcher);
  await vi.waitFor(() => {
    expect(text(join(outDir, 'index.html'))).toContain('FIRST');
  }, settled);
  return join(outDir, 'index.html');
}

/** Points the link `at` to `target` until the story at `out` reads `expected`. */
async function relinked(out: string, at: string, target: string, expected: string): Promise<void> {
  await applyUntil(
    () => {
      relink(at, target);
    },
    () => {
      expect(text(out)).toContain(expected);
    },
  );
}

/** Writes the story `marker` into `file` until the story at `out` has it. */
async function edited(out: string, file: string, marker: string): Promise<void> {
  await applyUntil(
    () => {
      writeFileSync(file, storyWith(marker));
    },
    () => {
      expect(text(out)).toContain(marker);
    },
  );
}

const watchers: RollupWatcher[] = [];
afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
});

describe.each(BUNDLERS)(
  '%s build watch: a source file reached through a chain of links (#434)',
  { timeout: 60_000 },
  (bundler) => {
    const files = {
      'first.tw': storyWith('FIRST'),
      'second.tw': storyWith('SECOND'),
      'third.tw': storyWith('THIRD'),
      'fourth.tw': storyWith('FOURTH'),
    };

    it.skipIf(noRelinkWatch)(
      'follows a chain of two links through a retarget of the middle hop, the named link and edits',
      async () => {
        const dir = makeProject(files);
        symlinkSync(join(dir, 'first.tw'), join(dir, 'mid.tw'));
        symlinkSync(join(dir, 'mid.tw'), join(dir, 'story.tw'));
        const out = await watchStory(bundler, dir, { sources: ['story.tw'] });
        await relinked(out, join(dir, 'mid.tw'), join(dir, 'second.tw'), 'SECOND');
        await edited(out, join(dir, 'second.tw'), 'SECOND_EDITED');
        await relinked(out, join(dir, 'story.tw'), join(dir, 'third.tw'), 'THIRD');
        await edited(out, join(dir, 'third.tw'), 'THIRD_EDITED');
        expect(text(out)).toContain('THIRD_EDITED');
      },
    );

    it.skipIf(noRelinkWatch)(
      'follows a chain of three links through a retarget of the last hop, a middle hop and edits',
      async () => {
        const dir = makeProject(files);
        symlinkSync(join(dir, 'first.tw'), join(dir, 'c.tw'));
        symlinkSync(join(dir, 'c.tw'), join(dir, 'b.tw'));
        symlinkSync(join(dir, 'b.tw'), join(dir, 'story.tw'));
        const out = await watchStory(bundler, dir, { sources: ['story.tw'] });
        await relinked(out, join(dir, 'c.tw'), join(dir, 'second.tw'), 'SECOND');
        await edited(out, join(dir, 'second.tw'), 'SECOND_EDITED');
        await relinked(out, join(dir, 'b.tw'), join(dir, 'third.tw'), 'THIRD');
        await edited(out, join(dir, 'third.tw'), 'THIRD_EDITED');
        await relinked(out, join(dir, 'story.tw'), join(dir, 'fourth.tw'), 'FOURTH');
        await edited(out, join(dir, 'fourth.tw'), 'FOURTH_EDITED');
        expect(text(out)).toContain('FOURTH_EDITED');
      },
    );

    it.skipIf(noRelinkWatch)('follows a retarget of the named link of a single link (the control)', async () => {
      const dir = makeProject(files);
      symlinkSync(join(dir, 'first.tw'), join(dir, 'story.tw'));
      const out = await watchStory(bundler, dir, { sources: ['story.tw'] });
      await relinked(out, join(dir, 'story.tw'), join(dir, 'second.tw'), 'SECOND');
      await edited(out, join(dir, 'second.tw'), 'SECOND_EDITED');
      expect(text(out)).toContain('SECOND_EDITED');
    });

    it.skipIf(noLinks)('follows an edit of the file at the end of a chain (the control)', async () => {
      const dir = makeProject(files);
      symlinkSync(join(dir, 'first.tw'), join(dir, 'mid.tw'));
      symlinkSync(join(dir, 'mid.tw'), join(dir, 'story.tw'));
      const out = await watchStory(bundler, dir, { sources: ['story.tw'] });
      await edited(out, join(dir, 'first.tw'), 'FIRST_EDITED');
      expect(text(out)).toContain('FIRST_EDITED');
    });

    it.skipIf(noRelinkWatch)('recovers when a middle hop dangles, and when the chain is a loop', async () => {
      const dir = makeProject(files);
      symlinkSync(join(dir, 'first.tw'), join(dir, 'mid.tw'));
      symlinkSync(join(dir, 'mid.tw'), join(dir, 'story.tw'));
      const out = await watchStory(bundler, dir, { sources: ['story.tw'] });
      relink(join(dir, 'mid.tw'), join(dir, 'missing.tw'));
      await new Promise((done) => setTimeout(done, 500));
      await relinked(out, join(dir, 'mid.tw'), join(dir, 'second.tw'), 'SECOND');
      relink(join(dir, 'mid.tw'), join(dir, 'story.tw'));
      await new Promise((done) => setTimeout(done, 500));
      await relinked(out, join(dir, 'mid.tw'), join(dir, 'third.tw'), 'THIRD');
      await edited(out, join(dir, 'third.tw'), 'THIRD_EDITED');
      expect(text(out)).toContain('THIRD_EDITED');
    });

    it.skipIf(noRelinkWatch)('follows a module and a head file reached through a chain', async () => {
      const dir = makeProject({
        'story/start.tw': storyWith('FIRST'),
        'mod-a.js': 'window.marker = "MOD_A";',
        'mod-b.js': 'window.marker = "MOD_B";',
        'head-a.html': '<meta name="m" content="head-a">',
        'head-b.html': '<meta name="m" content="head-b">',
      });
      symlinkSync(join(dir, 'mod-a.js'), join(dir, 'mod-mid.js'));
      symlinkSync(join(dir, 'mod-mid.js'), join(dir, 'mod.js'));
      symlinkSync(join(dir, 'head-a.html'), join(dir, 'head-mid.html'));
      symlinkSync(join(dir, 'head-mid.html'), join(dir, 'head.html'));
      const out = await watchStory(bundler, dir, { sources: ['story'], modules: ['mod.js'], headFile: 'head.html' });
      await relinked(out, join(dir, 'mod-mid.js'), join(dir, 'mod-b.js'), '"MOD_B"');
      await relinked(out, join(dir, 'head-mid.html'), join(dir, 'head-b.html'), 'content="head-b"');
      expect(text(out)).toContain('"MOD_B"');
    });
  },
);

describe.each(BUNDLERS)(
  '%s build watch: a source folder reached through a chain of links (#434)',
  { timeout: 60_000 },
  (bundler) => {
    const folders = {
      'first/story.tw': storyWith('FIRST'),
      'second/story.tw': storyWith('SECOND'),
      'third/story.tw': storyWith('THIRD'),
    };

    it.skipIf(noRelinkWatch).each([['the folder', 'current'] as const, ['a file in it', 'current/story.tw'] as const])(
      'follows a retarget of a middle hop and of the named link when the source is %s',
      async (_name, source) => {
        const dir = makeProject(folders);
        symlinkSync(join(dir, 'first'), join(dir, 'mid'));
        symlinkSync(join(dir, 'mid'), join(dir, 'current'));
        const out = await watchStory(bundler, dir, { sources: [source] });
        await relinked(out, join(dir, 'mid'), join(dir, 'second'), 'SECOND');
        await edited(out, join(dir, 'second/story.tw'), 'SECOND_EDITED');
        await relinked(out, join(dir, 'current'), join(dir, 'third'), 'THIRD');
        await edited(out, join(dir, 'third/story.tw'), 'THIRD_EDITED');
        expect(text(out)).toContain('THIRD_EDITED');
      },
    );

    it.skipIf(noRelinkWatch)('follows a chain of three folder links and a link among the folders above', async () => {
      const dir = makeProject(folders);
      mkdirSync(join(dir, 'x'));
      symlinkSync(join(dir, 'first'), join(dir, 'c'));
      symlinkSync(join(dir, 'c'), join(dir, 'b'));
      symlinkSync(join(dir, 'b'), join(dir, 'x/parent'));
      const out = await watchStory(bundler, dir, { sources: ['x/parent'] });
      await relinked(out, join(dir, 'c'), join(dir, 'second'), 'SECOND');
      await relinked(out, join(dir, 'b'), join(dir, 'third'), 'THIRD');
      await edited(out, join(dir, 'third/story.tw'), 'THIRD_EDITED');
      expect(text(out)).toContain('THIRD_EDITED');
    });
  },
);

describe.skipIf(noLinks)('watchTargets: the links on the way to an input (#434)', () => {
  const none = outputPaths({ files: [], dirs: [] });
  const spelled = (dir: string, names: readonly string[]): string[] => names.map((name) => toPosix(join(dir, name)));

  it('registers every hop of a chain of file links, by real path and as authored', () => {
    const dir = realpathSync(makeProject({ 'first.tw': storyWith('x') }));
    symlinkSync(join(dir, 'first.tw'), join(dir, 'mid.tw'));
    symlinkSync(join(dir, 'mid.tw'), join(dir, 'story.tw'));
    const targets = watchTargets([join(dir, 'story.tw')], () => false, none, 'real');
    expect(targets.sort()).toEqual(spelled(dir, ['first.tw', 'mid.tw', 'story.tw']).sort());
  });

  it('registers every hop of a chain of folder links above and at the input', () => {
    const dir = realpathSync(makeProject({ 'first/story.tw': storyWith('x') }));
    symlinkSync(join(dir, 'first'), join(dir, 'mid'));
    symlinkSync(join(dir, 'mid'), join(dir, 'current'));
    const targets = watchTargets([join(dir, 'current')], () => false, none, 'real');
    expect(targets).toEqual(expect.arrayContaining(spelled(dir, ['mid', 'current', 'first', 'first/story.tw'])));
  });

  it('leaves out a hop that leads to a folder holding a build output', () => {
    const dir = realpathSync(makeProject({ 'first/story.tw': storyWith('x') }));
    symlinkSync(join(dir, 'first'), join(dir, 'mid'));
    symlinkSync(join(dir, 'mid'), join(dir, 'current'));
    const outputs = outputPaths({ files: [], dirs: [join(dir, 'first', 'dist')] });
    expect(watchTargets([join(dir, 'current/story.tw')], () => false, outputs, 'real')).not.toContain(
      toPosix(join(dir, 'mid')),
    );
  });
});

describe.skipIf(noLinks)('watchPlan: given spelling (#434)', () => {
  const none = outputPaths({ files: [], dirs: [] });

  it('lists every link the input is reached through, and where the input leads now', () => {
    const dir = realpathSync(makeProject({ 'first.tw': storyWith('x'), 'x/keep': '' }));
    symlinkSync(join(dir, 'first.tw'), join(dir, 'mid.tw'));
    symlinkSync(join(dir, 'mid.tw'), join(dir, 'x/story.tw'));
    symlinkSync(join(dir, 'x'), join(dir, 'above'));
    const plan = watchPlan([join(dir, 'above/story.tw')], () => false, none, 'given');
    expect(plan.links.sort()).toEqual([join(dir, 'above'), join(dir, 'mid.tw'), join(dir, 'x/story.tw')].sort());
    expect(plan.targets).toEqual([join(dir, 'above/story.tw')]);
    expect([...plan.reals]).toEqual([[join(dir, 'above/story.tw'), join(dir, 'first.tw')]]);
  });

  it('registers nothing for a loop of links, which Rollup would fail on with an error nobody handles', () => {
    const dir = realpathSync(makeProject({}));
    symlinkSync(join(dir, 'b'), join(dir, 'a'));
    symlinkSync(join(dir, 'a'), join(dir, 'b'));
    const plan = watchPlan([join(dir, 'a')], () => false, none, 'given');
    expect(plan.targets).toEqual([]);
    expect(plan.links.sort()).toEqual([join(dir, 'a'), join(dir, 'b')]);
  });
});

describe.skipIf(noRelinkWatch)('createLinkWatch (#434)', () => {
  it('writes its signal file for a link pointed elsewhere, and for nothing else', async () => {
    const dir = makeProject({ 'one.tw': '', 'two.tw': '' });
    const link = join(dir, 'story.tw');
    symlinkSync(join(dir, 'one.tw'), link);
    const watch = createLinkWatch();
    try {
      watch.watch([link]);
      // Events for other names in the folder come first, and the signal still holds the count of none.
      writeFileSync(join(dir, 'other.tw'), 'x');
      rmSync(join(dir, 'other.tw'));
      await applyUntil(
        () => {
          replaceLink(link, join(dir, 'two.tw'));
        },
        () => {
          expect(text(watch.signal)).toBe('1');
        },
      );
      replaceLink(link, join(dir, 'one.tw'));
      await vi.waitFor(() => {
        expect(text(watch.signal)).toBe('2');
      }, settled);
      // A link that is gone leads nowhere.
      rmSync(link);
      await vi.waitFor(() => {
        expect(text(watch.signal)).toBe('3');
      }, settled);
      watch.close();
      expect(() => readFileSync(watch.signal)).toThrow();
    } finally {
      watch.close();
    }
  });
});

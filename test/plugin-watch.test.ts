/**
 * What `rollup --watch` and `vite build --watch` watch for the story: one
 * routine for both plugins (watchTargets), which registers what the compile
 * reads and nothing it leaves out: no file `exclude` matches (D11), no output.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { watch } from 'rollup';
import type { RollupWatcher, RollupWatcherEvent } from 'rollup';
import { outputPaths } from '../src/filesystem.js';
import { sep } from 'node:path';
import { toPosix } from '../src/plugins/paths.js';
import { tweeTsPlugin as rollupPlugin } from '../src/plugins/rollup.js';
import { tweeTsPlugin as vitePlugin } from '../src/plugins/vite.js';
import { watchTargets } from '../src/plugins/watch-targets.js';
import {
  cleanUp,
  COMPILE,
  makeProject,
  SETTLED,
  startBuildWatch,
  STORY,
  storyWith,
  tempDir,
} from './helpers/plugins.js';

afterEach(cleanUp);

const NO_OUTPUTS = outputPaths({ files: [], dirs: [] });

/** watchTargets for `inputs` under `dir`, spelt as given, relative to it. */
function targets(dir: string, inputs: string[], skip: (file: string) => boolean = () => false, outputs = NO_OUTPUTS) {
  const root = toPosix(dir);
  return watchTargets(
    inputs.map((input) => `${root}/${input}`),
    skip,
    outputs,
    'given',
  ).map((target) => target.slice(root.length + 1));
}

describe('watch targets', () => {
  it('spells each target by its real path when asked, for a source reached through a link', () => {
    const real = makeProject({ 'story/start.tw': STORY, 'story/parts/more.tw': STORY });
    const link = join(tempDir(), 'project');
    symlinkSync(real, link, 'junction');
    const story = toPosix(realpathSync.native(join(real, 'story')));
    const authored = toPosix(join(link, 'story'));
    // The link above the input is registered as authored too (#307).
    expect(watchTargets([authored], () => false, NO_OUTPUTS, 'real').sort()).toEqual(
      [story, `${story}/parts`, `${story}/parts/more.tw`, `${story}/start.tw`, toPosix(link)].sort(),
    );
  });

  it('leaves out a link above the input whose target holds a build output, so writing it starts no build', () => {
    const real = makeProject({ 'story/start.tw': STORY });
    const link = join(tempDir(), 'project');
    symlinkSync(real, link, 'junction');
    const outputs = outputPaths({ files: [], dirs: [join(real, 'dist')] });
    expect(watchTargets([toPosix(join(link, 'story'))], () => false, outputs, 'real')).not.toContain(toPosix(link));
  });

  it('registers an input that does not exist yet by its spelling, with the link above it', () => {
    const real = makeProject({ 'story/start.tw': STORY });
    const link = join(tempDir(), 'project');
    symlinkSync(real, link, 'junction');
    const targets = watchTargets([toPosix(join(link, 'later.tw'))], () => false, NO_OUTPUTS, 'real');
    expect(targets).toContain(toPosix(link));
    expect(targets.some((target) => target.endsWith('/later.tw'))).toBe(true);
  });

  it('keeps a literal backslash in a POSIX path and turns only the platform separator into a slash (#308)', () => {
    expect(toPosix(`a${sep}b\\c`)).toBe(sep === '\\' ? 'a/b/c' : `a${sep}b\\c`);
  });

  it('registers a folder, and what it holds, when nothing below it is left out', () => {
    const dir = makeProject({ 'story/a.tw': STORY, 'story/parts/b.tw': '', 'story/parts/deep/c.tw': '' });
    expect(targets(dir, ['story']).sort()).toEqual([
      'story',
      'story/a.tw',
      'story/parts',
      'story/parts/b.tw',
      'story/parts/deep',
      'story/parts/deep/c.tw',
    ]);
  });

  it('lists a folder that holds an excluded file by what it holds, without the excluded file', () => {
    const dir = makeProject({
      'story/a.tw': STORY,
      'story/art/x.png': '',
      'story/art/y.tw': '',
      'story/parts/b.tw': '',
    });
    const skip = (file: string): boolean => file.endsWith('.png');
    expect(targets(dir, ['story'], skip).sort()).toEqual([
      'story/a.tw',
      'story/art/y.tw',
      'story/parts',
      'story/parts/b.tw',
    ]);
  });

  it('registers nothing for an excluded source named directly', () => {
    const dir = makeProject({ 'a.tw': STORY });
    expect(targets(dir, ['a.tw'], () => true)).toEqual([]);
  });

  it('lists a folder that holds an output by what it holds, without the output', () => {
    const dir = makeProject({ 'story/a.tw': STORY, 'story/out/index.html': '', 'story/b.html': '' });
    const outputs = outputPaths({ files: [join(dir, 'story/b.html')], dirs: [join(dir, 'story/out')] });
    expect(targets(dir, ['story'], undefined, outputs)).toEqual(['story/a.tw']);
  });

  it('registers a source that does not exist (yet), but not one that is an output folder', () => {
    const dir = makeProject({});
    expect(targets(dir, ['missing'])).toEqual(['missing']);
    const outputs = outputPaths({ files: [], dirs: [join(dir, 'missing')] });
    expect(targets(dir, ['missing'], undefined, outputs)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('registers no link to a folder, and no folder holding one', () => {
    const dir = makeProject({ 'story/a.tw': STORY, 'other/b.tw': '' });
    symlinkSync(join('..', 'other'), join(dir, 'story', 'link'));
    expect(targets(dir, ['story'])).toEqual(['story/a.tw']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'leaves out a folder below a source that cannot be read, and the folder holding it',
    () => {
      const dir = makeProject({ 'story/a.tw': STORY });
      mkdirSync(join(dir, 'story', 'locked'));
      chmodSync(join(dir, 'story', 'locked'), 0o000);
      try {
        expect(targets(dir, ['story'])).toEqual(['story/a.tw']);
      } finally {
        chmodSync(join(dir, 'story', 'locked'), 0o755);
      }
    },
  );
});

/** A plugin, for Rollup and Vite alike, that records every path whose change the bundler's watcher reports. */
function recordChanges(changes: string[]): { name: string; watchChange(id: string): void } {
  return {
    name: 'record-changes',
    watchChange(id) {
      changes.push(toPosix(id));
    },
  };
}

/** Waits for the watcher's next END; returns the events up to it. */
function nextBuild(started: RollupWatcher): Promise<RollupWatcherEvent[]> {
  const events: RollupWatcherEvent[] = [];
  return new Promise((done) => {
    const listener = (event: RollupWatcherEvent): void => {
      if (event.code === 'BUNDLE_END') void event.result.close();
      events.push(event);
      if (event.code === 'END') {
        started.off('event', listener);
        done(events);
      }
    };
    started.on('event', listener);
  });
}

/**
 * A project whose story folder holds an excluded image, and whose output is
 * read from `out`. Returns the paths the tests edit.
 */
function excludeProject(): { dir: string; start: string; image: string; exclude: string } {
  const dir = makeProject({ 'story/start.tw': storyWith('OLD_TEXT'), 'story/art/x.png': 'one', 'entry.js': '' });
  // Exclude globs match paths relative to the working directory.
  const exclude = `${toPosix(relative(process.cwd(), join(dir, 'story')))}/**/*.png`;
  return { dir, start: join(dir, 'story', 'start.tw'), image: join(dir, 'story', 'art', 'x.png'), exclude };
}

/**
 * Edits the excluded image, then a source; once the source's edit is built, a
 * rebuild the image started would have been reported before it (the watcher
 * reports changes in order). Returns the changes the watcher reported after the
 * first edit.
 */
async function editExcludedThenSource(
  project: ReturnType<typeof excludeProject>,
  out: string,
  changes: string[],
): Promise<readonly string[]> {
  const saveUntilBuilt = async (text: string): Promise<void> => {
    writeFileSync(project.start, storyWith(text));
    await vi.waitFor(() => {
      // A watcher may not be ready right after the first build; the edit is saved again until it is built.
      if (!readFileSync(out, 'utf-8').includes(text)) writeFileSync(project.start, storyWith(text));
      expect(readFileSync(out, 'utf-8')).toContain(text);
    }, SETTLED);
  };
  // A first edit shows the watcher is ready, so it would see the edit to the image.
  await saveUntilBuilt('WARM_TEXT');
  changes.length = 0;
  writeFileSync(project.image, 'two');
  // A build already under way may read an edit before its event arrives, so the edits are
  // done when the watcher has reported two saves made after the image's: by then it has
  // reported the image too, had it watched it.
  const sourceChanges = (): number => changes.filter((id) => id.endsWith('/start.tw')).length;
  await saveUntilBuilt('NEW_TEXT');
  await vi.waitFor(() => {
    expect(sourceChanges()).toBeGreaterThan(0);
  }, SETTLED);
  const seen = sourceChanges();
  await saveUntilBuilt('LAST_TEXT');
  await vi.waitFor(() => {
    expect(sourceChanges()).toBeGreaterThan(seen);
  }, SETTLED);
  return changes;
}

describe('rollup --watch', { timeout: 30_000 }, () => {
  let watcher: RollupWatcher | undefined;
  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
  });

  it('starts no build for an edit to a file exclude leaves out (D11)', async () => {
    const project = excludeProject();
    const changes: string[] = [];
    const started = watch({
      input: join(project.dir, 'entry.js'),
      plugins: [
        rollupPlugin({
          sources: [join(project.dir, 'story')],
          format: 'test-format-1',
          compileOptions: { ...COMPILE, exclude: [project.exclude] },
        }),
        recordChanges(changes),
      ],
      output: { dir: join(project.dir, 'dist'), format: 'es' },
      watch: { buildDelay: 20 },
      onLog: () => {},
    });
    watcher = started;
    await nextBuild(started);
    const seen = await editExcludedThenSource(project, join(project.dir, 'dist', 'index.html'), changes);
    expect(seen.map((id) => id.split('/').pop())).toContain('start.tw');
    expect(seen.filter((id) => id.endsWith('.png'))).toEqual([]);
  });

  // Rollup's watcher follows a link and reports a change by the name it was given, so the plugin registers the
  // sources as `sources` names them (Vite's watcher reports real paths, so the Vite plugin registers those).
  // Not on Windows: there the folder link is a junction, and removing the temporary folder after Rollup has
  // watched through it fails on the CI runner (ENOTEMPTY).
  it.skipIf(process.platform === 'win32')(
    'rebuilds for an edit made through the real path of a source folder named through a link',
    async () => {
      const project = excludeProject();
      const link = join(tempDir(), 'linked-story');
      symlinkSync(join(project.dir, 'story'), link, 'junction');
      const changes: string[] = [];
      const out = join(project.dir, 'dist', 'index.html');
      const started = watch({
        input: join(project.dir, 'entry.js'),
        plugins: [
          rollupPlugin({ sources: [link], format: 'test-format-1', compileOptions: COMPILE }),
          recordChanges(changes),
        ],
        output: { dir: join(project.dir, 'dist'), format: 'es' },
        watch: { buildDelay: 20 },
        onLog: () => {},
      });
      watcher = started;
      await nextBuild(started);
      await vi.waitFor(() => {
        // A watcher may not be ready right after the first build; the edit is saved again until it is built.
        if (!readFileSync(out, 'utf-8').includes('LINKED_TEXT')) writeFileSync(project.start, storyWith('LINKED_TEXT'));
        expect(readFileSync(out, 'utf-8')).toContain('LINKED_TEXT');
      }, SETTLED);
      const reported = changes.filter((id) => id.endsWith('/start.tw'));
      expect(reported.length).toBeGreaterThan(0);
      expect(reported.filter((id) => !id.startsWith(toPosix(link)))).toEqual([]);
    },
  );
});

describe('vite build --watch', { timeout: 30_000 }, () => {
  it('starts no build for an edit to a file exclude leaves out (D11)', async () => {
    const project = excludeProject();
    const changes: string[] = [];
    await startBuildWatch({
      root: project.dir,
      build: { outDir: join(project.dir, 'dist') },
      plugins: [
        vitePlugin({
          sources: [join(project.dir, 'story')],
          format: 'test-format-1',
          compileOptions: { ...COMPILE, exclude: [project.exclude] },
        }),
        recordChanges(changes),
      ],
    });
    const seen = await editExcludedThenSource(project, join(project.dir, 'dist', 'index.html'), changes);
    expect(seen.map((id) => id.split('/').pop())).toContain('start.tw');
    expect(seen.filter((id) => id.endsWith('.png'))).toEqual([]);
  });
});

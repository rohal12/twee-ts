/**
 * `vite build --watch` with an entry the build bundles separately (a bundler input of its own): the files the entry
 * build read are registered whether it succeeded or failed (#322), and so are the links it read them through (#307).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import type { BuildWatcher } from './helpers/plugins.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { cleanUp, COMPILE, makeProject, SETTLED, STORY } from './helpers/plugins.js';

const watchers: BuildWatcher[] = [];
afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
  await cleanUp();
});

/** Starts `vite build --watch` with the entry bundled separately; returns the events seen so far and the story's path. */
async function watchSeparateEntry(dir: string, entry: string): Promise<{ events: string[]; story: () => string }> {
  const started: unknown = await build({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    plugins: [
      tweeTsPlugin({
        sources: [join(dir, 'story.tw')],
        format: 'test-format-1',
        entry,
        outputFilename: 'story.html',
        compileOptions: COMPILE,
      }),
    ],
    build: { watch: {}, outDir: join(dir, 'out'), rolldownOptions: { input: join(dir, 'outer.js') } },
  });
  const watcher = started as BuildWatcher;
  watchers.push(watcher);
  const events: string[] = [];
  watcher.on('event', (event) => {
    events.push(event.code);
    if (event.code === 'BUNDLE_END') void event.result?.close();
  });
  // The first build ends, or fails.
  await vi.waitFor(() => {
    if (!events.includes('END') && !events.includes('ERROR')) throw new Error('the first build has not finished');
  }, SETTLED);
  return { events, story: () => readFileSync(join(dir, 'out/story.html'), 'utf-8') };
}

const project = (files: Record<string, string>): string =>
  makeProject({ 'story.tw': STORY, 'outer.js': 'globalThis.outer = 1;', ...files });

describe('vite build watch: a separate entry that fails to bundle (#322)', () => {
  it('builds again when an imported file with a syntax error is corrected', async () => {
    const dir = project({ 'app/entry.js': 'import "./dependency.js";', 'app/dependency.js': 'globalThis.v = ;' });
    const { events, story } = await watchSeparateEntry(dir, join(dir, 'app/entry.js'));
    expect(events).toContain('ERROR');
    writeFileSync(join(dir, 'app/dependency.js'), 'globalThis.v = "RECOVERED";');
    await vi.waitFor(() => {
      expect(story()).toContain('RECOVERED');
    }, SETTLED);
  });

  it('builds again when the configured entry itself is corrected', async () => {
    const dir = project({ 'app/entry.js': 'globalThis.v = ;' });
    const { story } = await watchSeparateEntry(dir, join(dir, 'app/entry.js'));
    writeFileSync(join(dir, 'app/entry.js'), 'globalThis.v = "ENTRY_FIXED";');
    await vi.waitFor(() => {
      expect(story()).toContain('ENTRY_FIXED');
    }, SETTLED);
  });

  it('builds again when an import that did not exist is created', async () => {
    const dir = project({ 'app/entry.js': 'import "./later.js";' });
    const { events, story } = await watchSeparateEntry(dir, join(dir, 'app/entry.js'));
    expect(events).toContain('ERROR');
    writeFileSync(join(dir, 'app/later.js'), 'globalThis.v = "CREATED";');
    await vi.waitFor(() => {
      expect(story()).toContain('CREATED');
    }, SETTLED);
  });

  it('builds again when a failing dependency, introduced after a good bundle, is corrected', async () => {
    const dir = project({ 'app/entry.js': 'import "./dependency.js";', 'app/dependency.js': 'globalThis.v = 1;' });
    const { events, story } = await watchSeparateEntry(dir, join(dir, 'app/entry.js'));
    writeFileSync(join(dir, 'app/dependency.js'), 'globalThis.v = ;');
    await vi.waitFor(() => {
      expect(events).toContain('ERROR');
    }, SETTLED);
    writeFileSync(join(dir, 'app/dependency.js'), 'globalThis.v = "BACK";');
    await vi.waitFor(() => {
      expect(story()).toContain('BACK');
    }, SETTLED);
  });
});

describe('vite build watch: a separate entry that imports through a link (#307)', () => {
  // Linux only, as for the sources: the bundler's watcher on macOS reports no replacement of a link.
  it.skipIf(process.platform !== 'linux')(
    'builds again when an imported file link is pointed at another file',
    async () => {
      const dir = project({
        'app/entry.js': 'import "./dependency.js";',
        'app/a.js': 'globalThis.marker = "VERSION_A";',
        'app/b.js': 'globalThis.marker = "VERSION_B";',
      });
      symlinkSync(join(dir, 'app/a.js'), join(dir, 'app/dependency.js'));
      const { story } = await watchSeparateEntry(dir, join(dir, 'app/entry.js'));
      expect(story()).toContain('VERSION_A');
      unlinkSync(join(dir, 'app/dependency.js'));
      symlinkSync(join(dir, 'app/b.js'), join(dir, 'app/dependency.js'));
      await vi.waitFor(() => {
        expect(story()).toContain('VERSION_B');
      }, SETTLED);
      writeFileSync(join(dir, 'app/b.js'), 'globalThis.marker = "VERSION_B_EDITED";');
      await vi.waitFor(() => {
        expect(story()).toContain('VERSION_B_EDITED');
      }, SETTLED);
    },
  );
});

// An absolute import is read from the root only when it is not already a path inside the root, as Vite reads it: the
// entry's own absolute path is no import of a missing file in a folder below the root, whose nearest existing folder,
// the root, would be watched whole, so that any file written there started a build (#320 review).
describe('vite build watch: an entry inside the build given by its absolute path', () => {
  it('builds nothing for a file written in the root that the story does not read', async () => {
    const dir = makeProject({
      'src/story.tw': STORY,
      'src/app/entry.js': 'import "./dependency.js";',
      'src/app/dependency.js': 'globalThis.v = 1;',
    });
    const root = join(dir, 'src');
    const started: unknown = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [
        tweeTsPlugin({
          sources: [join(root, 'story.tw')],
          format: 'test-format-1',
          entry: join(root, 'app/entry.js'),
          outputFilename: 'story.html',
          compileOptions: COMPILE,
        }),
      ],
      build: { watch: {}, outDir: join(dir, 'dist'), emptyOutDir: true },
    });
    const watcher = started as BuildWatcher;
    watchers.push(watcher);
    const events: string[] = [];
    watcher.on('event', (event) => {
      events.push(event.code);
      if (event.code === 'BUNDLE_END') void event.result?.close();
    });
    await vi.waitFor(() => {
      expect(events).toContain('END');
    }, SETTLED);
    // Long enough for the watcher to report it, and for a build it started to begin.
    writeFileSync(join(root, 'notes.txt'), 'unrelated');
    await new Promise((done) => setTimeout(done, 1500));
    expect(events.filter((code) => code === 'START')).toHaveLength(1);
    // A file the entry reads still starts one.
    writeFileSync(join(root, 'app/dependency.js'), 'globalThis.v = "EDITED";');
    await vi.waitFor(() => {
      expect(readFileSync(join(dir, 'dist/story.html'), 'utf-8')).toContain('EDITED');
    }, SETTLED);
  });
});

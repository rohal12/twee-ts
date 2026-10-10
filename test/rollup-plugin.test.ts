import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  rollup,
  watch,
  type OutputOptions,
  type Plugin,
  type RollupBuild,
  type RollupLog,
  type RollupWatcher,
  type RollupWatcherEvent,
} from 'rollup';
import { build } from 'vite';
import { tweeTsPlugin } from '../src/plugins/rollup.js';

const FORMATS = join(__dirname, 'fixtures', 'storyformats');
const COMPILE = { formatPaths: [FORMATS], useTweegoPath: false, noRemote: true };

const STORY_DATA = `:: StoryTitle
T

:: StoryData
{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}
`;

const STORY = `${STORY_DATA}
:: Start
Hello from the story.
`;

/** No passage named Start: the compile reports an error. */
const NO_START = `${STORY_DATA}
:: Other
Hello
`;

/** Start appears twice: the compile reports a warning and still succeeds. */
const DUPLICATE_START = `${STORY}
:: Start
Hello again.
`;

const ENTRY = 'export const answer = 42;\n';

const dirs: string[] = [];
function makeProject(story: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-rollup-'));
  dirs.push(dir);
  const files: Record<string, string> = { 'story/start.tw': story, 'entry.js': ENTRY };
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storyPlugin(dir: string, format = 'test-format-1'): ReturnType<typeof tweeTsPlugin> {
  return tweeTsPlugin({ sources: [join(dir, 'story')], format, compileOptions: COMPILE });
}

interface Built {
  /** The story asset, when the build emitted one. */
  html: string | undefined;
  /** The logs the build sent through Rollup's log channel. */
  logs: RollupLog[];
}

/** Runs a real Rollup build and generate; rejects when either fails. */
async function rollupProject(dir: string, plugin: ReturnType<typeof tweeTsPlugin>, logs: RollupLog[]): Promise<Built> {
  const bundle = await rollup({
    input: join(dir, 'entry.js'),
    plugins: [plugin],
    onLog: (_level, log) => void logs.push(log),
  });
  try {
    const { output } = await bundle.generate({ format: 'es' });
    const asset = output.find((item) => item.type === 'asset' && item.fileName === 'index.html');
    const html = asset?.type === 'asset' ? String(asset.source) : undefined;
    return { html, logs };
  } finally {
    await bundle.close();
  }
}

/** STORY with `text` as its Start passage's text. */
function storyWith(text: string): string {
  return STORY.replace('Hello from the story.', text);
}

/** A passage to delete between two builds. */
const DELETED_PASSAGE = '\n:: Deleted\nDelete me\n';

/** The story's Story JavaScript. */
function userScript(html: string): string {
  return /<script[^>]*id="twine-user-script"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
}

/** Whether the story HTML holds a passage named Deleted. */
function hasDeletedPassage(html: string): boolean {
  return html.includes('name="Deleted"');
}

/**
 * The story's file name for the tests that write it inside the sources. It sorts
 * after start.tw, so a story HTML loaded back would be read last and its
 * passages would replace the edited ones.
 */
const OUTPUT_IN_SOURCES = 'z-output.html';

/** Runs a real Rollup build and writes it with `output`. */
async function writeProject(
  dir: string,
  plugin: ReturnType<typeof tweeTsPlugin>,
  output: OutputOptions,
): Promise<void> {
  const bundle = await rollup({ input: join(dir, 'entry.js'), plugins: [plugin], onLog: () => {} });
  try {
    await bundle.write(output);
  } finally {
    await bundle.close();
  }
}

/**
 * A plugin that records every file whose change Rollup's watcher reports, which
 * starts a rebuild. Unlike counting builds, it tells a change the build caused by
 * writing its own output from a save the test made (which the watcher may report twice).
 */
function recordChanges(changes: string[]): Plugin {
  return {
    name: 'record-changes',
    watchChange(id) {
      changes.push(id);
    },
  };
}

/** Whether `file` is the existing `folder` or inside it, by its path as given or its real path. */
function isInside(file: string, folder: string): boolean {
  return [folder, realpathSync(folder)].some((f) => {
    const rel = relative(f, resolve(file));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/** Runs the plugin's buildStart with a stand-in for Rollup's context; returns the files it registered. */
function watchFiles(plugin: ReturnType<typeof tweeTsPlugin>, watchMode: boolean): string[] {
  const added: string[] = [];
  plugin.buildStart.call({ addWatchFile: (id: string) => added.push(id), warn: () => {}, meta: { watchMode } });
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

  it('registers what a source folder that is the output folder holds, never the folder or its outputs (#187)', () => {
    const dir = makeProject(STORY);
    const story = join(dir, 'story');
    writeFileSync(join(story, 'index.html'), 'last build');
    mkdirSync(join(story, 'parts'));
    writeFileSync(join(story, 'parts', 'more.tw'), ':: More\nMore\n');
    const plugin = storyPlugin(dir);
    // Rollup's watch mode passes the outputs to the options hook before the first build.
    plugin.options({ output: [{ dir: story, format: 'es' }] });
    expect(watchFiles(plugin, true).sort()).toEqual([
      join(story, 'parts'),
      join(story, 'parts', 'more.tw'),
      join(story, 'start.tw'),
    ]);
  });

  it('registers no output folder inside a source folder, nor what it holds', () => {
    const dir = makeProject(STORY);
    const story = join(dir, 'story');
    mkdirSync(join(story, 'build'));
    writeFileSync(join(story, 'build', 'index.html'), 'last build');
    const plugin = storyPlugin(dir);
    plugin.options({ output: { dir: join(story, 'build'), format: 'es' } });
    expect(watchFiles(plugin, true)).toEqual([join(story, 'start.tw')]);
  });

  it.skipIf(process.platform === 'win32')(
    'registers no link to a folder, which source discovery does not follow (#160)',
    () => {
      const dir = makeProject(STORY);
      const story = join(dir, 'story');
      mkdirSync(join(dir, 'dist'));
      symlinkSync('.', join(story, 'self'));
      symlinkSync(join('..', 'dist'), join(story, 'build'));
      symlinkSync('missing', join(story, 'dangling'));
      expect(watchFiles(storyPlugin(dir), true)).toEqual([join(story, 'start.tw')]);
    },
  );

  it.skipIf(process.platform === 'win32')('registers no link to a file the build writes', () => {
    const dir = makeProject(STORY);
    const story = join(dir, 'story');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.html'), 'last build');
    symlinkSync(join('..', 'dist', 'index.html'), join(story, 'last.html'));
    const plugin = storyPlugin(dir);
    plugin.options({ output: { file: join(dir, 'dist', 'index.html'), format: 'es' } });
    expect(watchFiles(plugin, true)).toEqual([join(story, 'start.tw')]);
  });

  describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('with a folder that cannot be read', () => {
    it('skips an unreadable folder below a source', () => {
      const dir = makeProject(STORY);
      const story = join(dir, 'story');
      const locked = join(story, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        expect(watchFiles(storyPlugin(dir), true)).toEqual([join(story, 'start.tw')]);
      } finally {
        chmodSync(locked, 0o755);
      }
    });

    it('still registers an unreadable source folder, so the watcher reports it', () => {
      const dir = makeProject(STORY);
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        const plugin = tweeTsPlugin({ sources: [locked], compileOptions: COMPILE });
        expect(watchFiles(plugin, true)).toEqual([locked]);
      } finally {
        chmodSync(locked, 0o755);
      }
    });

    it('registers nothing for an unreadable source folder that is the output folder', () => {
      const dir = makeProject(STORY);
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        const plugin = tweeTsPlugin({ sources: [locked], compileOptions: COMPILE });
        plugin.options({ output: { dir: locked, format: 'es' } });
        expect(watchFiles(plugin, true)).toEqual([]);
      } finally {
        chmodSync(locked, 0o755);
      }
    });
  });
});

describe('rollup plugin: build', { timeout: 30_000 }, () => {
  it('emits the story as an asset', async () => {
    const dir = makeProject(STORY);
    const { html, logs } = await rollupProject(dir, storyPlugin(dir), []);
    expect(html).toContain('Hello from the story.');
    expect(logs.filter((log) => log.plugin === 'twee-ts')).toEqual([]);
  });

  it('fails the build and emits nothing when the starting passage is missing', async () => {
    const dir = makeProject(NO_START);
    await expect(rollupProject(dir, storyPlugin(dir), [])).rejects.toMatchObject({
      plugin: 'twee-ts',
      message: expect.stringContaining('Starting passage "Start" not found.'),
    });
  });

  it('fails the build on a malformed passage, naming file and line', async () => {
    const dir = makeProject(`${STORY}\n:: Broken [unclosed\nText\n`);
    const error = await rollupProject(dir, storyPlugin(dir), []).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      plugin: 'twee-ts',
      message: expect.stringMatching(/start\.tw:\d+: Malformed twee source/),
      loc: { line: expect.any(Number), column: 1 },
    });
    // The compiler reports the file as it found it, relative to the working directory.
    const { id, loc } = error as { id: string; loc: { file: string } };
    expect(resolve(id)).toBe(join(dir, 'story', 'start.tw'));
    expect(loc.file).toBe(id);
  });

  it('fails the build with the compiler error when the story format is missing', async () => {
    const dir = makeProject(STORY);
    await expect(rollupProject(dir, storyPlugin(dir, 'no-such-format'), [])).rejects.toMatchObject({
      plugin: 'twee-ts',
      message: expect.stringMatching(/no-such-format[\s\S]*No story format available for HTML output\./),
    });
  });

  it("passes warnings through Rollup's log channel and still emits the story", async () => {
    const dir = makeProject(DUPLICATE_START);
    const { html, logs } = await rollupProject(dir, storyPlugin(dir), []);
    expect(html).toContain('Hello again.');
    const warnings = logs.filter((log) => log.plugin === 'twee-ts');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'PLUGIN_WARNING',
      message: expect.stringContaining('Replacing existing passage "Start" with duplicate.'),
    });
  });

  // output.dir puts the story in that folder; output.file puts it next to the file.
  it.each([
    ['output.dir', (dir: string): OutputOptions => ({ dir: join(dir, 'story'), format: 'es' }), 'story'],
    [
      'output.file',
      (dir: string): OutputOptions => ({ file: join(dir, 'story/zz/bundle.js'), format: 'es' }),
      'story/zz',
    ],
  ])(
    'leaves the story of the last build out when %s writes it inside a source folder',
    async (_name, output, storyDir) => {
      const dir = makeProject(storyWith('OLD_TEXT') + DELETED_PASSAGE);
      const plugin = tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        outputFilename: OUTPUT_IN_SOURCES,
        compileOptions: COMPILE,
      });
      await writeProject(dir, plugin, output(dir));
      writeFileSync(join(dir, 'story/start.tw'), storyWith('NEW_TEXT'));
      await writeProject(dir, plugin, output(dir));
      const html = readFileSync(join(dir, storyDir, OUTPUT_IN_SOURCES), 'utf-8');
      expect(html).toContain('NEW_TEXT');
      expect(html).not.toContain('OLD_TEXT');
      expect(hasDeletedPassage(html)).toBe(false);
    },
  );

  type WriteAll = (bundle: RollupBuild, outputs: readonly OutputOptions[]) => Promise<unknown>;
  it.each<[string, WriteAll]>([
    // As the rollup CLI and rollup watch write an output array.
    ['in parallel', (bundle, outputs) => Promise.all(outputs.map((output) => bundle.write(output)))],
    [
      'one after the other',
      async (bundle, outputs) => {
        for (const output of outputs) await bundle.write(output);
      },
    ],
  ])("leaves every output's story out of each compile when several outputs are written %s (#153)", async (_n, all) => {
    const dir = makeProject(storyWith('OLD_TEXT') + DELETED_PASSAGE);
    const plugin = storyPlugin(dir);
    const outDirs = [join(dir, 'story', 'preview'), join(dir, 'dist')];
    const logs: RollupLog[] = [];
    const run = async (): Promise<void> => {
      const bundle = await rollup({
        input: join(dir, 'entry.js'),
        plugins: [plugin],
        onLog: (_level, log) => void logs.push(log),
      });
      try {
        await all(
          bundle,
          outDirs.map((outDir) => ({ dir: outDir, format: 'es' })),
        );
      } finally {
        await bundle.close();
      }
    };
    await run();
    writeFileSync(join(dir, 'story/start.tw'), storyWith('NEW_TEXT'));
    await run();
    for (const outDir of outDirs) {
      const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
      expect(html).toContain('NEW_TEXT');
      expect(html).not.toContain('OLD_TEXT');
      expect(hasDeletedPassage(html)).toBe(false);
    }
    expect(logs.filter((log) => log.plugin === 'twee-ts')).toEqual([]);
  });

  it.each([
    ['fixed', {}, 1],
    ['hashed', { entryFileNames: '[name]-[hash].js' }, 3],
  ])(
    'leaves the chunks it writes into a source folder out of the story (%s chunk names, #184)',
    async (_name, names, chunks) => {
      const dir = makeProject(STORY);
      const plugin = storyPlugin(dir);
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(dir, 'entry.js'), `export const build = ${i};\nconsole.log(build);\n`);
        await writeProject(dir, plugin, { dir: join(dir, 'story'), format: 'es', ...names });
        expect(userScript(readFileSync(join(dir, 'story', 'index.html'), 'utf-8'))).toBe('');
      }
      // Rollup never deletes an old hashed chunk; none of them is read either.
      expect(readdirSync(join(dir, 'story')).filter((name) => name.endsWith('.js'))).toHaveLength(chunks);
    },
  );
});

describe('rollup plugin: watch', { timeout: 30_000 }, () => {
  let watcher: RollupWatcher | undefined;

  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
  });

  /**
   * Waits for the watcher's next END, which follows a build that succeeded and
   * one that failed alike; returns the events up to it.
   */
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

  const errorMessages = (events: readonly RollupWatcherEvent[]): string[] =>
    events.flatMap((event) => (event.code === 'ERROR' ? [event.error.message] : []));

  const settled = { timeout: 15_000, interval: 100 };

  it('reports a failed build and keeps watching until the story is fixed', async () => {
    const dir = makeProject(NO_START);
    const outDir = join(dir, 'dist');
    const started = watch({
      input: join(dir, 'entry.js'),
      plugins: [storyPlugin(dir)],
      output: { dir: outDir, format: 'es' },
      watch: { buildDelay: 50 },
      onLog: () => {},
    });
    watcher = started;

    const failed = await nextBuild(started);
    expect(errorMessages(failed)).toEqual([expect.stringContaining('Starting passage "Start" not found.')]);
    expect(existsSync(join(outDir, 'index.html'))).toBe(false);

    // Rollup's file watcher may not be ready right after the first build; the
    // fix is saved again until a build picks it up.
    const fixed = nextBuild(started);
    const save = (): void => {
      writeFileSync(join(dir, 'story', 'start.tw'), STORY, 'utf-8');
    };
    save();
    const resave = setInterval(save, 250);
    const events = await fixed.finally(() => {
      clearInterval(resave);
    });
    expect(errorMessages(events)).toEqual([]);
    expect(events.map((event) => event.code)).toContain('BUNDLE_END');
    expect(readFileSync(join(outDir, 'index.html'), 'utf-8')).toContain('Hello from the story.');
  });

  it('builds, and rebuilds for an edit, when output.dir is the source folder itself (#187)', async () => {
    const dir = makeProject(storyWith('OLD_TEXT'));
    const story = join(dir, 'story');
    const out = join(story, 'index.html');
    const started = watch({
      input: join(dir, 'entry.js'),
      plugins: [storyPlugin(dir)],
      output: { dir: story, format: 'es' },
      watch: { buildDelay: 50 },
      onLog: () => {},
    });
    watcher = started;

    const first = await nextBuild(started);
    expect(errorMessages(first)).toEqual([]);
    expect(readFileSync(out, 'utf-8')).toContain('OLD_TEXT');
    expect(existsSync(join(story, 'entry.js'))).toBe(true);

    // Rollup's file watcher may not be ready right after the first build; the
    // edit is saved again until a build picks it up.
    const save = (): void => {
      writeFileSync(join(story, 'start.tw'), storyWith('NEW_TEXT'), 'utf-8');
    };
    save();
    const resave = setInterval(save, 250);
    await vi
      .waitFor(() => {
        expect(readFileSync(out, 'utf-8')).toContain('NEW_TEXT');
      }, settled)
      .finally(() => {
        clearInterval(resave);
      });
    expect(readFileSync(out, 'utf-8')).not.toContain('OLD_TEXT');
  });

  it('neither loads nor keeps rebuilding for the files it writes inside a source folder', async () => {
    const dir = makeProject(storyWith('OLD_TEXT') + DELETED_PASSAGE);
    const outDir = join(dir, 'story/z-build');
    const out = join(outDir, OUTPUT_IN_SOURCES);
    const changes: string[] = [];
    const started = watch({
      input: join(dir, 'entry.js'),
      plugins: [
        tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'test-format-1',
          outputFilename: OUTPUT_IN_SOURCES,
          compileOptions: COMPILE,
        }),
        recordChanges(changes),
      ],
      output: { dir: outDir, format: 'es' },
      watch: { buildDelay: 50 },
      onLog: () => {},
    });
    watcher = started;
    started.on('event', (event) => {
      if (event.code === 'BUNDLE_END') void event.result.close();
    });
    await vi.waitFor(() => {
      expect(readFileSync(out, 'utf-8')).toContain('OLD_TEXT');
    }, settled);

    // Rollup's file watcher may not be ready right after the first build; the
    // edit is saved again until a build picks it up.
    const save = (): void => {
      writeFileSync(join(dir, 'story/start.tw'), storyWith('NEW_TEXT'), 'utf-8');
    };
    save();
    const resave = setInterval(save, 250);
    await vi
      .waitFor(() => {
        expect(readFileSync(out, 'utf-8')).toContain('NEW_TEXT');
      }, settled)
      .finally(() => {
        clearInterval(resave);
      });
    const html = readFileSync(out, 'utf-8');
    expect(html).not.toContain('OLD_TEXT');
    expect(hasDeletedPassage(html)).toBe(false);

    // Writing the story and the bundle must start no build of its own. A second save marks
    // the end of the check: the watcher reports changes in the order they happen, so once
    // the save is built, a change from writing the last build would have been reported before it.
    writeFileSync(join(dir, 'story/start.tw'), storyWith('LAST_TEXT'), 'utf-8');
    await vi.waitFor(() => {
      expect(readFileSync(out, 'utf-8')).toContain('LAST_TEXT');
    }, settled);
    expect(changes.map((id) => basename(id))).toContain('start.tw');
    expect(changes.filter((id) => isInside(id, outDir))).toEqual([]);
  });
});

describe('rollup plugin: in a Vite build', { timeout: 30_000 }, () => {
  async function viteBuild(dir: string): Promise<void> {
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      build: { outDir: join(dir, 'dist'), rollupOptions: { input: join(dir, 'entry.js') } },
      plugins: [storyPlugin(dir)],
    });
  }

  it('writes the story', async () => {
    const dir = makeProject(STORY);
    await viteBuild(dir);
    expect(readFileSync(join(dir, 'dist', 'index.html'), 'utf-8')).toContain('Hello from the story.');
  });

  it('fails the build and writes no story when the starting passage is missing', async () => {
    const dir = makeProject(NO_START);
    await expect(viteBuild(dir)).rejects.toThrow('Starting passage "Start" not found.');
    expect(existsSync(join(dir, 'dist', 'index.html'))).toBe(false);
  });
});

// A bundler's build may write its chunks and assets over files of a source folder, but the story it writes there
// is checked as the CLI checks its output: a file of a loadable type that an earlier build didn't write is the
// author's own, and the build fails rather than overwrite it (#402).
describe('rollup plugin: the story over an authored file', { timeout: 30_000 }, () => {
  const AUTHORED_HTML =
    '<!doctype html><html><body><tw-storydata name="Authored" startnode="1" creator="Twine" creator-version="2.6.2" ' +
    'ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" format="Harlowe" format-version="3.3.0" options="" hidden>' +
    '<tw-passagedata pid="1" name="Start" tags="" position="0,0" size="100,100">Authored</tw-passagedata>' +
    '</tw-storydata></body></html>';

  const outputs: readonly [string, string, (dir: string) => OutputOptions][] = [
    ['output.dir', 'story', (dir) => ({ dir: join(dir, 'story'), format: 'es' })],
    ['output.file', 'story/zz', (dir) => ({ file: join(dir, 'story/zz/bundle.js'), format: 'es' })],
  ];

  it.each(outputs)(
    'refuses to overwrite an authored Twine HTML file at the story path (%s)',
    async (_n, where, out) => {
      const dir = makeProject(STORY);
      mkdirSync(join(dir, where), { recursive: true });
      const authored = join(dir, where, 'story.html');
      writeFileSync(authored, AUTHORED_HTML);
      const plugin = tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        outputFilename: 'story.html',
        compileOptions: COMPILE,
      });
      await expect(writeProject(dir, plugin, out(dir))).rejects.toMatchObject({
        plugin: 'twee-ts',
        message: expect.stringContaining('Output file cannot be an input source'),
      });
      expect(readFileSync(authored, 'utf-8')).toBe(AUTHORED_HTML);
    },
  );

  it('refuses an authored Twee file at the story path', async () => {
    const dir = makeProject(STORY);
    const authored = join(dir, 'story', 'story.tw');
    writeFileSync(authored, STORY);
    const plugin = tweeTsPlugin({
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      outputFilename: 'story.tw',
      compileOptions: COMPILE,
    });
    await expect(writeProject(dir, plugin, { dir: join(dir, 'story'), format: 'es' })).rejects.toMatchObject({
      message: expect.stringContaining('Output file cannot be an input source'),
    });
    expect(readFileSync(authored, 'utf-8')).toBe(STORY);
  });

  it('writes over an earlier build of the story, and over a file the sources do not load', async () => {
    const dir = makeProject(STORY);
    const plugin = tweeTsPlugin({
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      outputFilename: 'story.html',
      compileOptions: COMPILE,
    });
    await writeProject(dir, plugin, { dir: join(dir, 'story'), format: 'es' });
    // A new plugin instance, as a new process: the file there is only recognised as a build of twee-ts.
    const next = tweeTsPlugin({
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      outputFilename: 'story.html',
      compileOptions: COMPILE,
    });
    await writeProject(dir, next, { dir: join(dir, 'story'), format: 'es' });
    expect(readFileSync(join(dir, 'story', 'story.html'), 'utf-8')).toContain('Hello from the story.');
  });

  it('leaves a chunk the bundle writes into a source folder alone, as it cannot tell it from an earlier build', async () => {
    const dir = makeProject(STORY);
    const plugin = tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    writeFileSync(join(dir, 'story', 'entry.js'), '/* authored */');
    await writeProject(dir, plugin, { dir: join(dir, 'story'), format: 'es' });
    expect(readFileSync(join(dir, 'story', 'index.html'), 'utf-8')).toContain('Hello from the story.');
  });
});

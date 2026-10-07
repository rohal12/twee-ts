import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  build,
  createLogger,
  createServer,
  type InlineConfig,
  type Logger,
  type Plugin,
  type ViteDevServer,
} from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { toPosix } from '../src/plugins/paths.js';
import { buildWatchSeesFolders, watcherReady, serverUrl } from './helpers/plugins.js';

export const FORMATS = join(__dirname, 'fixtures', 'storyformats');
export const COMPILE = { formatPaths: [FORMATS], useTweegoPath: false, noRemote: true };

export const STORY = `:: StoryData
{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}

:: StoryTitle
Plugin Test

:: Start
Hello from the story.
`;

export const ENTRY = `import './style.css';
const marker: string = 'entry-ok';
(window as unknown as Record<string, string>).marker = marker;
`;

export const STYLE = ':root { --entry-marker: 1; }\n';

const dirs: string[] = [];
export function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-vite-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
  return dir;
}

/**
 * A project reached through a symbolic link to its folder (a junction on Windows,
 * which needs no privilege), as a project under macOS's /var (really /private/var)
 * is. Watchers and bundlers report its files under the real path.
 */
export function makeLinkedProject(files: Record<string, string>): string {
  const real = makeProject(files);
  const holder = mkdtempSync(join(tmpdir(), 'twee-ts-vite-link-'));
  dirs.push(holder);
  const link = join(holder, 'project');
  symlinkSync(real, link, 'junction');
  return link;
}

export function userScript(html: string): string {
  return /<script[^>]*id="twine-user-script"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
}

export function userStylesheet(html: string): string {
  return /<style[^>]*id="twine-user-stylesheet"[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
}

function writeBinary(dir: string, name: string, bytes: number): void {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 7));
}

const ASSET_ENTRY = `import './style.css';
import logo from './img/logo.png';
(window as unknown as Record<string, string>).logo = logo;
`;

const ASSET_STYLE = `@font-face { font-family: t; src: url(./fonts/f.woff2); }
body { background: url(./img/bg.png); }
`;

const KEEP_ENTRY = `import keep from './img/keep.png?no-inline';
(window as unknown as Record<string, string>).keep = keep;
`;

/** A project whose entry uses a font and two images, each above Vite's 4 KiB inline limit. */
function assetProject(): string {
  const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ASSET_ENTRY, 'app/style.css': ASSET_STYLE });
  for (const file of ['app/fonts/f.woff2', 'app/img/bg.png', 'app/img/logo.png']) writeBinary(dir, file, 8192);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * An exclude glob for `pattern` inside the project `dir`. Exclude globs are read
 * relative to the working directory, and the projects live outside it, in the
 * temp folder, where `**` alone doesn't reach.
 */
function excludeGlob(dir: string, pattern: string): string {
  return `${toPosix(relative(process.cwd(), dir))}/${pattern}`;
}

/** STORY with `text` as its Start passage's text. */
function storyWith(text: string): string {
  return STORY.replace('Hello from the story.', text);
}

/** A passage to delete between two builds. */
const DELETED_PASSAGE = '\n:: Deleted\nDelete me\n';

/** Whether the story HTML holds a passage named Deleted. */
function hasDeletedPassage(html: string): boolean {
  return html.includes('name="Deleted"');
}

/**
 * A folder for the build output inside the story sources. Its name sorts after
 * start.tw, so a story HTML loaded back from it would be read last and its
 * passages would replace the edited ones.
 */
function outDirInSources(dir: string): string {
  return join(dir, 'story/z-build');
}

async function buildProject(
  dir: string,
  plugin: ReturnType<typeof tweeTsPlugin>,
  buildOptions: Record<string, unknown> = {},
): Promise<string> {
  const outDir = join(dir, 'dist');
  await build({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    build: { outDir, ...buildOptions },
    plugins: [plugin],
  });
  return outDir;
}

function entryPlugin(dir: string): ReturnType<typeof tweeTsPlugin> {
  return tweeTsPlugin({
    sources: [join(dir, 'story')],
    format: 'test-format-1',
    entry: join(dir, 'app/main.ts'),
    compileOptions: COMPILE,
  });
}

describe('vite plugin: build', { timeout: 30_000 }, () => {
  it('bundles the entry into the story and writes only the HTML', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const outDir = await buildProject(
      dir,
      tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'app/main.ts'),
        compileOptions: COMPILE,
      }),
    );
    expect(readdirSync(outDir)).toEqual(['index.html']);
    const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(html).toContain('Hello from the story.');
    expect(userScript(html)).toContain('entry-ok');
    expect(userScript(html)).not.toMatch(/^\s*(import|export)\s/m);
    expect(userStylesheet(html)).toContain('--entry-marker');
  });

  it('entry without CSS: no stylesheet passage and no .css file', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts': '(window as unknown as Record<string, number>).n = 1;\n',
    });
    const outDir = await buildProject(
      dir,
      tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'app/main.ts'),
        compileOptions: COMPILE,
      }),
    );
    expect(readdirSync(outDir)).toEqual(['index.html']);
    const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(html).not.toContain('twee-ts-entry.css');
    expect(userScript(html)).toContain('window.n');
  });

  it('without an entry: needs no index.html and writes only the story', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const outDir = await buildProject(
      dir,
      tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE }),
    );
    expect(readdirSync(outDir)).toEqual(['index.html']);
    expect(readFileSync(join(outDir, 'index.html'), 'utf-8')).toContain('Hello from the story.');
  });

  it('leaves the files compileOptions.exclude matches out of the story', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    writeBinary(dir, 'story/art/scene.png', 64);
    const outDir = await buildProject(
      dir,
      tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        compileOptions: { ...COMPILE, exclude: [excludeGlob(dir, 'story/art/**')] },
      }),
    );
    const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(html).toContain('Hello from the story.');
    expect(html).not.toContain('Twine.image');
  });

  it('leaves the HTML of the last build out of the story when it sits inside a source folder', async () => {
    const dir = makeProject({ 'story/start.tw': storyWith('OLD_TEXT') + DELETED_PASSAGE });
    const plugin = tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    const buildOptions = { outDir: outDirInSources(dir), emptyOutDir: false };
    await buildProject(dir, plugin, buildOptions);
    writeFileSync(join(dir, 'story/start.tw'), storyWith('NEW_TEXT'));
    await buildProject(dir, plugin, buildOptions);
    const html = readFileSync(join(outDirInSources(dir), 'index.html'), 'utf-8');
    expect(html).toContain('NEW_TEXT');
    expect(html).not.toContain('OLD_TEXT');
    expect(hasDeletedPassage(html)).toBe(false);
  });

  it("leaves every output's story out of each compile when the build has several outputs (#153)", async () => {
    const dir = makeProject({ 'story/start.tw': storyWith('OLD_TEXT') + DELETED_PASSAGE });
    const plugin = tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    const outDirs = [join(dir, 'dist'), join(dir, 'story', 'preview')];
    const buildOptions = {
      emptyOutDir: false,
      rolldownOptions: { output: outDirs.map((outDir) => ({ dir: outDir })) },
    };
    await buildProject(dir, plugin, buildOptions);
    writeFileSync(join(dir, 'story/start.tw'), storyWith('NEW_TEXT'));
    await buildProject(dir, plugin, buildOptions);
    for (const outDir of outDirs) {
      const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
      expect(html).toContain('NEW_TEXT');
      expect(html).not.toContain('OLD_TEXT');
      expect(hasDeletedPassage(html)).toBe(false);
    }
  });

  it.each([
    ['a subfolder of', (dir: string) => outDirInSources(dir)],
    ['the same folder as', (dir: string) => join(dir, 'story')],
  ])(
    'leaves the assets and public files a build writes into %s a source folder out of the story (#184)',
    async (_where, outDirOf) => {
      const dir = makeProject({
        'story/start.tw': STORY,
        'app/main.ts': KEEP_ENTRY,
        'public/vendor.js': 'window.vendorLoaded = true;\n',
      });
      writeBinary(dir, 'app/img/keep.png', 8192);
      const outDir = outDirOf(dir);
      for (let build = 1; build <= 2; build++) {
        await buildProject(dir, entryPlugin(dir), { outDir, emptyOutDir: false });
        const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
        expect(html).not.toContain('Twine.image');
        expect(userScript(html)).not.toContain('vendorLoaded');
      }
      expect(readdirSync(outDir)).toEqual(expect.arrayContaining(['keep.png', 'vendor.js']));
    },
  );

  it('without an entry: a root index.html does not replace the story', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'index.html': '<!doctype html><html><head></head><body>vite page</body></html>',
    });
    const outDir = await buildProject(
      dir,
      tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE }),
    );
    expect(readdirSync(outDir)).toEqual(['index.html']);
    expect(readFileSync(join(outDir, 'index.html'), 'utf-8')).toContain('Hello from the story.');
  });

  it('inlines the fonts and images the entry uses, so the HTML stays the only file', async () => {
    const dir = assetProject();
    const outDir = await buildProject(dir, entryPlugin(dir));
    expect(readdirSync(outDir)).toEqual(['index.html']);
    const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(userStylesheet(html)).toContain('data:font/woff2;base64,');
    expect(userStylesheet(html)).toContain('data:image/png;base64,');
    expect(userScript(html)).toContain('data:image/png;base64,');
  });

  it('writes an asset the bundler still emits next to the HTML', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': KEEP_ENTRY });
    writeBinary(dir, 'app/img/keep.png', 8192);
    const outDir = await buildProject(dir, entryPlugin(dir));
    expect(readdirSync(outDir).sort()).toEqual(['index.html', 'keep.png']);
  });

  it('leaves no source-map comment pointing at a file the build does not write', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const outDir = await buildProject(dir, entryPlugin(dir), { sourcemap: true });
    expect(readdirSync(outDir)).toEqual(['index.html']);
    const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(userScript(html)).not.toContain('sourceMappingURL');
    expect(userStylesheet(html)).not.toContain('sourceMappingURL');
  });

  it("keeps an inline source map inside the story with build.sourcemap: 'inline'", async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const outDir = await buildProject(dir, entryPlugin(dir), { sourcemap: 'inline' });
    expect(readdirSync(outDir)).toEqual(['index.html']);
    expect(userScript(readFileSync(join(outDir, 'index.html'), 'utf-8'))).toContain('sourceMappingURL=data:');
  });

  it('fails the build on a malformed passage, naming file and line', async () => {
    const dir = makeProject({
      'story/start.tw': `${STORY}\n:: Broken [unclosed\nText\n`,
      'app/main.ts': ENTRY,
      'app/style.css': STYLE,
    });
    await expect(
      buildProject(
        dir,
        tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'test-format-1',
          entry: join(dir, 'app/main.ts'),
          compileOptions: COMPILE,
        }),
      ),
    ).rejects.toThrow(/start\.tw:\d+: Malformed twee source/);
  });

  it('fails the build when the story format is missing', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    await expect(
      buildProject(
        dir,
        tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'no-such-format',
          entry: join(dir, 'app/main.ts'),
          compileOptions: COMPILE,
        }),
      ),
    ).rejects.toThrow(/no-such-format/);
  });

  it('fails the build on a TypeScript syntax error in the entry', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': 'const = ;\n' });
    await expect(
      buildProject(
        dir,
        tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'test-format-1',
          entry: join(dir, 'app/main.ts'),
          compileOptions: COMPILE,
        }),
      ),
    ).rejects.toThrow(/main\.ts/);
  });
});

/** The watcher `vite build --watch` returns, as far as these tests use it. */
interface BuildWatcher {
  on(event: 'event', listener: (event: { code: string; result?: { close(): unknown } }) => void): unknown;
  close(): Promise<void>;
}

describe('vite plugin: build watch', { timeout: 30_000 }, () => {
  let watcher: BuildWatcher | undefined;

  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
  });

  /** Starts `vite build --watch` and waits for its first build; returns the story's path. */
  async function watchBuild(
    dir: string,
    plugin: ReturnType<typeof tweeTsPlugin>,
    outDir = join(dir, 'dist'),
    extra: Plugin[] = [],
  ): Promise<string> {
    const started = (await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      build: { outDir, watch: {} },
      plugins: [plugin, ...extra],
    })) as unknown as BuildWatcher;
    watcher = started;
    await new Promise<void>((done, fail) => {
      started.on('event', (event) => {
        if (event.code === 'BUNDLE_END') void event.result?.close();
        if (event.code === 'END') done();
        if (event.code === 'ERROR') fail(new Error('the first build failed'));
      });
    });
    return join(outDir, 'index.html');
  }

  const story = (file: string): string => readFileSync(file, 'utf-8');
  const settled = { timeout: 15_000, interval: 100 };

  it('rebuilds when a source changes, is added to a nested folder, or is deleted', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'story/parts/extra.tw': ':: Extra\nEXTRA_TEXT\n' });
    const out = await watchBuild(
      dir,
      tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE }),
    );
    expect(story(out)).toContain('EXTRA_TEXT');

    writeFileSync(join(dir, 'story/start.tw'), STORY.replace('Hello from the story.', 'UPDATED_TEXT'));
    await vi.waitFor(() => {
      expect(story(out)).toContain('UPDATED_TEXT');
    }, settled);

    // The watcher of Vite 8.0 and 8.1 reports no change inside a registered folder;
    // the added file is then read with the next change it does report.
    writeFileSync(join(dir, 'story/parts/added.tw'), ':: Added\nADDED_TEXT\n');
    await vi.waitFor(() => {
      expect(!buildWatchSeesFolders || story(out).includes('ADDED_TEXT')).toBe(true);
    }, settled);

    unlinkSync(join(dir, 'story/parts/extra.tw'));
    await vi.waitFor(() => {
      expect(story(out)).not.toContain('EXTRA_TEXT');
    }, settled);
    expect(story(out)).toContain('ADDED_TEXT');
  });

  it.skipIf(process.platform === 'win32')(
    'rebuilds when a source file name holds a literal backslash, as for an ordinary name (#308)',
    async () => {
      const dir = makeProject({ 'story\\part.tw': STORY });
      const out = await watchBuild(
        dir,
        tweeTsPlugin({ sources: [join(dir, 'story\\part.tw')], format: 'test-format-1', compileOptions: COMPILE }),
      );
      writeFileSync(join(dir, 'story\\part.tw'), STORY.replace('Hello from the story.', 'BACKSLASH_EDIT'));
      await vi.waitFor(() => {
        expect(story(out)).toContain('BACKSLASH_EDIT');
      }, settled);
    },
  );

  // macOS's watcher resolves a registered link to its target, so replacing the link raises no event there.
  it.skipIf(process.platform !== 'linux')(
    'rebuilds when a source link is pointed at another file, then for edits to the new target (#307)',
    async () => {
      const dir = makeProject({
        'first.tw': STORY.replace('Hello from the story.', 'FIRST_TEXT'),
        'second.tw': STORY.replace('Hello from the story.', 'SECOND_TEXT'),
      });
      symlinkSync(join(dir, 'first.tw'), join(dir, 'story.tw'));
      const out = await watchBuild(
        dir,
        tweeTsPlugin({ sources: [join(dir, 'story.tw')], format: 'test-format-1', compileOptions: COMPILE }),
      );
      expect(story(out)).toContain('FIRST_TEXT');

      unlinkSync(join(dir, 'story.tw'));
      symlinkSync(join(dir, 'second.tw'), join(dir, 'story.tw'));
      await vi.waitFor(() => {
        expect(story(out)).toContain('SECOND_TEXT');
      }, settled);

      writeFileSync(join(dir, 'second.tw'), STORY.replace('Hello from the story.', 'SECOND_EDITED'));
      await vi.waitFor(() => {
        expect(story(out)).toContain('SECOND_EDITED');
      }, settled);
    },
  );

  it('rebuilds when a single-file source, the head file or a module changes', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'head.txt': '<meta name="head-marker" content="one">',
      'lib/mod.js': 'window.modMarker = 1;',
    });
    const out = await watchBuild(
      dir,
      tweeTsPlugin({
        sources: [join(dir, 'story/start.tw')],
        format: 'test-format-1',
        compileOptions: { ...COMPILE, headFile: join(dir, 'head.txt'), modules: [join(dir, 'lib')] },
      }),
    );
    expect(story(out)).toContain('content="one"');
    expect(story(out)).toContain('window.modMarker = 1;');

    writeFileSync(join(dir, 'story/start.tw'), STORY.replace('Hello from the story.', 'UPDATED_TEXT'));
    await vi.waitFor(() => {
      expect(story(out)).toContain('UPDATED_TEXT');
    }, settled);

    writeFileSync(join(dir, 'head.txt'), '<meta name="head-marker" content="two">');
    await vi.waitFor(() => {
      expect(story(out)).toContain('content="two"');
    }, settled);

    writeFileSync(join(dir, 'lib/mod.js'), 'window.modMarker = 2;');
    await vi.waitFor(() => {
      expect(story(out)).toContain('window.modMarker = 2;');
    }, settled);
  });

  it('neither loads nor watches its own HTML when it sits inside a source folder', async () => {
    const dir = makeProject({ 'story/start.tw': storyWith('OLD_TEXT') + DELETED_PASSAGE });
    const outDir = outDirInSources(dir);
    const changes: string[] = [];
    const out = await watchBuild(
      dir,
      tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE }),
      outDir,
      [recordChanges(changes)],
    );

    writeFileSync(join(dir, 'story/start.tw'), storyWith('NEW_TEXT'));
    await vi.waitFor(() => {
      expect(story(out)).toContain('NEW_TEXT');
    }, settled);
    expect(story(out)).not.toContain('OLD_TEXT');
    expect(hasDeletedPassage(story(out))).toBe(false);

    // Writing the story must start no build of its own. A second save marks the end of the
    // check: the watcher reports changes in the order they happen, so once the save is
    // built, a change from writing the last build would have been reported before it.
    writeFileSync(join(dir, 'story/start.tw'), storyWith('LAST_TEXT'));
    await vi.waitFor(() => {
      expect(story(out)).toContain('LAST_TEXT');
    }, settled);
    expect(changes.map((id) => basename(id))).toContain('start.tw');
    expect(changes.filter((id) => isInside(id, outDir))).toEqual([]);
  });
});

describe(
  "vite plugin: build watch with the bundler's output.dir in a source folder (#155)",
  { timeout: 30_000 },
  () => {
    let watcher: BuildWatcher | undefined;

    afterEach(async () => {
      await watcher?.close();
      watcher = undefined;
    });

    /** The plugin, with the files its buildStart registers for the watcher added to `files`. */
    interface WatchContext {
      addWatchFile(id: string): void;
    }

    function recordingBuildStart(plugin: Plugin, files: string[]): Plugin {
      const buildStart = plugin.buildStart as (this: WatchContext, options: unknown) => void;
      return {
        ...plugin,
        buildStart(this: WatchContext, options: unknown) {
          const context = new Proxy(this, {
            get(target, key) {
              if (key === 'addWatchFile') {
                return (id: string) => {
                  files.push(id);
                  target.addWatchFile(id);
                };
              }
              const value: unknown = Reflect.get(target, key, target);
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
          });
          buildStart.call(context, options);
        },
      };
    }

    it('watches neither the story it writes nor a folder that holds it, and rebuilds for an edit', async () => {
      const dir = makeProject({ 'story/start.tw': storyWith('OLD_TEXT'), 'story/parts/more.tw': ':: More\nMore\n' });
      // The bundler watches real paths (macOS FSEvents reports nothing else).
      const story = toPosix(realpathSync.native(join(dir, 'story')));
      const preview = join(dir, 'story', 'preview');
      const out = join(preview, 'index.html');
      const files: string[] = [];
      const plugin = tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
      const started = (await build({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        build: { emptyOutDir: false, watch: {}, rolldownOptions: { output: { dir: preview } } },
        plugins: [recordingBuildStart(plugin, files)],
      })) as unknown as BuildWatcher;
      watcher = started;
      await new Promise<void>((done, fail) => {
        started.on('event', (event) => {
          if (event.code === 'BUNDLE_END') void event.result?.close();
          if (event.code === 'END') done();
          if (event.code === 'ERROR') fail(new Error('the first build failed'));
        });
      });
      expect(readFileSync(out, 'utf-8')).toContain('OLD_TEXT');
      // The story folder holds the output folder, so only what it holds is listed; its
      // subfolder holds nothing left out, so it is listed with what it holds.
      expect([...new Set(files)].sort()).toEqual([`${story}/parts`, `${story}/parts/more.tw`, `${story}/start.tw`]);

      writeFileSync(join(dir, 'story/start.tw'), storyWith('NEW_TEXT'));
      await vi.waitFor(
        () => {
          expect(readFileSync(out, 'utf-8')).toContain('NEW_TEXT');
        },
        {
          timeout: 15_000,
          interval: 100,
        },
      );
    });
  },
);

/** Writes a vite.config.mjs that loads the plugin from source, as a project's config file would. */
function writeConfig(dir: string, options: Record<string, unknown>, extra = ''): string {
  const pluginUrl = pathToFileURL(resolve(__dirname, '..', 'src', 'plugins', 'vite.ts')).href;
  const file = join(dir, 'vite.config.mjs');
  writeFileSync(
    file,
    `import { tweeTsPlugin } from ${JSON.stringify(pluginUrl)};\nexport default {\n${extra}  plugins: [tweeTsPlugin(${JSON.stringify(options)})],\n};\n`,
  );
  return file;
}

/**
 * A plugin that records every file whose change the bundler's watcher reports, which
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

function reloadsSent(send: { mock: { calls: unknown[][] } }): number {
  return send.mock.calls.filter(([payload]) => (payload as { type?: string }).type === 'full-reload').length;
}

describe('vite plugin: dev server', { timeout: 30_000 }, () => {
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(
    dir: string,
    plugin?: ReturnType<typeof tweeTsPlugin>,
    configFile?: string,
    extra: InlineConfig = {},
  ): Promise<string> {
    const { server: serverOptions, ...rest } = extra;
    server = await createServer({
      configFile: configFile ?? false,
      root: dir,
      logLevel: 'silent',
      plugins: plugin ? [plugin] : [],
      ...rest,
      server: { host: '127.0.0.1', port: 0, strictPort: false, ...serverOptions },
    });
    await server.listen();
    await watcherReady(server);
    return `${serverUrl(server)}/`;
  }

  async function page(url: string): Promise<string> {
    return (await fetch(url)).text();
  }

  function plugin(
    dir: string,
    extra: Partial<Parameters<typeof tweeTsPlugin>[0]> = {},
  ): ReturnType<typeof tweeTsPlugin> {
    return tweeTsPlugin({
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      entry: join(dir, 'app/main.ts'),
      compileOptions: COMPILE,
      ...extra,
    });
  }

  it('does not loop when the entry sits next to the config file', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'main.ts': ENTRY, 'style.css': STYLE });
    const configFile = writeConfig(dir, {
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      entry: join(dir, 'main.ts'),
      compileOptions: COMPILE,
    });
    const url = await start(dir, undefined, configFile);
    expect(userScript(await page(url))).toContain('entry-ok');
    const send = vi.spyOn(server!.ws, 'send');
    writeFileSync(join(dir, 'main.ts'), ENTRY.replace('entry-ok', 'entry-saved'));
    await vi.waitFor(
      async () => {
        expect(userScript(await page(url))).toContain('entry-saved');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
    // Each bundle of the entry loads the config file, which writes a temporary copy next to
    // it; a plugin that rebuilt for that copy would rebuild forever. The copy's events come
    // from the real watcher, so the test can't hold them back: a second save marks the end
    // of the check instead. A rebuild the copy started shows as a reload beyond the two saves'.
    // (A request compiles again by itself only for the story's files, not for the entry's.)
    writeFileSync(join(dir, 'main.ts'), ENTRY.replace('entry-ok', 'entry-saved-again'));
    await vi.waitFor(
      async () => {
        expect(userScript(await page(url))).toContain('entry-saved-again');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
    expect(reloadsSent(send)).toBe(2);
  });

  it("recovers when a missing import outside the entry's folder is created", async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts':
        "import { mark } from '../shared/util';\n(window as unknown as Record<string, string>).marker = mark;\n",
    });
    const url = await start(dir, plugin(dir));
    expect(await page(url)).not.toContain('Hello from the story.');
    mkdirSync(join(dir, 'shared'));
    writeFileSync(join(dir, 'shared/util.ts'), "export const mark = 'shared-ok';\n");
    await vi.waitFor(
      async () => {
        expect(userScript(await page(url))).toContain('shared-ok');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it("inlines the entry's fonts and images in dev too", async () => {
    const dir = assetProject();
    const url = await start(dir, plugin(dir));
    const html = await page(url);
    expect(userStylesheet(html)).toContain('data:font/woff2;base64,');
    expect(userScript(html)).toContain('data:image/png;base64,');
  });

  it('serves an asset the bundler still emits', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': KEEP_ENTRY });
    writeBinary(dir, 'app/img/keep.png', 8192);
    const url = await start(dir, plugin(dir));
    const response = await fetch(`${url}keep.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect((await response.arrayBuffer()).byteLength).toBe(8192);
  });

  it('picks up a save that keeps the old modification time', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const file = join(dir, 'story/start.tw');
    const coarse = new Date('2026-01-01T00:00:00Z');
    utimesSync(file, coarse, coarse);
    const url = await start(dir, plugin(dir));
    writeFileSync(file, STORY.replace('Hello from the story.', 'Same-second save.'));
    utimesSync(file, coarse, coarse);
    await vi.waitFor(
      async () => {
        expect(await page(url)).toContain('Same-second save.');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('keeps rebuilding after reporting an error fails', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    let broken = true;
    const quiet = createLogger('silent');
    const customLogger: Logger = {
      ...quiet,
      error(message, options) {
        if (broken && message.includes('[twee-ts]')) {
          broken = false;
          throw new Error('the logger broke');
        }
        quiet.error(message, options);
      },
    };
    const url = await start(dir, plugin(dir), undefined, { customLogger });
    const file = join(dir, 'story/start.tw');
    writeFileSync(file, `${STORY}\n:: Broken [unclosed\nText\n`);
    await vi.waitFor(
      () => {
        expect(broken).toBe(false);
      },
      { timeout: 10_000, interval: 50 },
    );
    writeFileSync(file, STORY.replace('Hello from the story.', 'Recovered text.'));
    await vi.waitFor(
      async () => {
        expect(await page(url)).toContain('Recovered text.');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('runs no rebuild after the server closes, in middleware mode too', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    // No file watcher: the test delivers the change itself, while fake timers hold the
    // plugin's debounce, so the change is still waiting when the server closes.
    const mw = await createServer({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      plugins: [plugin(dir)],
    });
    const send = vi.spyOn(mw.ws, 'send');
    const file = join(dir, 'story/start.tw');
    writeFileSync(file, STORY.replace('Hello from the story.', 'Late save.'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mw.watcher.emit('all', 'change', file);
      expect(vi.getTimerCount()).toBe(1);
      await mw.close();
      // Closing cancelled the debounce: no rebuild is left to start.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("without a config file, bundles the entry with the server's define and aliases", async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'lib/mark.ts': "export const libMark = 'alias-ok';\n",
      'app/main.ts':
        "import { libMark } from '@lib/mark';\ndeclare const __DEFINED__: string;\n(window as unknown as Record<string, string>).marks = __DEFINED__ + libMark;\n",
    });
    const url = await start(dir, plugin(dir), undefined, {
      define: { __DEFINED__: JSON.stringify('define-ok') },
      resolve: { alias: { '@lib': join(dir, 'lib') } },
    });
    const script = userScript(await page(url));
    expect(script).toContain('define-ok');
    expect(script).toContain('alias-ok');
  });

  it("bundles the entry even when the user's config turns on build.watch", async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const configFile = writeConfig(
      dir,
      {
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'app/main.ts'),
        compileOptions: COMPILE,
      },
      '  build: { watch: {} },\n',
    );
    const url = await start(dir, undefined, configFile);
    expect(userScript(await page(url))).toContain('entry-ok');
  });

  it("does not print the entry build's own failure message", async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': 'const = ;\n' });
      const url = await start(dir, plugin(dir));
      expect(await page(url)).toContain('/@vite/client');
      expect(printed.mock.calls.flat().join('\n')).not.toMatch(/Build failed/);
    } finally {
      printed.mockRestore();
    }
  });

  it('warns when the entry sits inside the story sources', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const warnings: string[] = [];
    const quiet = createLogger('silent');
    const customLogger: Logger = { ...quiet, warn: (message) => void warnings.push(message) };
    await start(dir, plugin(dir, { sources: [dir] }), undefined, { customLogger });
    expect(warnings.join('\n')).toMatch(/entry \S*main\.ts is inside the story sources/);
  });

  it("serves the story with Vite's client and the bundled entry", async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    const html = await page(url);
    expect(html).toContain('<script type="module" src="/@vite/client"></script>');
    expect(html).toContain('Hello from the story.');
    expect(userScript(html)).toContain('entry-ok');
    expect(userStylesheet(html)).toContain('--entry-marker');
    expect(await page(`${url}?ignored=1`)).toContain('Hello from the story.');
  });

  it('recompiles after a passage changes and tells the page to reload', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    const send = vi.spyOn(server!.ws, 'send');
    writeFileSync(join(dir, 'story/start.tw'), STORY.replace('Hello from the story.', 'Changed text.'));
    await vi.waitFor(
      async () => {
        expect(await page(url)).toContain('Changed text.');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
    expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '/index.html' });
  });

  it('rebundles when CSS imported by the entry changes', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    writeFileSync(join(dir, 'app/style.css'), ':root { --entry-marker: 2; }\n');
    await vi.waitFor(
      async () => {
        expect(userStylesheet(await page(url))).toMatch(/--entry-marker:\s*2/);
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('rebundles when CSS reached through a nested @import changes', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts': "import './styles/index.css';\n",
      'app/styles/index.css': "@import './base.css';\n",
      'app/styles/base.css': ':root { --nested-marker: 1; }\n',
    });
    const url = await start(dir, plugin(dir));
    expect(userStylesheet(await page(url))).toMatch(/--nested-marker:\s*1/);
    writeFileSync(join(dir, 'app/styles/base.css'), ':root { --nested-marker: 2; }\n');
    await vi.waitFor(
      async () => {
        expect(userStylesheet(await page(url))).toMatch(/--nested-marker:\s*2/);
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('rebundles when a file the entry CSS references with url() changes', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts': "import './styles/index.css';\n",
      'app/styles/index.css': "@import './base.css';\n",
      'app/styles/base.css': 'body { background: url(../img/bg.png); }\n',
    });
    const image = join(dir, 'app/img/bg.png');
    mkdirSync(dirname(image), { recursive: true });
    writeFileSync(image, Buffer.from('first-image'));
    const url = await start(dir, plugin(dir));
    const encoded = (text: string): string => Buffer.from(text).toString('base64');
    expect(userStylesheet(await page(url))).toContain(encoded('first-image'));
    writeFileSync(image, Buffer.from('second-image'));
    await vi.waitFor(
      async () => {
        expect(userStylesheet(await page(url))).toContain(encoded('second-image'));
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it("leaves a shared plugin object's hooks alone across entry rebuilds, and still sees its watch files", async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts': "(window as unknown as Record<string, string>).marker = 'EXTRA' + 'v0';\n",
      'app/extra.txt': 'extra-one',
    });
    const extra = join(dir, 'app/extra.txt');
    const transformHandler = function (this: { addWatchFile(id: string): void }, code: string, id: string) {
      if (!id.endsWith('main.ts')) return null;
      this.addWatchFile(extra);
      return code.replace('EXTRA', readFileSync(extra, 'utf-8'));
    };
    const transform = { order: 'pre' as const, handler: transformHandler };
    const load = (): null => null;
    // One object every load of the config file hands out, as a package-level plugin would be.
    const shared = { name: 'shared-plugin', transform, load };
    const key = '__tweeTsSharedTestPlugin';
    (globalThis as Record<string, unknown>)[key] = shared;
    const pluginUrl = pathToFileURL(resolve(__dirname, '..', 'src', 'plugins', 'vite.ts')).href;
    const configFile = join(dir, 'vite.config.mjs');
    const options = {
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      entry: join(dir, 'app/main.ts'),
      compileOptions: COMPILE,
    };
    writeFileSync(
      configFile,
      `import { tweeTsPlugin } from ${JSON.stringify(pluginUrl)};\n` +
        `export default { plugins: [globalThis[${JSON.stringify(key)}], tweeTsPlugin(${JSON.stringify(options)})] };\n`,
    );
    try {
      const url = await start(dir, undefined, configFile);
      expect(userScript(await page(url))).toContain('extra-one');
      for (const n of [1, 2, 3]) {
        writeFileSync(
          join(dir, 'app/main.ts'),
          `(window as unknown as Record<string, string>).marker = 'EXTRA' + 'v${n}';\n`,
        );
        await vi.waitFor(
          async () => {
            expect(userScript(await page(url))).toContain(`v${n}`);
          },
          {
            timeout: 10_000,
            interval: 100,
          },
        );
      }
      expect(Object.keys(shared)).toEqual(['name', 'transform', 'load']);
      expect(shared.transform).toBe(transform);
      expect(shared.transform.handler).toBe(transformHandler);
      expect(Object.keys(shared.transform)).toEqual(['order', 'handler']);
      expect(shared.load).toBe(load);
      writeFileSync(extra, 'extra-two');
      await vi.waitFor(
        async () => {
          expect(userScript(await page(url))).toContain('extra-two');
        },
        {
          timeout: 10_000,
          interval: 100,
        },
      );
    } finally {
      Reflect.deleteProperty(globalThis, key);
    }
  });

  it('sees the watch files of a plugin in a project reached through a symbolic link', async () => {
    const dir = makeLinkedProject({
      'story/start.tw': STORY,
      'app/main.ts': "(window as unknown as Record<string, string>).marker = 'EXTRA';\n",
      'app/extra.txt': 'link-one',
    });
    const extra = join(dir, 'app/extra.txt');
    const watching = {
      name: 'watching-plugin',
      transform(this: { addWatchFile(id: string): void }, code: string, id: string) {
        if (!id.endsWith('main.ts')) return null;
        this.addWatchFile(extra);
        return code.replace('EXTRA', readFileSync(extra, 'utf-8'));
      },
    };
    const url = await start(dir, undefined, undefined, { plugins: [watching, plugin(dir)] });
    expect(userScript(await page(url))).toContain('link-one');
    writeFileSync(extra, 'link-two');
    await vi.waitFor(
      async () => {
        expect(userScript(await page(url))).toContain('link-two');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
    writeFileSync(join(dir, 'story/start.tw'), STORY.replace('Hello from the story.', 'Linked change.'));
    await vi.waitFor(
      async () => {
        expect(await page(url)).toContain('Linked change.');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('sees the watch files of a plugin that applyToEnvironment returns', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts': "(window as unknown as Record<string, string>).marker = 'EXTRA';\n",
      'app/extra.txt': 'env-one',
    });
    const extra = join(dir, 'app/extra.txt');
    const outer = {
      name: 'env-plugin',
      applyToEnvironment: () => ({
        name: 'env-plugin-inner',
        transform(this: { addWatchFile(id: string): void }, code: string, id: string) {
          if (!id.endsWith('main.ts')) return null;
          this.addWatchFile(extra);
          return code.replace('EXTRA', readFileSync(extra, 'utf-8'));
        },
      }),
    };
    const key = '__tweeTsEnvTestPlugin';
    (globalThis as Record<string, unknown>)[key] = outer;
    const pluginUrl = pathToFileURL(resolve(__dirname, '..', 'src', 'plugins', 'vite.ts')).href;
    const configFile = join(dir, 'vite.config.mjs');
    const options = {
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      entry: join(dir, 'app/main.ts'),
      compileOptions: COMPILE,
    };
    writeFileSync(
      configFile,
      `import { tweeTsPlugin } from ${JSON.stringify(pluginUrl)};\n` +
        `export default { plugins: [globalThis[${JSON.stringify(key)}], tweeTsPlugin(${JSON.stringify(options)})] };\n`,
    );
    try {
      const url = await start(dir, undefined, configFile);
      expect(userScript(await page(url))).toContain('env-one');
      writeFileSync(extra, 'env-two');
      await vi.waitFor(
        async () => {
          expect(userScript(await page(url))).toContain('env-two');
        },
        {
          timeout: 10_000,
          interval: 100,
        },
      );
    } finally {
      Reflect.deleteProperty(globalThis, key);
    }
  });

  it('rebundles when CSS the entry imports with ?inline changes', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts':
        "import css from './styles/index.css?inline';\n(window as unknown as Record<string, string>).css = css;\n",
      'app/styles/index.css': ':root { --inline-marker: 1; }\n',
    });
    const url = await start(dir, plugin(dir));
    expect(userScript(await page(url))).toMatch(/--inline-marker:\s*1/);
    writeFileSync(join(dir, 'app/styles/index.css'), ':root { --inline-marker: 2; }\n');
    await vi.waitFor(
      async () => {
        expect(userScript(await page(url))).toMatch(/--inline-marker:\s*2/);
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('recompiles when the head file changes', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts': ENTRY,
      'app/style.css': STYLE,
      'head.html': '<meta name="head-marker" content="one">',
    });
    const url = await start(dir, plugin(dir, { compileOptions: { ...COMPILE, headFile: join(dir, 'head.html') } }));
    expect(await page(url)).toContain('content="one"');
    writeFileSync(join(dir, 'head.html'), '<meta name="head-marker" content="two">');
    await vi.waitFor(
      async () => {
        expect(await page(url)).toContain('content="two"');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('drops a deleted passage', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'story/extra.tw': ':: Extra\nExtra passage text.\n',
      'app/main.ts': ENTRY,
      'app/style.css': STYLE,
    });
    const url = await start(dir, plugin(dir));
    expect(await page(url)).toContain('Extra passage text.');
    unlinkSync(join(dir, 'story/extra.tw'));
    await vi.waitFor(
      async () => {
        expect(await page(url)).not.toContain('Extra passage text.');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('coalesces rapid saves into one reload and ends on the latest content', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    // No file watcher: the test delivers the watcher events itself. With real events, how
    // far apart they arrive depends on the runner's load and chokidar, not on the plugin.
    const url = await start(dir, plugin(dir), undefined, { server: { watch: null } });
    const send = vi.spyOn(server!.ws, 'send');
    const file = join(dir, 'story/start.tw');
    const emit = (event: 'add' | 'change' | 'unlink'): void => void server!.watcher.emit('all', event, file);
    // Saves 15 ms apart, as an editor that writes by unlink and add produces them. Fake timers
    // drive the plugin's debounce, so the gaps are exactly 15 ms however loaded the machine is.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      unlinkSync(file);
      emit('unlink');
      vi.advanceTimersByTime(15);
      writeFileSync(file, STORY.replace('Hello from the story.', 'First save.'));
      emit('add');
      vi.advanceTimersByTime(15);
      writeFileSync(file, STORY.replace('Hello from the story.', 'Second save.'));
      emit('change');
      vi.advanceTimersByTime(50);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    // A request waits for the compiles under way. With no watcher and no timer left, no
    // other compile can start, so the reloads counted after it are all there will be.
    expect(await page(url)).toContain('Second save.');
    expect(reloadsSent(send)).toBe(1);
    expect(send.mock.calls.some(([payload]) => (payload as { type?: string }).type === 'error')).toBe(false);
  });

  it('ends on the latest content when saves come further apart than the debounce', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    // No file watcher, as above: the test delivers the events, and fake timers make each
    // gap exactly 80 ms, longer than the plugin's debounce, however loaded the machine is.
    const url = await start(dir, plugin(dir), undefined, { server: { watch: null } });
    const send = vi.spyOn(server!.ws, 'send');
    const file = join(dir, 'story/start.tw');
    /** Makes a save, lets its debounce run out, and waits for the compile it starts to report. */
    const save = async (event: 'add' | 'change' | 'unlink', write: () => void): Promise<void> => {
      const reported = send.mock.calls.length;
      write();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        server!.watcher.emit('all', event, file);
        vi.advanceTimersByTime(80);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(
        () => {
          expect(send.mock.calls.length).toBeGreaterThan(reported);
        },
        {
          timeout: 10_000,
          interval: 20,
        },
      );
    };
    await save('unlink', () => {
      unlinkSync(file);
    });
    await save('add', () => {
      writeFileSync(file, STORY.replace('Hello from the story.', 'First save.'));
    });
    await save('change', () => {
      writeFileSync(file, STORY.replace('Hello from the story.', 'Second save.'));
    });
    expect(reloadsSent(send)).toBe(2); // the deleted Start passage is reported as an error
    expect(await page(url)).toContain('Second save.');
  });

  // The watcher can miss changes: after a folder is deleted and created again in
  // quick succession (as `git rebase` does), new files in it go unseen, and under
  // Deno so do edits to the files created with it. These tests run without a
  // watcher, so no event ever arrives.
  it('serves a changed passage that no watcher event announced', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir), undefined, { server: { watch: null } });
    expect(await page(url)).toContain('Hello from the story.');
    writeFileSync(join(dir, 'story/start.tw'), STORY.replace('Hello from the story.', 'Unannounced save.'));
    expect(await page(url)).toContain('Unannounced save.');
  });

  it('serves a story folder deleted and created again with no watcher event', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'story/scenes/old.tw': ':: Old\nOld scene text.\n',
      'app/main.ts': ENTRY,
      'app/style.css': STYLE,
    });
    const url = await start(dir, plugin(dir), undefined, { server: { watch: null } });
    expect(await page(url)).toContain('Old scene text.');
    rmSync(join(dir, 'story/scenes'), { recursive: true });
    mkdirSync(join(dir, 'story/scenes'));
    writeFileSync(join(dir, 'story/scenes/new.tw'), ':: New\nNew scene text.\n');
    const html = await page(url);
    expect(html).toContain('New scene text.');
    expect(html).not.toContain('Old scene text.');
  });

  it('serves a changed head file that no watcher event announced', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'head.html': '<meta name="head-marker" content="first">',
      'app/main.ts': ENTRY,
      'app/style.css': STYLE,
    });
    const headFile = join(dir, 'head.html');
    const url = await start(dir, plugin(dir, { compileOptions: { ...COMPILE, headFile } }), undefined, {
      server: { watch: null },
    });
    expect(await page(url)).toContain('content="first"');
    writeFileSync(headFile, '<meta name="head-marker" content="second">');
    expect(await page(url)).toContain('content="second"');
  });

  it('compiles nothing and reloads nothing for a request when no file changed', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir), undefined, { server: { watch: null } });
    const send = vi.spyOn(server!.ws, 'send');
    await page(url);
    await page(url);
    expect(reloadsSent(send)).toBe(0);
  });

  it('compiles nothing and reloads nothing for a change to an excluded file, announced or not', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    writeBinary(dir, 'story/art/scene.png', 64);
    const compileOptions = { ...COMPILE, exclude: [excludeGlob(dir, 'story/art/**')] };
    const url = await start(dir, plugin(dir, { compileOptions }), undefined, { server: { watch: null } });
    expect(await page(url)).not.toContain('Twine.image');
    const send = vi.spyOn(server!.ws, 'send');
    writeBinary(dir, 'story/art/scene.png', 128);
    writeBinary(dir, 'story/art/new.png', 64);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      server!.watcher.emit('all', 'change', join(dir, 'story/art/scene.png'));
      server!.watcher.emit('all', 'add', join(dir, 'story/art/new.png'));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    // The request compares the inputs with the last compile; the excluded files don't count.
    expect(await page(url)).not.toContain('Twine.image');
    expect(reloadsSent(send)).toBe(0);
  });

  it("leaves a build's HTML inside a source folder out of the story and ignores its changes", async () => {
    const dir = makeProject({ 'story/start.tw': storyWith('OLD_TEXT') + DELETED_PASSAGE });
    const outDir = outDirInSources(dir);
    const storyPlugin = (): ReturnType<typeof tweeTsPlugin> =>
      tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    await buildProject(dir, storyPlugin(), { outDir, emptyOutDir: false });
    const built = join(outDir, 'index.html');
    expect(readFileSync(built, 'utf-8')).toContain('OLD_TEXT');

    writeFileSync(join(dir, 'story/start.tw'), storyWith('NEW_TEXT'));
    const url = await start(dir, storyPlugin(), undefined, { build: { outDir }, server: { watch: null } });
    const html = await page(url);
    expect(html).toContain('NEW_TEXT');
    expect(html).not.toContain('OLD_TEXT');
    expect(hasDeletedPassage(html)).toBe(false);

    // Another build writing the HTML recompiles nothing, announced or not.
    const send = vi.spyOn(server!.ws, 'send');
    writeFileSync(built, readFileSync(built, 'utf-8').replace('OLD_TEXT', 'REBUILT_TEXT'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      server!.watcher.emit('all', 'change', built);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(await page(url)).not.toContain('REBUILT_TEXT');
    expect(reloadsSent(send)).toBe(0);
  });

  it("leaves a build's story out when the bundler's output.dir put it in a source folder (#155)", async () => {
    const dir = makeProject({ 'story/start.tw': storyWith('OLD_TEXT') + DELETED_PASSAGE });
    const preview = join(dir, 'story', 'preview');
    const buildOptions = { emptyOutDir: false, rolldownOptions: { output: { dir: preview } } };
    const storyPlugin = (): ReturnType<typeof tweeTsPlugin> =>
      tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    await buildProject(dir, storyPlugin(), buildOptions);
    expect(readFileSync(join(preview, 'index.html'), 'utf-8')).toContain('OLD_TEXT');

    writeFileSync(join(dir, 'story/start.tw'), storyWith('NEW_TEXT'));
    const url = await start(dir, storyPlugin(), undefined, { build: buildOptions });
    const html = await page(url);
    expect(html).toContain('NEW_TEXT');
    expect(html).not.toContain('OLD_TEXT');
    expect(hasDeletedPassage(html)).toBe(false);
  });

  it('keeps recompiling after server.restart() with the plugin passed inline (#179)', async () => {
    const dir = makeProject({ 'story/start.tw': storyWith('FIRST_TEXT') });
    const url = await start(
      dir,
      tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE }),
    );
    expect(await page(url)).toContain('FIRST_TEXT');
    // The restarted server keeps the plugin instance; closing the old one must not stop it.
    await server!.restart();
    writeFileSync(join(dir, 'story/start.tw'), storyWith('AFTER_RESTART'));
    await vi.waitFor(
      async () => {
        expect(await page(url)).toContain('AFTER_RESTART');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('keeps recompiling after a build with the same plugin instance ends (#179)', async () => {
    const dir = makeProject({ 'story/start.tw': storyWith('FIRST_TEXT') });
    const shared = tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    const url = await start(dir, shared);
    expect(await page(url)).toContain('FIRST_TEXT');
    await buildProject(dir, shared);
    writeFileSync(join(dir, 'story/start.tw'), storyWith('AFTER_BUILD'));
    await vi.waitFor(
      async () => {
        expect(await page(url)).toContain('AFTER_BUILD');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('still recompiles for a module that an exclude glob also matches', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'story/lib/mod.js': 'window.modMarker = 1;',
      'app/main.ts': ENTRY,
      'app/style.css': STYLE,
    });
    const module = join(dir, 'story/lib/mod.js');
    const compileOptions = { ...COMPILE, exclude: [excludeGlob(dir, 'story/lib/**')], modules: [module] };
    const url = await start(dir, plugin(dir, { compileOptions }), undefined, { server: { watch: null } });
    const html = await page(url);
    expect(html).toContain('window.modMarker = 1;');
    expect(userScript(html)).not.toContain('modMarker');
    writeFileSync(module, 'window.modMarker = 2;');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      server!.watcher.emit('all', 'change', module);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(50);
    } finally {
      vi.useRealTimers();
    }
    expect(await page(url)).toContain('window.modMarker = 2;');
  });

  it('rebundles when an excluded file the entry uses changes', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts': "import './style.css';\n",
      'app/style.css': 'body { background: url(../story/art/bg.png); }\n',
    });
    const image = join(dir, 'story/art/bg.png');
    mkdirSync(dirname(image), { recursive: true });
    writeFileSync(image, Buffer.from('first-image'));
    const compileOptions = { ...COMPILE, exclude: [excludeGlob(dir, 'story/art/**')] };
    const url = await start(dir, plugin(dir, { compileOptions }));
    const encoded = (text: string): string => Buffer.from(text).toString('base64');
    const html = await page(url);
    expect(html).not.toContain('Twine.image');
    expect(userStylesheet(html)).toContain(encoded('first-image'));
    writeFileSync(image, Buffer.from('second-image'));
    await vi.waitFor(
      async () => {
        expect(userStylesheet(await page(url))).toContain(encoded('second-image'));
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('shows a malformed passage in the overlay and keeps serving the last good story', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    const send = vi.spyOn(server!.ws, 'send');
    writeFileSync(join(dir, 'story/start.tw'), `${STORY}\n:: Broken [unclosed\nText\n`);
    await vi.waitFor(
      () => {
        expect(send).toHaveBeenCalledWith({
          type: 'error',
          err: expect.objectContaining({
            message: expect.stringMatching(/Malformed twee source/),
            loc: expect.objectContaining({ file: expect.stringMatching(/start\.tw$/) }),
          }),
        });
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(await page(url)).toContain('Hello from the story.');
  });

  it('recovers after a broken entry is fixed', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    const send = vi.spyOn(server!.ws, 'send');
    writeFileSync(join(dir, 'app/main.ts'), 'const = ;\n');
    await vi.waitFor(
      () => {
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
    writeFileSync(join(dir, 'app/main.ts'), ENTRY.replace('entry-ok', 'entry-fixed'));
    await vi.waitFor(
      async () => {
        expect(userScript(await page(url))).toContain('entry-fixed');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
  });

  it('serves a waiting page with the client when the first compile fails', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': 'const = ;\n' });
    const url = await start(dir, plugin(dir));
    const html = await page(url);
    expect(html).toContain('<script type="module" src="/@vite/client"></script>');
    expect(html).not.toContain('Hello from the story.');
  });

  it('keeps working without an entry (existing users)', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const url = await start(dir, plugin(dir, { entry: undefined }));
    const html = await page(url);
    expect(html).toContain('/@vite/client');
    expect(html).toContain('Hello from the story.');
  });

  it("works from a config file: the entry build loads the user's config and the plugin stands aside", async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const configFile = writeConfig(dir, {
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      entry: join(dir, 'app/main.ts'),
      compileOptions: COMPILE,
    });
    const url = await start(dir, undefined, configFile);
    const html = await page(url);
    expect(userScript(html)).toContain('entry-ok');
    expect(html).toContain('Hello from the story.');
  });

  it('serves the story under a non-default base', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir), undefined, { base: '/game/' });
    const html = await page(`${url}game/`);
    expect(html).toContain('<script type="module" src="/game/@vite/client"></script>');
    expect(html).toContain('Hello from the story.');
    expect(await page(`${url}game/index.html`)).toContain('Hello from the story.');
  });
});

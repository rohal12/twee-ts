/**
 * The Vite plugin's hooks called directly, with stand-ins for what Vite passes them.
 * That reaches the branches a real Vite run does not take in this process: the plugin
 * instance an entry build loads from the user's config file runs in Vite's own module
 * graph, and a failing story or an unreadable folder is easier to set up by hand.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import type { TweeTsVitePluginOptions } from '../src/plugins/vite.js';

const FORMATS = join(__dirname, 'fixtures', 'storyformats');
const COMPILE = { formatPaths: [FORMATS], useTweegoPath: false, noRemote: true };
const INNER_BUILD_FLAG = '__tweeTsEntryBuild';
const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello from the story.\n';
const DUPLICATE_START = `${STORY}\n:: Start\nHello again.\n`;
const NO_START = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Other\nHi\n';

interface BuildContext {
  addWatchFile?(id: string): void;
  meta?: { watchMode: boolean };
}

interface BundleContext {
  emitFile(file: { type: 'asset'; fileName: string; source: string }): void;
  warn(message: string): void;
  error(error: Error): never;
}

/** The hooks as the tests call them. */
interface Hooks {
  config(userConfig: Record<string, unknown>, env: { command: string; mode: string }): unknown;
  configResolved(config: unknown): void;
  buildStart(this: BuildContext): void;
  watchChange(id: string): void;
  generateBundle: {
    handler(this: BundleContext, outputOptions: object, bundle: Record<string, unknown>): Promise<void>;
  };
  configureServer(server: unknown): Promise<void>;
}

function hooksOf(options: TweeTsVitePluginOptions): Hooks {
  return tweeTsPlugin(options) as unknown as Hooks;
}

const dirs: string[] = [];
function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-vite-hooks-'));
  dirs.push(dir);
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

/** The parts of Vite's resolved config the plugin reads. */
function resolvedConfig(root: string, build: Record<string, unknown> = {}): unknown {
  return {
    root,
    publicDir: '',
    build: { outDir: 'dist', copyPublicDir: false, ...build },
    logger: { warn: vi.fn() },
  };
}

/** Starts a build the way Vite does and returns the files `buildStart` registers for `--watch`. */
function watchTargets(hooks: Hooks, config: unknown): string[] {
  hooks.config({}, { command: 'build', mode: 'production' });
  hooks.configResolved(config);
  const added: string[] = [];
  hooks.buildStart.call({ addWatchFile: (id) => added.push(id), meta: { watchMode: true } });
  return added;
}

describe('vite plugin hooks: config', () => {
  it('gives a build the stand-in input when the config names none', () => {
    const result = hooksOf({ sources: ['story'] }).config({}, { command: 'build', mode: 'production' });
    expect(JSON.stringify(result)).toContain('virtual:twee-ts-empty-input');
  });

  it('leaves a build alone when the config names an input of its own', () => {
    const hooks = hooksOf({ sources: ['story'] });
    const env = { command: 'build', mode: 'production' };
    expect(hooks.config({ build: { rolldownOptions: { input: 'main.ts' } } }, env)).toBeUndefined();
    expect(hooks.config({ build: { rollupOptions: { input: 'main.ts' } } }, env)).toBeUndefined();
  });

  it('changes nothing for the dev server', () => {
    expect(hooksOf({ sources: ['story'] }).config({}, { command: 'serve', mode: 'development' })).toBeUndefined();
  });
});

describe('vite plugin hooks: the entry build the plugin starts itself', () => {
  const env = { command: 'build', mode: 'production' };

  it('stands aside in every hook', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'main.ts': '' });
    const hooks = hooksOf({ sources: [dir], entry: join(dir, 'main.ts'), compileOptions: COMPILE });
    expect(hooks.config({ [INNER_BUILD_FLAG]: true }, env)).toBeUndefined();

    // The entry sits inside the sources, which warns outside the entry build.
    const config = resolvedConfig(dir) as { logger: { warn: ReturnType<typeof vi.fn> } };
    hooks.configResolved(config);
    expect(config.logger.warn).not.toHaveBeenCalled();

    hooks.watchChange(join(dir, 'story/start.tw'));

    const emitted: unknown[] = [];
    const bundle = { 'a.js': { type: 'chunk' } };
    await hooks.generateBundle.handler.call(
      { emitFile: (file) => emitted.push(file), warn: vi.fn(), error: vi.fn() as never },
      { dir: join(dir, 'dist') },
      bundle,
    );
    expect(emitted).toEqual([]);
    expect(Object.keys(bundle)).toEqual(['a.js']);

    const watcher = { add: vi.fn(), on: vi.fn(), close: vi.fn() };
    await hooks.configureServer({ config: { base: '/', root: dir }, watcher, ws: { on: vi.fn() } });
    expect(watcher.add).not.toHaveBeenCalled();
    expect(watcher.on).not.toHaveBeenCalled();
  });

  it('warns about an entry inside the sources when it is the user-facing instance', () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'main.ts': '' });
    const hooks = hooksOf({ sources: [dir], entry: join(dir, 'main.ts'), compileOptions: COMPILE });
    hooks.config({}, env);
    const config = resolvedConfig(dir) as { logger: { warn: ReturnType<typeof vi.fn> } };
    hooks.configResolved(config);
    expect(config.logger.warn).toHaveBeenCalledWith(expect.stringContaining('is inside the story sources'));
  });
});

describe('vite plugin hooks: build --watch targets', () => {
  it('registers a source file, and skips a source that does not exist', () => {
    const dir = makeProject({ 'one.tw': STORY });
    const hooks = hooksOf({ sources: [join(dir, 'one.tw'), join(dir, 'missing')], compileOptions: COMPILE });
    expect(watchTargets(hooks, resolvedConfig(dir))).toEqual([
      realpathSync.native(join(dir, 'one.tw')).replace(/\\/g, '/'),
    ]);
  });

  // The bundler's watcher reports real paths (macOS FSEvents gives /private/var/… for /var/…), so it
  // must watch real paths: a target named through a link never matches an event, and nothing rebuilds.
  it('registers sources reached through a symbolic link by their real path', () => {
    const real = makeProject({ 'story/start.tw': STORY, 'story/parts/more.tw': STORY });
    const holder = makeProject({});
    const link = join(holder, 'project');
    symlinkSync(real, link, 'junction');
    const hooks = hooksOf({ sources: [join(link, 'story')], compileOptions: COMPILE });
    const story = realpathSync.native(join(real, 'story')).replace(/\\/g, '/');
    expect(watchTargets(hooks, resolvedConfig(link))).toEqual([
      story,
      `${story}/parts`,
      `${story}/parts/more.tw`,
      `${story}/start.tw`,
    ]);
  });

  it.skipIf(process.platform === 'win32')('skips a link to a file the build writes', () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'dist/index.html': 'last build' });
    symlinkSync(join('..', 'dist', 'index.html'), join(dir, 'story', 'last.html'));
    const hooks = hooksOf({ sources: [join(dir, 'story')], compileOptions: COMPILE });
    const targets = watchTargets(hooks, resolvedConfig(dir));
    expect(targets.some((t) => t.endsWith('/last.html'))).toBe(false);
    expect(targets.some((t) => t.endsWith('/start.tw'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips a folder it cannot read', () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const locked = join(dir, 'story', 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const hooks = hooksOf({ sources: [join(dir, 'story')], compileOptions: COMPILE });
      const targets = watchTargets(hooks, resolvedConfig(dir));
      expect(targets.some((t) => t.endsWith('/locked'))).toBe(false);
      expect(targets.some((t) => t.endsWith('/start.tw'))).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('registers nothing when it is not a watch build', () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const hooks = hooksOf({ sources: [join(dir, 'story')] });
    hooks.config({}, { command: 'build', mode: 'production' });
    hooks.configResolved(resolvedConfig(dir));
    const added: string[] = [];
    hooks.buildStart.call({ addWatchFile: (id) => added.push(id), meta: { watchMode: false } });
    expect(added).toEqual([]);
  });

  it("reads the output folder from the bundler's output.dir and leaves it out", () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'story/out/index.html': 'last build' });
    const hooks = hooksOf({ sources: [join(dir, 'story')], compileOptions: COMPILE });
    const config = resolvedConfig(dir, { rolldownOptions: { output: { dir: join(dir, 'story', 'out') } } });
    const targets = watchTargets(hooks, config);
    expect(targets.some((t) => t.includes('/out'))).toBe(false);
    expect(targets.some((t) => t.endsWith('/start.tw'))).toBe(true);
  });

  it('reads an output that only names a file, and an array of outputs', () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'story/bundle.html': 'last build' });
    const hooks = hooksOf({ sources: [join(dir, 'story')], compileOptions: COMPILE });
    const config = resolvedConfig(dir, {
      rolldownOptions: { output: [{ file: join(dir, 'story', 'bundle.html') }, { format: 'es' }] },
    });
    const targets = watchTargets(hooks, config);
    expect(targets.some((t) => t.endsWith('/bundle.html'))).toBe(false);
  });
});

describe('vite plugin hooks: generateBundle', () => {
  /** Runs the hook and returns what the story build emitted and warned about. */
  async function generate(
    options: TweeTsVitePluginOptions,
  ): Promise<{ emitted: { fileName: string; source: string }[]; warnings: string[] }> {
    const hooks = hooksOf(options);
    const emitted: { fileName: string; source: string }[] = [];
    const warnings: string[] = [];
    await hooks.generateBundle.handler.call(
      {
        emitFile: (file) => emitted.push(file),
        warn: (message) => warnings.push(message),
        error: (error) => {
          throw error;
        },
      },
      { dir: join(tmpdir(), 'twee-ts-never-written') },
      {},
    );
    return { emitted, warnings };
  }

  it('emits the story without needing a resolved config, and takes the format from compileOptions', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const { emitted, warnings } = await generate({
      sources: [join(dir, 'story')],
      compileOptions: { ...COMPILE, formatId: 'test-format-1' },
    });
    expect(warnings).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.fileName).toBe('index.html');
    expect(emitted[0]?.source).toContain('Hello from the story.');
  });

  it('passes compile warnings on to the bundler', async () => {
    const dir = makeProject({ 'story/start.tw': DUPLICATE_START });
    const { emitted, warnings } = await generate({
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      compileOptions: COMPILE,
    });
    expect(emitted).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/Replacing existing passage "Start"/);
  });

  it('fails with the compile error, located in the file, and emits nothing', async () => {
    const dir = makeProject({ 'story/start.tw': NO_START });
    const hooks = hooksOf({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    const emitted: unknown[] = [];
    await expect(
      hooks.generateBundle.handler.call(
        {
          emitFile: (file) => emitted.push(file),
          warn: vi.fn(),
          error: (error) => {
            throw error;
          },
        },
        { dir: join(dir, 'dist') },
        {},
      ),
    ).rejects.toThrow(/Start/);
    expect(emitted).toEqual([]);
  });
});

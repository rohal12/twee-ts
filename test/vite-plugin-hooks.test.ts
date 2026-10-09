/**
 * The Vite plugin's hooks called directly, with stand-ins for what Vite passes them.
 * That reaches the branches a real Vite run does not take in this process: hook
 * calls outside a client build, a hook that runs before any config is resolved,
 * and a failing story or an unreadable folder, which are easier to set up by hand.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import type { TweeTsVitePluginOptions } from '../src/plugins/vite.js';
import {} from './helpers/plugins.js';

const FORMATS = join(__dirname, 'fixtures', 'storyformats');
const COMPILE = { formatPaths: [FORMATS], useTweegoPath: false, noRemote: true };
const STORY =
  ':: StoryTitle\nT\n\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello from the story.\n';
const DUPLICATE_START = `${STORY}\n:: Start\nHello again.\n`;
const NO_START = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Other\nHi\n';
const BUILD = { command: 'build', mode: 'production' };
const SERVE = { command: 'serve', mode: 'development' };

interface BuildContext {
  addWatchFile(id: string): void;
  meta: { watchMode: boolean };
  environment: { config: unknown };
}

interface BundleContext {
  emitFile(file: { type: 'asset'; fileName: string; source: string }): void;
  warn(message: string): void;
  error(error: Error | string): never;
  environment: { config: unknown };
}

/** The hooks as the tests call them. */
interface Hooks {
  applyToEnvironment(environment: { name: string }): boolean;
  config(userConfig: Record<string, unknown>, env: { command: string; mode: string }): unknown;
  configEnvironment(name: string, config: Record<string, unknown>, env: { command: string; mode: string }): unknown;
  configResolved(config: unknown): void;
  buildStart(this: BuildContext): Promise<void>;
  watchChange(id: string): void;
  generateBundle: {
    handler(this: BundleContext, outputOptions: object, bundle: Record<string, unknown>): Promise<void>;
  };
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
function resolvedConfig(root: string, build: Record<string, unknown> = {}, command = 'build'): unknown {
  return {
    command,
    root,
    publicDir: '',
    build: { outDir: 'dist', copyPublicDir: false, ...build },
    logger: { warn: vi.fn() },
  };
}

describe('vite plugin hooks: the build input', () => {
  it('gives the client build the stand-in input when the config names none', () => {
    const result = hooksOf({ sources: ['story'] }).configEnvironment('client', {}, BUILD);
    expect(result).toEqual({ build: { rolldownOptions: { input: 'virtual:twee-ts-empty-input' } } });
  });

  /** Configs naming an input of their own: the bundler option, or what Vite reads instead. */
  const OWN_INPUTS: readonly (readonly [string, Record<string, unknown>])[] = [
    ['build.rolldownOptions.input', { build: { rolldownOptions: { input: 'main.ts' } } }],
    ['build.rollupOptions.input', { build: { rollupOptions: { input: 'main.ts' } } }],
    ["Vite 8's top-level input", { input: 'main.ts' }],
    ['build.lib', { build: { lib: { entry: 'lib.ts' } } }],
    ['build.ssr', { build: { ssr: 'server.ts' } }],
  ];

  it.each(OWN_INPUTS)('leaves a build alone when the config names its own input (%s)', (_name, config) => {
    expect(hooksOf({ sources: ['story'] }).configEnvironment('client', config, BUILD)).toBeUndefined();
  });

  it('changes nothing for the dev server or another environment', () => {
    const hooks = hooksOf({ sources: ['story'] });
    expect(hooks.configEnvironment('client', {}, SERVE)).toBeUndefined();
    expect(hooks.configEnvironment('ssr', {}, BUILD)).toBeUndefined();
  });

  it("makes the entry the build's only input, named for the instance, keeping the user's one output", () => {
    const hooks = hooksOf({ sources: ['story'], entry: 'app/main.ts' });
    const result = hooksOf({ sources: ['story'], entry: 'app/main.ts' }).configEnvironment(
      'client',
      { build: { rolldownOptions: { output: { banner: '/* user */', format: 'es' } } } },
      BUILD,
    );
    const settings = JSON.parse(JSON.stringify(result)) as {
      build: { cssCodeSplit: boolean; rolldownOptions: { input: Record<string, string>; output: unknown } };
    };
    expect(settings.build.cssCodeSplit).toBe(false);
    expect(Object.keys(settings.build.rolldownOptions.input)).toEqual([expect.stringMatching(/^twee-ts-entry-\d+$/)]);
    expect(Object.values(settings.build.rolldownOptions.input)).toEqual([join(process.cwd(), 'app/main.ts')]);
    expect(settings.build.rolldownOptions.output).toEqual({
      banner: '/* user */',
      format: 'iife',
      entryFileNames: 'twee-ts-entry.js',
      assetFileNames: '[name][extname]',
    });
    // Each instance names its input differently, so each finds only its own.
    expect(JSON.stringify(hooks.configEnvironment('client', {}, BUILD))).not.toBe(JSON.stringify(result));
  });

  it('bundles the entry with a build of its own when the user writes several outputs', () => {
    const hooks = hooksOf({ sources: ['story'], entry: 'app/main.ts' });
    const config = { build: { rolldownOptions: { output: [{ dir: 'a' }, { dir: 'b' }] } } };
    expect(hooks.configEnvironment('client', config, BUILD)).toEqual({
      build: { rolldownOptions: { input: 'virtual:twee-ts-empty-input' } },
    });
  });

  it('applies to the client environment only', () => {
    const hooks = hooksOf({ sources: ['story'] });
    expect(hooks.applyToEnvironment({ name: 'client' })).toBe(true);
    expect(hooks.applyToEnvironment({ name: 'ssr' })).toBe(false);
    expect(hooks.applyToEnvironment({ name: 'worker' })).toBe(false);
  });
});

describe('vite plugin hooks: configResolved', () => {
  it('warns about an entry inside the sources', () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'main.ts': '' });
    const hooks = hooksOf({ sources: [dir], entry: join(dir, 'main.ts'), compileOptions: COMPILE });
    const config = resolvedConfig(dir) as { logger: { warn: ReturnType<typeof vi.fn> } };
    hooks.configResolved(config);
    expect(config.logger.warn).toHaveBeenCalledWith(expect.stringContaining('is inside the story sources'));
  });

  it('does not warn about an entry outside the sources, or without an entry', () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'main.ts': '' });
    for (const options of [{ entry: join(dir, 'main.ts') }, {}]) {
      const config = resolvedConfig(dir) as { logger: { warn: ReturnType<typeof vi.fn> } };
      hooksOf({ sources: [join(dir, 'story')], ...options }).configResolved(config);
      expect(config.logger.warn).not.toHaveBeenCalled();
    }
  });
});

describe('vite plugin hooks: buildStart', () => {
  /** The files buildStart registers for the build of this config. */
  async function registered(hooks: Hooks, watchMode: boolean, config: unknown): Promise<string[]> {
    const added: string[] = [];
    await hooks.buildStart.call({
      addWatchFile: (id) => added.push(id),
      meta: { watchMode },
      environment: { config },
    });
    return added;
  }

  it('registers the sources for --watch, and nothing outside watch mode', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const hooks = hooksOf({ sources: [join(dir, 'story')], compileOptions: COMPILE });
    const config = resolvedConfig(dir);
    // By real path, as the bundler's watcher reports them (macOS gives /private/var/… for /var/…).
    const story = realpathSync.native(join(dir, 'story')).replace(/\\/g, '/');
    expect(await registered(hooks, true, config)).toEqual([story, `${story}/start.tw`]);
    expect(await registered(hooks, false, config)).toEqual([]);
  });

  it('registers nothing for the dev server or an SSR build', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const hooks = hooksOf({ sources: [join(dir, 'story')], compileOptions: COMPILE });
    expect(await registered(hooks, true, resolvedConfig(dir, {}, 'serve'))).toEqual([]);
    expect(await registered(hooks, true, resolvedConfig(dir, { ssr: true }))).toEqual([]);
    expect(await registered(hooks, true, resolvedConfig(dir))).toHaveLength(2);
  });

  it("leaves out the output folder the bundler's output.dir names, and an output file", async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'story/out/index.html': 'last build', 'story/b.html': 'x' });
    const hooks = hooksOf({ sources: [join(dir, 'story')], compileOptions: COMPILE });
    const config = resolvedConfig(dir, {
      rolldownOptions: { output: [{ dir: join(dir, 'story', 'out') }, { file: join(dir, 'story', 'b.html') }] },
    });
    const targets = await registered(hooks, true, config);
    expect(targets.some((t) => t.includes('/out'))).toBe(false);
    expect(targets.some((t) => t.endsWith('/b.html'))).toBe(false);
    expect(targets.some((t) => t.endsWith('/start.tw'))).toBe(true);
  });
});

describe('vite plugin hooks: generateBundle', () => {
  /** Runs the hook in a build and returns what the story build emitted and warned about. */
  async function generate(
    options: TweeTsVitePluginOptions,
    bundle: Record<string, unknown> = {},
    config: unknown = resolvedConfig(tmpdir()),
  ): Promise<{ emitted: { fileName: string; source: string }[]; warnings: string[] }> {
    const hooks = hooksOf(options);
    const emitted: { fileName: string; source: string }[] = [];
    const warnings: string[] = [];
    await hooks.generateBundle.handler.call(
      {
        emitFile: (file) => emitted.push(file),
        warn: (message) => warnings.push(message),
        error: (error) => {
          throw typeof error === 'string' ? new Error(error) : error;
        },
        environment: { config },
      },
      { dir: join(tmpdir(), 'twee-ts-never-written') },
      bundle,
    );
    return { emitted, warnings };
  }

  it('emits the story', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const { emitted, warnings } = await generate({
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      compileOptions: COMPILE,
    });
    expect(warnings).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.fileName).toBe('index.html');
    expect(emitted[0]?.source).toContain('Hello from the story.');
  });

  it('emits nothing outside a client build', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const options = { sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE };
    expect((await generate(options, {}, resolvedConfig(dir, { ssr: true }))).emitted).toEqual([]);
    expect((await generate(options, {}, resolvedConfig(dir, {}, 'serve'))).emitted).toEqual([]);
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
    await expect(
      generate({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE }),
    ).rejects.toThrow(/Start/);
  });

  it('fails when the bundle already holds a file of the story’s name', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const options = { sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE };
    await expect(generate(options, { 'index.html': { type: 'asset', source: 'landing' } })).rejects.toThrow(
      /already writes a file named index\.html/,
    );
  });
});

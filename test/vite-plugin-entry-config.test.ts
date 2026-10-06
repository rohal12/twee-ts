/**
 * The entry is bundled from the user's whole configuration, in dev as in a
 * build (RC1: D1-D3, the siblings of #222). The dev entry build replays what
 * the server was given (inline settings, CLI flags, the config file) minus the
 * keys ENTRY_BUILD_EXCLUDED_KEYS lists, evaluated for the dev command; so an
 * entry bundles to a script that behaves the same in dev as in a build, except
 * where the config itself branches on the command.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import type { InlineConfig, Plugin } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { ENTRY_BUILD_EXCLUDED_KEYS } from '../src/plugins/vite-entry.js';
import {
  buildFiles,
  cleanUp,
  COMPILE,
  makeProject,
  runEntry,
  SETTLED,
  startServer,
  STORY,
  textOf,
  userScript,
  writeViteConfig,
} from './helpers/plugins.js';

afterEach(cleanUp);

/** The entry's options for a project made by `project()`. */
function pluginOptions(dir: string, outputFilename = 'index.html') {
  return {
    sources: [join(dir, 'story')],
    format: 'test-format-1',
    entry: join(dir, 'app/main.js'),
    outputFilename,
    compileOptions: COMPILE,
  };
}

/** A project whose entry is `entry`, with `files` besides. */
function project(entry: string, files: Record<string, string | Uint8Array> = {}): string {
  return makeProject({ 'story/start.tw': STORY, 'app/main.js': entry, ...files });
}

/** What the entry observed when the story served in dev at `path` (under the base) ran it. */
async function devResult(config: InlineConfig, path = '/'): Promise<unknown> {
  const { url } = await startServer(config);
  const html = await (await fetch(url + path)).text();
  expect(userScript(html)).not.toBe('');
  return runEntry(userScript(html));
}

/** What the entry observed when the story a build wrote as `outputFilename` ran it. */
async function buildResult(config: InlineConfig, outputFilename = 'index.html'): Promise<unknown> {
  const files = await buildFiles(config);
  const script = userScript(textOf(files.get(outputFilename)));
  expect(script).not.toBe('');
  return runEntry(script);
}

/** A plugin that serves `virtual:message` and stamps every `__STAMP__` in the entry. */
function virtualPlugin(stamp: string): Plugin {
  return {
    name: 'test-virtual',
    resolveId: (id) => (id === 'virtual:message' ? '\0virtual:message' : undefined),
    load: (id) => (id === '\0virtual:message' ? 'export default "from-virtual";' : undefined),
    transform: (code, id) => (id.endsWith('main.js') ? code.replace('__STAMP__', JSON.stringify(stamp)) : undefined),
  };
}

/**
 * Each configuration the dev entry build must carry over: what the project
 * holds, the settings given inline (to createServer() and build() alike), the
 * path the story is served at, and what the entry observes with them.
 */
interface ConfigCase {
  readonly name: string;
  readonly entry: string;
  readonly files?: Record<string, string | Uint8Array>;
  readonly config: (dir: string) => InlineConfig;
  readonly path?: string;
  readonly expected: Record<string, unknown>;
}

const CASES: readonly ConfigCase[] = [
  {
    name: 'an inline plugin (virtual module and transform)',
    entry: "import m from 'virtual:message';\nout.m = m;\nout.stamp = __STAMP__;\n",
    config: () => ({ plugins: [virtualPlugin('stamped')] }),
    expected: { m: 'from-virtual', stamp: 'stamped' },
  },
  {
    name: 'define',
    entry: 'out.d = __DEFINED__;\nout.n = __NUMBER__;\n',
    config: () => ({ define: { __DEFINED__: JSON.stringify('define-ok'), __NUMBER__: '42' } }),
    expected: { d: 'define-ok', n: 42 },
  },
  {
    name: 'resolve.alias',
    entry: "import { mark } from '@lib/mark.js';\nout.mark = mark;\n",
    files: { 'lib/mark.js': "export const mark = 'alias-ok';\n" },
    config: (dir) => ({ resolve: { alias: { '@lib': join(dir, 'lib') } } }),
    expected: { mark: 'alias-ok' },
  },
  {
    name: 'resolve.conditions and resolve.extensions',
    entry: "import { which } from 'cond-pkg';\nimport { ext } from './ext';\nout.which = which;\nout.ext = ext;\n",
    files: {
      'node_modules/cond-pkg/package.json': JSON.stringify({
        name: 'cond-pkg',
        exports: { '.': { twee: './twee.js', default: './default.js' } },
      }),
      'node_modules/cond-pkg/twee.js': "export const which = 'twee-condition';\n",
      'node_modules/cond-pkg/default.js': "export const which = 'default';\n",
      'app/ext.mine.js': "export const ext = 'extension-ok';\n",
    },
    config: () => ({ resolve: { conditions: ['twee', 'browser'], extensions: ['.mine.js', '.js'] } }),
    expected: { which: 'twee-condition', ext: 'extension-ok' },
  },
  {
    name: 'base, with an asset emitted separately',
    entry: "import keep from './keep.png?no-inline';\nout.base = import.meta.env.BASE_URL;\nout.keep = keep;\n",
    files: { 'app/keep.png': new Uint8Array(64).fill(7) },
    config: () => ({ base: '/game/' }),
    path: '/game/',
    expected: { base: '/game/', keep: '/game/keep.png' },
  },
  {
    name: 'envPrefix and envDir',
    entry: 'out.x = import.meta.env.GAME_X;\nout.hidden = import.meta.env.VITE_HIDDEN ?? null;\n',
    files: { 'env/.env': 'GAME_X=from-env\nVITE_HIDDEN=no\n' },
    config: (dir) => ({ envPrefix: 'GAME_', envDir: join(dir, 'env') }),
    expected: { x: 'from-env', hidden: null },
  },
  {
    name: 'css.modules',
    entry: "import styles from './a.module.css';\nout.cls = styles.foo;\n",
    files: { 'app/a.module.css': '.foo { color: red; }\n' },
    config: () => ({ css: { modules: { generateScopedName: 'scoped_[local]' } } }),
    expected: { cls: 'scoped_foo' },
  },
  {
    name: 'assetsInclude',
    entry: "import data from './level.dat';\nout.isUrl = data.startsWith('data:');\n",
    files: { 'app/level.dat': 'LEVEL' },
    config: () => ({ assetsInclude: ['**/*.dat'] }),
    expected: { isUrl: true },
  },
  {
    name: 'mode, as import.meta.env sees it',
    entry: 'out.mode = import.meta.env.MODE;\nout.dev = import.meta.env.DEV;\nout.ssr = import.meta.env.SSR;\n',
    config: () => ({ mode: 'staging' }),
    expected: { mode: 'staging', dev: true, ssr: false },
  },
];

describe('vite plugin entry: the same configuration in dev and in a build (RC1, D2)', () => {
  // The build runs in the dev server's mode, so what depends on the mode is the same.
  const asBuild = (config: InlineConfig): InlineConfig => ({ mode: 'development', ...config });

  describe.each(CASES)('$name', ({ entry, files, config, path, expected }) => {
    it('given inline, without a config file', { timeout: 30_000 }, async () => {
      const dir = project(entry, files);
      const inline = (): InlineConfig => ({
        root: dir,
        ...config(dir),
        plugins: [...(config(dir).plugins ?? []), tweeTsPlugin(pluginOptions(dir))],
      });
      const dev = await devResult(inline(), path);
      expect(dev).toEqual(expected);
      expect(await buildResult(asBuild(inline()))).toEqual(dev);
    });

    it('given inline next to a config file (as CLI flags are)', { timeout: 30_000 }, async () => {
      const dir = project(entry, files);
      const configFile = writeViteConfig(
        dir,
        `export default { plugins: [tweeTsPlugin(${JSON.stringify(pluginOptions(dir))})] };`,
      );
      const inline = (): InlineConfig => ({ root: dir, configFile, ...config(dir) });
      const dev = await devResult(inline(), path);
      expect(dev).toEqual(expected);
      expect(await buildResult(asBuild(inline()))).toEqual(dev);
    });
  });

  it('bundles the same when the build bundles the entry by a build of its own (a page of its own as input)', async () => {
    const dir = project("import m from 'virtual:message';\nout.m = m;\nout.base = import.meta.env.BASE_URL;\n", {
      'index.html': '<!doctype html><html><head></head><body>LANDING</body></html>',
    });
    const config = (): InlineConfig => ({
      root: dir,
      base: '/game/',
      plugins: [virtualPlugin('x'), tweeTsPlugin(pluginOptions(dir, 'story.html'))],
    });
    const dev = await devResult(config(), '/game/story.html');
    expect(dev).toEqual({ m: 'from-virtual', base: '/game/' });
    const built = { ...config(), mode: 'development', build: { rolldownOptions: { input: join(dir, 'index.html') } } };
    expect(await buildResult(built, 'story.html')).toEqual(dev);
  });

  it('keeps an inline override of what the config file sets, in dev and in a build', { timeout: 30_000 }, async () => {
    const dir = project("import { mark } from '@lib/mark.js';\nout.d = __DEFINED__;\nout.mark = mark;\n", {
      'file-lib/mark.js': "export const mark = 'file';\n",
      'inline-lib/mark.js': "export const mark = 'inline';\n",
    });
    const configFile = writeViteConfig(
      dir,
      `export default { define: { __DEFINED__: '"file"' }, resolve: { alias: { '@lib': ${JSON.stringify(join(dir, 'file-lib'))} } }, plugins: [tweeTsPlugin(${JSON.stringify(pluginOptions(dir))})] };`,
    );
    const inline = (): InlineConfig => ({
      root: dir,
      configFile,
      define: { __DEFINED__: '"inline"' },
      resolve: { alias: { '@lib': join(dir, 'inline-lib') } },
    });
    const dev = await devResult(inline());
    expect(dev).toEqual({ d: 'inline', mark: 'inline' });
    expect(await buildResult({ ...inline(), mode: 'development' })).toEqual(dev);
  });
});

describe('vite plugin entry: the dev command (D3)', () => {
  const ENTRY = 'out.cmd = __CMD__;\nout.hook = __HOOK__;\nout.marks = ["__MARK__"];\n';

  /** Plugins that each leave a mark only when Vite applies them, and record what their hooks see. */
  function commandPlugins(seen: string[], closed: string[]): Plugin[] {
    const mark =
      (name: string): NonNullable<Plugin['transform']> =>
      (code, id) =>
        id.endsWith('main.js') ? code.replace('"__MARK__"', `"${name}", "__MARK__"`) : undefined;
    return [
      { name: 'only-build', apply: 'build', transform: mark('build'), closeBundle: () => void closed.push('build') },
      { name: 'only-serve', apply: 'serve', transform: mark('serve') },
      { name: 'by-function', apply: (_config, env) => env.command === 'serve', transform: mark('function') },
      {
        name: 'hooks',
        config: (_config, env) => ({ define: { __HOOK__: JSON.stringify(env.command) } }),
        configEnvironment: (name, _config, env) => void seen.push(`${name}:${env.command}`),
        configResolved: (config) => void seen.push(config.command),
      },
    ];
  }

  it(
    "evaluates the config file, apply and the plugins' hooks for the dev command in dev, and for build in a build",
    { timeout: 30_000 },
    async () => {
      const dir = project(ENTRY);
      const configFile = writeViteConfig(
        dir,
        `export default ({ command }) => ({ define: { __CMD__: JSON.stringify(command) }, plugins: [tweeTsPlugin(${JSON.stringify(pluginOptions(dir))})] });`,
      );
      const seen: string[] = [];
      const closed: string[] = [];
      const config = (): InlineConfig => ({ root: dir, configFile, plugins: commandPlugins(seen, closed) });
      expect(await devResult(config())).toEqual({
        cmd: 'serve',
        hook: 'serve',
        marks: ['serve', 'function', '__MARK__'],
      });
      // The entry build saw the dev command too, as the dev server's own instance did.
      expect(seen.filter((command) => !command.includes(':'))).toEqual(['serve', 'serve']);
      expect(seen.filter((command) => command.includes(':'))).toEqual(expect.arrayContaining(['client:serve']));
      expect(seen.filter((command) => command.endsWith(':build'))).toEqual([]);
      expect(closed).toEqual([]);
      expect(await buildResult(config())).toEqual({ cmd: 'build', hook: 'build', marks: ['build', '__MARK__'] });
    },
  );

  it('runs no build-only plugin while the entry is bundled again in dev', { timeout: 30_000 }, async () => {
    const dir = project("out.v = 'one';\n" + ENTRY.replace('__CMD__', '"x"'));
    const seen: string[] = [];
    const closed: string[] = [];
    const { url } = await startServer({
      root: dir,
      plugins: [...commandPlugins(seen, closed), tweeTsPlugin(pluginOptions(dir))],
    });
    writeFileSync(join(dir, 'app/main.js'), "out.v = 'two';\n" + ENTRY.replace('__CMD__', '"x"'));
    await vi.waitFor(async () => {
      expect(userScript(await (await fetch(url)).text())).toContain('two');
    }, SETTLED);
    expect(closed).toEqual([]);
  });
});

describe('vite plugin entry: what the entry build leaves out', () => {
  it('lists exactly the keys that configure servers, logging, or what is built instead of the entry', () => {
    expect(Object.keys(ENTRY_BUILD_EXCLUDED_KEYS).sort()).toEqual(
      [
        'builder',
        'clearScreen',
        'configFile',
        'customLogger',
        'devtools',
        'logLevel',
        'mode',
        'plugins',
        'preview',
        'publicDir',
        'root',
        'server',
      ].sort(),
    );
  });

  it('bundles the entry with every excluded key set, and copies no public file', { timeout: 30_000 }, async () => {
    const dir = project("out.ok = 'bundled';\n", { 'public/robots.txt': 'public' });
    const { url } = await startServer({
      root: dir,
      clearScreen: true,
      builder: {},
      preview: { port: 1 },
      appType: 'mpa',
      server: { headers: { 'X-Test': '1' } },
      build: { lib: { entry: join(dir, 'lib.js'), formats: ['es'] }, ssr: true, write: true, watch: {} },
      plugins: [tweeTsPlugin(pluginOptions(dir))],
    });
    const html = await (await fetch(url)).text();
    expect(runEntry(userScript(html))).toEqual({ ok: 'bundled' });
    expect((await fetch(`${url}/robots.txt`)).status).toBe(200);
  });
});

/** Runs `script` in a child Node process with tsx; resolves to what it printed. */
function runNode(script: string, cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, NO_COLOR: '1', PROJECT: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let printed = '';
    child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (printed += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) => {
      if (code === 0) done(printed);
      else fail(new Error(`the child exited with ${String(code)}:\n${printed}`));
    });
  });
}

/** Lines Vite prints while it bundles. */
const PROGRESS = /transforming|modules transformed|rendering chunks|computing gzip|built in/;

describe('vite plugin entry: quiet entry builds (D1)', () => {
  const pluginUrl = pathToFileURL(resolve(__dirname, '..', 'src', 'plugins', 'vite.ts')).href;
  const options = (dir: string, outputFilename: string): string =>
    JSON.stringify({ ...pluginOptions(dir, outputFilename) });

  it('prints no progress lines in dev, at start or when the entry is bundled again', { timeout: 60_000 }, async () => {
    const dir = project("out.v = 'one';\n");
    const printed = await runNode(
      `import { createServer } from 'vite';
       import { writeFileSync } from 'node:fs';
       import { tweeTsPlugin } from ${JSON.stringify(pluginUrl)};
       const server = await createServer({ configFile: false, root: process.env.PROJECT, logLevel: 'silent',
         server: { host: '127.0.0.1', port: 0 }, plugins: [tweeTsPlugin(${options(dir, 'index.html')})] });
       await server.listen();
       const url = 'http://127.0.0.1:' + server.httpServer.address().port + '/';
       writeFileSync(process.env.PROJECT + '/app/main.js', "out.v = 'two';\\n");
       for (let i = 0; i < 300 && !(await (await fetch(url)).text()).includes('two'); i++) await new Promise((r) => setTimeout(r, 50));
       await server.close();`,
      dir,
    );
    expect(printed).not.toMatch(PROGRESS);
  });

  it('prints no progress lines for an entry bundled by a build of its own', { timeout: 60_000 }, async () => {
    const dir = project("out.v = 'one';\n", { 'index.html': '<html><head></head><body></body></html>' });
    const printed = await runNode(
      `import { build } from 'vite';
       import { tweeTsPlugin } from ${JSON.stringify(pluginUrl)};
       await build({ configFile: false, root: process.env.PROJECT, logLevel: 'silent',
         build: { write: false, rolldownOptions: { input: process.env.PROJECT + '/index.html' } },
         plugins: [tweeTsPlugin(${options(dir, 'story.html')})] });`,
      dir,
    );
    expect(printed).not.toMatch(PROGRESS);
  });
});

describe('vite plugin entry: a config file with the plugin given inline', () => {
  it(
    'evaluates the config file for the dev command in dev, and for build in a build',
    { timeout: 30_000 },
    async () => {
      const dir = project('out.cmd = __CMD__;\nout.d = __FILE__;\n');
      const configFile = join(dir, 'vite.config.mjs');
      writeFileSync(
        configFile,
        'export default ({ command }) => ({ define: { __CMD__: JSON.stringify(command), __FILE__: \'"from-file"\' } });\n',
      );
      const config = (): InlineConfig => ({ root: dir, configFile, plugins: [tweeTsPlugin(pluginOptions(dir))] });
      expect(await devResult(config())).toEqual({ cmd: 'serve', d: 'from-file' });
      expect(await buildResult(config())).toEqual({ cmd: 'build', d: 'from-file' });
    },
  );
});

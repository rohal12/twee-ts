import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { build, createLogger, createServer, type InlineConfig, type Logger, type ViteDevServer } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';

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

function reloadsSent(send: { mock: { calls: unknown[][] } }): number {
  return send.mock.calls.filter(([payload]) => (payload as { type?: string }).type === 'full-reload').length;
}

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
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
    const port = await freePort();
    const { server: serverOptions, ...rest } = extra;
    server = await createServer({
      configFile: configFile ?? false,
      root: dir,
      logLevel: 'silent',
      plugins: plugin ? [plugin] : [],
      ...rest,
      server: { host: '127.0.0.1', port, strictPort: true, ...serverOptions },
    });
    await server.listen();
    return `http://127.0.0.1:${port}/`;
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
    await vi.waitFor(async () => expect(userScript(await page(url))).toContain('entry-saved'), {
      timeout: 10_000,
      interval: 100,
    });
    await new Promise((done) => setTimeout(done, 1500));
    expect(reloadsSent(send)).toBe(1);
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
    await vi.waitFor(async () => expect(userScript(await page(url))).toContain('shared-ok'), {
      timeout: 10_000,
      interval: 100,
    });
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
    await vi.waitFor(async () => expect(await page(url)).toContain('Same-second save.'), {
      timeout: 10_000,
      interval: 100,
    });
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
    await vi.waitFor(() => expect(broken).toBe(false), { timeout: 10_000, interval: 50 });
    writeFileSync(file, STORY.replace('Hello from the story.', 'Recovered text.'));
    await vi.waitFor(async () => expect(await page(url)).toContain('Recovered text.'), {
      timeout: 10_000,
      interval: 100,
    });
  });

  it('runs no rebuild after the server closes, in middleware mode too', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const mw = await createServer({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false },
      plugins: [plugin(dir)],
    });
    const send = vi.spyOn(mw.ws, 'send');
    const changed = new Promise<void>((done) => mw.watcher.once('change', () => done()));
    writeFileSync(join(dir, 'story/start.tw'), STORY.replace('Hello from the story.', 'Late save.'));
    await changed;
    await mw.close();
    await new Promise((done) => setTimeout(done, 500));
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
    await vi.waitFor(async () => expect(await page(url)).toContain('Changed text.'), {
      timeout: 10_000,
      interval: 100,
    });
    expect(send).toHaveBeenCalledWith({ type: 'full-reload' });
  });

  it('rebundles when CSS imported by the entry changes', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    writeFileSync(join(dir, 'app/style.css'), ':root { --entry-marker: 2; }\n');
    await vi.waitFor(async () => expect(userStylesheet(await page(url))).toMatch(/--entry-marker:\s*2/), {
      timeout: 10_000,
      interval: 100,
    });
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
    await vi.waitFor(async () => expect(await page(url)).toContain('content="two"'), {
      timeout: 10_000,
      interval: 100,
    });
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
    await vi.waitFor(async () => expect(await page(url)).not.toContain('Extra passage text.'), {
      timeout: 10_000,
      interval: 100,
    });
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
    await vi.waitFor(async () => expect(await page(url)).toContain('Second save.'), { timeout: 10_000, interval: 100 });
    await new Promise((done) => setTimeout(done, 300));
    expect(reloadsSent(send)).toBe(1);
    expect(send.mock.calls.some(([payload]) => (payload as { type?: string }).type === 'error')).toBe(false);
  });

  it('ends on the latest content when saves come further apart than the debounce', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    const file = join(dir, 'story/start.tw');
    const pause = () => new Promise((done) => setTimeout(done, 80));
    unlinkSync(file);
    await pause();
    writeFileSync(file, STORY.replace('Hello from the story.', 'First save.'));
    await pause();
    writeFileSync(file, STORY.replace('Hello from the story.', 'Second save.'));
    await vi.waitFor(async () => expect(await page(url)).toContain('Second save.'), { timeout: 10_000, interval: 100 });
  });

  it('shows a malformed passage in the overlay and keeps serving the last good story', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    const send = vi.spyOn(server!.ws, 'send');
    writeFileSync(join(dir, 'story/start.tw'), `${STORY}\n:: Broken [unclosed\nText\n`);
    await vi.waitFor(
      () =>
        expect(send).toHaveBeenCalledWith({
          type: 'error',
          err: expect.objectContaining({
            message: expect.stringMatching(/Malformed twee source/),
            loc: expect.objectContaining({ file: expect.stringMatching(/start\.tw$/) }),
          }),
        }),
      { timeout: 10_000, interval: 100 },
    );
    expect(await page(url)).toContain('Hello from the story.');
  });

  it('recovers after a broken entry is fixed', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    const send = vi.spyOn(server!.ws, 'send');
    writeFileSync(join(dir, 'app/main.ts'), 'const = ;\n');
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })), {
      timeout: 10_000,
      interval: 100,
    });
    writeFileSync(join(dir, 'app/main.ts'), ENTRY.replace('entry-ok', 'entry-fixed'));
    await vi.waitFor(async () => expect(userScript(await page(url))).toContain('entry-fixed'), {
      timeout: 10_000,
      interval: 100,
    });
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

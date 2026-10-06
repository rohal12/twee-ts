import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DomUtils, parseDocument } from 'htmlparser2';
import { tmpdir } from 'node:os';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
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
import { compileJavaScript } from './helpers/javascript.js';
import { bundlerOptionsKey, hasEntry, peerRun, watcherReady } from './helpers/plugins.js';

const FORMATS = join(__dirname, 'fixtures', 'storyformats');
const COMPILE = { formatPaths: [FORMATS], useTweegoPath: false, noRemote: true };
const STORY =
  ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nGaps\n\n:: Start\nHello from the story.\n';
const DUPLICATE_START = `${STORY}\n:: Start\nHello again.\n`;
const BROKEN = `${STORY}\n:: Broken [unclosed\nText\n`;

const dirs: string[] = [];
function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-vite-gaps-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
  return dir;
}

let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => {
        done(port);
      });
    });
  });
}

/** Starts a dev server on a free port with no logging unless `customLogger` is given; returns its base URL. */
async function start(dir: string, options: Parameters<typeof tweeTsPlugin>[0], customLogger?: Logger): Promise<string> {
  const port = await freePort();
  server = await createServer({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    ...(customLogger ? { customLogger } : {}),
    plugins: [tweeTsPlugin(options)],
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await server.listen();
  await watcherReady(server);
  return `http://127.0.0.1:${port}/`;
}

/** A logger that keeps what it is given, by level. */
function recordingLogger(): { logger: Logger; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    ...createLogger('silent'),
    warn: (message) => void warnings.push(message),
    error: (message) => void errors.push(message),
  };
  return { logger, warnings, errors };
}

describe('vite plugin: dev server details', { timeout: 30_000 }, () => {
  it('serves the client first when the story format has no <head>', async () => {
    const dir = makeProject({
      'story/start.tw': STORY.replace(':: StoryTitle\nGaps\n\n', ''),
      'formats/headless-1/format.js':
        'window.storyFormat({"name":"Headless","version":"1.0.0","source":"<body>{{STORY_DATA}}</body>"});',
    });
    const url = await start(dir, {
      sources: [join(dir, 'story')],
      format: 'headless-1',
      compileOptions: { ...COMPILE, formatPaths: [join(dir, 'formats')] },
    });
    const html = await (await fetch(url)).text();
    expect(html.startsWith('<script type="module" src="/@vite/client"></script>')).toBe(true);
    expect(html).toContain('Hello from the story.');
  });

  it('serves the story at the name given as outputFilename, and nothing at index.html', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const url = await start(dir, {
      sources: [join(dir, 'story')],
      format: 'test-format-1',
      outputFilename: 'story.html',
      compileOptions: COMPILE,
    });
    expect(await (await fetch(`${url}story.html`)).text()).toContain('Hello from the story.');
    expect((await fetch(`${url}index.html`)).status).toBe(404);
  });

  it('answers a request it does not serve with what Vite would answer', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const url = await start(dir, { sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    expect((await fetch(`${url}nothing-here.txt`)).status).toBe(404);
  });

  it("logs the compile's warnings and still serves the story", async () => {
    const dir = makeProject({ 'story/start.tw': DUPLICATE_START });
    const { logger, warnings } = recordingLogger();
    const url = await start(
      dir,
      { sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE },
      logger,
    );
    expect(warnings.join('\n')).toMatch(/\[twee-ts\] .*start\.tw:\d+: Replacing existing passage "Start"/);
    expect(await (await fetch(url)).text()).toContain('Hello again.');
  });

  it('ignores the temporary copy Vite writes of its config file, which would otherwise start a rebuild', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    await start(dir, { sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    const send = vi.spyOn(server!.ws, 'send');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      server!.watcher.emit('all', 'add', join(dir, 'story', 'vite.config.mjs.timestamp-1727270000000-0a1b2c.mjs'));
      expect(vi.getTimerCount()).toBe(0);
      // A source that really changed does schedule a rebuild.
      server!.watcher.emit('all', 'change', join(dir, 'story', 'start.tw'));
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('shows the last compile error to a page that connects after it happened', async () => {
    const dir = makeProject({ 'story/start.tw': BROKEN });
    const url = await start(dir, { sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    const send = vi.spyOn(server!.ws, 'send');
    const socket = new WebSocket(url.replace('http', 'ws'), 'vite-hmr');
    try {
      await vi.waitFor(
        () => {
          expect(send).toHaveBeenCalledWith({
            type: 'error',
            err: expect.objectContaining({ message: expect.stringMatching(/Malformed twee source/) }),
          });
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      socket.close();
    }
  });

  it.skipIf(!hasEntry)("passes the entry build's warnings on to the dev server's logger", async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts': "export const value = eval('1 + 1');\n",
    });
    const { logger, warnings } = recordingLogger();
    await start(
      dir,
      {
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'app/main.ts'),
        compileOptions: COMPILE,
      },
      logger,
    );
    expect(warnings.join('\n')).toMatch(/eval/i);
  });
});

describe('vite plugin: build details', { timeout: 30_000 }, () => {
  it('writes the story when the config names an input of its own', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'main.js': 'globalThis.ran = true;\n' });
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      build: { outDir: join(dir, 'dist'), [bundlerOptionsKey]: { input: join(dir, 'main.js') } },
      plugins: [tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE })],
    });
    expect(readFileSync(join(dir, 'dist', 'index.html'), 'utf-8')).toContain('Hello from the story.');
  });
});

const ENTRY_STORY_OPTIONS = (dir: string): Parameters<typeof tweeTsPlugin>[0] => ({
  sources: [join(dir, 'story')],
  format: 'test-format-1',
  entry: join(dir, 'app/main.ts'),
  compileOptions: COMPILE,
});

/** The text of the story's user script, where the bundled entry ends up. */
function entryScript(html: string): string {
  return /<script[^>]*id="twine-user-script"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
}

function virtualPlugin(name: string, value: string): Plugin {
  return {
    name: 'test-virtual',
    resolveId(id) {
      if (id === name) return `\0${name}`;
      return undefined;
    },
    load(id) {
      if (id === `\0${name}`) return `export default ${JSON.stringify(value)};`;
      return undefined;
    },
  };
}

function writeViteConfig(dir: string, options: unknown, extra: string): string {
  const pluginUrl = pathToFileURL(resolve(__dirname, '..', 'src', 'plugins', 'vite.ts')).href;
  const file = join(dir, 'vite.config.mjs');
  writeFileSync(
    file,
    `import { tweeTsPlugin } from ${JSON.stringify(pluginUrl)};\nexport default {\n${extra}  plugins: [tweeTsPlugin(${JSON.stringify(options)})],\n};\n`,
  );
  return file;
}

// Loads the plugin from a config file, which finds the repository's Vite (see helpers/plugins.ts).
describe.skipIf(!hasEntry || peerRun)(
  'vite plugin: user configuration in the dev entry build',
  { timeout: 30_000 },
  () => {
    const VIRTUAL_ENTRY = 'import message from "virtual:test-message";\nglobalThis.m = message;\n';

    async function serve(config: InlineConfig): Promise<string> {
      const port = await freePort();
      server = await createServer({
        logLevel: 'silent',
        ...config,
        server: { host: '127.0.0.1', port, strictPort: true },
      });
      await server.listen();
      await watcherReady(server);
      return `http://127.0.0.1:${port}/`;
    }

    it('applies an inline plugin with configFile:false in dev and in a production build', async () => {
      const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': VIRTUAL_ENTRY });
      const config = (): InlineConfig => ({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        plugins: [virtualPlugin('virtual:test-message', 'virtual-ok'), tweeTsPlugin(ENTRY_STORY_OPTIONS(dir))],
      });
      const built = await build({ ...config(), build: { write: false } });
      const results = Array.isArray(built) ? built : [built];
      const outputs = results.flatMap((b) => ('output' in b ? b.output : []));
      const file = outputs.find((o) => o.fileName === 'index.html');
      expect(file && 'source' in file ? String(file.source) : '').toContain('virtual-ok');

      const url = await serve(config());
      const html = await (await fetch(url)).text();
      expect(html).not.toContain('The story has not compiled yet.');
      expect(entryScript(html)).toContain('virtual-ok');
    });

    it('applies a transform-only inline plugin to the dev entry', async () => {
      const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': 'globalThis.marker = "__TOKEN__";\n' });
      const transformer: Plugin = {
        name: 'test-transform',
        transform(code, id) {
          if (id.endsWith('main.ts')) return code.replace('__TOKEN__', 'transformed-ok');
          return undefined;
        },
      };
      const url = await serve({
        configFile: false,
        root: dir,
        plugins: [transformer, tweeTsPlugin(ENTRY_STORY_OPTIONS(dir))],
      });
      expect(entryScript(await (await fetch(url)).text())).toContain('transformed-ok');
    });

    it('keeps an inline define override when a config file also defines the value', async () => {
      const dir = makeProject({
        'story/start.tw': STORY,
        'app/main.ts': 'declare const __VALUE__: string;\nglobalThis.value = __VALUE__;\n',
      });
      const configFile = writeViteConfig(
        dir,
        ENTRY_STORY_OPTIONS(dir),
        `  define: { __VALUE__: JSON.stringify('from-file') },\n`,
      );
      const url = await serve({ configFile, root: dir, define: { __VALUE__: JSON.stringify('from-inline') } });
      const script = entryScript(await (await fetch(url)).text());
      expect(script).toContain('from-inline');
      expect(script).not.toContain('from-file');
    });

    it('applies inline plugins and aliases next to a config file', async () => {
      const dir = makeProject({
        'story/start.tw': STORY,
        'lib/mark.ts': "export const libMark = 'alias-ok';\n",
        'app/main.ts':
          'import message from "virtual:test-message";\nimport { libMark } from "@lib/mark";\nglobalThis.m = message + libMark;\n',
      });
      const configFile = writeViteConfig(dir, ENTRY_STORY_OPTIONS(dir), '');
      const url = await serve({
        configFile,
        root: dir,
        plugins: [virtualPlugin('virtual:test-message', 'virtual-ok')],
        resolve: { alias: { '@lib': join(dir, 'lib') } },
      });
      const script = entryScript(await (await fetch(url)).text());
      expect(script).toContain('virtual-ok');
      expect(script).toContain('alias-ok');
    });

    it('does not run the twee-ts plugin again inside the entry build', async () => {
      const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': 'globalThis.ok = "recursion-free";\n' });
      const url = await serve({
        configFile: false,
        root: dir,
        plugins: [tweeTsPlugin(ENTRY_STORY_OPTIONS(dir))],
      });
      expect(entryScript(await (await fetch(url)).text())).toContain('recursion-free');
    });
  },
);

describe('vite plugin: the client script in the served head', { timeout: 30_000 }, () => {
  function clientScripts(html: string) {
    return DomUtils.getElementsByTagName('script', parseDocument(html), true).filter(
      (script) => script.attribs['src'] === '/@vite/client',
    );
  }

  async function serveTemplate(source: string): Promise<string> {
    const dir = makeProject({
      'story/start.tw': STORY.replace(':: StoryTitle\nGaps\n\n', ''),
      'formats/probe-1/format.js': `window.storyFormat(${JSON.stringify({ name: 'Probe', version: '1.0.0', source })});`,
    });
    const url = await start(dir, {
      sources: [join(dir, 'story')],
      format: 'probe-1',
      compileOptions: { ...COMPILE, formatPaths: [join(dir, 'formats')] },
    });
    return (await fetch(url)).text();
  }

  const parentName = (script: { parent: unknown }): string | undefined =>
    (script.parent as { name?: string } | null)?.name;
  const BODY = '<body>{{STORY_DATA}}</body></html>';

  it('puts exactly one client element in the real head and leaves a comment look-alike alone', async () => {
    const html = await serveTemplate(`<!-- License: <head> -->\n<!doctype html><html><head></head>${BODY}`);
    expect(html).toContain('<!-- License: <head> -->');
    const scripts = clientScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0] && parentName(scripts[0])).toBe('head');
  });

  it('leaves a head look-alike in an inline script string intact and the script valid', async () => {
    const inline = 'var s = "<head>"; var t = 1;';
    const html = await serveTemplate(`<!doctype html><html><script>${inline}</script><head></head>${BODY}`);
    expect(html).toContain(`<script>${inline}</script>`);
    expect(() => {
      compileJavaScript(inline);
    }).not.toThrow();
    const scripts = clientScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0] && parentName(scripts[0])).toBe('head');
  });

  it('leaves a head look-alike in an attribute value intact', async () => {
    const html = await serveTemplate(`<!doctype html><html><meta content="<head>"><head></head>${BODY}`);
    expect(html).toContain('<meta content="<head>">');
    const scripts = clientScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0] && parentName(scripts[0])).toBe('head');
  });

  it('places the client in a head whose quoted attribute holds a >', async () => {
    const html = await serveTemplate(`<!doctype html><html><head data-x="a>b"></head>${BODY}`);
    expect(html).toContain('<head data-x="a>b">');
    const scripts = clientScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0] && parentName(scripts[0])).toBe('head');
  });

  it('still falls back to the start of the page without a head tag', async () => {
    const html = await serveTemplate('<body>{{STORY_DATA}}</body>');
    expect(html.startsWith('<script type="module" src="/@vite/client"></script>')).toBe(true);
  });
});

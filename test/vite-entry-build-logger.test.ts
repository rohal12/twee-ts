import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { createLogger, createServer, type Logger, type Plugin, type ViteDevServer } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { hasEntry, watcherReady } from './helpers/plugins.js';

const FORMATS = join(__dirname, 'fixtures', 'storyformats');
const COMPILE = { formatPaths: [FORMATS], useTweegoPath: false, noRemote: true };
const STORY =
  ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nLogger\n\n:: Start\nHello.\n';

const dirs: string[] = [];
let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-vite-logger-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
  return dir;
}

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

async function serve(
  dir: string,
  plugins: unknown[],
  customLogger: Logger,
  extra: { base?: string } = {},
): Promise<string> {
  const port = await freePort();
  server = await createServer({
    configFile: false,
    root: dir,
    ...extra,
    logLevel: 'silent',
    customLogger,
    plugins: plugins as Plugin[],
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await server.listen();
  await watcherReady(server);
  return `http://127.0.0.1:${port}/`;
}

const options = (dir: string): Parameters<typeof tweeTsPlugin>[0] => ({
  sources: [join(dir, 'story')],
  format: 'test-format-1',
  entry: join(dir, 'app/main.ts'),
  compileOptions: COMPILE,
});

describe.skipIf(!hasEntry)('vite plugin: the logger of the dev entry build', { timeout: 30_000 }, () => {
  it('forwards warnings (also once-only ones) and the warned state, and drops the rest', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': 'globalThis.ok = 1;\n' });
    const warnings: string[] = [];
    const onceWarnings: string[] = [];
    const errors: string[] = [];
    const infos: string[] = [];
    const outer: Logger = {
      ...createLogger('silent'),
      info: (message) => void infos.push(message),
      warn: (message) => void warnings.push(message),
      warnOnce: (message) => void onceWarnings.push(message),
      error: (message) => void errors.push(message),
    };
    let sawEntryBuild = false;
    let hasWarnedInEntry: boolean | undefined;
    let hasErrorLoggedInEntry: boolean | undefined;
    const probe: Plugin = {
      name: 'test-logger-probe',
      configResolved(config) {
        // Only the entry build writes nothing.
        if (config.build.write) return;
        sawEntryBuild = true;
        config.logger.info('entry-info');
        config.logger.warn('entry-warn');
        config.logger.warnOnce('entry-warn-once');
        config.logger.error('entry-error');
        config.logger.clearScreen('info');
        hasWarnedInEntry = config.logger.hasWarned;
        hasErrorLoggedInEntry = config.logger.hasErrorLogged(new Error('x'));
      },
    };
    await serve(dir, [probe, tweeTsPlugin(options(dir))], outer);

    expect(sawEntryBuild).toBe(true);
    expect(warnings).toContain('entry-warn');
    expect(onceWarnings).toContain('entry-warn-once');
    expect(errors).not.toContain('entry-error');
    expect(infos).not.toContain('entry-info');
    expect(hasErrorLoggedInEntry).toBe(false);
    expect(typeof hasWarnedInEntry).toBe('boolean');
  });

  it('ignores falsy and nested entries in the inline plugin list', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': 'globalThis.marker = "__TOKEN__";\n' });
    const transformer: Plugin = {
      name: 'test-nested-transform',
      transform(code, id) {
        return id.endsWith('main.ts') ? code.replace('__TOKEN__', 'nested-ok') : undefined;
      },
    };
    const url = await serve(
      dir,
      [false, null, [transformer, [undefined]], tweeTsPlugin(options(dir))],
      createLogger('silent'),
    );
    const html = await (await fetch(url)).text();
    expect(html).toContain('nested-ok');
  });
});

describe('vite plugin: dev server requests and connections', { timeout: 30_000 }, () => {
  const plain = (dir: string): Parameters<typeof tweeTsPlugin>[0] => ({
    sources: [join(dir, 'story')],
    format: 'test-format-1',
    compileOptions: COMPILE,
  });

  it('sends no error to a page that connects while the last compile is good', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const url = await serve(dir, [tweeTsPlugin(plain(dir))], createLogger('silent'));
    const send = vi.spyOn(server!.ws, 'send');
    // Connection listeners run in the order they were added, the plugin's (added when the server was
    // configured) before this one: once this one has run, the plugin has sent whatever it sends to a new
    // page (#250 TEST-2: no fixed wait).
    const handled = new Promise<void>((done) => {
      server!.ws.on('connection', () => {
        done();
      });
    });
    const socket = new WebSocket(url.replace('http', 'ws'), 'vite-hmr');
    try {
      await new Promise<void>((done, fail) => {
        socket.addEventListener('open', () => {
          done();
        });
        socket.addEventListener('error', () => {
          fail(new Error('websocket failed'));
        });
      });
      await handled;
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    } finally {
      socket.close();
    }
  });

  it('leaves a request outside the base path to Vite', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const url = await serve(dir, [tweeTsPlugin(plain(dir))], createLogger('silent'), { base: '/app/' });
    const res = await fetch(`${url}other.txt`);
    expect(res.status).toBeLessThan(500);
  });
});

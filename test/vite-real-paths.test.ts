import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { build, createServer, type Plugin, type ViteDevServer } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';

const COMPILE = { formatPaths: [join(__dirname, 'fixtures/storyformats')], useTweegoPath: false, noRemote: true };
const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nold text';
const dirs: string[] = [];
let server: ViteDevServer | undefined;
let watcher: { close(): Promise<void> } | undefined;
function project(): { dir: string; real: string; alias: string } {
  const dir = mkdtempSync(join(tmpdir(), 'twee-vite-real-'));
  dirs.push(dir);
  const real = join(dir, 'real');
  const alias = join(dir, 'alias');
  mkdirSync(join(real, 'story'), { recursive: true });
  writeFileSync(join(real, 'story/start.tw'), STORY);
  symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { dir, real, alias };
}
afterEach(async () => {
  await server?.close();
  server = undefined;
  await watcher?.close();
  watcher = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vite plugin: real filesystem path identities', { timeout: 30_000 }, () => {
  it('invalidates a cached authored alias when watchChange names the real file at the same mtime', async () => {
    const { alias, real } = project();
    const plugin = tweeTsPlugin({ sources: [join(alias, 'story')], format: 'test-format-1', compileOptions: COMPILE });
    type Context = {
      emitFile(file: { source: string }): void;
      warn(message: string): void;
      error(error: Error): never;
    };
    const generate = plugin.generateBundle as { handler(this: Context, output: object, bundle: object): Promise<void> };
    const file = join(real, 'story/start.tw');
    const fixed = new Date(1_700_000_000_000);
    utimesSync(file, fixed, fixed);
    let output = '';
    const context = {
      emitFile: (file: { source: string }) => {
        output = file.source;
      },
      warn: () => {},
      error: (e: Error) => {
        throw e;
      },
    };
    await generate.handler.call(context, {}, {});
    expect(output).toContain('old text');
    const previous = statSync(file);
    writeFileSync(file, STORY.replace('old text', 'new text'));
    utimesSync(file, previous.atime, previous.mtime);
    (plugin.watchChange as (id: string) => void)(file);
    await generate.handler.call(context, {}, {});
    expect(output).toContain('new text');
  });

  it('rebuilds under a real Vite build watcher when sources use a directory alias', async () => {
    const { alias, real } = project();
    const out = join(real, 'build/index.html');
    const changes: string[] = [];
    const started = await build({
      root: real,
      configFile: false,
      logLevel: 'silent',
      build: { outDir: 'build', watch: {} },
      plugins: [
        tweeTsPlugin({ sources: [join(alias, 'story')], format: 'test-format-1', compileOptions: COMPILE }),
        {
          name: 'record-filesystem-events',
          watchChange(id) {
            changes.push(id);
          },
        },
      ],
    });
    watcher = started as unknown as { close(): Promise<void> };
    await vi.waitFor(() => expect(readFileSync(out, 'utf8')).toContain('old text'));
    writeFileSync(join(real, 'story/start.tw'), STORY.replace('old text', 'new text'));
    await vi.waitFor(() => expect(readFileSync(out, 'utf8')).toContain('new text'), { timeout: 10_000 });
    expect(changes.some((id) => id.endsWith('/start.tw') || id.endsWith('\\start.tw'))).toBe(true);
  });

  it('rebundles entry imports when Vite watches an authored root alias', async () => {
    const { alias, real } = project();
    writeFileSync(join(real, 'main.ts'), "import './style.css'; window.marker='entry-one';");
    writeFileSync(join(real, 'style.css'), ':root { --marker: 1; }');
    server = await createServer({
      root: alias,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        tweeTsPlugin({
          sources: [join(alias, 'story')],
          entry: join(alias, 'main.ts'),
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    });
    await server.listen();
    const url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/`;
    const page = async (): Promise<string> => (await fetch(url)).text();
    expect(await page()).toContain('entry-one');
    writeFileSync(join(real, 'main.ts'), "import './style.css'; window.marker='entry-two';");
    await vi.waitFor(async () => expect(await page()).toContain('entry-two'), { timeout: 10_000 });
    writeFileSync(join(real, 'style.css'), ':root { --marker: 2; }');
    await vi.waitFor(async () => expect(await page()).toMatch(/--marker:\s*2/), { timeout: 10_000 });
  });

  it('watches an entry plugin dependency outside the Vite root and accepts its real path', async () => {
    const { alias, real, dir } = project();
    writeFileSync(join(real, 'main.ts'), "window.marker='CUSTOM';");
    const external = join(dir, 'external');
    mkdirSync(external);
    const file = join(external, 'value.txt');
    writeFileSync(file, 'external-one');
    const dependency: Plugin = {
      name: 'external-entry-dependency',
      transform(code, id) {
        if (!id.endsWith('/main.ts')) return;
        this.addWatchFile(file);
        return code.replace('CUSTOM', readFileSync(file, 'utf8'));
      },
    };
    server = await createServer({
      root: alias,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        dependency,
        tweeTsPlugin({
          sources: [join(alias, 'story')],
          entry: join(alias, 'main.ts'),
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    });
    await server.listen();
    const url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/`;
    const page = async (): Promise<string> => (await fetch(url)).text();
    expect(await page()).toContain('external-one');
    writeFileSync(file, 'external-two');
    await vi.waitFor(async () => expect(await page()).toContain('external-two'), { timeout: 10_000 });
  });

  it('keeps authored exclude globs when a watcher reports a source alias by its real path', async () => {
    const { alias, real } = project();
    const file = join(real, 'story/ignored.tw');
    writeFileSync(file, ':: Ignored\nignored');
    const excluded = relative(process.cwd(), join(alias, 'story/ignored.tw')).replace(/\\/g, '/');
    server = await createServer({
      root: real,
      configFile: false,
      logLevel: 'silent',
      server: { watch: null },
      plugins: [
        tweeTsPlugin({
          sources: [join(alias, 'story')],
          format: 'test-format-1',
          compileOptions: { ...COMPILE, exclude: [excluded] },
        }),
      ],
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      server.watcher.emit('all', 'change', file);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebundles a plugin dependency authored through an alias when the real watcher reports its physical path', async () => {
    const { alias, real } = project();
    writeFileSync(join(real, 'main.ts'), "window.marker='CUSTOM';");
    const authored = join(alias, 'value.txt');
    const physical = join(real, 'value.txt');
    writeFileSync(physical, 'alias-one');
    const dependency: Plugin = {
      name: 'aliased-entry-dependency',
      transform(code, id) {
        if (!id.endsWith('/main.ts')) return;
        this.addWatchFile(authored);
        return code.replace('CUSTOM', readFileSync(authored, 'utf8'));
      },
    };
    server = await createServer({
      root: alias,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        dependency,
        tweeTsPlugin({
          sources: [join(alias, 'story')],
          entry: join(alias, 'main.ts'),
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    });
    await server.listen();
    const url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/`;
    const page = async (): Promise<string> => (await fetch(url)).text();
    expect(await page()).toContain('alias-one');
    writeFileSync(physical, 'alias-two');
    await vi.waitFor(async () => expect(await page()).toContain('alias-two'), { timeout: 10_000 });
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { build, createServer, type ViteDevServer } from 'vite';
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

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function buildProject(dir: string, plugin: ReturnType<typeof tweeTsPlugin>): Promise<string> {
  const outDir = join(dir, 'dist');
  await build({ configFile: false, root: dir, logLevel: 'silent', build: { outDir }, plugins: [plugin] });
  return outDir;
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
    ).rejects.toThrow(/start\.tw:\d+: .*Malformed twee source/);
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

  async function start(dir: string, plugin?: ReturnType<typeof tweeTsPlugin>, configFile?: string): Promise<string> {
    const port = await freePort();
    server = await createServer({
      configFile: configFile ?? false,
      root: dir,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port, strictPort: true },
      plugins: plugin ? [plugin] : [],
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

  it('coalesces rapid saves and ends on the latest content', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const url = await start(dir, plugin(dir));
    const file = join(dir, 'story/start.tw');
    unlinkSync(file);
    writeFileSync(file, STORY.replace('Hello from the story.', 'First save.'));
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
    const pluginUrl = pathToFileURL(resolve(__dirname, '..', 'src', 'plugins', 'vite.ts')).href;
    writeFileSync(
      join(dir, 'vite.config.mjs'),
      `import { tweeTsPlugin } from ${JSON.stringify(pluginUrl)};
export default {
  plugins: [tweeTsPlugin({
    sources: [${JSON.stringify(join(dir, 'story'))}],
    format: 'test-format-1',
    entry: ${JSON.stringify(join(dir, 'app/main.ts'))},
    compileOptions: ${JSON.stringify(COMPILE)},
  })],
};
`,
    );
    const url = await start(dir, undefined, join(dir, 'vite.config.mjs'));
    const html = await page(url);
    expect(userScript(html)).toContain('entry-ok');
    expect(html).toContain('Hello from the story.');
  });
});

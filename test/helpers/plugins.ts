/**
 * Shared set-up for the bundler plugin tests: temporary projects, dev servers
 * on a free loopback port, and builds held in memory.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build, createServer, version } from 'vite';
import type { InlineConfig, ViteDevServer } from 'vite';

const FORMATS = join(__dirname, '..', 'fixtures', 'storyformats');
export const COMPILE = { formatPaths: [FORMATS], useTweegoPath: false, noRemote: true };

export const STORY = `:: StoryData
{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}

:: StoryTitle
Plugin Test

:: Start
Hello from the story.
`;

/** STORY with `text` as its Start passage's text. */
export function storyWith(text: string): string {
  return STORY.replace('Hello from the story.', text);
}

/**
 * Whether `vite build --watch` reports a change inside a folder a plugin
 * registers with addWatchFile: the Rolldown watcher of Vite 8.0 and 8.1 reports
 * changes to registered files only.
 */
export const buildWatchSeesFolders = !/^8\.[01]\./.test(version);

/** The watcher `vite build --watch` returns, as far as the tests use it. */
export interface BuildWatcher {
  on(event: 'event', listener: (event: { code: string; result?: { close(): unknown } }) => void): unknown;
  close(): Promise<void>;
}

function isBuildWatcher(value: unknown): value is BuildWatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'on') === 'function' &&
    typeof Reflect.get(value, 'close') === 'function'
  );
}

const dirs: string[] = [];

/**
 * A new temporary folder, by its real path: Vite reads the root by its real
 * path, and a build input or a watched file named another way (macOS's /var for
 * /private/var, a Windows 8.3 name such as RUNNER~1) would not lie inside it.
 * The tests that are about such spellings make them themselves.
 */
function newTempDir(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-plugin-')));
}
const servers: ViteDevServer[] = [];
const watchers: BuildWatcher[] = [];

/** Starts `vite build --watch` and waits for its first build; cleanUp() closes it. */
export async function startBuildWatch(config: InlineConfig): Promise<BuildWatcher> {
  const started: unknown = await build({
    configFile: false,
    logLevel: 'silent',
    ...config,
    build: { ...config.build, watch: {} },
  });
  if (!isBuildWatcher(started)) throw new Error('the build returned no watcher');
  watchers.push(started);
  await new Promise<void>((done, fail) => {
    started.on('event', (event) => {
      if (event.code === 'BUNDLE_END') void event.result?.close();
      if (event.code === 'END') done();
      if (event.code === 'ERROR') fail(new Error('the first build failed'));
    });
  });
  return started;
}

/** A temporary project with `files` (relative path to content); removed by cleanUp(). */
export function makeProject(files: Readonly<Record<string, string | Uint8Array>>): string {
  const dir = newTempDir();
  dirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

/** Writes `files` (relative path to content) into `dir`, creating folders as needed. */
export function writeFiles(dir: string, files: Readonly<Record<string, string | Uint8Array>>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/** Another temporary folder, removed by cleanUp(). */
export function tempDir(): string {
  const dir = newTempDir();
  dirs.push(dir);
  return dir;
}

/** Closes the servers started and removes the projects made since the last call; for afterEach. */
export async function cleanUp(): Promise<void> {
  await Promise.all([...servers.splice(0), ...watchers.splice(0)].map((closable) => closable.close()));
  // Windows may hold a folder's handles a moment after a watcher closes, so removing it is retried.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Every file below `dir`, but in node_modules and .git. */
function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : filesBelow(path);
    return entry.isFile() ? [path] : [];
  });
}

/**
 * Resolves once the server's file watcher watches every file below its root,
 * after which it reports their changes. A server is listening before its
 * watcher has scanned the root (and the folders a plugin adds), and an edit
 * made in between goes unseen; chokidar's `ready` event doesn't cover folders
 * added after the first scan, so the watched files are polled instead. The
 * stand-in Vite uses with `server.watch: null` watches nothing and is ready.
 */
export async function watcherReady(server: ViteDevServer): Promise<void> {
  if (server.config.server.watch === null) return;
  const files = filesBelow(server.config.root);
  const deadline = Date.now() + 10_000;
  const watches = (file: string): boolean => {
    const watched: Readonly<Record<string, readonly string[] | undefined>> = server.watcher.getWatched();
    return watched[dirname(file)]?.includes(basename(file)) ?? false;
  };
  while (!files.every(watches)) {
    if (Date.now() > deadline) throw new Error('the dev server never watched all the files of its root');
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Starts a dev server on a free loopback port, logging nothing unless the config says; returns it and its URL. */
export async function startServer(config: InlineConfig): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    ...config,
    server: { host: '127.0.0.1', port: 0, ...config.server },
  });
  servers.push(server);
  await server.listen();
  await watcherReady(server);
  return { server, url: serverUrl(server) };
}

/**
 * The loopback URL (no trailing slash) of a listening dev server. Tests never choose a port: they pass
 * `port: 0` without `strictPort`, so Vite lets the OS pick one. A port found free beforehand could be taken by another
 * process before the server binds it.
 */
export function serverUrl(server: ViteDevServer): string {
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('the dev server has no TCP address');
  }
  return `http://127.0.0.1:${(address satisfies AddressInfo).port}`;
}

/** The files a build writes, held in memory: file name to content. */
export async function buildFiles(config: InlineConfig): Promise<Map<string, string | Uint8Array>> {
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    ...config,
    build: { write: false, ...config.build },
  });
  const files = new Map<string, string | Uint8Array>();
  for (const result of Array.isArray(out) ? out : [out]) {
    if (!('output' in result)) throw new Error('the build returned a watcher');
    for (const item of result.output) files.set(item.fileName, item.type === 'chunk' ? item.code : item.source);
  }
  return files;
}

/** The text of a file a build wrote, or an empty string. */
export function textOf(content: string | Uint8Array | undefined): string {
  if (content === undefined) return '';
  return typeof content === 'string' ? content : Buffer.from(content).toString('utf-8');
}

/** The story's Story JavaScript. */
export function userScript(html: string): string {
  return /<script[^>]*id="twine-user-script"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
}

/**
 * What a bundled entry script leaves in `globalThis.out` when it runs, as JSON:
 * the entry under test assigns what it observed there. The script runs in a
 * fresh context with an empty `out` object.
 */
export function runEntry(script: string): unknown {
  const context: Record<string, unknown> = { out: {} };
  runInNewContext(script, context);
  return JSON.parse(JSON.stringify(context['out']));
}

/** Writes `vite.config.mjs` into `dir` with `body` after an import of the plugin from source; returns its path. */
export function writeViteConfig(dir: string, body: string): string {
  const pluginUrl = pathToFileURL(resolve(__dirname, '..', '..', 'src', 'plugins', 'vite.ts')).href;
  const file = join(dir, 'vite.config.mjs');
  writeFileSync(file, `import { tweeTsPlugin } from ${JSON.stringify(pluginUrl)};\n${body}\n`);
  return file;
}

/** vi.waitFor options for state that settles after file-system events. */
export const SETTLED = { timeout: 15_000, interval: 50 };

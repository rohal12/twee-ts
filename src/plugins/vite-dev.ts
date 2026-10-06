/**
 * The Vite plugin in the dev server: compiles the story (and bundles the
 * entry) at start and after every change to a file it was built from, serves
 * it at the base URL with Vite's client added, and reports errors to Vite's
 * overlay.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import type { Connect, ErrorPayload, ResolvedConfig, ViteDevServer } from 'vite';
import type { FileCacheEntry } from '../types.js';
import { getFilenames, outputPaths } from '../filesystem.js';
import type { BuildOutputs } from '../filesystem.js';
import { mediaTypeFromFilename } from '../media-types.js';
import { viteWaitingPage } from '../html-structure.js';
import { compileStory, fatalError } from './diagnostics.js';
import type { ResolvedPluginOptions } from './options.js';
import { canonicalPath, fileKey, isViteConfigTemp, keyWithin } from './paths.js';
import { bundleEntry, entrySources, PLUGIN_NAME } from './vite-entry.js';
import type { EntryBundle } from './vite-entry.js';

/** What the dev server needs from the plugin. */
export interface DevStoryOptions {
  readonly options: ResolvedPluginOptions;
  readonly cache: Map<string, FileCacheEntry>;
  /** What builds with this config write, which is never a source. */
  readonly outputs: (config: ResolvedConfig) => BuildOutputs;
  /** Adds Vite's client to the story's HTML. */
  readonly injectClient: (html: string, base: string) => string;
}

/** How long after a change the story is compiled, so saves landing together compile once. */
const DEBOUNCE_MS = 50;

/**
 * The paths under the base URL the story is served at: the output file name,
 * and, as a static host serves it, the folder of an `index.html`.
 */
export function storyPaths(outputFilename: string): string[] {
  const index = 'index.html';
  return outputFilename === index || outputFilename.endsWith(`/${index}`)
    ? [outputFilename, outputFilename.slice(0, -index.length)]
    : [outputFilename];
}

/**
 * A request URL's path below `base`, decoded, without query or hash; undefined
 * when the path is outside the base or is not a valid percent-encoding.
 */
export function pathBelowBase(url: string, base: string): string | undefined {
  const raw = url.replace(/[?#].*$/s, '');
  let path;
  let decodedBase;
  try {
    path = decodeURIComponent(raw);
    decodedBase = decodeURI(base);
  } catch {
    return undefined;
  }
  return path.startsWith(decodedBase) ? path.slice(decodedBase.length) : undefined;
}

/** Served until the first successful compile, so the overlay has a page to appear on. */
function waitingPage(base: string): string {
  return viteWaitingPage(`${base}@vite/client`);
}

function toOverlayError(e: unknown): ErrorPayload['err'] {
  const error = fatalError(e);
  return {
    // Bundler messages carry terminal colour codes; the overlay would show them raw.
    message: stripVTControlCharacters(error.message),
    stack: '',
    plugin: PLUGIN_NAME,
    ...(error.id ? { id: error.id } : {}),
    ...(error.loc ? { loc: error.loc } : {}),
  };
}

/** What a change to a file alters: modification time, size and inode (a file replaced by a new one). */
function fileState(file: string): string | undefined {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return undefined; // Missing: it counts as gone.
  }
}

/**
 * Files by their identity key (see fileKey), each with the path it is read and
 * watched at (its canonical path).
 */
type TrackedFiles = ReadonlyMap<string, string>;

/** `paths` as TrackedFiles. */
function tracked(paths: Iterable<string>): TrackedFiles {
  return new Map([...paths].map((path) => [fileKey(path), canonicalPath(path)]));
}

/** The state of each of `files`, by key, for telling later which changed (see filesChanged). */
function fileStates(files: TrackedFiles): Map<string, string> {
  const states = new Map<string, string>();
  for (const [key, path] of files) {
    const state = fileState(path);
    if (state !== undefined) states.set(key, state);
  }
  return states;
}

/** The keys of the files added, removed or changed between two `fileStates` results. */
function filesChanged(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const [file, state] of after) if (before.get(file) !== state) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return changed;
}

/**
 * Sets up the story in `server`: the first compile, the watcher, and a
 * middleware that notes each request's URL before Vite's own middlewares
 * rewrite it. Resolves, after the first compile, to the middleware that serves
 * the story, which the plugin installs after Vite's internal middlewares (host
 * check, CORS, base), so they apply to the story as to any page.
 */
export async function setUpDevStory(server: ViteDevServer, dev: DevStoryOptions): Promise<Connect.NextHandleFunction> {
  const { options, cache } = dev;
  const config = server.config;
  const { base } = config;
  const paths = storyPaths(options.outputFilename);
  const { inputs, excluded: excludedGlob } = options;
  const entryPath = options.entry;
  // Files and folders are compared by identity key (see paths.ts); the inputs are watched as given.
  const root = fileKey(config.root);
  const inputKeys = inputs.map(fileKey);

  // What a build writes, which `vite build` may have left inside a source folder:
  // the story, chunks and assets, and the copies of the public files.
  let outputs = dev.outputs(config);
  let output = outputPaths(outputs);
  const excluded = (file: string): boolean => excludedGlob(file) || output.isOutput(file, inputs);
  server.watcher.add([...inputs]);

  let html = '';
  let lastError: ErrorPayload['err'] | undefined;
  let entry: EntryBundle | undefined; // last good bundle
  let entryStale = true; // bundle again on the next rebuild
  // The files the entry was last bundled from, and their states then, kept while a
  // later bundle fails, so that fixing one of them (inside the root or not) bundles it again.
  let entryFiles: TrackedFiles = new Map();
  let entryStates = new Map<string, string>();
  // Files outside the root the watcher was asked to add for the entry, by key; Vite watches the root itself.
  const watchedForEntry = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  // The input files as the last compile found them, to tell whether the watcher
  // missed a change (see catchUp).
  let compiledInputs = new Map<string, string>();
  let catchingUp: Promise<void> | undefined;

  // Stops this server's rebuilds when it closes, on close() and restart() alike;
  // no rebuild may start after that, including one whose timer is still pending
  // in middleware mode. Vite closes each server's own watcher then. closeBundle
  // can't tell: it runs for the whole plugin instance, which a restarted server
  // (the plugin passed inline keeps its instance) or a build may share.
  const closeWatcher = server.watcher.close.bind(server.watcher);
  server.watcher.close = async () => {
    closed = true;
    clearTimeout(timer);
    pending.clear();
    return closeWatcher();
  };

  const storyInputFiles = (): Map<string, string> =>
    fileStates(tracked(getFilenames(inputs, outputs).filenames.filter((file) => !excludedGlob(file))));

  // Whether a change to `file` may change the entry's bundle: after a good bundle,
  // one of the files it was built from (its modules and the files its plugins
  // watch, such as CSS @imports and url() targets); while there is none, or the
  // last one failed, also anything in the project, so that creating a missing
  // import brings it back.
  const touchesEntry = (key: string): boolean =>
    entryPath !== undefined && (entryFiles.has(key) || (entryStale && keyWithin(key, [root])));

  // Watches the entry's files outside the root, and stops watching those it no longer uses.
  const watchEntryFiles = (files: TrackedFiles): void => {
    const added = [...files].filter(
      ([key]) => !keyWithin(key, [root]) && !keyWithin(key, inputKeys) && !watchedForEntry.has(key),
    );
    const dropped = [...watchedForEntry].filter(([key]) => !files.has(key));
    for (const [key] of dropped) watchedForEntry.delete(key);
    for (const [key, path] of added) watchedForEntry.set(key, path);
    if (dropped.length > 0) server.watcher.unwatch(dropped.map(([, path]) => path));
    if (added.length > 0) server.watcher.add(added.map(([, path]) => path));
  };

  const bundle = async (): Promise<void> => {
    if (entryPath === undefined) return;
    entryStale = true;
    const next = await bundleEntry(config, entryPath, 'serve');
    entry = next;
    entryStale = false;
    entryFiles = tracked(next.files);
    entryStates = fileStates(entryFiles);
    watchEntryFiles(entryFiles);
  };

  // `initial`: the compile at server start. No page is open yet, and Vite would
  // hold a full-reload for the first page that connects and reload it once.
  const rebuild = async (changed: ReadonlySet<string>, initial = false): Promise<void> => {
    if (closed) return;
    try {
      outputs = dev.outputs(config);
      output = outputPaths(outputs);
      // Taken before the compile reads anything, so a file written during it
      // still counts as changed afterwards.
      compiledInputs = storyInputFiles();
      // The compile cache trusts modification times, which a quick save may leave
      // unchanged (coarse file-system timestamps); forget the files that changed.
      for (const key of [...cache.keys()]) if (changed.has(fileKey(key))) cache.delete(key);
      if (entryStale || [...changed].some(touchesEntry)) await bundle();
      const story = await compileStory(options.compile(entrySources(entry)), outputs, cache);
      for (const warning of story.warnings) config.logger.warn(`[twee-ts] ${warning}`);
      html = dev.injectClient(story.output, base);
      lastError = undefined;
      // A path tells the client to reload only the pages showing the story.
      if (!initial) server.ws.send({ type: 'full-reload', path: `/${options.outputFilename}` });
    } catch (e) {
      lastError = toOverlayError(e);
      config.logger.error(`[twee-ts] ${lastError.message}`);
      server.ws.send({ type: 'error', err: lastError });
    }
  };

  // rebuild() reports its own errors; this catches a failure while reporting,
  // so one bad report doesn't stop every later rebuild.
  const keepQueueAlive = (e: unknown): void => {
    try {
      config.logger.error(`[twee-ts] ${fatalError(e).message}`);
    } catch {
      // Nothing left to report with.
    }
  };

  await rebuild(new Set(), true);

  server.watcher.on('all', (event, path) => {
    if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
    // Loading the config for the entry build writes and deletes one of these;
    // reacting to it would bundle again, and again.
    if (isViteConfigTemp(path)) return;
    const changed = fileKey(path);
    if ((!keyWithin(changed, inputKeys) || excluded(path)) && !touchesEntry(changed)) return;
    pending.add(changed);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = pending;
      pending = new Set();
      queue = queue.then(() => rebuild(files)).catch(keepQueueAlive);
    }, DEBOUNCE_MS);
  });

  // The watcher can miss changes, or be off (`server.watch: null`). When a folder
  // is deleted and created again in quick succession (as `git rebase` does),
  // chokidar stops watching the folder, so a file added to it later raises no
  // event; under Deno it also loses the files created with it, so their later
  // edits raise none either. Before the story is served, this waits for any
  // compile under way, compares the story's input files and the entry's files
  // with what the last compile and bundle read, and compiles again first if
  // they differ.
  const catchUp = (): Promise<void> => {
    catchingUp ??= (async () => {
      await queue;
      const changed = filesChanged(compiledInputs, storyInputFiles());
      for (const file of filesChanged(entryStates, fileStates(entryFiles))) changed.add(file);
      if (changed.size === 0) return;
      // Changes the watcher did report, still waiting out the debounce, go into the same compile.
      for (const file of pending) changed.add(file);
      pending = new Set();
      clearTimeout(timer);
      queue = queue.then(() => rebuild(changed)).catch(keepQueueAlive);
      await queue;
    })().finally(() => {
      catchingUp = undefined;
    });
    return catchingUp;
  };

  server.ws.on('connection', () => {
    if (lastError) server.ws.send({ type: 'error', err: lastError });
  });

  // Vite's base middleware strips the base from a request's URL before the
  // plugin's own middleware sees it, and only when the URL is below the base;
  // the URL as the request came in tells which.
  const requestUrls = new WeakMap<IncomingMessage, string>();
  server.middlewares.use((req, _res, next) => {
    requestUrls.set(req, String(req.url));
    next();
  });

  const send = (req: IncomingMessage, res: ServerResponse, type: string, body: string | Uint8Array): void => {
    // `server.headers`, as Vite sends them with the pages it serves itself (Vite 5 may leave them unset).
    for (const [name, value] of Object.entries({ ...config.server.headers })) {
      if (typeof value === 'string' || typeof value === 'number') res.setHeader(name, value);
      else if (Array.isArray(value)) res.setHeader(name, value.map(String));
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
    // A page from the dev server is always checked again, as Vite serves its own.
    res.setHeader('Cache-Control', 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    // Undefined for a request the middleware above never saw, which is then left alone.
    const path = pathBelowBase(String(requestUrls.get(req)), base);
    if (path === undefined) {
      next();
      return;
    }
    if (paths.includes(path)) {
      catchUp().then(() => {
        send(req, res, 'text/html; charset=utf-8', html || waitingPage(base));
      }, next);
      return;
    }
    // Files the entry's bundle still emits separately, where the build writes them.
    const asset = entry?.assets.get(path);
    if (asset === undefined) {
      next();
      return;
    }
    send(req, res, mediaTypeFromFilename(path), asset);
  };
}

/**
 * The Vite plugin in the dev server: compiles the story (and bundles the
 * entry) at start and after every change to a file it was built from, serves
 * it at the base URL with Vite's client added, and reports errors to Vite's
 * overlay.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Connect, ErrorPayload, ResolvedConfig, ViteDevServer } from 'vite';
import type { FileCacheEntry } from '../types.js';
import { getFilenames, outputPaths } from '../filesystem.js';
import { sha256Hex } from '../format-cache.js';
import type { BuildOutputs } from '../filesystem.js';
import { mediaTypeFromFilename, normalizedFileExt } from '../media-types.js';
import { viteWaitingPage } from '../html-structure.js';
import { compileStory, fatalError } from './diagnostics.js';
import type { ResolvedPluginOptions } from './options.js';
import { canonicalPath, fileKey, isViteConfigTemp, keyWithin, toPosix } from './paths.js';
import { bundleEntry, entryCollisionMessage, entrySources, PLUGIN_NAME } from './vite-entry.js';
import type { EntryBundle } from './vite-entry.js';
import { scopeAdmits, scopeId, scopeListing, scopeWatchTargets } from './vite-glob.js';
import type { GlobScope } from './vite-glob.js';
import { missingImportFolders } from './watch-targets.js';

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
 * How long a file the watcher was asked to add may take to be listed as watched, and how long after that its
 * watch may still miss an edit (macOS FSEvents starts reporting a moment after the watch is set up); see
 * `recheckOnceWatched` in setUpDevStory.
 */
const WATCH_LISTED_TIMEOUT_MS = 10_000;
const WATCH_START_MS = 500;

/** Resolves after `ms`, without keeping the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms).unref());
}

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
    decodedBase = decodeURIComponent(base);
  } catch {
    return undefined;
  }
  return path.startsWith(decodedBase) ? path.slice(decodedBase.length) : undefined;
}

/** Served until the first successful compile, so the overlay has a page to appear on. */
/** The reload message for a rebuilt story: limited to the story's pages unless Vite's client could not match them. */
export function reloadPayload(base: string, outputFilename: string): { type: 'full-reload'; path?: string } {
  let decoded: string;
  try {
    decoded = decodeURI(base);
  } catch {
    return { type: 'full-reload' };
  }
  return decoded === base ? { type: 'full-reload', path: `/${outputFilename}` } : { type: 'full-reload' };
}

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

/**
 * Media types of the files a bundle emits that Tweego's table of story media does not have: a browser
 * refuses a worker or stylesheet served as `application/octet-stream`.
 */
const BUNDLE_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['js', 'text/javascript'],
  ['mjs', 'text/javascript'],
  ['css', 'text/css'],
  ['json', 'application/json'],
  ['map', 'application/json'],
  ['wasm', 'application/wasm'],
  ['html', 'text/html; charset=utf-8'],
  ['txt', 'text/plain; charset=utf-8'],
]);

/** The media type the dev server gives an asset of the entry's bundle. */
function assetMediaType(path: string): string {
  return BUNDLE_MEDIA_TYPES.get(normalizedFileExt(path)) ?? mediaTypeFromFilename(path);
}

/**
 * What a change to a file alters: modification time, change time (which an in-place edit that restores the
 * modification time still moves, as the loader's file signature relies on), size and inode (a file replaced by a
 * new one).
 */
function fileState(file: string): string | undefined {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return undefined; // Missing: it counts as gone.
  }
}

/**
 * A module's file as the bundle was about to read it: its state (see fileState) and the hash of its content.
 * Taken just before the bundler reads the file, so a write in between makes the file differ from it afterwards.
 */
interface FileRead {
  readonly state: string;
  readonly hash: string;
}

/** `file` as it is now, as a FileRead; undefined when it can't be read. */
function fileRead(file: string): FileRead | undefined {
  const state = fileState(file);
  if (state === undefined) return undefined;
  try {
    return { state, hash: sha256Hex(readFileSync(file)) };
  } catch {
    return undefined;
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

/**
 * The key of the file `authored` reaches, when it reaches it through a link (somewhere along the path, or
 * at the end of it): the one case where the file's own path says nothing of a change of target.
 * undefined for a path with no link in it, and for one that reaches nothing.
 */
function linkKey(authored: string): string | undefined {
  if (!existsSync(authored)) return undefined;
  return canonicalPath(authored) === toPosix(resolve(authored)) ? undefined : fileKey(authored);
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

/**
 * The states to compare later changes with, for the files a bundle was made from: each file as it was just
 * before the bundle read it (`observed`, noted as each module loads), else as it was before the bundle began
 * (`before`, for a file known from the last bundle), else as it is now. An edit while the bundle was made
 * then differs from the recorded state afterwards, and the next request makes the bundle again.
 */
function settledStates(
  files: TrackedFiles,
  observed: ReadonlyMap<string, string>,
  before: ReadonlyMap<string, string>,
): Map<string, string> {
  const states = new Map<string, string>();
  for (const [key, path] of files) {
    const state = observed.get(key) ?? before.get(key) ?? fileState(path);
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
 * The names of Vite's middlewares that answer a request with a file: from the public folder, the module
 * transform, the files of the root and the file system, and the HTML fallback.
 */
const VITE_FILE_MIDDLEWARES: ReadonlySet<string> = new Set([
  'viteServePublicMiddleware',
  'viteTriggerLazyBundlingMiddleware',
  'viteMemoryFilesMiddleware',
  'viteTransformMiddleware',
  'viteServeRawFsMiddleware',
  'viteServeStaticMiddleware',
  'viteHtmlFallbackMiddleware',
  'viteIndexHtmlMiddleware',
]);

/**
 * Installs the story's route (see setUpDevStory) among `middlewares`, as the plugin's post hook does: after Vite's
 * checks of a request (host, CORS, proxy, base), so they apply to the story as to any page, and before the first
 * of its middlewares that serve files. A build writes the story and the entry's assets over a public file of the
 * same name, and a static host serves nothing else at their paths, so the dev server must not answer them with a
 * file from the public folder or the root (#339). Appended when none of those middlewares is there.
 */
export function installStoryRoute(middlewares: Connect.Server, route: Connect.NextHandleFunction): void {
  const at = middlewares.stack.findIndex(
    ({ handle }) => typeof handle === 'function' && VITE_FILE_MIDDLEWARES.has(handle.name),
  );
  if (at === -1) middlewares.use(route);
  else middlewares.stack.splice(at, 0, { route: '', handle: route });
}

/** The assets each story instance of a dev server currently serves, so instances can see each other's names. */
const devAssets = new WeakMap<ViteDevServer, Set<() => ReadonlyMap<string, string | Uint8Array> | undefined>>();

function sameBytes(a: string | Uint8Array, b: string | Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

/**
 * Sets up the story in `server`: the first compile, the watcher, and a
 * middleware that notes each request's URL before Vite's own middlewares
 * rewrite it. Resolves, after the first compile, to the middleware that serves
 * the story and the entry's assets, for installStoryRoute.
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
  // A source folder may be a symbolic link that is retargeted while the server runs, so its identity is read
  // when it is needed, never kept from startup.
  const inputKeys = (): string[] => inputs.map(fileKey);

  // What a build writes, which `vite build` may have left inside a source folder:
  // the story, chunks and assets, and the copies of the public files.
  let outputs = dev.outputs(config);
  let output = outputPaths(outputs);
  const excluded = (file: string): boolean => excludedGlob(file) || output.isOutput(file, inputs);
  server.watcher.add([...inputs]);

  let html = '';
  let lastError: ErrorPayload['err'] | undefined;
  let entry: EntryBundle | undefined; // last good bundle
  const instances = devAssets.get(server) ?? new Set();
  devAssets.set(server, instances);
  instances.add(() => entry?.assets);
  let entryStale = true; // bundle again on the next rebuild
  // The files the entry was last bundled from, and their states then, kept while a
  // later bundle fails, so that fixing one of them (inside the root or not) bundles it again.
  let entryFiles: TrackedFiles = new Map();
  let entryStates = new Map<string, string>();
  // Where the entry and its imports are spelled when that reaches a file through a link, with the key of
  // the file each reached when the bundle read it: retargeting a link changes the key, not the target.
  let entryLinks = new Map<string, string>();
  // Folders where an import the last failed bundle could not resolve would be created (its nearest existing
  // folder), by key; they are among entryFiles, whose state changes when a file is created in one.
  let entryMissingFolders: string[] = [];
  // The scope of each glob pattern of the entry's modules (see vite-glob.ts), by scopeId, and what was in each
  // when the bundle read it: a file added, removed or renamed there may change what the glob selects. Kept, as
  // entryFiles are, while a later bundle fails.
  let entryGlobs = new Map<string, GlobScope>();
  let globStates = new Map<string, string>();
  // Each module of the last good bundle as it read it, by key: a watcher event for one that is still byte for byte
  // and state for state what the bundle read reports a change the bundle already has (#343). Kept only with a
  // watcher; the catch-up compares states alone.
  let entryReads = new Map<string, FileRead>();
  const readsModules = config.server.watch !== null;
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
    entryPath !== undefined && (entryFiles.has(key) || (entryStale && keyWithin(key, [root, ...entryMissingFolders])));

  // Whether a link the entry is spelled through now reaches another file (or none) than the bundle read.
  const linkMoved = (): boolean => [...entryLinks].some(([spelled, key]) => linkKey(spelled) !== key);

  // Whether what is in the scope of one of the entry's globs differs from what the bundle read there.
  const globsChanged = (): boolean => [...entryGlobs].some(([id, scope]) => scopeListing(scope) !== globStates.get(id));

  // Whether adding or removing the file or folder at `path` may change what one of the entry's globs selects.
  const inGlobScope = (path: string, isDir: boolean): boolean =>
    [...entryGlobs.values()].some((scope) => scopeAdmits(scope, path, isDir));

  // What the watcher watches for the entry: its files, and the folders of its globs (or the nearest above each
  // that exists, where creating it shows).
  const entryWatchTargets = (): TrackedFiles =>
    new Map([...entryFiles, ...tracked(scopeWatchTargets(entryGlobs.values()))]);

  // Watches the entry's files outside the root, and stops watching those it no longer uses.
  const watchEntryFiles = (files: TrackedFiles): void => {
    const added = [...files].filter(
      ([key]) => !keyWithin(key, [root]) && !keyWithin(key, inputKeys()) && !watchedForEntry.has(key),
    );
    const dropped = [...watchedForEntry].filter(([key]) => !files.has(key));
    for (const [key] of dropped) watchedForEntry.delete(key);
    for (const [key, path] of added) watchedForEntry.set(key, path);
    if (dropped.length > 0) server.watcher.unwatch(dropped.map(([, path]) => path));
    if (added.length > 0) {
      server.watcher.add(added.map(([, path]) => path));
      recheckOnceWatched(new Map(added)).catch(keepQueueAlive);
    }
  };

  const isListed = (path: string): boolean => {
    const watched: Readonly<Record<string, readonly string[] | undefined>> = server.watcher.getWatched();
    return watched[dirname(path)]?.includes(basename(path)) ?? false;
  };

  // The watcher sets up a file it is asked to add some time later, and raises no event for an edit made
  // before that (on macOS, FSEvents starts reporting a moment later still). Once it lists the files, and a
  // moment after, their states are compared with the bundle's, and a change counts as one it reported.
  const recheckOnceWatched = async (files: TrackedFiles): Promise<void> => {
    if (config.server.watch === null) return; // No watcher: the catch-up before serving sees every change.
    const deadline = Date.now() + WATCH_LISTED_TIMEOUT_MS;
    while (!closed && Date.now() < deadline && ![...files.values()].every(isListed)) await delay(DEBOUNCE_MS);
    await delay(WATCH_START_MS);
    if (closed) return;
    // In the queue, so the states are those of the last bundle, not of one under way.
    queue = queue
      .then(() => {
        const own = new Map([...files].filter(([key]) => entryFiles.has(key)));
        const now = fileStates(own);
        const then = new Map([...entryStates].filter(([key]) => own.has(key)));
        for (const key of filesChanged(then, now)) if (watchedForEntry.has(key)) noteChange(key);
        // A glob's folder: what is in it, against what the bundle read there.
        const [folder] = [...files.keys()].filter((key) => !own.has(key) && watchedForEntry.has(key));
        if (folder !== undefined && globsChanged()) noteChange(folder);
      })
      .catch(keepQueueAlive);
    await queue;
  };

  const bundle = async (): Promise<void> => {
    if (entryPath === undefined) return;
    entryStale = true;
    const spelled = new Map<string, string>(); // authored path → key, of each link the bundle went through
    const authoredPaths = new Set<string>(); // every import path as authored
    const watchFiles = new Set<string>(); // what the bundle's plugins watch, and its modules
    const noteSpelling = (authored: string): void => {
      authoredPaths.add(authored);
      const key = linkKey(authored);
      if (key !== undefined && !spelled.has(authored)) spelled.set(authored, key);
    };
    noteSpelling(entryPath);
    if (entry === undefined) {
      // No good bundle yet, so the configured entry is the one file known to matter: watch it
      // (it may lie outside the root) and note its state, so that fixing it bundles again.
      entryFiles = tracked([entryPath]);
      entryStates = fileStates(entryFiles);
      watchEntryFiles(entryWatchTargets());
    }
    // The scopes of the globs this bundle reads, each with what was in it just before Vite read it (so a file
    // added while the bundle is made differs from it afterwards), and what was in the known ones before it began.
    const globs = new Map<string, GlobScope>();
    const globsRead = new Map<string, string>();
    const globsBefore = new Map([...entryGlobs].map(([id, scope]) => [id, scopeListing(scope)]));
    // The files known so far, as they are before the bundle begins, and each module as it is just before
    // the bundle reads it: a file edited while the bundle is made then differs from what is recorded
    // afterwards, which is what the catch-up looks for.
    const before = fileStates(entryFiles);
    const observed = new Map<string, string>();
    const loaded = new Map<string, string>(); // key → path of each module the bundle loaded
    const reads = new Map<string, FileRead>();
    let next: EntryBundle;
    try {
      next = await bundleEntry(config, entryPath, 'serve', options.outputFilename, {
        watchFiles,
        onLoad: (file) => {
          const key = fileKey(file);
          const read = readsModules ? fileRead(canonicalPath(file)) : undefined;
          const state = read?.state ?? fileState(canonicalPath(file));
          if (state !== undefined && !observed.has(key)) observed.set(key, state);
          if (read !== undefined && !reads.has(key)) reads.set(key, read);
          if (!loaded.has(key)) loaded.set(key, canonicalPath(file));
        },
        onResolve: noteSpelling,
        onGlob: (scope) => {
          const id = scopeId(scope);
          if (globs.has(id)) return;
          globs.set(id, scope);
          globsRead.set(id, scopeListing(scope));
        },
      });
    } catch (error) {
      // The modules the failed bundle loaded, and the files its plugins watch, are inputs too: fixing an
      // imported one must bundle again. So is the place of an import it could not resolve: creating it must.
      const folders = missingImportFolders(authoredPaths);
      entryMissingFolders = folders.map(fileKey);
      entryFiles = new Map([...entryFiles, ...loaded, ...tracked(watchFiles), ...tracked(folders)]);
      entryStates = settledStates(entryFiles, observed, before);
      entryLinks = new Map([...entryLinks, ...spelled]);
      entryGlobs = new Map([...entryGlobs, ...globs]);
      globStates = new Map([...globsBefore, ...globsRead]);
      watchEntryFiles(entryWatchTargets());
      throw error;
    }
    entry = next;
    entryStale = false;
    entryFiles = tracked(next.files);
    entryStates = settledStates(entryFiles, observed, before);
    entryLinks = spelled;
    entryMissingFolders = [];
    entryGlobs = globs;
    globStates = globsRead;
    entryReads = reads;
    watchEntryFiles(entryWatchTargets());
  };

  // Whether the change reported for `key` is one the last good bundle already read (#343): a module of it, not a
  // story input, that is now as it was, state and content, when the bundle read it. A request catches up with a
  // change before the watcher reports it; the late event then needs no bundle, compile or reload. Comparing the
  // content as well tells a real save from it on a file system whose coarse timestamps leave the state unchanged;
  // a file touched or saved unchanged after the bundle read it has another state, and is bundled again as before.
  const alreadyRead = (key: string): boolean => {
    const read = entryReads.get(key);
    const path = entryFiles.get(key);
    if (entryStale || read === undefined || path === undefined || keyWithin(key, inputKeys())) return false;
    const now = fileRead(path);
    return now?.state === read.state && now.hash === read.hash;
  };

  // `initial`: the compile at server start. No page is open yet, and Vite would
  // hold a full-reload for the first page that connects and reload it once.
  const rebuild = async (changed: ReadonlySet<string>, initial = false): Promise<void> => {
    if (closed) return;
    try {
      const unread = [...changed].filter((key) => !alreadyRead(key));
      if (changed.size > 0 && unread.length === 0 && !linkMoved() && !globsChanged()) return;
      outputs = dev.outputs(config);
      output = outputPaths(outputs);
      // Taken before the compile reads anything, so a file written during it
      // still counts as changed afterwards.
      compiledInputs = storyInputFiles();
      // The compile cache trusts modification times, which a quick save may leave
      // unchanged (coarse file-system timestamps); forget the files that changed.
      for (const key of [...cache.keys()]) if (changed.has(fileKey(key))) cache.delete(key);
      if (entryStale || linkMoved() || globsChanged() || unread.some(touchesEntry)) await bundle();
      const story = await compileStory(options.compile(entrySources(entry)), outputs, cache);
      for (const warning of story.warnings) config.logger.warn(`[twee-ts] ${warning}`);
      html = dev.injectClient(story.output, base);
      lastError = undefined;
      // A path tells the client to reload only the pages showing the story. Vite's client compares it with the
      // decoded page path and the base as configured, so under a base that has percent-encoded characters
      // (spaces, non-ASCII) the comparison never matches; then every page reloads instead.
      if (!initial) server.ws.send(reloadPayload(base, options.outputFilename));
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

  // A change to a file the story or the entry is made from: compiled with the others that land with it.
  const noteChange = (changed: string): void => {
    if (closed) return;
    pending.add(changed);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = pending;
      pending = new Set();
      queue = queue.then(() => rebuild(files)).catch(keepQueueAlive);
    }, DEBOUNCE_MS);
  };

  await rebuild(new Set(), true);

  server.watcher.on('all', (event, path) => {
    // Loading the config for the entry build writes and deletes one of these;
    // reacting to it would bundle again, and again.
    if (isViteConfigTemp(path)) return;
    const changed = fileKey(path);
    // A file or folder added to or removed from a glob's scope may change what the glob selects.
    const regrouped = event !== 'change' && inGlobScope(path, event === 'addDir' || event === 'unlinkDir');
    if (event !== 'add' && event !== 'change' && event !== 'unlink' && !regrouped) return;
    if (!regrouped && (!keyWithin(changed, inputKeys()) || excluded(path)) && !touchesEntry(changed) && !linkMoved()) {
      return;
    }
    noteChange(changed);
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
      if (changed.size === 0 && !linkMoved() && !globsChanged()) return;
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
    // `server.headers`, as Vite sends them with the pages it serves itself.
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
    // Another instance emitting the same name with other bytes: the production build rejects that, and the dev
    // server must not pick one by plugin order.
    for (const other of instances) {
      const theirs = other()?.get(path);
      if (theirs !== undefined && !sameBytes(theirs, asset)) {
        const message = entryCollisionMessage(path);
        config.logger.error(`[twee-ts] ${message}`);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(message);
        return;
      }
    }
    send(req, res, assetMediaType(path), asset);
  };
}

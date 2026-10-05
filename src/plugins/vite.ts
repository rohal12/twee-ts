/**
 * Ready-made Vite plugin for twee-ts.
 *
 * Compiles Twee sources into the story HTML. With `entry`, Vite also bundles a
 * script, and the CSS it imports, into the story as its Story JavaScript and
 * Story Stylesheet.
 *
 * In dev the compiled HTML is served at the base URL with Vite's client added.
 * Every change to a source, the head file, a module or a file the entry imports
 * recompiles it and reloads the page, and errors appear in Vite's overlay. A
 * request for the story also recompiles it first if a source, the head file or
 * a module changed without the watcher reporting it.
 */
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { build, version as viteVersion } from 'vite';
import type { ErrorPayload, InlineConfig, Logger, Plugin, ResolvedConfig, UserConfig } from 'vite';
import type { CompileOptions, CompileResult, Diagnostic, FileCacheEntry, InlineSource } from '../types.js';
import { compileForOutputFile } from '../compiler.js';
import { fatalError, formatDiagnostic, splitDiagnostics } from './diagnostics.js';
import type { LocatedError } from './diagnostics.js';
import { getFilenames, isExcluded } from '../filesystem.js';
import { mediaTypeFromFilename } from '../media-types.js';
import { emittedFilePath, isInside, isViteConfigTemp, toPosix } from './paths.js';

export interface TweeTsVitePluginOptions {
  /** Source directories/files to compile, relative to the working directory. */
  sources: string[];
  /** Story format ID. */
  format?: string;
  /** Output filename in build output. Default: 'index.html'. */
  outputFilename?: string;
  /** Additional compile options. `sources` and `formatId` come from the options above. */
  compileOptions?: Partial<CompileOptions>;
  /**
   * A JS or TS file, relative to the working directory. Vite bundles it and
   * everything it imports into one self-contained script that becomes the
   * story's Story JavaScript; CSS it imports becomes the Story Stylesheet.
   * Requires Vite 8.
   */
  entry?: string;
}

/** Passage names the bundled entry takes inside the story. */
const ENTRY_SCRIPT_NAME = 'twee-ts-entry.js';
const ENTRY_STYLE_NAME = 'twee-ts-entry.css';

/**
 * Set on the inline config of the build this plugin starts itself to bundle the
 * entry in dev. The plugin instance that build loads from the user's config file
 * sees it and stands aside.
 */
const INNER_BUILD_FLAG = '__tweeTsEntryBuild';

/**
 * A build input that stands in when there is no entry, so Vite does not look
 * for an index.html (whose page would replace the story). Its empty chunk is
 * dropped from the output.
 */
const EMPTY_INPUT = 'virtual:twee-ts-empty-input';
const RESOLVED_EMPTY_INPUT = '\0' + EMPTY_INPUT;

const viteMajor = Number.parseInt(viteVersion, 10);

/**
 * The bundled entry: its script, its stylesheet, the files it was built from
 * (forward-slash paths), and any files the bundler still emits separately
 * (by output file name).
 */
interface EntryBundle {
  script: string;
  style: string;
  files: Set<string>;
  assets: Map<string, string | Uint8Array>;
}

/** The parts of a Vite output bundle this plugin reads. */
type BundleItem =
  | { type: 'chunk'; code: string; isEntry: boolean; moduleIds: readonly string[] }
  | { type: 'asset'; source: string | Uint8Array };

function buildCompileOptions(options: TweeTsVitePluginOptions, entry: EntryBundle | undefined): CompileOptions {
  const inline: InlineSource[] = [];
  if (entry) {
    inline.push({ filename: ENTRY_SCRIPT_NAME, content: entry.script });
    if (entry.style !== '') inline.push({ filename: ENTRY_STYLE_NAME, content: entry.style });
  }
  return {
    ...options.compileOptions,
    sources: [...options.sources, ...inline],
    formatId: options.format ?? options.compileOptions?.formatId,
  };
}

/** Whether the user's config names build inputs of its own. */
function hasUserInput(userConfig: UserConfig): boolean {
  const build = userConfig.build as Record<string, { input?: unknown } | undefined> | undefined;
  return build?.['rolldownOptions']?.input !== undefined || build?.['rollupOptions']?.input !== undefined;
}

/** Build settings naming one input, under the option name this Vite version reads. */
function inputOnly(input: string): NonNullable<InlineConfig['build']> {
  return (viteMajor >= 8 ? { rolldownOptions: { input } } : { rollupOptions: { input } }) as NonNullable<
    InlineConfig['build']
  >;
}

/**
 * Build settings that turn the entry into one IIFE script and one stylesheet.
 * Fonts and images the entry uses are inlined as data URLs, so the story stays
 * one file; only an import marked `?no-inline` is still emitted separately.
 */
function entryBuildOptions(entryPath: string): NonNullable<InlineConfig['build']> {
  return {
    cssCodeSplit: false,
    assetsInlineLimit: () => true,
    rolldownOptions: {
      input: entryPath,
      output: { format: 'iife', entryFileNames: ENTRY_SCRIPT_NAME, assetFileNames: '[name][extname]' },
    },
  };
}

/** Removes a trailing source-map comment that points at a file (a data: URL map stays). */
function dropFileSourceMapComment(code: string): string {
  return code
    .replace(/\n?\/\/# sourceMappingURL=(?!data:)\S*\s*$/, '')
    .replace(/\n?\/\*# sourceMappingURL=(?!data:)[^*]*\*\/\s*$/, '');
}

/**
 * Takes the entry's script and stylesheet out of the bundle, together with
 * their map files, which the story cannot ship. Anything else the bundler
 * emitted stays in the bundle, so a build writes it next to the HTML, and is
 * also returned, so the dev server can serve it.
 */
function takeEntryFromBundle(bundle: Record<string, BundleItem>): EntryBundle {
  const entry: EntryBundle = { script: '', style: '', files: new Set(), assets: new Map() };
  const styles: string[] = [];
  for (const [fileName, item] of Object.entries(bundle)) {
    if (item.type === 'chunk') {
      if (item.isEntry) {
        entry.script = dropFileSourceMapComment(item.code);
        for (const id of item.moduleIds) if (!id.startsWith('\0')) entry.files.add(fileOfId(id));
      }
      delete bundle[fileName];
    } else if (fileName.endsWith('.css')) {
      const css = typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
      styles.push(dropFileSourceMapComment(css));
      delete bundle[fileName];
    } else if (fileName.endsWith('.map')) {
      delete bundle[fileName];
    } else {
      entry.assets.set(fileName, item.source);
    }
  }
  entry.style = styles.join('\n');
  return entry;
}

/** Absolute forward-slash paths of the head file and the modules, which `exclude` doesn't apply to. */
function headInputs(options: TweeTsVitePluginOptions): string[] {
  const extra = options.compileOptions;
  return [...(extra?.headFile ? [extra.headFile] : []), ...(extra?.modules ?? [])].map((p) => toPosix(resolve(p)));
}

/**
 * Whether a file (forward-slash path) is an input the compile leaves out: the
 * story HTML a build writes (`builtStory`, an absolute path), and the sources
 * `exclude` matches. `exclude` never applies to the head file and modules.
 */
function excludedInput(options: TweeTsVitePluginOptions, builtStory: string | undefined): (file: string) => boolean {
  const exclude = options.compileOptions?.exclude ?? [];
  const notExcludable = headInputs(options);
  const output = builtStory === undefined ? undefined : toPosix(builtStory);
  return (file) => file === output || (isExcluded(file, exclude) && !isInside(file, notExcludable));
}

/**
 * Where a build writes the story HTML with this config: `build.outDir`, against
 * the root. It may sit inside a source folder, where neither a compile nor the
 * watchers may take it for a source.
 */
function builtStoryPath(config: ResolvedConfig, outputFilename: string): string {
  return resolve(config.root, config.build.outDir, outputFilename);
}

/** Absolute forward-slash paths whose changes recompile the story: sources, head file, modules. */
function watchedInputs(options: TweeTsVitePluginOptions): string[] {
  return [...options.sources.map((p) => toPosix(resolve(p))), ...headInputs(options)];
}

/**
 * What `vite build --watch` watches for the story: every file under `inputs`
 * (forward-slash paths) but those `skip` returns true for, and every folder
 * under them. The bundler watches each path on its own, not recursively, so a
 * folder is listed for the files added to it or deleted from it.
 *
 * A watched folder may still report changes in its subfolders (Rolldown's
 * watcher on Linux does), so no folder that holds the story the build writes
 * (`story`, a forward-slash path) is listed: writing the story would start the
 * next build. A file added straight to such a folder is found when another
 * change starts a build.
 */
function buildWatchTargets(
  inputs: readonly string[],
  skip: (file: string) => boolean,
  story: string | undefined,
): string[] {
  const targets: string[] = [];
  const walk = (path: string): void => {
    let entries;
    try {
      if (!statSync(path).isDirectory()) {
        if (!skip(path)) targets.push(path);
        return;
      }
      entries = readdirSync(path);
    } catch {
      return; // Missing or unreadable: the compile reports it.
    }
    if (story === undefined || !story.startsWith(`${path}/`)) targets.push(path);
    for (const entry of entries) walk(`${path}/${entry}`);
  };
  for (const input of inputs) walk(input);
  return targets;
}

/**
 * Every file under `inputs` (forward-slash paths) but those `skip` returns true
 * for, with what a change to it alters: modification time, size and inode (a
 * file replaced by a new one).
 */
function inputFiles(inputs: readonly string[], skip: (file: string) => boolean): Map<string, string> {
  const files = new Map<string, string>();
  for (const filename of getFilenames([...inputs]).filenames) {
    const file = toPosix(resolve(filename));
    if (skip(file)) continue;
    try {
      const stat = statSync(filename);
      files.set(file, `${stat.mtimeMs}:${stat.size}:${stat.ino}`);
    } catch {
      // Deleted since the walk found it; it counts as gone.
    }
  }
  return files;
}

/** The files added, removed or changed between two `inputFiles` results. */
function filesChanged(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const [file, state] of after) if (before.get(file) !== state) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return changed;
}

/** Adds Vite's client to the page so reloads and the error overlay reach it. */
function injectViteClient(html: string, base: string): string {
  const tag = `<script type="module" src="${base}@vite/client"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return tag + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}

/** Served until the first successful compile, so the overlay has a page to appear on. */
function waitingPage(base: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<script type="module" src="${base}@vite/client"></script>` +
    '<title>twee-ts</title></head><body><p>The story has not compiled yet.</p></body></html>'
  );
}

function toOverlayError(e: unknown): ErrorPayload['err'] {
  const error = fatalError(e);
  return {
    // Bundler messages carry terminal colour codes; the overlay would show them raw.
    message: stripVTControlCharacters(error.message),
    stack: '',
    plugin: 'twee-ts',
    ...(error.id ? { id: error.id } : {}),
    ...(error.loc ? { loc: error.loc } : {}),
  };
}

/** Bundles the entry for dev with the user's own Vite config, unminified, with an inline source map. */
/**
 * The entry build's logger: its warnings go to the dev server's logger; its
 * progress lines and its own "build failed" line are dropped, because the plugin
 * reports a failed bundle itself.
 */
function entryBuildLogger(outer: Logger): Logger {
  return {
    info: () => {},
    warn: (message, options) => outer.warn(message, options),
    warnOnce: (message, options) => outer.warnOnce(message, options),
    error: () => {},
    clearScreen: () => {},
    hasErrorLogged: () => false,
    get hasWarned() {
      return outer.hasWarned;
    },
  };
}

/**
 * Keeps the entry build a one-off even when the user's config sets build.watch:
 * Vite's config merge skips a null, so the inline `watch: null` alone can't.
 */
const oneOffEntryBuild: Plugin = {
  name: 'twee-ts:one-off-entry-build',
  enforce: 'post',
  config(userConfig) {
    if (userConfig.build) userConfig.build.watch = null;
  },
};

/** Build-phase plugin hooks that may call `this.addWatchFile`. */
const WATCH_FILE_HOOKS = [
  'buildStart',
  'resolveId',
  'resolveDynamicImport',
  'load',
  'transform',
  'moduleParsed',
  'buildEnd',
];

/** A module id or watched file as a forward-slash file path, without a query or hash (like Vite's cleanUrl). */
function fileOfId(id: string): string {
  return toPosix(id.replace(/[?#].*$/s, ''));
}

/** A plugin context whose `addWatchFile` also records the file in `files`. */
function recordingContext(context: object, files: Set<string>): object {
  return new Proxy(context, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key !== 'addWatchFile') return value.bind(target);
      return (id: string) => {
        if (!id.startsWith('\0')) files.add(fileOfId(resolve(id)));
        return value.call(target, id);
      };
    },
  });
}

/**
 * A copy of `plugin` whose hooks record `addWatchFile` calls in `files`. The
 * original stays untouched, so a plugin object shared across entry builds never
 * collects wrappers. The copy keeps the prototype, so class-based plugins keep
 * their methods, and object-form hooks keep `order`, `filter` and the rest. A
 * plugin with no such hooks (a built-in one, for instance) is returned as is.
 */
function recordingPlugin(plugin: unknown, files: Set<string>): unknown {
  if (typeof plugin !== 'object' || plugin === null) return plugin;
  const hooks = plugin as Readonly<Record<string, unknown>>;
  const hookHandler = (hook: unknown): unknown =>
    typeof hook === 'object' && hook !== null ? (hook as { handler?: unknown }).handler : hook;
  if (!WATCH_FILE_HOOKS.some((name) => typeof hookHandler(hooks[name]) === 'function')) return plugin;
  const copy = Object.create(
    Object.getPrototypeOf(plugin) as object | null,
    Object.getOwnPropertyDescriptors(plugin),
  ) as Record<string, unknown>;
  for (const name of WATCH_FILE_HOOKS) {
    const hook = hooks[name];
    const handler = hookHandler(hook);
    if (typeof handler !== 'function') continue;
    const wrapped = function (this: object, ...args: unknown[]): unknown {
      return handler.apply(recordingContext(this, files), args);
    };
    copy[name] = typeof hook === 'function' ? wrapped : { ...(hook as object), handler: wrapped };
  }
  return copy;
}

/**
 * Collects the files the entry build's plugins add with `addWatchFile`. These
 * are not modules of the bundle: Vite's CSS plugin adds the stylesheets pulled
 * in by `@import` and the files `url()` points at this way. The build runs on
 * recording copies of its plugins. They are made in the bundler's `options`
 * hook, which sees the final plugin list, including the plugins Vite resolves
 * per environment (`applyToEnvironment`) after `configResolved`.
 */
function recordWatchFiles(files: Set<string>): Plugin {
  return {
    name: 'twee-ts:record-watch-files',
    options: {
      order: 'post',
      async handler(inputOptions) {
        const plugins = (await flattenPlugins(inputOptions.plugins)).map((p) => recordingPlugin(p, files));
        return { ...inputOptions, plugins: plugins as typeof inputOptions.plugins };
      },
    },
  };
}

/** A plugin option (nested arrays, promises, falsy entries) as one flat list. */
async function flattenPlugins(option: unknown): Promise<unknown[]> {
  const value: unknown = await option;
  if (Array.isArray(value)) return (await Promise.all(value.map(flattenPlugins))).flat();
  return value ? [value] : [];
}

/** Bundles the entry for dev with the user's own Vite config, unminified, with an inline source map. */
async function bundleEntryForDev(config: ResolvedConfig, entryPath: string): Promise<EntryBundle> {
  const watchFiles = new Set<string>();
  const inline: InlineConfig & Record<string, unknown> = {
    configFile: config.configFile ?? false,
    root: config.root,
    mode: config.mode,
    customLogger: entryBuildLogger(config.logger),
    publicDir: false,
    // With a config file the entry build reads it again, plugins and all. Without
    // one, the settings that change how code bundles come across from the server.
    ...(config.configFile ? {} : { define: config.define, resolve: { alias: config.resolve.alias } }),
    build: {
      ...entryBuildOptions(entryPath),
      write: false,
      minify: false,
      sourcemap: 'inline',
      emptyOutDir: false,
      copyPublicDir: false,
      watch: null,
    },
    plugins: [oneOffEntryBuild, recordWatchFiles(watchFiles)],
    [INNER_BUILD_FLAG]: true,
  };
  const out = await build(inline);
  const bundle: Record<string, BundleItem> = {};
  for (const result of Array.isArray(out) ? out : [out]) {
    if (!('output' in result)) {
      await result.close();
      throw new Error('twee-ts: the entry build returned a watcher instead of a bundle.');
    }
    for (const item of result.output) bundle[item.fileName] = item;
  }
  const entry = takeEntryFromBundle(bundle);
  for (const file of watchFiles) entry.files.add(file);
  return entry;
}

export function tweeTsPlugin(options: TweeTsVitePluginOptions): Plugin {
  const outputFilename = options.outputFilename ?? 'index.html';
  const cache = new Map<string, FileCacheEntry>();
  let innerBuild = false;
  let building = false;
  let builtStory: string | undefined; // where a build writes the story, once the config is resolved
  let stopDev: (() => void) | undefined;

  if (options.entry && viteMajor < 8) {
    throw new Error(`twee-ts: the entry option needs Vite 8 or newer (found ${viteVersion}).`);
  }

  return {
    name: 'twee-ts',

    config(userConfig, env) {
      innerBuild = (userConfig as Record<string, unknown>)[INNER_BUILD_FLAG] === true;
      building = env.command === 'build';
      if (innerBuild || !building) return undefined;
      if (options.entry) return { build: entryBuildOptions(resolve(options.entry)) };
      if (hasUserInput(userConfig)) return undefined;
      return { build: inputOnly(EMPTY_INPUT) };
    },

    configResolved(config) {
      if (innerBuild) return;
      builtStory = builtStoryPath(config, outputFilename);
      if (!options.entry) return;
      const sources = options.sources.map((p) => toPosix(resolve(p)));
      if (isInside(toPosix(resolve(options.entry)), sources)) {
        config.logger.warn(
          `[twee-ts] The entry ${options.entry} is inside the story sources (${options.sources.join(', ')}). ` +
            'twee-ts also loads the .js and .css files it finds in source folders, unbundled, as Story JavaScript ' +
            "and Story Stylesheet; keep the entry's folder out of `sources`.",
        );
      }
    },

    // `vite build --watch` rebuilds for the files the build registers. The story's
    // inputs are read in generateBundle, outside the module graph, so they are
    // registered here; the dev server watches them itself (configureServer).
    buildStart() {
      if (innerBuild || !building || !this.meta.watchMode) return;
      const story = builtStory === undefined ? undefined : toPosix(builtStory);
      for (const target of buildWatchTargets(watchedInputs(options), excludedInput(options, builtStory), story)) {
        this.addWatchFile(target);
      }
    },

    // The compile cache trusts modification times, which a quick save may leave
    // unchanged (coarse file-system timestamps); forget a file that changed.
    watchChange(id) {
      if (innerBuild) return;
      const changed = toPosix(resolve(id));
      for (const key of [...cache.keys()]) if (toPosix(resolve(key)) === changed) cache.delete(key);
    },

    resolveId(id) {
      return id === EMPTY_INPUT ? RESOLVED_EMPTY_INPUT : undefined;
    },

    load(id) {
      // A statement app builds keep (they drop unused exports), so Rollup in Vite 5
      // doesn't warn about an empty chunk. The chunk is removed from the output.
      return id === RESOLVED_EMPTY_INPUT ? 'globalThis.tweeTsEmptyInput = true;' : undefined;
    },

    generateBundle: {
      order: 'post',
      async handler(outputOptions, bundle) {
        if (innerBuild) return;
        for (const [fileName, item] of Object.entries(bundle)) {
          if (item.type === 'chunk' && item.facadeModuleId === RESOLVED_EMPTY_INPUT) delete bundle[fileName];
        }
        const entry = options.entry ? takeEntryFromBundle(bundle) : undefined;
        // The bundler's own output settings say where the story goes, should they
        // differ from build.outDir; its last build there is no source.
        const outFile = emittedFilePath(outputOptions, outputFilename) ?? builtStory;
        let result: CompileResult;
        try {
          result = await compileForOutputFile(buildCompileOptions(options, entry), outFile, cache);
        } catch (e) {
          return this.error(fatalError(e));
        }
        let warnings: Diagnostic[];
        try {
          warnings = splitDiagnostics(result);
        } catch (e) {
          return this.error(e as LocatedError);
        }
        for (const w of warnings) this.warn(formatDiagnostic(w));
        this.emitFile({ type: 'asset', fileName: outputFilename, source: result.output });
      },
    },

    async configureServer(server) {
      if (innerBuild) return;
      const base = server.config.base;
      const servePaths = outputFilename === 'index.html' ? [base, `${base}index.html`] : [`${base}${outputFilename}`];
      const inputs = watchedInputs(options);
      // A build's story HTML, which `vite build` may have left inside a source folder.
      const buildOutput = builtStoryPath(server.config, outputFilename);
      const excluded = excludedInput(options, buildOutput);
      const entryPath = options.entry ? resolve(options.entry) : undefined;
      const root = toPosix(server.config.root);
      server.watcher.add(inputs);

      let html = '';
      let lastError: ErrorPayload['err'] | undefined;
      let entry: EntryBundle | undefined; // last good bundle
      let entryStale = true; // bundle again on the next rebuild
      let queue: Promise<void> = Promise.resolve();
      let pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      // The input files as the last compile found them, to tell whether the
      // watcher missed a change (see catchUp).
      let compiledInputs = new Map<string, string>();
      let catchingUp: Promise<void> | undefined;
      stopDev = () => {
        closed = true;
        clearTimeout(timer);
        pending.clear();
      };

      // The files that belong to the entry: after a good bundle, the modules it was
      // built from and the files its plugins watch (such as CSS @imports and url()
      // targets); while there is none, or the last one failed, anything in
      // the project, so that creating a missing import brings it back.
      const touchesEntry = (file: string): boolean =>
        entryPath !== undefined && (entryStale ? isInside(file, [root]) : (entry?.files.has(file) ?? false));

      // `initial`: the compile at server start. No page is open yet, and Vite would
      // hold a full-reload for the first page that connects and reload it once.
      const rebuild = async (changed: ReadonlySet<string>, initial = false): Promise<void> => {
        if (closed) return;
        // Taken before the compile reads anything, so a file written during it
        // still counts as changed afterwards.
        compiledInputs = inputFiles(inputs, excluded);
        // The compile cache trusts modification times, which a quick save may leave
        // unchanged (coarse file-system timestamps); forget the files that changed.
        for (const key of [...cache.keys()]) if (changed.has(toPosix(resolve(key)))) cache.delete(key);
        try {
          if (entryPath && (entryStale || [...changed].some(touchesEntry))) {
            entryStale = true;
            entry = await bundleEntryForDev(server.config, entryPath);
            entryStale = false;
          }
          const result = await compileForOutputFile(buildCompileOptions(options, entry), buildOutput, cache);
          for (const w of splitDiagnostics(result)) server.config.logger.warn(`[twee-ts] ${formatDiagnostic(w)}`);
          html = injectViteClient(result.output, base);
          lastError = undefined;
          if (!initial) server.ws.send({ type: 'full-reload' });
        } catch (e) {
          lastError = toOverlayError(e);
          server.config.logger.error(`[twee-ts] ${lastError.message}`);
          server.ws.send({ type: 'error', err: lastError });
        }
      };

      // rebuild() reports its own errors; this catches a failure while reporting,
      // so one bad report doesn't stop every later rebuild.
      const keepQueueAlive = (e: unknown): void => {
        try {
          server.config.logger.error(`[twee-ts] ${fatalError(e).message}`);
        } catch {
          // Nothing left to report with.
        }
      };

      await rebuild(new Set(), true);

      server.watcher.on('all', (event, file) => {
        if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
        const changed = toPosix(resolve(file));
        // Loading the config for the entry build writes and deletes one of these;
        // reacting to it would bundle again, and again.
        if (isViteConfigTemp(changed)) return;
        if ((!isInside(changed, inputs) || excluded(changed)) && !touchesEntry(changed)) return;
        pending.add(changed);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const files = pending;
          pending = new Set();
          queue = queue.then(() => rebuild(files)).catch(keepQueueAlive);
        }, 50);
      });

      // The watcher can miss changes. When a folder is deleted and created again
      // in quick succession (as `git rebase` does), chokidar stops watching the
      // folder, so a file added to it later raises no event; under Deno it also
      // loses the files created with it, so their later edits raise none
      // either. Before the story is served, this
      // waits for any compile under way, compares the input files with what the
      // last compile found, and compiles again first if they differ.
      const catchUp = (): Promise<void> => {
        catchingUp ??= (async () => {
          await queue;
          const changed = filesChanged(compiledInputs, inputFiles(inputs, excluded));
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

      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (servePaths.includes(path)) {
          catchUp().then(() => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html || waitingPage(base));
          }, next);
          return;
        }
        // Files the entry's bundle still emits separately, where the build writes them.
        const asset = path.startsWith(base) ? entry?.assets.get(path.slice(base.length)) : undefined;
        if (asset !== undefined) {
          res.statusCode = 200;
          res.setHeader('Content-Type', mediaTypeFromFilename(path));
          res.end(asset);
          return;
        }
        next();
      });
    },

    // Vite runs this when the dev server closes (and after a build); no rebuild may
    // start after it, including one whose timer is still pending in middleware mode.
    closeBundle() {
      stopDev?.();
    },
  };
}

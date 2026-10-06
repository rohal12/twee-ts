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
import { join, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { build, version as viteVersion } from 'vite';
import type { ErrorPayload, InlineConfig, Logger, Plugin, ResolvedConfig, UserConfig } from 'vite';
import type { CompileOptions, CompileResult, Diagnostic, FileCacheEntry, InlineSource } from '../types.js';
import { compileForOutputFile } from '../compiler.js';
import { fatalError, formatDiagnostic, splitDiagnostics } from './diagnostics.js';
import type { LocatedError } from './diagnostics.js';
import { getFilenames, isExcluded, outputPaths, realPathOf, walkedEntry } from '../filesystem.js';
import type { BuildOutputs, OutputPaths } from '../filesystem.js';
import { mediaTypeFromFilename } from '../media-types.js';
import { findHeadStartEnd } from '../modules.js';
import { createOutputRecord, isInside, isViteConfigTemp, outputLocations, toPosix } from './paths.js';
import type { OutputLocation } from './paths.js';

export interface TweeTsVitePluginOptions {
  /** Source directories/files to compile, relative to the working directory. */
  sources: string[];
  /** Story format ID. */
  format?: string | undefined;
  /** Output filename in build output. Default: 'index.html'. */
  outputFilename?: string | undefined;
  /** Additional compile options. `sources` and `formatId` come from the options above. */
  compileOptions?: Partial<CompileOptions> | undefined;
  /**
   * A JS or TS file, relative to the working directory. Vite bundles it and
   * everything it imports into one self-contained script that becomes the
   * story's Story JavaScript; CSS it imports becomes the Story Stylesheet.
   * Requires Vite 8.
   */
  entry?: string | undefined;
}

/** Passage names the bundled entry takes inside the story. */
const ENTRY_SCRIPT_NAME = 'twee-ts-entry.js';
const ENTRY_STYLE_NAME = 'twee-ts-entry.css';

/**
 * Set on the inline config of the build this plugin starts itself to bundle the
 * entry in dev. The plugin instance that build loads from the user's config file
 * sees it and stands aside.
 */
/** The plugin's name, which is also how the entry build tells it from the user's other plugins. */
const PLUGIN_NAME = 'twee-ts';
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
  return viteMajor >= 8 ? { rolldownOptions: { input } } : { rollupOptions: { input } };
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

/**
 * Removes a file from the bundle, which Rollup and Vite hand plugins as a plain object keyed by
 * file name: deleting its key is how a plugin drops an output file.
 */
function removeFromBundle(bundle: Record<string, unknown>, fileName: string): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the bundle object is the bundler's API.
  delete bundle[fileName];
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
      removeFromBundle(bundle, fileName);
    } else if (fileName.endsWith('.css')) {
      const css = typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
      styles.push(dropFileSourceMapComment(css));
      removeFromBundle(bundle, fileName);
    } else if (fileName.endsWith('.map')) {
      removeFromBundle(bundle, fileName);
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
 * Whether a file (forward-slash path) is a source `exclude` matches. `exclude`
 * never applies to the head file and modules.
 */
function excludedByGlob(options: TweeTsVitePluginOptions): (file: string) => boolean {
  const exclude = options.compileOptions?.exclude ?? [];
  const notExcludable = headInputs(options);
  return (file) => isExcluded(file, exclude) && !isInside(file, notExcludable);
}

/**
 * Where a build with this config writes: each output's folder, the bundler's
 * `output.dir` or else `build.outDir`, or the bundler's `output.file`. Vite
 * resolves an `output.dir` against the root when it empties the folder and
 * copies the public files into it, while the bundler resolves it against the
 * working directory when it writes; both count.
 */
function configOutputLocations(config: ResolvedConfig): OutputLocation[] {
  const outDir = resolve(config.root, config.build.outDir);
  const bundlerOptions = (
    config.build as unknown as Readonly<Record<string, { readonly output?: unknown } | undefined>>
  )[viteMajor >= 8 ? 'rolldownOptions' : 'rollupOptions'];
  const option = bundlerOptions?.output;
  const outputs: unknown[] = option === undefined ? [{}] : Array.isArray(option) ? option : [option];
  return outputs.flatMap((output) => {
    const [location] = outputLocations(output);
    if (location === undefined) return [{ dir: outDir }];
    if (location.dir === undefined) return [location];
    return [{ dir: resolve(location.dir) }, { dir: resolve(config.root, location.dir) }];
  });
}

/**
 * Every path a build with this config writes, as far as the config tells: each
 * output's folder (see configOutputLocations), the story in it, and the copies
 * of the public files Vite puts there. The plugin adds the files each bundle
 * writes as it builds (see createOutputRecord).
 */
function configOutputs(config: ResolvedConfig, outputFilename: string): BuildOutputs {
  const record = createOutputRecord(outputFilename);
  const publicFiles =
    config.build.copyPublicDir && config.publicDir
      ? getFilenames([config.publicDir]).filenames.map((file) => relative(config.publicDir, resolve(file)))
      : [];
  for (const location of configOutputLocations(config)) {
    record.addLocation(location);
    record.addFiles(location, publicFiles);
  }
  return record.outputs();
}

/** Both builds' outputs together. */
function mergeOutputs(a: BuildOutputs, b: BuildOutputs): BuildOutputs {
  return { files: [...a.files, ...b.files], dirs: [...a.dirs, ...b.dirs] };
}

/** Absolute forward-slash paths whose changes recompile the story: sources, head file, modules. */
function watchedInputs(options: TweeTsVitePluginOptions): string[] {
  return [...options.sources.map((p) => toPosix(resolve(p))), ...headInputs(options)];
}

/**
 * What `vite build --watch` watches for the story: every file under `inputs`
 * (forward-slash paths) that source discovery reads, but those `skip` returns
 * true for, and every folder under them. The bundler watches each path on its
 * own, not recursively, so a folder is listed for the files added to it or
 * deleted from it. As in source discovery, a link to a folder is not followed.
 *
 * A watched folder may still report changes in its subfolders (Rolldown's
 * watcher on Linux does), so no path the build writes (`outputs`) is listed, nor
 * a folder that holds one: writing the outputs would start the next build. A file
 * added straight to such a folder is found when another change starts a build.
 */
function buildWatchTargets(inputs: readonly string[], skip: (file: string) => boolean, outputs: OutputPaths): string[] {
  const targets: string[] = [];
  const walk = (path: string, real: string, isRoot: boolean): void => {
    if (outputs.isFile(real) || (!isRoot && outputs.isDir(real))) return;
    let entry;
    let names;
    try {
      entry = isRoot ? { stat: statSync(path), real } : walkedEntry(path, real);
      if (entry === undefined || outputs.isFile(entry.real)) return;
      if (!entry.stat.isDirectory()) {
        if (!skip(path)) targets.push(path);
        return;
      }
      names = readdirSync(path);
    } catch {
      return; // Missing or unreadable: the compile reports it.
    }
    if (!outputs.holds(entry.real)) targets.push(path);
    for (const name of names) walk(`${path}/${name}`, join(entry.real, name), false);
  };
  for (const input of inputs) walk(input, realPathOf(input), true);
  return targets;
}

/**
 * Every file under `inputs` (forward-slash paths) that source discovery reads,
 * leaving out `outputs`, but those `skip` returns true for, with what a change to
 * it alters: modification time, size and inode (a file replaced by a new one).
 */
function inputFiles(
  inputs: readonly string[],
  skip: (file: string) => boolean,
  outputs: BuildOutputs,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const filename of getFilenames(inputs, outputs).filenames) {
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
  // The real head start tag: not one in a comment, a script or an attribute value.
  const at = findHeadStartEnd(html);
  if (at === undefined) return tag + html;
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

/**
 * The entry build's logger: its warnings go to the dev server's logger; its
 * progress lines and its own "build failed" line are dropped, because the plugin
 * reports a failed bundle itself.
 */
function entryBuildLogger(outer: Logger): Logger {
  return {
    info: () => {
      // Progress lines are dropped.
    },
    warn: (message, options) => {
      outer.warn(message, options);
    },
    warnOnce: (message, options) => {
      outer.warnOnce(message, options);
    },
    error: () => {
      // The plugin reports a failed bundle itself.
    },
    clearScreen: () => {
      // The dev server's screen is not the entry build's to clear.
    },
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
      const bound: unknown = value.bind(target);
      if (key !== 'addWatchFile') return bound;
      return (id: string): unknown => {
        if (!id.startsWith('\0')) files.add(fileOfId(resolve(id)));
        const result: unknown = value.call(target, id);
        return result;
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

/**
 * The plugins passed to `createServer()` itself, flattened, without twee-ts: the entry build must not run this
 * plugin, whose state belongs to the server, and a config file brings its own plugins when it is read again.
 * Vite's resolved list is not used, as it holds the built-ins every build adds for itself.
 */
async function inlinePlugins(config: ResolvedConfig): Promise<Plugin[]> {
  const plugins = (await flattenPlugins(config.inlineConfig.plugins)) as Plugin[];
  return plugins.filter((plugin) => plugin.name !== PLUGIN_NAME);
}

/** Bundles the entry for dev with the user's own Vite config, unminified, with an inline source map. */
async function bundleEntryForDev(config: ResolvedConfig, entryPath: string): Promise<EntryBundle> {
  const watchFiles = new Set<string>();
  // With a config file the entry build reads it again, plugins and all, so only what the server was given on top
  // of it comes across. Without one, the resolved settings that change how code bundles do.
  // Vite reads an absent `define` the same as an undefined one (its config merge skips undefined values).
  const define = config.configFile ? config.inlineConfig.define : config.define;
  const alias = config.configFile ? config.inlineConfig.resolve?.alias : config.resolve.alias;
  const settings: InlineConfig = {
    ...(define ? { define } : {}),
    ...(alias ? { resolve: { alias } } : {}),
  };
  const inline: InlineConfig & Record<string, unknown> = {
    configFile: config.configFile ?? false,
    root: config.root,
    mode: config.mode,
    customLogger: entryBuildLogger(config.logger),
    publicDir: false,
    ...settings,
    build: {
      ...entryBuildOptions(entryPath),
      write: false,
      minify: false,
      sourcemap: 'inline',
      emptyOutDir: false,
      copyPublicDir: false,
      watch: null,
    },
    plugins: [...(await inlinePlugins(config)), oneOffEntryBuild, recordWatchFiles(watchFiles)],
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
  // The config of the last build this plugin took part in, once resolved.
  let buildConfig: ResolvedConfig | undefined;
  // The files this plugin's builds write, and their output folders, as each bundle
  // reports them. A source folder may hold any of them; none is a source.
  const record = createOutputRecord(outputFilename);
  // Everything the builds and the dev server leave out: what the config says a
  // build writes, and what the builds so far wrote.
  const allOutputs = (config: ResolvedConfig): BuildOutputs =>
    mergeOutputs(configOutputs(config, outputFilename), record.outputs());

  if (options.entry && viteMajor < 8) {
    throw new Error(`twee-ts: the entry option needs Vite 8 or newer (found ${viteVersion}).`);
  }

  return {
    name: PLUGIN_NAME,

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
      if (building) buildConfig = config;
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
      if (innerBuild || !building || !this.meta.watchMode || buildConfig === undefined) return;
      const outputs = outputPaths(allOutputs(buildConfig));
      for (const target of buildWatchTargets(watchedInputs(options), excludedByGlob(options), outputs)) {
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
          if (item.type === 'chunk' && item.facadeModuleId === RESOLVED_EMPTY_INPUT) removeFromBundle(bundle, fileName);
        }
        // Where this output writes the story and the bundle, should the bundler's own
        // settings differ from what the config said. Nothing a build writes is a source.
        record.addLocation(outputOptions);
        record.addFiles(outputOptions, Object.keys(bundle));
        const outputs = buildConfig === undefined ? record.outputs() : allOutputs(buildConfig);
        const entry = options.entry ? takeEntryFromBundle(bundle) : undefined;
        let result: CompileResult;
        try {
          result = await compileForOutputFile(buildCompileOptions(options, entry), outputs, cache);
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
      // What a build writes, which `vite build` may have left inside a source folder:
      // the story, chunks and assets, and the copies of the public files.
      let outputs = allOutputs(server.config);
      let output = outputPaths(outputs);
      const refreshOutputs = (): void => {
        outputs = allOutputs(server.config);
        output = outputPaths(outputs);
      };
      const excludedGlob = excludedByGlob(options);
      const excluded = (file: string): boolean => excludedGlob(file) || output.isOutput(file, inputs);
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
        refreshOutputs();
        // Taken before the compile reads anything, so a file written during it
        // still counts as changed afterwards.
        compiledInputs = inputFiles(inputs, excludedGlob, outputs);
        // The compile cache trusts modification times, which a quick save may leave
        // unchanged (coarse file-system timestamps); forget the files that changed.
        for (const key of [...cache.keys()]) if (changed.has(toPosix(resolve(key)))) cache.delete(key);
        try {
          if (entryPath && (entryStale || [...changed].some(touchesEntry))) {
            entryStale = true;
            entry = await bundleEntryForDev(server.config, entryPath);
            entryStale = false;
          }
          const result = await compileForOutputFile(buildCompileOptions(options, entry), outputs, cache);
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
          const changed = filesChanged(compiledInputs, inputFiles(inputs, excludedGlob, outputs));
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
  };
}

/**
 * Ready-made Vite plugin for twee-ts.
 *
 * Compiles Twee sources into the story HTML. With `entry`, Vite also bundles a
 * script, and the CSS it imports, into the story as its Story JavaScript and
 * Story Stylesheet.
 *
 * In dev the compiled HTML is served at the base URL with Vite's client added.
 * Every change to a source, the head file, a module or a file the entry was
 * bundled from recompiles it and reloads the page, and errors appear in Vite's
 * overlay (see vite-dev.ts). A build emits the story with the configured file
 * name, in the client environment only.
 */
import { resolve } from 'node:path';
import { version as viteVersion } from 'vite';
import type { BuildEnvironmentOptions, Plugin, ResolvedConfig, UserConfig } from 'vite';
import type { FileCacheEntry } from '../types.js';
import { recordOwnOutput } from '../atomic-write.js';
import { compileStory, fatalError } from './diagnostics.js';
import type { CompiledStory } from './diagnostics.js';
import { outputPaths } from '../filesystem.js';
import type { BuildOutputs, OutputPaths } from '../filesystem.js';
import { insertViteClient } from '../html-structure.js';
import { isSameOrInside } from '../path-identity.js';
import { checkViteVersion, resolvePluginOptions } from './options.js';
import type { SharedPluginOptions } from './options.js';
import {
  canonicalPath,
  createOutputRecord,
  emittedFilePath,
  fileKey,
  fileOfId,
  outputLocations,
  toPosix,
} from './paths.js';
import type { OutputLocation, OutputRecord } from './paths.js';
import { installStoryRoute, setUpDevStory } from './vite-dev.js';
import { publicFiles } from './vite-public.js';
import {
  bundleEntry,
  ENTRY_INPUT_NAME,
  entryInputSettings,
  entryRenderBuiltUrl,
  entryCollisionMessage,
  entryAssetReferences,
  entrySources,
  forgetKeptResolver,
  importSpellings,
  PLUGIN_NAME,
  pluginWith,
  removeFromBundle,
  recordWatchFiles,
  takeEntryFromBundle,
  withWorkerPlugin,
} from './vite-entry.js';
import type { BundleItem, EntryBundle, ImportHookContext } from './vite-entry.js';
import { moduleGlobScopes, readScope, scopeAdmits, scopeId, scopeWatchTargets } from './vite-glob.js';
import type { GlobScope } from './vite-glob.js';
import { importWatchTargets, watchTargets } from './watch-targets.js';
import { isRecord } from '../util.js';

export type { PluginCompileOptions } from './options.js';

export interface TweeTsVitePluginOptions extends SharedPluginOptions {
  /**
   * A JS or TS file, relative to the working directory. Vite bundles it and
   * everything it imports into one self-contained script that becomes the
   * story's Story JavaScript; CSS it imports becomes the Story Stylesheet.
   */
  entry?: string | undefined;
}

/**
 * A build input that stands in when the user's config names none, so Vite does
 * not look for an index.html (whose page would replace the story). Its empty
 * chunk is dropped from the output.
 */
const EMPTY_INPUT = 'virtual:twee-ts-empty-input';
const RESOLVED_EMPTY_INPUT = '\0' + EMPTY_INPUT;

/** The environment the story belongs to: the browser's. */
const CLIENT = 'client';

/** Vite's plugin that bundles workers, and keeps their bundles between the builds of `vite build --watch`. */
const VITE_WORKER_PLUGIN = 'vite:worker';

/** The plugin instances created so far, which numbers each instance's entry input. */
let instances = 0;

/** The bundler options of build settings: `rolldownOptions`, or the older name Vite 8 still reads. */
function bundlerOptionsOf(build: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(build)) return undefined;
  const options = build['rolldownOptions'] ?? build['rollupOptions'];
  return isRecord(options) ? options : undefined;
}

/**
 * Whether a config (or an environment's options) names what the build builds:
 * a bundler input, Vite 8's top-level `input`, a library entry or an SSR entry.
 */
function namesInput(config: object): boolean {
  const build: unknown = Reflect.get(config, 'build');
  return (
    Reflect.get(config, 'input') !== undefined ||
    bundlerOptionsOf(build)?.['input'] !== undefined ||
    (isRecord(build) && (Boolean(build['lib']) || Boolean(build['ssr'])))
  );
}

/** Build settings naming one input. */
function inputOnly(input: string): BuildEnvironmentOptions {
  return { rolldownOptions: { input } };
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
  const option = bundlerOptionsOf(config.build)?.['output'];
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
 * writes as it builds (see createOutputRecord). A build passes its persistent
 * record so public copies remain excluded after a file is removed or a link is retargeted.
 */
function configOutputs(config: ResolvedConfig, record: OutputRecord): BuildOutputs {
  const copiedFiles = config.build.copyPublicDir && config.publicDir ? publicFiles(config.publicDir) : [];
  for (const location of configOutputLocations(config)) {
    record.addLocation(location);
    record.addFiles(location, copiedFiles);
  }
  return record.outputs();
}

/** Both builds' outputs together. */
function mergeOutputs(a: BuildOutputs, b: BuildOutputs): BuildOutputs {
  return {
    files: [...a.files, ...b.files],
    stories: [...(a.stories ?? []), ...(b.stories ?? [])],
    dirs: [...a.dirs, ...b.dirs],
  };
}

/** Adds Vite's client to the page, first in its head, so reloads and the error overlay reach it. */
function injectViteClient(html: string, base: string): string {
  return insertViteClient(html, `${base}@vite/client`);
}

/**
 * What `vite build --watch` is told to watch for the entry's globs: each glob's folder (or the nearest one above it
 * that exists), by real path, as the bundler's watcher reports it. A folder that holds a build output is left out,
 * since the watcher would report what the build writes there and rebuild for ever: a file added to it is bundled
 * with the next build something else starts.
 */
function globWatchTargets(scopes: Iterable<GlobScope>, outputs: OutputPaths): string[] {
  return scopeWatchTargets(scopes)
    .map(canonicalPath)
    .filter((folder) => !outputs.holds(folder));
}

/** Whether a resolved config is a build of the client, the only build that carries the story. */
function isStoryBuild(config: ResolvedConfig): boolean {
  return config.command === 'build' && !config.build.ssr;
}

/** An import as written: its importer and its source. */
function importKey(importer: string | undefined, source: string): string {
  return `${importer ?? ''}\0${source}`;
}

/** Whether a plugin is Vite's own (its resolver, alias and the rest) or one of twee-ts's. */
function isOwnPlugin(plugin: Plugin): boolean {
  return (
    plugin.name === 'alias' ||
    plugin.name.startsWith('vite:') ||
    plugin.name.startsWith('builtin:') ||
    plugin.name === PLUGIN_NAME ||
    plugin.name.startsWith(`${PLUGIN_NAME}:`)
  );
}

/**
 * A copy of `plugin` (see pluginWith) with a `resolveId` hook that passes each import it resolves (see importKey) to
 * `claim`. A plugin without a `resolveId` hook in JavaScript is returned as it is.
 */
function claimingPlugin(plugin: Plugin, claim: (key: string) => void): Plugin {
  const hook = plugin.resolveId;
  const handler: unknown = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof handler !== 'function') return plugin;
  const claiming = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const result: unknown = await Reflect.apply(handler, this, args);
    const [source, importer] = args;
    if (result !== null && result !== undefined && typeof source === 'string') {
      claim(importKey(typeof importer === 'string' ? importer : undefined, source));
    }
    return result;
  };
  return pluginWith(
    plugin,
    new Map([['resolveId', typeof hook === 'function' ? claiming : { ...hook, handler: claiming }]]),
  );
}

/** The part of a build hook's context that registering watch targets uses. */
type WatchHookContext = ImportHookContext & {
  readonly environment: { readonly config: ResolvedConfig };
  addWatchFile(id: string): void;
};

export function tweeTsPlugin(options: TweeTsVitePluginOptions): Plugin {
  checkViteVersion(viteVersion);
  const resolved = resolvePluginOptions('vite', options);
  const { outputFilename, entry: entryPath } = resolved;
  instances += 1;
  // The name of this instance's entry input, when it bundles the entry inside the user's build.
  const entryInput = `${ENTRY_INPUT_NAME}-${instances}`;
  const cache = new Map<string, FileCacheEntry>();
  // The entry bundled by a build of its own, for each build (by environment) that
  // couldn't bundle it inside itself.
  const ownBuilds = new WeakMap<object, EntryBundle>();
  const entryInputs = new WeakMap<ResolvedConfig, () => ReadonlySet<string>>();
  const entryAssets = new WeakMap<ResolvedConfig, ReadonlySet<string>>();
  // The files this plugin's builds write, and their output folders, as each bundle
  // reports them. A source folder may hold any of them; none is a source.
  const record = createOutputRecord(outputFilename);
  // Everything the builds and the dev server leave out: what the config says a
  // build writes, and what the builds so far wrote.
  const allOutputs = (config: ResolvedConfig): BuildOutputs =>
    mergeOutputs(configOutputs(config, createOutputRecord(outputFilename)), record.outputs());

  /**
   * The build settings this instance adds to a client build: none when the
   * user's config names an input (the entry is then bundled by a build of its
   * own); else, with an entry, the entry as the only input (unless the user's
   * output is an array, which the entry's IIFE can't use); else the stand-in
   * input.
   */
  const inputSettings = (
    config: Readonly<UserConfig>,
  ): { build: BuildEnvironmentOptions; define?: Record<string, string> } | undefined => {
    if (namesInput(config)) return undefined;
    if (entryPath === undefined) return { build: inputOnly(EMPTY_INPUT) };
    const output = config.build?.rolldownOptions?.output;
    if (Array.isArray(output)) return { build: inputOnly(EMPTY_INPUT) };
    return entryInputSettings(entryInput, entryPath, output, outputFilename);
  };

  /** Whether this instance's entry is an input of the build with this config. */
  const bundlesEntryInside = (config: { readonly build: unknown }): boolean => {
    const input = bundlerOptionsOf(config.build)?.['input'];
    return isRecord(input) && Object.hasOwn(input, entryInput);
  };

  /** The resolved config of the build a hook runs in: its environment's, so builds sharing the instance keep apart. */
  const configOf = (context: { readonly environment: { readonly config: ResolvedConfig } }): ResolvedConfig =>
    context.environment.config;

  // What builds with each config write, as `vite build --watch` leaves them out of its watch targets; taken once per
  // build (see buildStart), and once per nested worker build, whose config is its own.
  let watchOutputs = new WeakMap<ResolvedConfig, OutputPaths>();
  // Each file (by real path) an import has reached in the builds of `vite build --watch`, by the import as written:
  // its importer and its source. Not by the path it reaches the file through, which a retarget may change too (a
  // package's `exports`, a folder's index of another extension).
  const keptTargets = new Map<string, Set<string>>();
  // The imports one of the user's plugins resolved itself (see importKey), in `vite build --watch`: their module is
  // the plugin's choice, which no link changes.
  const claimed = new Set<string>();
  const outputsOf = (config: ResolvedConfig): OutputPaths => {
    const known = watchOutputs.get(config);
    if (known !== undefined) return known;
    const outputs = outputPaths(allOutputs(config));
    watchOutputs.set(config, outputs);
    return outputs;
  };

  /**
   * `vite build --watch` with the entry bundled inside the build: the bundler watches each module by its real path,
   * so the links an import of the entry's graph goes through (or the folder where an import that reaches nothing
   * would be created) are registered here, as the import is resolved (see importWatchTargets).
   */
  const registerImport = async (context: WatchHookContext, source: string, importer: string | undefined) => {
    const config = configOf(context);
    const { spellings, kept } = await importSpellings(context, source, importer, config.root);
    for (const target of importWatchTargets(spellings, outputsOf(config))) context.addWatchFile(target);
    return kept;
  };

  /** Likewise, each glob's folder: Vite's import-glob reads the files a glob matches, and registers no folder. */
  const registerGlobs = async (
    context: WatchHookContext & Parameters<typeof moduleGlobScopes>[0],
    code: string,
    id: string,
  ) => {
    const config = configOf(context);
    const scopes = await moduleGlobScopes(context, code, id, config.root);
    for (const target of globWatchTargets(scopes, outputsOf(config))) context.addWatchFile(target);
    return scopes;
  };

  // The globs of the entry's workers in `vite build --watch`, by scopeId, each with the modules that call it.
  const workerGlobs = new Map<string, { readonly scope: GlobScope; readonly importers: Set<string> }>();
  let warnedWorkerCache = false;

  /**
   * `vite build --watch` keeps each worker's bundle until a file it read changes, and a file added to the folder of
   * one of its globs is none of those. When `file` is added to (or removed from) the scope of a worker's glob, the
   * bundles of the workers whose modules call the glob are let go, through Vite's own worker plugin, as an edit of
   * those modules would; the build that follows bundles them again (#424).
   */
  const releaseWorkerGlobs = async (context: WatchHookContext, file: string): Promise<void> => {
    const importers = [...workerGlobs.values()]
      .filter(({ scope }) => {
        // The folders the glob reaches through links as they are now: one linked in since is in its scope too.
        const { linked } = readScope(scope);
        return scopeAdmits(scope, file, false, linked) || scopeAdmits(scope, file, true, linked);
      })
      .flatMap(({ importers: modules }) => [...modules]);
    if (importers.length === 0) return;
    const hook = configOf(context).plugins.find((plugin) => plugin.name === VITE_WORKER_PLUGIN)?.watchChange;
    const handler: unknown = typeof hook === 'function' ? hook : hook?.handler;
    if (typeof handler !== 'function') {
      if (!warnedWorkerCache) {
        warnedWorkerCache = true;
        configOf(context).logger.warn(
          `[twee-ts] This Vite version has no ${VITE_WORKER_PLUGIN} plugin with a watchChange hook, through which ` +
            "twee-ts has Vite bundle a worker again: a file added to the folder of a worker's import.meta.glob() is " +
            "bundled when one of the worker's modules changes.",
        );
      }
      return;
    }
    for (const module of importers) await Reflect.apply(handler, context, [module, { event: 'update' }]);
  };

  /**
   * The same registrations in each build of a worker the entry starts, which Vite bundles nested in the entry's
   * build with the plugins of `worker.plugins` (#424). What a worker build registers is watched by the outer build.
   */
  const workerWatcher = (): Plugin => ({
    name: `${PLUGIN_NAME}:worker-watch`,
    resolveId: {
      order: 'pre',
      async handler(source, importer) {
        await registerImport(this, source, importer);
        return undefined;
      },
    },
    transform: {
      filter: { code: 'import.meta.glob' },
      async handler(code, id) {
        for (const scope of await registerGlobs(this, code, id)) {
          const key = scopeId(scope);
          const known = workerGlobs.get(key) ?? { scope, importers: new Set<string>() };
          known.importers.add(fileOfId(id));
          workerGlobs.set(key, known);
        }
      },
    },
  });

  return {
    name: PLUGIN_NAME,

    // The story belongs to the client build. A server or worker
    // environment a framework adds builds no copy of it.
    applyToEnvironment: (environment) => environment.name === CLIENT,

    // A build that bundles the entry inside itself finds the files it writes besides the story
    // from the output folder (see entryRenderBuiltUrl). Its input is the client environment's, which
    // configEnvironment below sets unless the config names one.
    config: {
      order: 'post',
      handler(config, env) {
        const client = config.environments?.[CLIENT] ?? {};
        if (env.command !== 'build' || entryPath === undefined || namesInput(config) || namesInput(client)) return;
        const renderBuiltUrl = entryRenderBuiltUrl(config.base, outputFilename, config.experimental?.renderBuiltUrl);
        if (renderBuiltUrl !== undefined) config.experimental = { ...config.experimental, renderBuiltUrl };
        // `vite build --watch`: the entry's workers register what they read too.
        if (config.build?.watch) config.worker = withWorkerPlugin(config.worker, workerWatcher);
      },
    },

    // The input of the client environment only.
    configEnvironment(name, environmentConfig, env) {
      if (name !== CLIENT || env.command !== 'build') return undefined;
      return inputSettings(environmentConfig);
    },

    configResolved(config) {
      if (config.command === 'build') {
        const recorder = recordWatchFiles(undefined, config.root);
        entryInputs.set(config, recorder.inputs);
        const assetReferences = entryAssetReferences();
        entryAssets.set(config, assetReferences.files);
        // The final plugin list includes environment-selected plugins. Record their addWatchFile calls,
        // as the separate entry build does, before any module or stylesheet is read.
        const clientOnly = (plugin: Plugin): Plugin =>
          pluginWith(
            plugin,
            new Map([['applyToEnvironment', (environment: { name: string }) => environment.name === CLIENT]]),
          );
        // resolveFileUrl stops at the first answer, so observe references before a user's custom resolver.
        Reflect.set(config, 'plugins', [
          clientOnly(assetReferences.plugin),
          ...config.plugins,
          clientOnly(recorder.plugin),
        ]);
      }
      if (entryPath === undefined) return;
      // `vite build --watch` with the entry inside the build: note the imports the user's plugins resolve (see
      // resolveId below). Vite builds each environment's plugins from this list after this hook.
      if (config.command === 'build' && config.build.watch && bundlesEntryInside(config)) {
        config.plugins.forEach((plugin, at) => {
          if (!isOwnPlugin(plugin))
            Reflect.set(
              config.plugins,
              at,
              claimingPlugin(plugin, (key) => claimed.add(key)),
            );
        });
      }
      if (resolved.inputs.some((input) => isSameOrInside(entryPath, input))) {
        config.logger.warn(
          `[twee-ts] The entry ${toPosix(entryPath)} is inside the story sources (${resolved.sources.join(', ')}). ` +
            'twee-ts also loads the .js and .css files it finds in source folders, unbundled, as Story JavaScript ' +
            "and Story Stylesheet; keep the entry's folder out of `sources`.",
        );
      }
    },

    // `vite build --watch` rebuilds for the files the build registers. The story's
    // inputs are read in generateBundle, outside the module graph, so they are
    // registered here; the dev server watches them itself (vite-dev.ts). An entry
    // the build can't bundle inside itself is bundled here, by a build of its own,
    // whose files are registered too.
    async buildStart() {
      const config = configOf(this);
      if (!isStoryBuild(config)) return;
      watchOutputs = new WeakMap();
      forgetKeptResolver(config);
      if (this.meta.watchMode) {
        const outputs = outputPaths(allOutputs(config), 'snapshot');
        // By real path: the bundler's watcher reports real paths (macOS FSEvents reports nothing else).
        for (const target of watchTargets(resolved.inputs, resolved.excluded, outputs, 'real')) {
          this.addWatchFile(target);
        }
      }
      if (entryPath === undefined || bundlesEntryInside(config)) return;
      // What the entry build read is registered whether it succeeds or fails: a failed bundle is
      // recovered by fixing one of these files, which no other input of the build includes.
      const watched = new Set<string>();
      const authored = new Set<string>([entryPath]);
      const globs: GlobScope[] = [];
      const registerEntryInputs = (): void => {
        if (!this.meta.watchMode) return;
        for (const file of watched) this.addWatchFile(canonicalPath(file));
        const outputs = outputPaths(allOutputs(config), 'snapshot');
        for (const target of importWatchTargets(authored, outputs)) this.addWatchFile(target);
        for (const target of globWatchTargets(globs, outputs)) this.addWatchFile(target);
      };
      watched.add(entryPath);
      let bundle: EntryBundle;
      try {
        bundle = await bundleEntry(config, entryPath, 'build', outputFilename, {
          watchFiles: watched,
          onLoad: (file) => watched.add(file),
          onResolve: (spelling) => authored.add(spelling),
          onGlob: (scope) => globs.push(scope),
        });
      } catch (e) {
        registerEntryInputs();
        return this.error(fatalError(e));
      }
      ownBuilds.set(this.environment, bundle);
      for (const file of bundle.files) watched.add(file);
      registerEntryInputs();
      return undefined;
    },

    // The compile cache trusts modification times, which a quick save may leave
    // unchanged (coarse file-system timestamps); forget a file that changed.
    async watchChange(id, change) {
      const changed = fileKey(id);
      for (const key of [...cache.keys()]) if (fileKey(key) === changed) cache.delete(key);
      if (change.event !== 'update') await releaseWorkerGlobs(this, id);
    },

    // `vite build --watch` with the entry bundled inside the build: Vite's import-glob reads the files a glob
    // matches when it bundles, and registers none of the folders it read, so a file added to one starts no
    // build. Each glob's folder is registered here, as the module comes past on its way to the import-glob.
    transform: {
      filter: { code: 'import.meta.glob' },
      async handler(code, id) {
        const config = configOf(this);
        if (!this.meta.watchMode || !isStoryBuild(config) || !bundlesEntryInside(config)) return;
        await registerGlobs(this, code, id);
      },
    },

    // Before the other plugins, which would resolve the import first: see registerImport.
    resolveId: {
      order: 'pre',
      async handler(id, importer, options) {
        if (id === EMPTY_INPUT) return RESOLVED_EMPTY_INPUT;
        const config = configOf(this);
        if (!this.meta.watchMode || !isStoryBuild(config) || !bundlesEntryInside(config)) return undefined;
        const kept = await registerImport(this, id, importer);
        // Vite's resolver keeps what an import resolved to for the builds that follow, also after a link on the
        // way is retargeted: the module it gives is then the old target. Each file the import reached is known;
        // when Vite's answer is one of those that it no longer reaches, the module is the one it reaches now, as a
        // new build would find (#320).
        if (kept === undefined) return undefined;
        const now = canonicalPath(kept);
        const written = importKey(importer, id);
        const targets = keptTargets.get(written) ?? new Set<string>();
        keptTargets.set(written, targets.add(now));
        if (targets.size < 2) return undefined;
        claimed.delete(written);
        const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
        // A plugin of the user's that resolved the import decided the module itself: it is left as it chose.
        if (claimed.has(written)) return undefined;
        if (resolved === null || resolved.external === true || resolved.external === 'absolute') return undefined;
        const file = canonicalPath(fileOfId(resolved.id));
        if (file === now || !targets.has(file)) return undefined;
        return { ...resolved, id: `${now}${/\?.*$/s.exec(resolved.id)?.[0] ?? ''}` };
      },
    },

    load(id) {
      // A statement app builds keep (they drop unused exports), so the bundler
      // doesn't warn about an empty chunk. The chunk is removed from the output.
      return id === RESOLVED_EMPTY_INPUT ? 'globalThis.tweeTsEmptyInput = true;' : undefined;
    },

    generateBundle: {
      order: 'post',
      async handler(outputOptions, bundle) {
        const config = configOf(this);
        if (!isStoryBuild(config)) return;
        for (const [fileName, item] of Object.entries(bundle)) {
          if (item.type === 'chunk' && item.facadeModuleId === RESOLVED_EMPTY_INPUT) removeFromBundle(bundle, fileName);
        }
        if (Object.hasOwn(bundle, outputFilename)) {
          return this.error(
            `twee-ts: the build already writes a file named ${outputFilename} (another input or plugin emits it); ` +
              "set the plugin's outputFilename to another name.",
          );
        }
        let entry: EntryBundle | undefined;
        if (entryPath !== undefined) {
          const items: Record<string, BundleItem> = bundle;
          entry = bundlesEntryInside(config)
            ? takeEntryFromBundle(items, entryInput, entryAssets.get(this.environment.getTopLevelConfig()))
            : ownBuilds.get(this.environment);
          if (!bundlesEntryInside(config)) {
            for (const [fileName, source] of entry?.assets ?? []) {
              if (fileName === outputFilename || Object.hasOwn(bundle, fileName)) {
                return this.error(entryCollisionMessage(fileName));
              }
              this.emitFile({ type: 'asset', fileName, source });
            }
          }
        }
        // Where this output writes the story and the bundle, should the bundler's own
        // settings differ from what the config said. Nothing a build writes is a source.
        record.addLocation(outputOptions);
        record.addFiles(outputOptions, [...Object.keys(bundle), ...(entry?.assets.keys() ?? [])]);
        let story: CompiledStory;
        try {
          // Chunk moduleIds omit tree-shaken modules; CSS and worker plugins also read files registered only
          // with addWatchFile. Protect all of them, including the entry itself, from the story's write.
          const entryFiles = [
            ...(entryPath === undefined ? [] : [entryPath]),
            ...(entry?.files ?? []),
            ...(entryInputs.get(this.environment.getTopLevelConfig())?.() ?? []),
          ].filter((id) => !id.startsWith('\0'));
          story = await compileStory(
            resolved.compile(entrySources(entry)),
            configOutputs(config, record),
            cache,
            true,
            entryFiles,
          );
        } catch (e) {
          return this.error(fatalError(e));
        }
        for (const warning of story.warnings) this.warn(warning);
        this.emitFile({ type: 'asset', fileName: outputFilename, source: story.output });
        return undefined;
      },
    },

    writeBundle(outputOptions, bundle) {
      const story = bundle[outputFilename];
      const path = emittedFilePath(outputOptions, outputFilename);
      // Vite writes the asset itself, so record its bytes only after the write. This also recognises markless
      // output modes and HTML with arbitrary filenames on subsequent builds, without trusting edited files.
      if (story?.type === 'asset' && path !== undefined) recordOwnOutput(path, story.source);
    },

    async configureServer(server) {
      const route = await setUpDevStory(server, {
        options: resolved,
        cache,
        outputs: allOutputs,
        injectClient: injectViteClient,
      });
      // Installed once Vite's internal middlewares are, between its request checks and its file serving.
      return () => {
        installStoryRoute(server.middlewares, route);
      };
    },
  };
}

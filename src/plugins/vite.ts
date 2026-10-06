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
import { relative, resolve } from 'node:path';
import { version as viteVersion } from 'vite';
import type { BuildEnvironmentOptions, Plugin, ResolvedConfig, UserConfig } from 'vite';
import type { FileCacheEntry } from '../types.js';
import { TweeTsError } from '../compiler.js';
import { compileStory, fatalError } from './diagnostics.js';
import type { CompiledStory } from './diagnostics.js';
import { getFilenames, outputPaths } from '../filesystem.js';
import type { BuildOutputs } from '../filesystem.js';
import { insertViteClient } from '../html-structure.js';
import { isSameOrInside } from '../path-identity.js';
import { resolvePluginOptions } from './options.js';
import type { SharedPluginOptions } from './options.js';
import { canonicalPath, createOutputRecord, fileKey, outputLocations, toPosix } from './paths.js';
import type { OutputLocation } from './paths.js';
import { setUpDevStory } from './vite-dev.js';
import {
  bundleEntry,
  ENTRY_INPUT_NAME,
  entryInputSettings,
  entrySources,
  PLUGIN_NAME,
  removeFromBundle,
  takeEntryFromBundle,
} from './vite-entry.js';
import type { BundleItem, EntryBundle } from './vite-entry.js';
import { watchTargets } from './watch-targets.js';

export type { PluginCompileOptions } from './options.js';

export interface TweeTsVitePluginOptions extends SharedPluginOptions {
  /**
   * A JS or TS file, relative to the working directory. Vite bundles it and
   * everything it imports into one self-contained script that becomes the
   * story's Story JavaScript; CSS it imports becomes the Story Stylesheet.
   * Requires Vite 8.
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

const viteMajor = Number.parseInt(viteVersion, 10);

/** The plugin instances created so far, which numbers each instance's entry input. */
let instances = 0;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The bundler options of build settings, under the name this Vite version reads. */
function bundlerOptionsOf(build: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(build)) return undefined;
  const options = build[viteMajor >= 8 ? 'rolldownOptions' : 'rollupOptions'] ?? build['rollupOptions'];
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

/** Build settings naming one input, under the option name this Vite version reads. */
function inputOnly(input: string): BuildEnvironmentOptions {
  return viteMajor >= 8 ? { rolldownOptions: { input } } : { rollupOptions: { input } };
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

/** Adds Vite's client to the page, first in its head, so reloads and the error overlay reach it. */
function injectViteClient(html: string, base: string): string {
  return insertViteClient(html, `${base}@vite/client`);
}

/** Whether a resolved config is a build of the client, the only build that carries the story. */
function isStoryBuild(config: ResolvedConfig): boolean {
  return config.command === 'build' && !config.build.ssr;
}

export function tweeTsPlugin(options: TweeTsVitePluginOptions): Plugin {
  const resolved = resolvePluginOptions('vite', options);
  const { outputFilename, entry: entryPath } = resolved;
  if (entryPath !== undefined && viteMajor < 8) {
    throw new TweeTsError(`twee-ts: the entry option needs Vite 8 or newer (found ${viteVersion}).`, [], {
      code: 'INVALID_OPTIONS',
    });
  }
  instances += 1;
  // The name of this instance's entry input, when it bundles the entry inside the user's build.
  const entryInput = `${ENTRY_INPUT_NAME}-${instances}`;
  const cache = new Map<string, FileCacheEntry>();
  // The config of the last build or server this instance took part in. Under Vite 6
  // and newer, each build hook reads its own build's config from the environment
  // instead, so builds sharing the instance keep apart.
  let lastConfig: ResolvedConfig | undefined;
  // The entry bundled by a build of its own, for each build (by environment) that
  // couldn't bundle it inside itself.
  const ownBuilds = new WeakMap<object, EntryBundle>();
  // The files this plugin's builds write, and their output folders, as each bundle
  // reports them. A source folder may hold any of them; none is a source.
  const record = createOutputRecord(outputFilename);
  // Everything the builds and the dev server leave out: what the config says a
  // build writes, and what the builds so far wrote.
  const allOutputs = (config: ResolvedConfig): BuildOutputs =>
    mergeOutputs(configOutputs(config, outputFilename), record.outputs());

  /**
   * The build settings this instance adds to a client build: none when the
   * user's config names an input (the entry is then bundled by a build of its
   * own); else, with an entry, the entry as the only input (unless the user's
   * output is an array, which the entry's IIFE can't use); else the stand-in
   * input.
   */
  const inputSettings = (config: Readonly<UserConfig>): { build: BuildEnvironmentOptions } | undefined => {
    if (namesInput(config)) return undefined;
    if (entryPath === undefined) return { build: inputOnly(EMPTY_INPUT) };
    const output = config.build?.rolldownOptions?.output;
    if (Array.isArray(output)) return { build: inputOnly(EMPTY_INPUT) };
    return { build: entryInputSettings(entryInput, entryPath, output) };
  };

  /** Whether this instance's entry is an input of the build with this config. */
  const bundlesEntryInside = (config: ResolvedConfig): boolean => {
    const input = bundlerOptionsOf(config.build)?.['input'];
    return isRecord(input) && Object.hasOwn(input, entryInput);
  };

  /**
   * The resolved config of the build a hook runs in: under Vite 6 and newer the
   * config of the hook's environment, under Vite 5 (no environments) the last one.
   */
  const configOf = (context: {
    readonly environment: { readonly config: ResolvedConfig };
  }): ResolvedConfig | undefined => {
    const environment: unknown = context.environment;
    return environment === undefined ? lastConfig : context.environment.config;
  };

  return {
    name: PLUGIN_NAME,

    // Vite 6 and newer: the story belongs to the client build. A server or worker
    // environment a framework adds builds no copy of it.
    applyToEnvironment: (environment) => environment.name === CLIENT,

    // Vite 5, which has one environment per build: the input of a client build.
    config(userConfig, env) {
      if (viteMajor >= 6 || env.command !== 'build' || Boolean(userConfig.build?.ssr)) return undefined;
      return inputSettings(userConfig);
    },

    // Vite 6 and newer: the input of the client environment only.
    configEnvironment(name, environmentConfig, env) {
      if (name !== CLIENT || env.command !== 'build') return undefined;
      return inputSettings(environmentConfig);
    },

    configResolved(config) {
      lastConfig = config;
      if (entryPath === undefined) return;
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
      if (config === undefined || !isStoryBuild(config)) return;
      if (this.meta.watchMode) {
        const outputs = outputPaths(allOutputs(config));
        // By real path: the bundler's watcher reports real paths (macOS FSEvents reports nothing else).
        for (const target of watchTargets(resolved.inputs, resolved.excluded, outputs, 'real')) {
          this.addWatchFile(target);
        }
      }
      if (entryPath === undefined || bundlesEntryInside(config)) return;
      let bundle: EntryBundle;
      try {
        bundle = await bundleEntry(config, entryPath, 'build');
      } catch (e) {
        return this.error(fatalError(e));
      }
      ownBuilds.set(this.environment, bundle);
      if (this.meta.watchMode) for (const file of bundle.files) this.addWatchFile(canonicalPath(file));
      return undefined;
    },

    // The compile cache trusts modification times, which a quick save may leave
    // unchanged (coarse file-system timestamps); forget a file that changed.
    watchChange(id) {
      const changed = fileKey(id);
      for (const key of [...cache.keys()]) if (fileKey(key) === changed) cache.delete(key);
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
        const config = configOf(this);
        if (config === undefined || !isStoryBuild(config)) return;
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
          entry = bundlesEntryInside(config) ? takeEntryFromBundle(items, entryInput) : ownBuilds.get(this.environment);
          if (!bundlesEntryInside(config)) {
            for (const [fileName, source] of entry?.assets ?? []) {
              if (Object.hasOwn(bundle, fileName)) {
                return this.error(
                  `twee-ts: the entry emits ${fileName}, a file the build already writes; rename one of them.`,
                );
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
          story = await compileStory(resolved.compile(entrySources(entry)), allOutputs(config), cache);
        } catch (e) {
          return this.error(fatalError(e));
        }
        for (const warning of story.warnings) this.warn(warning);
        this.emitFile({ type: 'asset', fileName: outputFilename, source: story.output });
        return undefined;
      },
    },

    async configureServer(server) {
      const route = await setUpDevStory(server, {
        options: resolved,
        cache,
        outputs: allOutputs,
        injectClient: injectViteClient,
      });
      // Installed after Vite's internal middlewares (host check, CORS, base, public
      // files, transforms) and before its HTML fallback.
      return () => {
        server.middlewares.use(route);
      };
    },
  };
}

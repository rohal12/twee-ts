/**
 * Bundling the Vite plugin's `entry` into one script and one stylesheet for the
 * story. In a build, the plugin bundles the entry inside the user's build when
 * it can (see entryInputSettings), and otherwise, and always in dev, with a
 * build of its own: bundleEntry() below, which replays the user's configuration.
 */
import { isAbsolute, resolve } from 'node:path';
import { build, loadConfigFromFile, mergeConfig } from 'vite';
import type {
  BuildEnvironmentOptions,
  ConfigEnv,
  InlineConfig,
  LogLevel,
  Logger,
  Plugin,
  ResolvedConfig,
  UserConfig,
} from 'vite';
import type { InlineSource } from '../types.js';
import { toPosix } from './paths.js';
import { isRecord } from '../util.js';

/** The plugin's name, which is also how the entry build tells it from the user's other plugins. */
export const PLUGIN_NAME = 'twee-ts';

/** Passage names the bundled entry takes inside the story. */
const ENTRY_SCRIPT_NAME = 'twee-ts-entry.js';
const ENTRY_STYLE_NAME = 'twee-ts-entry.css';

/** How the name of the entry's input starts when the plugin bundles it inside the user's build. */
export const ENTRY_INPUT_NAME = 'twee-ts-entry';

/** Which Vite command a configuration is evaluated for. */
export type ViteCommand = ConfigEnv['command'];

/**
 * The bundled entry: its script, its stylesheet, the files it was built from
 * (forward-slash paths: its modules and the files its plugins watch), and any
 * files the bundler still emits separately (by output file name).
 */
export interface EntryBundle {
  readonly script: string;
  readonly style: string;
  readonly files: ReadonlySet<string>;
  readonly assets: ReadonlyMap<string, string | Uint8Array>;
}

/** The entry's script and stylesheet as inline sources of the story (none without an entry). */
export function entrySources(entry: EntryBundle | undefined): InlineSource[] {
  if (entry === undefined) return [];
  return [
    { filename: ENTRY_SCRIPT_NAME, content: entry.script },
    ...(entry.style === '' ? [] : [{ filename: ENTRY_STYLE_NAME, content: entry.style }]),
  ];
}

/** The parts of a Vite output bundle item this plugin reads. */
export type BundleItem =
  | {
      readonly type: 'chunk';
      readonly code: string;
      readonly isEntry: boolean;
      readonly name: string;
      readonly moduleIds: readonly string[];
    }
  | { readonly type: 'asset'; readonly source: string | Uint8Array };

/** The bundler options of a build (Rolldown's, under Vite 8). */
type BundlerOptions = NonNullable<BuildEnvironmentOptions['rolldownOptions']>;

/** The bundler's `output` option: one output's options or several. */
type OutputOption = BundlerOptions['output'];

/** One output's options. */
type OutputOptions = Exclude<NonNullable<OutputOption>, readonly unknown[]>;

/**
 * The output options of the entry's bundle: one IIFE script, and assets under
 * their own names, so a build writes them where the dev server serves them.
 */
const ENTRY_OUTPUT = {
  format: 'iife',
  entryFileNames: ENTRY_SCRIPT_NAME,
  assetFileNames: '[name][extname]',
} as const satisfies OutputOptions;

/**
 * The output options of the entry's bundle given the user's `output` option:
 * the user's own when it is one object, with the entry's format and file names
 * on top. An array of outputs describes the user's own files; none of them
 * applies to the entry.
 */
export function entryOutput(userOutput: OutputOption): OutputOptions {
  return userOutput === undefined || Array.isArray(userOutput)
    ? { ...ENTRY_OUTPUT }
    : { ...userOutput, ...ENTRY_OUTPUT };
}

/**
 * Settings that make every font and image the entry uses inline as a data URL,
 * and its CSS one stylesheet, so the story stays one file; only an import marked
 * `?no-inline` is still emitted separately.
 */
const ONE_FILE = { cssCodeSplit: false, assetsInlineLimit: (): boolean => true } as const;

/**
 * What `import.meta.url` stands for in the entry's script, given the story's output file name. The script runs
 * as a classic script inside the story page, where `import.meta` does not exist (the bundler leaves `{}.url`, so
 * `new URL(asset, import.meta.url)` and Vite's worker URLs throw `Invalid URL`). The files the build writes
 * besides the story, such as an asset marked `?no-inline`, are found from the output folder the story is below,
 * so the base is the story page's URL, taken up one level for each folder of a nested `outputFilename`.
 */
function entryDefine(outputFilename: string): { readonly 'import.meta.url': string } {
  const depth = outputFilename.split('/').length - 1;
  const base =
    depth === 0 ? 'document.baseURI' : `new URL(${JSON.stringify('../'.repeat(depth))}, document.baseURI).href`;
  return { 'import.meta.url': base };
}

/**
 * Build settings that bundle the entry inside the user's build, as its only
 * input, under `inputName`, which tells the plugin instance it is its own, and
 * what the bundled script needs to run in the story (`define`).
 */
export function entryInputSettings(
  inputName: string,
  entryPath: string,
  userOutput: OutputOption,
  outputFilename: string,
): { readonly build: BuildEnvironmentOptions; readonly define: Record<string, string> } {
  return {
    build: { ...ONE_FILE, rolldownOptions: { input: { [inputName]: entryPath }, output: entryOutput(userOutput) } },
    define: entryDefine(outputFilename),
  };
}

/** Removes a trailing source-map comment that points at a file (a data: URL map stays). */
function dropFileSourceMapComment(code: string): string {
  return code
    .replace(/\n?\/\/# sourceMappingURL=(?!data:)\S*\s*$/, '')
    .replace(/\n?\/\*# sourceMappingURL=(?!data:)[^*]*\*\/\s*$/, '');
}

/** A module id or watched file as a forward-slash file path, without a query or hash (like Vite's cleanUrl). */
function fileOfId(id: string): string {
  return toPosix(id.replace(/[?#].*$/s, ''));
}

/** Removes a file from a bundle, which bundlers hand plugins as a plain object keyed by file name. */
export function removeFromBundle(bundle: Record<string, unknown>, fileName: string): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the bundle object is the bundler's API.
  delete bundle[fileName];
}

/**
 * Takes the entry out of a bundle: its entry chunk (the one named `inputName`,
 * when the entry is one input of the user's build; the only one, from the
 * entry's own build), every stylesheet, and the map files, which the story
 * cannot ship. The chunk is found by its input's name, not by its module's
 * path, which the bundler may spell another way (a root reached through a
 * link is read by its real path). Anything else the bundler emitted for it
 * stays in the bundle, so a build writes it next to the HTML, and is also
 * returned, so the dev server can serve it.
 */
export function takeEntryFromBundle(bundle: Record<string, BundleItem>, inputName?: string): EntryBundle {
  let script = '';
  const files = new Set<string>();
  const assets = new Map<string, string | Uint8Array>();
  const styles: string[] = [];
  for (const [fileName, item] of Object.entries(bundle)) {
    if (item.type === 'chunk') {
      if (!item.isEntry || (inputName !== undefined && item.name !== inputName)) continue;
      script = dropFileSourceMapComment(item.code);
      for (const id of item.moduleIds) if (!id.startsWith('\0')) files.add(fileOfId(id));
      removeFromBundle(bundle, fileName);
    } else if (fileName.endsWith('.css')) {
      const css = typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
      styles.push(dropFileSourceMapComment(css));
      removeFromBundle(bundle, fileName);
    } else if (fileName.endsWith('.map')) {
      removeFromBundle(bundle, fileName);
    } else {
      assets.set(fileName, item.source);
    }
  }
  return { script, style: styles.join('\n'), files, assets };
}

/**
 * The entry build's logger: its warnings go to the outer logger; its progress
 * lines and its own "build failed" line are dropped, because the plugin
 * reports a failed bundle itself. (The progress lines Vite 8 prints itself are
 * kept quiet by the entry build's log level; see bundleEntry.)
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
      // The outer screen is not the entry build's to clear.
    },
    hasErrorLogged: () => false,
    get hasWarned() {
      return outer.hasWarned;
    },
  };
}

/**
 * The entry build's log level: no progress lines (Vite 8 prints those itself
 * at `info`), and no more than the outer build or server shows.
 */
export function entryBuildLogLevel(outer: LogLevel | undefined): LogLevel {
  return outer === undefined || outer === 'info' ? 'warn' : outer;
}

/**
 * Top-level keys of the user's configuration the entry build doesn't take, and
 * why. Everything else (define, resolve, css, json, esbuild/oxc, env options,
 * base, assetsInclude, worker, build options, environments, experimental and
 * the rest) comes across as the user gave it, so the entry bundles the same in
 * dev as in a build.
 */
export const ENTRY_BUILD_EXCLUDED_KEYS: Readonly<Record<string, string>> = {
  configFile: 'the entry build is given the loaded config file itself',
  plugins: 'replaced by the same plugins without twee-ts, plus the entry build’s own',
  root: 'set to the resolved root',
  mode: 'set to the resolved mode',
  logLevel: 'set so the entry build prints no progress lines',
  customLogger: 'the entry build reports through the outer logger',
  clearScreen: 'the entry build never clears the screen',
  publicDir: 'the entry build copies no public files',
  server: 'configures the dev server, not a build',
  preview: 'configures the preview server, not a build',
  builder: 'would build every environment instead of the entry',
  devtools: 'starts Vite’s devtools integration, which belongs to the outer server or build',
};

/** The user's configuration without the keys the entry build doesn't take. */
function withoutExcludedKeys(config: UserConfig): UserConfig {
  const copy: UserConfig = { ...config };
  for (const key of Object.keys(ENTRY_BUILD_EXCLUDED_KEYS)) Reflect.deleteProperty(copy, key);
  return copy;
}

/** A plugin option (nested arrays, promises, falsy entries) as one flat list. */
async function flattenPlugins(option: unknown): Promise<unknown[]> {
  const value: unknown = await option;
  if (Array.isArray(value)) return (await Promise.all(value.map(flattenPlugins))).flat();
  return value ? [value] : [];
}

function isPlugin(value: unknown): value is Plugin {
  return isRecord(value) && typeof value['name'] === 'string';
}

/** The handler of a plugin hook in function or object form. */
function hookHandler(hook: unknown): unknown {
  return isRecord(hook) ? hook['handler'] : hook;
}

/** A hook with its handler replaced, keeping the object form's order and other fields. */
function withHandler(hook: unknown, handler: (this: unknown, ...args: unknown[]) => unknown): unknown {
  return isRecord(hook) ? { ...hook, handler } : handler;
}

/**
 * Whether Vite applies `plugin` for `command`: as Vite reads `apply`, with
 * the configuration and environment the plugin would see.
 */
function appliesTo(plugin: Plugin, command: ViteCommand, config: UserConfig, env: ConfigEnv): boolean {
  const { apply } = plugin;
  if (apply === undefined) return true;
  if (typeof apply === 'function') return apply({ ...config, mode: env.mode }, env);
  return apply === command;
}

/**
 * `plugin` as the entry build runs it: without `apply` (already decided by
 * appliesTo), and, for the dev command, with its `config`, `configEnvironment`
 * and `configResolved` hooks seeing the dev command, as the dev server's
 * instance of the plugin sees it. The plugin object itself is left untouched.
 */
function asEntryBuildPlugin(plugin: Plugin, command: ViteCommand): Plugin {
  const overrides = new Map<PropertyKey, unknown>([['apply', undefined]]);
  if (command === 'serve') {
    const devEnv = (env: unknown): unknown => Object.assign({}, env, { command, isSsrBuild: false });
    const wrap = (name: 'config' | 'configEnvironment' | 'configResolved', patch: (args: unknown[]) => unknown[]) => {
      const hook: unknown = plugin[name];
      const handler = hookHandler(hook);
      if (typeof handler !== 'function') return;
      overrides.set(
        name,
        withHandler(hook, function (this: unknown, ...args: unknown[]): unknown {
          return Reflect.apply(handler, this, patch(args));
        }),
      );
    };
    wrap('config', ([config, env]) => [config, devEnv(env)]);
    wrap('configEnvironment', ([name, config, env]) => [name, config, devEnv(env)]);
    wrap('configResolved', ([config]) => [
      isRecord(config) ? withOverrides(config, new Map([['command', command]])) : config,
    ]);
  }
  return withOverrides(plugin, overrides);
}

/** `target` with some properties reading differently; the object itself is left untouched. */
function withOverrides<T extends object>(target: T, overrides: ReadonlyMap<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = overrides.has(key) ? overrides.get(key) : Reflect.get(object, key, receiver);
      return value;
    },
  });
}

/**
 * Build settings that make the entry the build's one input and its bundle one
 * script and one stylesheet held in memory, whatever the user's build settings
 * say; for the dev command also unminified, with an inline source map. Settings
 * that would build something else (`lib`, `ssr`) or write files are dropped.
 */
function entryBuildSettings(
  userBuild: BuildEnvironmentOptions | undefined,
  entryPath: string,
  command: ViteCommand,
): BuildEnvironmentOptions {
  // A user config may still use the old name, which Vite 8 accepts for `rolldownOptions`.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- read so it can be replaced.
  const { lib: _lib, ssr: _ssr, rollupOptions, rolldownOptions, ...rest } = { ...userBuild };
  const { input: _input, output, ...bundler }: BundlerOptions = rolldownOptions ?? rollupOptions ?? {};
  return {
    ...rest,
    ...ONE_FILE,
    write: false,
    watch: null,
    emptyOutDir: false,
    copyPublicDir: false,
    ...(command === 'serve' ? { minify: false, sourcemap: 'inline' } : {}),
    rolldownOptions: { ...bundler, input: entryPath, output: entryOutput(output) },
  };
}

/**
 * Applies entryBuildSettings last, after every config hook, in the
 * configuration and in the client environment's own options (which the build
 * reads), so no setting from the user or a plugin makes the entry build build
 * or write anything else.
 */
function entryBuildEnforcer(entryPath: string, command: ViteCommand, outputFilename: string): Plugin {
  return {
    name: `${PLUGIN_NAME}:entry-build`,
    enforce: 'post',
    config: {
      order: 'post',
      handler(config) {
        config.build = entryBuildSettings(config.build, entryPath, command);
        config.define = { ...config.define, ...entryDefine(outputFilename) };
      },
    },
    configEnvironment: {
      order: 'post',
      handler(name, config) {
        if (name !== 'client') return;
        config.build = entryBuildSettings(config.build, entryPath, command);
        config.define = { ...config.define, ...entryDefine(outputFilename) };
      },
    },
  };
}

/** Build-phase plugin hooks that may call `this.addWatchFile`. */
const WATCH_FILE_HOOKS = [
  'buildStart',
  'resolveId',
  'resolveDynamicImport',
  'load',
  'transform',
  'moduleParsed',
  'buildEnd',
] as const;

/** A plugin context whose `addWatchFile` also records the file in `files`. */
function recordingContext(context: object, files: Set<string>): object {
  return new Proxy(context, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key !== 'addWatchFile') {
        const bound: unknown = value.bind(target);
        return bound;
      }
      return (id: unknown): unknown => {
        if (typeof id === 'string' && !id.startsWith('\0')) files.add(fileOfId(resolve(id)));
        return Reflect.apply(value, target, [id]);
      };
    },
  });
}

/**
 * `plugin` with hooks that record its `addWatchFile` calls in `files`. The
 * original stays untouched, so a plugin object shared across entry builds
 * never collects wrappers. A plugin without such hooks (a built-in one, for
 * instance) is returned as it is.
 */
function recordingPlugin(plugin: Plugin, files: Set<string>): Plugin {
  const overrides = new Map<PropertyKey, unknown>();
  for (const name of WATCH_FILE_HOOKS) {
    const hook = plugin[name];
    const handler = hookHandler(hook);
    if (typeof handler !== 'function') continue;
    overrides.set(
      name,
      withHandler(hook, function (this: unknown, ...args: unknown[]): unknown {
        const context = typeof this === 'object' && this !== null ? recordingContext(this, files) : this;
        return Reflect.apply(handler, context, args);
      }),
    );
  }
  return overrides.size === 0 ? plugin : withOverrides(plugin, overrides);
}

/**
 * Collects the files the entry build's plugins add with `addWatchFile`. These
 * are not modules of the bundle: Vite's CSS plugin adds the stylesheets pulled
 * in by `@import` and the files `url()` points at this way. The build runs on
 * recording stand-ins of its plugins, made in the bundler's `options` hook,
 * which sees the final plugin list, including the plugins Vite resolves per
 * environment (`applyToEnvironment`) after `configResolved`.
 */
function recordWatchFiles(files: Set<string>, onLoad: ((file: string) => void) | undefined): Plugin {
  return {
    name: `${PLUGIN_NAME}:record-watch-files`,
    // Called for each module just before its file is read, so a caller can note the file's state as the
    // bundle is about to see it. It reads nothing itself: the module is loaded as usual.
    load: {
      order: 'pre',
      handler(id) {
        const file = fileOfId(id);
        if (onLoad !== undefined && isAbsolute(file) && !id.startsWith('\0')) onLoad(file);
        return null;
      },
    },
    // Every module of the graph, also one the bundle renders no code of (a module
    // whose constant the bundler inlined), which the chunk's module list leaves out.
    buildEnd() {
      for (const id of this.getModuleIds()) {
        const file = fileOfId(id);
        if (isAbsolute(file)) files.add(file);
      }
    },
    options: {
      order: 'post',
      async handler(inputOptions) {
        // Vite passes its resolved plugins, which are all plugin objects; anything else is left out, as
        // the user's plugin list is read (see userEntryConfig()).
        const plugins = (await flattenPlugins(inputOptions.plugins))
          .filter(isPlugin)
          .map((p) => recordingPlugin(p, files));
        return { ...inputOptions, plugins };
      },
    },
  };
}

/**
 * The user's own configuration as Vite evaluated it for the outer server or
 * build, but for `command`: the config file (when there is one) evaluated
 * again for that command and mode, with what was passed to `createServer()` or
 * `build()` (or the CLI flags) on top, as Vite merges them.
 */
async function userConfigFor(config: ResolvedConfig, env: ConfigEnv): Promise<UserConfig> {
  const inline: InlineConfig = config.inlineConfig;
  if (!config.configFile) return inline;
  const loaded = await loadConfigFromFile(
    env,
    config.configFile,
    config.root,
    entryBuildLogLevel(config.logLevel),
    entryBuildLogger(config.logger),
    inline.configLoader,
  );
  return loaded === null ? inline : mergeConfig(loaded.config, inline);
}

/**
 * Bundles the entry with a Vite build of its own, from the user's own
 * configuration, evaluated for `command`: the config file's function and each
 * plugin's `apply` see that command, and so do the `config`, `configEnvironment`
 * and `configResolved` hooks of the user's plugins. Every setting comes across
 * but those ENTRY_BUILD_EXCLUDED_KEYS lists and the build settings
 * entryBuildSettings decides. twee-ts itself (every instance) is left out.
 */
export async function bundleEntry(
  config: ResolvedConfig,
  entryPath: string,
  command: ViteCommand,
  outputFilename: string,
  onLoad?: (file: string) => void,
): Promise<EntryBundle> {
  const env: ConfigEnv = { command, mode: config.mode, isSsrBuild: false, isPreview: false };
  const user = await userConfigFor(config, env);
  const plugins = (await flattenPlugins(user.plugins))
    .filter(isPlugin)
    .filter((plugin) => plugin.name !== PLUGIN_NAME && appliesTo(plugin, command, user, env))
    .map((plugin) => asEntryBuildPlugin(plugin, command));
  const watchFiles = new Set<string>();
  const inline: InlineConfig = {
    ...withoutExcludedKeys(user),
    configFile: false,
    root: config.root,
    mode: config.mode,
    logLevel: entryBuildLogLevel(config.logLevel),
    customLogger: entryBuildLogger(config.logger),
    clearScreen: false,
    publicDir: false,
    plugins: [...plugins, entryBuildEnforcer(entryPath, command, outputFilename), recordWatchFiles(watchFiles, onLoad)],
  };
  // One output, as entryBuildSettings sets it, and no watcher (`watch: null`).
  const [result] = [await build(inline)].flat();
  if (result === undefined || !('output' in result)) throw new Error('twee-ts: the entry build returned no bundle.');
  const bundle: Record<string, BundleItem> = Object.fromEntries(result.output.map((item) => [item.fileName, item]));
  const entry = takeEntryFromBundle(bundle);
  return { ...entry, files: new Set([...entry.files, ...watchFiles]) };
}

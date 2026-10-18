/**
 * Bundling the Vite plugin's `entry` into one script and one stylesheet for the
 * story. In a build, the plugin bundles the entry inside the user's build when
 * it can (see entryInputSettings), and otherwise, and always in dev, with a
 * build of its own: bundleEntry() below, which replays the user's configuration.
 */
import { existsSync, statSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, createIdResolver, loadConfigFromFile, mergeConfig } from 'vite';
import type {
  BuildEnvironmentOptions,
  ConfigEnv,
  InlineConfig,
  LogLevel,
  Logger,
  Plugin,
  RenderBuiltAssetUrl,
  ResolvedConfig,
  UserConfig,
} from 'vite';
import type { InlineSource } from '../types.js';
import { toPosix } from './paths.js';
import { moduleGlobScopes } from './vite-glob.js';
import type { GlobScope } from './vite-glob.js';
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

/** The error for a file the entry emits under a name the build (or another story's entry) already writes. */
export function entryCollisionMessage(fileName: string): string {
  return `twee-ts: the entry emits ${fileName}, a file the build already writes; rename one of them.`;
}

/** The entry's script and stylesheet as inline sources of the story (none without an entry). */
export function entrySources(entry: EntryBundle | undefined): InlineSource[] {
  if (entry === undefined) return [];
  return [
    // The leading `;` ends an unterminated statement of the script passage before it, which would otherwise take
    // the entry's opening parenthesis as a call.
    { filename: ENTRY_SCRIPT_NAME, content: `;${entry.script}` },
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
  | {
      readonly type: 'asset';
      readonly source: string | Uint8Array;
      /** The source files the bundler made the asset from (the bundler's own stylesheet names no file). */
      readonly originalFileNames?: readonly string[] | undefined;
    };

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
  const depth = folderDepth(outputFilename);
  const base =
    depth === 0 ? 'document.baseURI' : `new URL(${JSON.stringify('../'.repeat(depth))}, document.baseURI).href`;
  return { 'import.meta.url': base };
}

/** How many folders deep `outputFilename` puts the story below the output folder. */
function folderDepth(outputFilename: string): number {
  return outputFilename.split('/').length - 1;
}

/**
 * The `experimental.renderBuiltUrl` of a build that bundles the entry, given the build's `base`, the story's
 * `outputFilename` and the configuration's own `renderBuiltUrl` (`user`, which decides first), or `user` itself
 * when nothing changes. With a relative `base` (`''` or `'./'`), Vite makes the URL of a file the build writes
 * besides the story (an asset marked `?no-inline`, a worker) relative to the script or stylesheet that names it.
 * The story page holds both inline, so such a URL resolves against the page, which a nested `outputFilename` puts
 * below the output folder the files are written to. For the entry's script, the URL is then resolved at run time
 * against the output folder, as `import.meta.url` is (see `entryDefine`); in its stylesheet, it is a path up from
 * the page. Every stylesheet of such a build is the entry's: the build bundles nothing else.
 */
export function entryRenderBuiltUrl(
  base: string | undefined,
  outputFilename: string,
  user: RenderBuiltAssetUrl | undefined,
): RenderBuiltAssetUrl | undefined {
  const depth = folderDepth(outputFilename);
  if ((base !== '' && base !== './') || depth === 0) return user;
  const outputFolder = entryDefine(outputFilename)['import.meta.url'];
  return (filename, type) => {
    const own = user?.(filename, type);
    if (own !== undefined) return own;
    // As Vite writes a file name into a URL.
    const path = filename.replaceAll('%', '%25');
    if (type.hostType === 'js' && type.hostId === ENTRY_SCRIPT_NAME) {
      return { runtime: `new URL(${JSON.stringify(path)}, ${outputFolder}).href` };
    }
    return type.hostType === 'css' ? `${'../'.repeat(depth)}${path}` : undefined;
  };
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
export function fileOfId(id: string): string {
  return toPosix(id.replace(/[?#].*$/s, ''));
}

/** Removes a file from a bundle, which bundlers hand plugins as a plain object keyed by file name. */
export function removeFromBundle(bundle: Record<string, unknown>, fileName: string): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the bundle object is the bundler's API.
  delete bundle[fileName];
}

/**
 * Whether an asset is a file the entry imported as a URL (`theme.css?url`), not the stylesheet the bundler made
 * of the entry's CSS. The bundler names the files an asset came from; for its own stylesheet that is a bare
 * output name (`style.css`), for an imported file the file's path.
 */
function isImportedFile(item: Extract<BundleItem, { type: 'asset' }>): boolean {
  return (item.originalFileNames ?? []).some((name) => isAbsolute(name) || win32.isAbsolute(name));
}

/**
 * Takes the entry out of a bundle: its entry chunk (the one named `inputName`,
 * when the entry is one input of the user's build; the only one, from the
 * entry's own build), every stylesheet it made of the entry's CSS (a CSS file imported as a URL stays an asset), and the map files, which the story
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
    } else if (fileName.endsWith('.css') && !isImportedFile(item)) {
      const css = typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
      styles.push(dropFileSourceMapComment(css));
      removeFromBundle(bundle, fileName);
    } else if (fileName.endsWith('.map') && (item.originalFileNames?.length ?? 0) === 0) {
      // Generated source maps have no originating resource; an imported .map has one, relative or absolute.
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
  publicDir: 'set to the outer build’s resolved public directory, which the entry build resolves from but never copies',
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
  return pluginWith(plugin, overrides);
}

/**
 * A copy of `plugin` with some properties of its own reading differently; the plugin itself is left untouched. The
 * copy has the plugin's prototype (a class's methods and getters) and each of its own properties as they are
 * defined (a getter stays a getter), so a frozen plugin, or one whose hooks are getters, is copied as well: a Proxy
 * may not answer differently for a property a frozen object defines. The copy stands in for the plugin wherever
 * the plugin list has it.
 */
export function pluginWith(plugin: Plugin, overrides: ReadonlyMap<PropertyKey, unknown>): Plugin {
  const copy: Plugin = { ...plugin };
  // Between the copy and the plugin's prototype, the overridden properties as plain writable ones: Vite clones a
  // plugin by assigning its own properties to an object of the same prototype, which fails for a property that
  // prototype has only a getter for (a class whose hook is a getter).
  const layer = {};
  Object.setPrototypeOf(layer, Reflect.getPrototypeOf(plugin));
  for (const [key, value] of overrides) {
    Object.defineProperty(layer, key, { value, writable: true, enumerable: false, configurable: true });
  }
  Object.setPrototypeOf(copy, layer);
  for (const key of Reflect.ownKeys(plugin)) {
    const descriptor = Object.getOwnPropertyDescriptor(plugin, key);
    if (descriptor !== undefined && !overrides.has(key)) Object.defineProperty(copy, key, descriptor);
  }
  for (const [key, value] of overrides) {
    Object.defineProperty(copy, key, { value, writable: true, enumerable: true, configurable: true });
  }
  return copy;
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
        const renderBuiltUrl = entryRenderBuiltUrl(config.base, outputFilename, config.experimental?.renderBuiltUrl);
        if (renderBuiltUrl !== undefined) config.experimental = { ...config.experimental, renderBuiltUrl };
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

/** A plugin context whose `addWatchFile` also passes the file to `record`. */
function recordingContext(context: object, record: (file: string) => void): object {
  return new Proxy(context, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key !== 'addWatchFile') {
        const bound: unknown = value.bind(target);
        return bound;
      }
      return (id: unknown): unknown => {
        if (typeof id === 'string' && !id.startsWith('\0')) record(fileOfId(resolve(id)));
        return Reflect.apply(value, target, [id]);
      };
    },
  });
}

/**
 * `plugin` with hooks that pass the file of each of its `addWatchFile` calls to `record`. The
 * original stays untouched, so a plugin object shared across entry builds
 * never collects wrappers. A plugin without such hooks (a built-in one, for
 * instance) is returned as it is.
 */
function recordingPlugin(plugin: Plugin, record: (file: string) => void): Plugin {
  const overrides = new Map<PropertyKey, unknown>();
  for (const name of WATCH_FILE_HOOKS) {
    const hook = plugin[name];
    const handler = hookHandler(hook);
    if (typeof handler !== 'function') continue;
    overrides.set(
      name,
      withHandler(hook, function (this: unknown, ...args: unknown[]): unknown {
        const context = typeof this === 'object' && this !== null ? recordingContext(this, record) : this;
        return Reflect.apply(handler, context, args);
      }),
    );
  }
  return overrides.size === 0 ? plugin : pluginWith(plugin, overrides);
}

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** A resolver Vite makes for plugins (see keptPath). */
type IdResolver = ReturnType<typeof createIdResolver>;

/** The part of a plugin hook's context the import spellings use: the environment the hook runs in. */
export interface ImportHookContext {
  readonly environment: Parameters<IdResolver>[0];
}

/** How an import is resolved with its links kept (see keptPath), one resolver per configuration. */
const keptResolvers = new WeakMap<ResolvedConfig, IdResolver>();

/**
 * Makes keptPath resolve with a new resolver for `config`: Vite's resolver remembers what it found, which a build of
 * `vite build --watch` must not take from the one before.
 */
export function forgetKeptResolver(config: ResolvedConfig): void {
  keptResolvers.delete(config);
}

/**
 * The file `source`, imported by `importer`, reaches as Vite's resolver finds it, with the links on the way kept
 * (`resolve.preserveSymlinks`): the path through a linked file, folder or package folder, which the module's own
 * (real) path never shows. It follows every spelling Vite's resolver reads: relative and absolute paths, the root's
 * `/`, missing extensions, a folder's index, `resolve.alias`, bare package names, a package's subpaths and exports,
 * `#` subpath imports and `resolve.tsconfigPaths`. Undefined for an import it resolves to no file (a virtual module,
 * an external one, one it cannot resolve), or when resolving fails, which the bundle itself then reports.
 */
async function keptPath(
  context: ImportHookContext,
  source: string,
  importer: string | undefined,
): Promise<string | undefined> {
  const { environment } = context;
  let resolver = keptResolvers.get(environment.config);
  if (resolver === undefined) {
    resolver = createIdResolver(environment.config, { preserveSymlinks: true });
    keptResolvers.set(environment.config, resolver);
  }
  try {
    const id = await resolver(environment, source, importer);
    return id === undefined || id.startsWith('\0') ? undefined : fileOfId(id);
  } catch {
    return undefined;
  }
}

/**
 * The paths an import of `source` by `importer` is written as, absolute and with forward slashes, when it is written
 * as a path: relative to the importer, or absolute; also when that reaches nothing yet, so creating it shows. None for
 * a bare name or an alias. An absolute path that starts with `/` is read as Vite reads it: from the root first, unless
 * it already names a path inside the root, and as a path of the file system when that is where it reaches a file.
 */
function writtenPaths(source: string, importer: string | undefined, root: string): string[] {
  const from = importer === undefined ? undefined : fileOfId(importer);
  if (isAbsolute(source)) {
    const file = fileOfId(source);
    const fromRoot =
      /^[/\\]/.test(source) && !file.startsWith(`${toPosix(root).replace(/\/$/, '')}/`) && !existsSync(file)
        ? [fileOfId(join(root, source))]
        : [];
    return [...fromRoot, file];
  }
  return from !== undefined && isAbsolute(from) && /^\.\.?(?:[/\\]|$)/.test(source)
    ? [fileOfId(resolve(dirname(from), source))]
    : [];
}

/**
 * Package locations Node's upward node_modules search can use for an unresolved bare import. These are recovery
 * inputs only: Vite still decides aliases, exports and the actual module. Watching the package itself sees a
 * restored manifest, export target or nested subpath without watching every installed package recursively.
 */
function missingPackagePaths(source: string, importer: string | undefined): string[] {
  if (
    importer === undefined ||
    !isAbsolute(fileOfId(importer)) ||
    source === '' ||
    /^[./\\#\0]/.test(source) ||
    source.includes(':')
  )
    return [];
  const parts = source.split('/');
  const name = parts.slice(0, source.startsWith('@') ? 2 : 1).join('/');
  const paths: string[] = [];
  for (let folder = dirname(fileOfId(importer)); ; folder = dirname(folder)) {
    if (toPosix(folder).split('/').at(-1) !== 'node_modules') paths.push(toPosix(join(folder, 'node_modules', name)));
    if (dirname(folder) === folder) break;
  }
  return paths;
}

/**
 * A package can import itself through its exports without living in node_modules. Node can locate its manifest
 * even when the export target is missing. Track the package's own file listing as a recovery scope, excluding
 * node_modules; recording the whole folder as a watch file would scan all of its installed dependencies too.
 * The node_modules candidates above remain necessary for packages that have no manifest yet.
 */
function missingPackageScope(
  source: string,
  importer: string | undefined,
  candidates: readonly string[],
): GlobScope | undefined {
  if (importer === undefined || candidates.length === 0) return undefined;
  let manifest: string | undefined;
  try {
    manifest = findPackageJSON(source, pathToFileURL(fileOfId(importer)));
  } catch {
    return undefined; // No package metadata yet, or unreadable metadata: Vite diagnoses the import itself.
  }
  if (manifest === undefined) return undefined;
  const dir = toPosix(dirname(manifest));
  return candidates.includes(dir) ? undefined : { dir, deep: true, dot: true, exhaustive: false, suffix: '' };
}

/**
 * Every path an import of `source` by `importer` is spelled as (see writtenPaths), and the path Vite's resolver
 * reaches the file by, links kept (`kept`, see keptPath). A caller then sees a link on the way that is retargeted,
 * which the file's own path never shows. Nothing for an import from a virtual module, or of one.
 */
export async function importSpellings(
  context: ImportHookContext,
  source: string,
  importer: string | undefined,
  root: string,
): Promise<{ readonly spellings: readonly string[]; readonly kept: string | undefined }> {
  if (source.startsWith('\0') || (importer?.startsWith('\0') ?? false)) return { spellings: [], kept: undefined };
  const written = writtenPaths(source, importer, root);
  // A path written to a file that is there is the one Vite's resolver takes, links and all; only an import written
  // otherwise (a bare name, an alias, a missing extension, a folder) is resolved, which halves the work of a graph
  // of relative imports.
  const resolved = written.find(isFile) ?? (await keptPath(context, source, importer));
  const kept = resolved !== undefined && isAbsolute(resolved) ? resolved : undefined;
  return { spellings: [...new Set([...written, ...(kept === undefined ? [] : [kept])])], kept };
}

/**
 * What a caller of bundleEntry learns as the entry build runs, filled in also when the build fails (the files of a
 * failed bundle are the ones whose fixing bundles it again):
 * - `watchFiles`: the files the build's plugins add with `addWatchFile`, and the modules of its graph;
 * - `onWatchFile`: each file (or folder) a plugin adds with `addWatchFile`, as it adds it, which is before it
 *   reads what it watches;
 * - `onLoad`: each module's file, just before the build reads it;
 * - `onResolve`: each import's path as authored (see recordWatchFiles);
 * - `onGlob`: the scope of each `import.meta.glob()` pattern of a module, just before Vite reads the files it
 *   matches (see vite-glob.ts).
 */
export interface EntryBuildObserver {
  readonly watchFiles?: Set<string>;
  readonly onWatchFile?: (file: string) => void;
  readonly onLoad?: (file: string) => void;
  readonly onResolve?: (authored: string) => void;
  readonly onGlob?: (scope: GlobScope) => void;
}

/**
 * Collects the files the entry build's plugins add with `addWatchFile`. These
 * are not modules of the bundle: Vite's CSS plugin adds the stylesheets pulled
 * in by `@import` and the files `url()` points at this way. The build runs on
 * recording stand-ins of its plugins, made in the bundler's `options` hook,
 * which sees the final plugin list, including the plugins Vite resolves per
 * environment (`applyToEnvironment`) after `configResolved`.
 */
function recordWatchFiles(files: Set<string>, root: string, observer: EntryBuildObserver): Plugin {
  const { onLoad, onResolve, onGlob, onWatchFile } = observer;
  const record = (file: string): void => {
    files.add(file);
    onWatchFile?.(file);
  };
  return {
    name: `${PLUGIN_NAME}:record-watch-files`,
    // Called for each module just before its file is read, so a caller can note the file's state as the
    // bundle is about to see it. It reads nothing itself: the module is loaded as usual.
    load: {
      order: 'pre',
      handler(id) {
        const file = fileOfId(id);
        if (!isAbsolute(file) || id.startsWith('\0')) return null;
        onLoad?.(file);
        // A plugin may resolve a module to a path through a link (or `resolve.preserveSymlinks` keep it), which
        // is then the module's own spelling.
        onResolve?.(file);
        return null;
      },
    },
    // Where each import is spelled, before the bundler follows a link to its target (see importSpellings): a
    // caller then sees a link that is retargeted, which the target's own path never shows. It resolves nothing
    // for the bundle: the import is resolved as usual.
    resolveId: {
      order: 'pre',
      async handler(source, importer) {
        if (onResolve === undefined) return null;
        const { spellings, kept } = await importSpellings(this, source, importer, root);
        for (const spelled of spellings) onResolve(spelled);
        // Missing packages have no resolved spelling yet. Keep their search locations as recovery inputs,
        // without treating a whole ancestor of node_modules as a missing relative import's watch folder.
        if (kept === undefined && spellings.length === 0) {
          const candidates = missingPackagePaths(source, importer);
          for (const path of candidates) record(path);
          const scope = missingPackageScope(source, importer, candidates);
          if (scope !== undefined) {
            record(join(scope.dir, 'package.json'));
            onGlob?.(scope);
          }
        }
        return null;
      },
    },
    // The scopes of the module's glob calls. This plugin is the last of the user's, so it sees each module as
    // Vite's import-glob, which runs next, does; it transforms nothing itself.
    transform: {
      filter: { code: 'import.meta.glob' },
      async handler(code, id) {
        if (onGlob === undefined) return null;
        for (const scope of await moduleGlobScopes(this, code, id, root)) onGlob(scope);
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
          .map((p) => recordingPlugin(p, record));
        return { ...inputOptions, plugins };
      },
    },
  };
}

/** The `worker` options of a configuration. */
type WorkerOptions = NonNullable<UserConfig['worker']>;

/**
 * `worker` with `plugin()` after its own `worker.plugins`, which Vite calls for each worker build (nested ones
 * too); the user's plugins come first, in their order, whether given as a function or as the list older Vite
 * versions took.
 */
export function withWorkerPlugin(worker: UserConfig['worker'], plugin: () => Plugin): WorkerOptions {
  const own = worker?.plugins;
  // Typed as a function only, but Vite still reads a list (with a warning), which is kept as one item: Vite flattens
  // the list a function returns.
  return { ...worker, plugins: () => [typeof own === 'function' ? own() : own, plugin()] };
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
  observer: EntryBuildObserver = {},
): Promise<EntryBundle> {
  const watchFiles = observer.watchFiles ?? new Set<string>();
  const env: ConfigEnv = { command, mode: config.mode, isSsrBuild: false, isPreview: false };
  const user = await userConfigFor(config, env);
  const plugins = (await flattenPlugins(user.plugins))
    .filter(isPlugin)
    .filter((plugin) => plugin.name !== PLUGIN_NAME && appliesTo(plugin, command, user, env))
    .map((plugin) => asEntryBuildPlugin(plugin, command));
  const inline: InlineConfig = {
    ...withoutExcludedKeys(user),
    configFile: false,
    root: config.root,
    mode: config.mode,
    logLevel: entryBuildLogLevel(config.logLevel),
    customLogger: entryBuildLogger(config.logger),
    clearScreen: false,
    // Public files stay resolvable (`/logo.svg`, base rewriting); `copyPublicDir: false` keeps them uncopied.
    publicDir: config.publicDir || false,
    plugins: [
      ...plugins,
      entryBuildEnforcer(entryPath, command, outputFilename),
      recordWatchFiles(watchFiles, config.root, observer),
    ],
    // A worker the entry starts is bundled by a build nested in this one, with the plugins of `worker.plugins`:
    // its modules, globs and import spellings are the entry's too (#424).
    worker: withWorkerPlugin(user.worker, () => recordWatchFiles(watchFiles, config.root, observer)),
  };
  // One output, as entryBuildSettings sets it, and no watcher (`watch: null`).
  const [result] = [await build(inline)].flat();
  if (result === undefined || !('output' in result)) throw new Error('twee-ts: the entry build returned no bundle.');
  const bundle: Record<string, BundleItem> = Object.fromEntries(result.output.map((item) => [item.fileName, item]));
  const entry = takeEntryFromBundle(bundle);
  return { ...entry, files: new Set([...entry.files, ...watchFiles]) };
}

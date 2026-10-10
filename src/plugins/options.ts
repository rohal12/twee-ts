/**
 * The options both bundler plugins take, checked once where the plugin is
 * created and turned into what the plugin works with: the compile options of a
 * build, the files whose changes rebuild the story, and which of them
 * `compileOptions.exclude` leaves out. The Vite and the Rollup plugin share this,
 * so the same options mean the same thing in both.
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CompileOptions, InlineSource } from '../types.js';
import { TweeTsError } from '../errors.js';
import { isExcluded } from '../filesystem.js';
import { identify, isSameOrInside } from '../path-identity.js';
import { toPosix } from './paths.js';
import { parseVersion } from '../semver.js';
import { isRecord } from '../util.js';

/**
 * The compile options a plugin passes on to the compiler. `sources` and
 * `formatId` come from the plugin's own `sources` and `format` options, so they
 * are not accepted here.
 */
export type PluginCompileOptions = Omit<Partial<CompileOptions>, 'sources' | 'formatId'>;

/** The options both plugins take. */
export interface SharedPluginOptions {
  /**
   * Source directories/files to compile, relative to the working directory. The plugins take paths only: a
   * bundler watches files, so the inline sources `compile()` accepts are not supported here.
   */
  sources: readonly string[];
  /** Story format ID (`formatId` in the compile options). */
  format?: string | undefined;
  /**
   * Output file name, relative to the output folder: names separated by forward
   * slashes, without a `.` or `..` segment. Default: 'index.html'.
   */
  outputFilename?: string | undefined;
  /** Additional compile options. Set `sources` and `format` with the options above, not here. */
  compileOptions?: PluginCompileOptions | undefined;
}

/** The options the Vite plugin takes on top of the shared ones. */
interface EntryOption {
  entry?: string | undefined;
}

/** Which plugin the options are for, which decides the option names it accepts. */
export type PluginKind = 'vite' | 'rollup';

/** The option names each plugin accepts. */
const OPTION_NAMES: Readonly<Record<PluginKind, readonly string[]>> = {
  rollup: ['sources', 'format', 'outputFilename', 'compileOptions'],
  vite: ['sources', 'format', 'outputFilename', 'compileOptions', 'entry'],
};

/** The compile options each plugin sets from an option of its own, by that option's name. */
const PLUGIN_SET_COMPILE_OPTIONS: readonly (readonly [string, string])[] = [
  ['sources', 'sources'],
  ['formatId', 'format'],
];

/** The options, checked and resolved. */
export interface ResolvedPluginOptions {
  /** The sources as given: the compiler reads them, and `exclude` globs match against them. */
  readonly sources: readonly string[];
  readonly format: string | undefined;
  readonly outputFilename: string;
  readonly compileOptions: Readonly<PluginCompileOptions>;
  /** The entry, absolute (Vite only). */
  readonly entry: string | undefined;
  /**
   * The paths whose changes rebuild the story, absolute and with forward
   * slashes: the sources, the head file and the modules.
   */
  readonly inputs: readonly string[];
  /** Whether `compileOptions.exclude` leaves a file (absolute, forward slashes) out of the story. */
  readonly excluded: (file: string) => boolean;
  /** The compile options of one build, with `inline` sources after the user's. */
  readonly compile: (inline?: readonly InlineSource[]) => CompileOptions;
}

function fail(kind: PluginKind, message: string): never {
  throw new TweeTsError(`twee-ts ${kind} plugin: ${message}`, [], { code: 'INVALID_OPTIONS' });
}

/** The oldest Vite the plugin works with (the `vite` peer dependency). */
const MINIMUM_VITE_MAJOR = 8;

/**
 * Throws a TweeTsError (`INVALID_OPTIONS`) that names twee-ts and the Vite version when Vite is older than the
 * plugin supports, instead of the obscure failure an older Vite gives (a missing `index.html`, say). A version
 * that is not a SemVer version (a custom build) is accepted.
 */
export function checkViteVersion(viteVersion: string): void {
  const parsed = parseVersion(viteVersion);
  if (parsed === null) return;
  if (parsed.major < MINIMUM_VITE_MAJOR) {
    fail(
      'vite',
      `Vite ${viteVersion} is not supported; the plugin needs Vite ${MINIMUM_VITE_MAJOR} or newer. ` +
        'Upgrade Vite, or use an older twee-ts release for this Vite.',
    );
  }
}

/**
 * Characters a file name can't hold on every file system (Windows rejects
 * `<>:"|?*`, the control characters and `\`), and those a URL path reads
 * differently from the file name (`#`, `?`, `%`).
 */
const UNPORTABLE = /[\u0000-\u001f\u007f<>:"|?*#%\\]/;

/** Names Windows reserves for devices, with or without an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Why `name` can't be an output file name, or undefined when it can. It must be
 * a relative path: names separated by forward slashes, none of them empty, `.`
 * or `..`, nor one a file system or a URL would read differently. The bundler
 * writes it inside the output folder, and the dev server serves it at the same
 * path under the base URL.
 */
export function outputFilenameProblem(name: string): string | undefined {
  if (name === '') return 'it is empty';
  if (UNPORTABLE.test(name)) return 'it holds a character that is not portable in a file name or URL path';
  if (name.startsWith('/')) return 'it is an absolute path';
  const segments = name.split('/');
  if (segments.includes('')) return 'it has an empty name between slashes, or ends with a slash';
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'it has a "." or ".." segment';
  if (segments.some((segment) => segment.endsWith('.') || segment.endsWith(' '))) {
    return 'a name in it ends with "." or a space, which Windows drops';
  }
  if (segments.some((segment) => WINDOWS_DEVICE.test(segment))) return 'a name in it is reserved on Windows';
  return undefined;
}

function checkString(kind: PluginKind, value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== 'string' || value === '')) {
    fail(kind, `\`${name}\` must be a non-empty string.`);
  }
}

function checkStringList(kind: PluginKind, value: unknown, name: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    fail(kind, `\`${name}\` must be an array of non-empty strings.`);
  }
}

/** Whether `value` is an `ExcludeGlob`: exactly a non-empty `base` and a non-empty `glob`, both strings. */
function isExcludeGlob(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    ['base', 'glob'].every((key) => typeof value[key] === 'string' && value[key] !== '')
  );
}

function checkExclude(kind: PluginKind, value: unknown): void {
  if (!Array.isArray(value) || value.some((item) => (typeof item !== 'string' ? !isExcludeGlob(item) : item === ''))) {
    fail(kind, '`compileOptions.exclude` must be an array of non-empty strings or `{ base, glob }` objects.');
  }
}

/**
 * Checks the options as a JavaScript caller may pass them, whatever their type
 * says: an object with only the accepted option names, each of the right type.
 */
function checkOptions(kind: PluginKind, options: unknown): void {
  if (!isRecord(options)) fail(kind, 'the options must be an object.');
  const accepted = OPTION_NAMES[kind];
  const unknown = Object.keys(options).filter((key) => !accepted.includes(key));
  if (unknown.length > 0) {
    const names = unknown.map((key) => `\`${key}\``).join(', ');
    fail(kind, `unknown option ${names}; the options are ${accepted.join(', ')}.`);
  }
  checkStringList(kind, options['sources'], 'sources');
  for (const name of ['format', 'outputFilename', 'entry']) checkString(kind, options[name], name);
  const outputFilename = options['outputFilename'];
  const problem = typeof outputFilename === 'string' ? outputFilenameProblem(outputFilename) : undefined;
  if (problem !== undefined) {
    fail(kind, `\`outputFilename\` ${JSON.stringify(outputFilename)} can't be used: ${problem}.`);
  }
  const compileOptions = options['compileOptions'];
  if (compileOptions === undefined) return;
  if (!isRecord(compileOptions)) fail(kind, '`compileOptions` must be an object.');
  for (const [key, own] of PLUGIN_SET_COMPILE_OPTIONS) {
    if (Object.hasOwn(compileOptions, key)) {
      fail(kind, `\`compileOptions.${key}\` is not accepted; set the plugin's \`${own}\` option instead.`);
    }
  }
  if (compileOptions['exclude'] !== undefined) checkExclude(kind, compileOptions['exclude']);
  if (compileOptions['modules'] !== undefined)
    checkStringList(kind, compileOptions['modules'], 'compileOptions.modules');
  checkString(kind, compileOptions['headFile'], 'compileOptions.headFile');
  // The compiler checks the other compile options itself.
}

/** Absolute forward-slash path of a path given relative to the working directory. */
function absolute(path: string): string {
  return toPosix(resolve(path));
}

/**
 * How the compiler spells `file` when it finds it by walking each source it is inside: the source
 * as given, then the file's path below it. A watcher may report the real path of a file the sources
 * (and so the exclude globs) reach through a link, which the globs would otherwise not match.
 */
function spellingsUnderSources(file: string, sources: readonly string[]): string[] {
  const real = identify(file).canonical;
  return sources.flatMap((source) => {
    const below = relative(identify(source).canonical, real);
    const outside = below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below);
    return outside ? [] : [join(resolve(source), below)];
  });
}

/**
 * Checks a plugin's options and resolves them. Throws a TweeTsError naming the
 * option for anything outside what the plugin supports: an unknown option, a
 * value of the wrong type, `compileOptions.sources` or `compileOptions.formatId`
 * (the plugin's `sources` and `format` set them), or an output file name that
 * is not a plain relative path.
 */
export function resolvePluginOptions(
  kind: PluginKind,
  options: Readonly<SharedPluginOptions & EntryOption>,
): ResolvedPluginOptions {
  checkOptions(kind, options);
  const { sources, format, entry } = options;
  const compileOptions: Readonly<PluginCompileOptions> = { ...options.compileOptions };
  const { headFile, modules = [], exclude = [] } = compileOptions;
  const notExcludable = [...(headFile === undefined ? [] : [headFile]), ...modules].map(absolute);
  return {
    sources: [...sources],
    format,
    outputFilename: options.outputFilename ?? 'index.html',
    compileOptions,
    entry: entry === undefined ? undefined : resolve(entry),
    inputs: [...sources.map(absolute), ...notExcludable],
    // `exclude` never applies to the head file and the modules.
    excluded: (file) =>
      exclude.length > 0 &&
      [file, ...spellingsUnderSources(file, sources)].some((spelling) => isExcluded(spelling, exclude)) &&
      !notExcludable.some((path) => isSameOrInside(file, path)),
    compile: (inline = []) => ({ ...compileOptions, sources: [...sources, ...inline], formatId: format }),
  };
}

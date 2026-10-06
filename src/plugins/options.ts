/**
 * The options both bundler plugins take, checked once where the plugin is
 * created and turned into what the plugin works with: the compile options of a
 * build, the files whose changes rebuild the story, and which of them
 * `compileOptions.exclude` leaves out. The Vite and the Rollup plugin share this,
 * so the same options mean the same thing in both.
 */
import { resolve } from 'node:path';
import type { CompileOptions, InlineSource } from '../types.js';
import { TweeTsError } from '../compiler.js';
import { isExcluded } from '../filesystem.js';
import { isInside, toPosix } from './paths.js';

/**
 * The compile options a plugin passes on to the compiler. `sources` and
 * `formatId` come from the plugin's own `sources` and `format` options, so they
 * are not accepted here.
 */
export type PluginCompileOptions = Omit<Partial<CompileOptions>, 'sources' | 'formatId'>;

/** The options both plugins take. */
export interface SharedPluginOptions {
  /** Source directories/files to compile, relative to the working directory. */
  sources: string[];
  /** Story format ID. */
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
  throw new TweeTsError(`twee-ts ${kind} plugin: ${message}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  for (const key of ['exclude', 'modules']) {
    if (compileOptions[key] !== undefined) checkStringList(kind, compileOptions[key], `compileOptions.${key}`);
  }
  checkString(kind, compileOptions['headFile'], 'compileOptions.headFile');
  // The compiler checks the other compile options itself.
}

/** Absolute forward-slash path of a path given relative to the working directory. */
function absolute(path: string): string {
  return toPosix(resolve(path));
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
    excluded: (file) => isExcluded(file, exclude) && !isInside(file, notExcludable),
    compile: (inline = []) => ({ ...compileOptions, sources: [...sources, ...inline], formatId: format }),
  };
}

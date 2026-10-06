/**
 * The command line, parsed completely into a typed request before anything runs.
 *
 * parseCliArgs() turns argv into a CliRequest or a CliUsageError; it never reads a file. resolveBuild()
 * then merges a build request with the config file into compile options. Every check that can be made on
 * the command line alone is made here: unknown options, missing or empty values, an option given twice,
 * options that conflict, tag aliases, and subcommands (only as the first word, never after `--`).
 */
import { parseArgs } from 'node:util';
import type { OutputMode, TweeTsConfig, WordCountMethod } from './types.js';
import { tagAliasProblem } from './config.js';

/** A command line that can't be run, with what to tell the user. The CLI prints it and exits with status 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** Where the config comes from: `twee-ts.config.json` in the working directory, a named file, or none. */
export type ConfigChoice =
  { readonly kind: 'auto' } | { readonly kind: 'file'; readonly path: string } | { readonly kind: 'none' };

/** The build settings given on the command line; a setting not given is undefined (the config decides). */
interface BuildFlags {
  readonly output?: string;
  readonly outputMode?: OutputMode;
  readonly formatId?: string;
  readonly startPassage?: string;
  readonly modules?: readonly string[];
  readonly headFile?: string;
  readonly exclude?: readonly string[];
  readonly formatIndices?: readonly string[];
  readonly formatUrls?: readonly string[];
  /** In order, a later one replacing an earlier one for the same alias. */
  readonly tagAliases?: readonly (readonly [string, string])[];
  readonly wordCountMethod?: WordCountMethod;
  readonly trim?: false;
  readonly twee2Compat?: true;
  readonly testMode?: true;
  readonly noRemote?: true;
  readonly sourceInfo?: true;
}

type BuildAction = 'once' | 'watch' | 'lint';

export interface BuildRequest {
  readonly kind: 'build';
  readonly action: BuildAction;
  readonly sources: readonly string[];
  readonly flags: BuildFlags;
  readonly config: ConfigChoice;
  readonly log: { readonly files: boolean; readonly stats: boolean };
}

export type CacheAction = 'list' | 'size' | 'path';

export type CliRequest =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'init' }
  | { readonly kind: 'cache-help' }
  | { readonly kind: 'cache'; readonly action: CacheAction }
  | { readonly kind: 'cache-clear'; readonly name?: string }
  | { readonly kind: 'list-formats'; readonly config: ConfigChoice }
  | BuildRequest;

export type CliParse =
  { readonly ok: true; readonly request: CliRequest } | { readonly ok: false; readonly error: CliUsageError };

const OUTPUT_MODE_FLAGS: Readonly<Record<string, OutputMode>> = {
  'decompile-twee3': 'twee3',
  decompile: 'twee3',
  'decompile-twee1': 'twee1',
  'archive-twine2': 'twine2-archive',
  'archive-twine1': 'twine1-archive',
  json: 'json',
};

const WORD_COUNT_METHODS: readonly WordCountMethod[] = ['tweego', 'whitespace'];

/** Every option, as node:util's parseArgs takes them. docs/cli.md documents each one (test/docs-reference.test.ts). */
export const OPTIONS = {
  output: { type: 'string', short: 'o' },
  format: { type: 'string', short: 'f' },
  start: { type: 'string', short: 's' },
  module: { type: 'string', short: 'm', multiple: true },
  head: { type: 'string' },
  'decompile-twee3': { type: 'boolean', short: 'd' },
  // Tweego's deprecated spelling of --decompile-twee3.
  decompile: { type: 'boolean' },
  'decompile-twee1': { type: 'boolean' },
  'archive-twine2': { type: 'boolean', short: 'a' },
  'archive-twine1': { type: 'boolean' },
  json: { type: 'boolean' },
  'twee2-compat': { type: 'boolean' },
  'no-trim': { type: 'boolean' },
  lint: { type: 'boolean' },
  test: { type: 'boolean', short: 't' },
  watch: { type: 'boolean', short: 'w' },
  'log-stats': { type: 'boolean', short: 'l' },
  'log-files': { type: 'boolean' },
  'list-formats': { type: 'boolean' },
  init: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'format-index': { type: 'string', multiple: true },
  'format-url': { type: 'string', multiple: true },
  'no-remote': { type: 'boolean' },
  'tag-alias': { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  'source-info': { type: 'boolean' },
  'word-count-method': { type: 'string' },
  config: { type: 'string', short: 'c' },
  'no-config': { type: 'boolean' },
  // Tweego's, which twee-ts doesn't support; recognised to say so.
  charset: { type: 'string' },
  'list-charsets': { type: 'boolean' },
} as const;

type OptionName = keyof typeof OPTIONS;

function isOptionName(name: string): name is OptionName {
  return Object.hasOwn(OPTIONS, name);
}

/** How an option is shown in messages: its short form too, when it has one. */
function optionLabel(name: OptionName): string {
  const option = OPTIONS[name];
  return 'short' in option ? `-${option.short}, --${name}` : `--${name}`;
}

/** The options that stand for a whole command, which take nothing else. */
const QUERY_OPTIONS: readonly OptionName[] = ['version', 'init', 'list-formats'];

/** The options --list-formats accepts besides itself: those that choose the config, whose formatPaths it lists. */
const LIST_FORMATS_OPTIONS: readonly OptionName[] = ['list-formats', 'config', 'no-config'];

/** What `parseArgs` threw, as a usage message without its code or its advice about `--`. */
function parseArgsMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const unknown = /^Unknown option '([^']+)'/.exec(message);
  if (unknown?.[1] !== undefined) return `unknown option ${unknown[1]}`;
  return message.replace(/\n[\s\S]*$/, '').replace(/^Option '([^']+)'/, 'option $1');
}

function parseCache(rest: readonly string[]): CliRequest {
  const [action, name, ...extra] = rest;
  const tooMany = (): CliUsageError =>
    new CliUsageError(`cache ${action ?? ''} takes ${action === 'clear' ? 'at most one name' : 'no arguments'}`);
  if (rest.some((arg) => arg.startsWith('-') && arg !== '-')) {
    throw new CliUsageError(
      'the cache subcommand takes no options; to build a folder named "cache", write ./cache or put -- before it',
    );
  }
  switch (action) {
    case undefined:
      return { kind: 'cache-help' };
    case 'list':
    case 'size':
    case 'path':
      if (name !== undefined) throw tooMany();
      return { kind: 'cache', action };
    case 'clear':
      if (extra.length > 0) throw tooMany();
      return name === undefined ? { kind: 'cache-clear' } : { kind: 'cache-clear', name };
    default:
      throw new CliUsageError(`unknown cache subcommand "${action}"; expected list, clear, size or path`);
  }
}

/** The tag aliases of `--tag-alias alias=target` values, each one checked. */
function parseTagAliases(values: readonly string[]): [string, string][] {
  return values.map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new CliUsageError(`invalid --tag-alias "${pair}": expected alias=target`);
    const alias = pair.slice(0, eq);
    const target = pair.slice(eq + 1);
    const problem = tagAliasProblem(alias, target);
    if (problem !== undefined) throw new CliUsageError(`invalid --tag-alias "${pair}": ${problem}`);
    return [alias, target];
  });
}

/**
 * Parses the arguments after `twee-ts` into a request. Never throws: a command line that can't be run
 * gives a CliUsageError.
 */
export function parseCliArgs(argv: readonly string[]): CliParse {
  try {
    return { ok: true, request: parseRequest(argv) };
  } catch (e) {
    if (e instanceof CliUsageError) return { ok: false, error: e };
    throw e;
  }
}

function parseRequest(argv: readonly string[]): CliRequest {
  // A subcommand only as the very first word: `twee-ts -o out.html cache` builds a folder named cache.
  if (argv[0] === 'cache') return parseCache(argv.slice(1));

  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true, tokens: true });
  } catch (e) {
    throw new CliUsageError(parseArgsMessage(e));
  }
  const { values, positionals, tokens } = parsed;

  // Each option once, except those that may repeat.
  const given = new Map<OptionName, number>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const { name } = token;
    // parseArgs (strict) only yields names from OPTIONS; the check narrows the type.
    if (!isOptionName(name)) continue;
    given.set(name, (given.get(name) ?? 0) + 1);
    const option = OPTIONS[name];
    if (!('multiple' in option) && (given.get(name) ?? 0) > 1) {
      throw new CliUsageError(`${optionLabel(name)} given more than once`);
    }
    if (token.value === '' && OPTIONS[name].type === 'string') {
      throw new CliUsageError(`${optionLabel(name)} needs a non-empty value`);
    }
  }
  const has = (name: OptionName): boolean => given.has(name);
  const names = [...given.keys()];

  if (has('help')) return { kind: 'help' };
  if (has('charset') || has('list-charsets')) {
    throw new CliUsageError(
      'twee-ts has no --charset: sources are read as UTF-8 (or UTF-16 after a byte order mark), and a file that is not valid UTF-8 as Windows-1252, as Tweego does by default',
    );
  }

  for (const query of QUERY_OPTIONS) {
    if (!has(query)) continue;
    const allowed = query === 'list-formats' ? LIST_FORMATS_OPTIONS : [query];
    const other = names.find((name) => !allowed.includes(name));
    if (other !== undefined) throw new CliUsageError(`--${query} can't be combined with ${optionLabel(other)}`);
    if (positionals.length > 0) throw new CliUsageError(`--${query} takes no sources`);
  }
  if (has('config') && has('no-config')) throw new CliUsageError('-c, --config and --no-config conflict');
  const config: ConfigChoice =
    values.config !== undefined
      ? { kind: 'file', path: values.config }
      : has('no-config')
        ? { kind: 'none' }
        : { kind: 'auto' };
  if (has('version')) return { kind: 'version' };
  if (has('init')) return { kind: 'init' };
  if (has('list-formats')) return { kind: 'list-formats', config };

  const modeFlags = names.filter((name) => Object.hasOwn(OUTPUT_MODE_FLAGS, name));
  const [modeFlag, otherModeFlag] = modeFlags;
  if (otherModeFlag !== undefined && modeFlag !== undefined) {
    throw new CliUsageError(
      `${optionLabel(modeFlag)} and ${optionLabel(otherModeFlag)} conflict: choose one output mode`,
    );
  }
  const outputMode = modeFlag === undefined ? undefined : OUTPUT_MODE_FLAGS[modeFlag];

  let action: BuildAction = 'once';
  if (has('lint')) {
    const conflict = names.find(
      (name) =>
        name === 'watch' || name === 'log-stats' || name === 'log-files' || Object.hasOwn(OUTPUT_MODE_FLAGS, name),
    );
    if (conflict !== undefined) throw new CliUsageError(`--lint can't be combined with ${optionLabel(conflict)}`);
    action = 'lint';
  } else if (has('watch')) {
    if (values.output === '-')
      throw new CliUsageError('watch mode needs an output file: standard output is not supported');
    action = 'watch';
  }

  const wordCountMethod = values['word-count-method'];
  if (wordCountMethod !== undefined && !WORD_COUNT_METHODS.some((m) => m === wordCountMethod)) {
    throw new CliUsageError(
      `invalid --word-count-method "${wordCountMethod}": expected ${WORD_COUNT_METHODS.join(' or ')}`,
    );
  }

  const flags: BuildFlags = {
    ...(values.output === undefined ? {} : { output: values.output }),
    ...(outputMode === undefined ? {} : { outputMode }),
    ...(values.format === undefined ? {} : { formatId: values.format }),
    ...(values.start === undefined ? {} : { startPassage: values.start }),
    ...(values.module === undefined ? {} : { modules: values.module }),
    ...(values.head === undefined ? {} : { headFile: values.head }),
    ...(values.exclude === undefined ? {} : { exclude: values.exclude }),
    ...(values['format-index'] === undefined ? {} : { formatIndices: values['format-index'] }),
    ...(values['format-url'] === undefined ? {} : { formatUrls: values['format-url'] }),
    ...(values['tag-alias'] === undefined ? {} : { tagAliases: parseTagAliases(values['tag-alias']) }),
    ...(wordCountMethod === 'tweego' || wordCountMethod === 'whitespace' ? { wordCountMethod } : {}),
    ...(has('no-trim') ? { trim: false } : {}),
    ...(has('twee2-compat') ? { twee2Compat: true } : {}),
    ...(has('test') ? { testMode: true } : {}),
    ...(has('no-remote') ? { noRemote: true } : {}),
    ...(has('source-info') ? { sourceInfo: true } : {}),
  };

  return {
    kind: 'build',
    action,
    sources: positionals,
    flags,
    config,
    log: { files: has('log-files'), stats: has('log-stats') },
  };
}

/** The compile options of a build request, the command line's settings winning over the config's. */
export interface ResolvedBuild {
  readonly action: BuildAction;
  readonly sources: readonly string[];
  /** `-` for standard output. */
  readonly output: string;
  readonly options: {
    readonly outputMode: OutputMode;
    readonly exclude?: readonly string[] | undefined;
    readonly formatId?: string | undefined;
    readonly startPassage?: string | undefined;
    readonly formatPaths?: readonly string[] | undefined;
    readonly modules?: readonly string[] | undefined;
    readonly headFile?: string | undefined;
    readonly trim: boolean;
    readonly twee2Compat: boolean;
    readonly testMode: boolean;
    readonly useTweegoPath?: boolean | undefined;
    readonly formatIndices?: readonly string[] | undefined;
    readonly formatUrls?: readonly string[] | undefined;
    readonly noRemote: boolean;
    readonly formatFetchTimeout?: number | undefined;
    readonly tagAliases?: Readonly<Record<string, string>> | undefined;
    readonly sourceInfo: boolean;
    readonly wordCountMethod?: WordCountMethod | undefined;
  };
}

/**
 * Merges a build request with the config (already validated and rebased onto the working directory):
 * a setting on the command line wins, and `--tag-alias` adds to (and overrides) the config's aliases.
 * Throws a CliUsageError when no sources are given anywhere, or watch mode has no output file.
 */
export function resolveBuild(request: BuildRequest, config: TweeTsConfig | null): ResolvedBuild {
  const { flags } = request;
  const sources = request.sources.length > 0 ? request.sources : (config?.sources ?? []);
  if (sources.length === 0) throw new CliUsageError('no input sources: name them, or set "sources" in the config');
  const output = flags.output ?? config?.output ?? '-';
  if (request.action === 'watch' && output === '-') {
    throw new CliUsageError('watch mode needs an output file (-o, or "output" in the config)');
  }
  // Own-property-safe: Object.fromEntries defines `__proto__` as an ordinary key (#241).
  const aliasEntries = [...Object.entries(config?.tagAliases ?? {}), ...(flags.tagAliases ?? [])];
  return {
    action: request.action,
    sources,
    output,
    options: {
      outputMode: flags.outputMode ?? config?.outputMode ?? 'html',
      exclude: flags.exclude ?? config?.exclude,
      formatId: flags.formatId ?? config?.formatId,
      startPassage: flags.startPassage ?? config?.startPassage,
      formatPaths: config?.formatPaths,
      modules: flags.modules ?? config?.modules,
      headFile: flags.headFile ?? config?.headFile,
      trim: flags.trim ?? config?.trim ?? true,
      twee2Compat: flags.twee2Compat ?? config?.twee2Compat ?? false,
      testMode: flags.testMode ?? config?.testMode ?? false,
      useTweegoPath: config?.useTweegoPath,
      formatIndices: flags.formatIndices ?? config?.formatIndices,
      formatUrls: flags.formatUrls ?? config?.formatUrls,
      noRemote: flags.noRemote ?? config?.noRemote ?? false,
      formatFetchTimeout: config?.formatFetchTimeout,
      tagAliases:
        aliasEntries.length > 0 || config?.tagAliases !== undefined ? Object.fromEntries(aliasEntries) : undefined,
      sourceInfo: flags.sourceInfo ?? config?.sourceInfo ?? false,
      wordCountMethod: flags.wordCountMethod ?? config?.wordCountMethod,
    },
  };
}

/** Whether a `-c` value that names no file looks like a charset, as Tweego's `-c` takes one. */
export function looksLikeCharset(value: string): boolean {
  return /^(?:utf-?(?:8|16(?:le|be)?|32)|windows-\d{3,4}|cp\d{3,4}|iso-?8859-\d{1,2}|latin-?\d|(?:us-)?ascii|macintosh|koi8-[ru]|shift[-_]jis|euc-[a-z]{2}|gbk|big5)$/i.test(
    value,
  );
}

/** The help text. */
export function usageText(version: string, configFilename: string): string {
  return `twee-ts v${version} — TypeScript Twee-to-HTML compiler

Usage: twee-ts [options] <sources...>
       twee-ts cache <list|clear [name]|size|path>

Options:
  -o, --output <file>       Output file; - for standard output (default)
  -f, --format <id>         Story format ID (default: sugarcube-2)
  -s, --start <name>        Starting passage (default: Start)
  -m, --module <file>       Module file to inject into <head> (repeatable)
  --head <file>             Raw HTML file to append to <head>
  -d, --decompile-twee3     Output as Twee 3 source
  --decompile-twee1         Output as Twee 1 source
  -a, --archive-twine2      Output as Twine 2 archive
  --archive-twine1          Output as Twine 1 archive
  --json                    Output as JSON
  --twee2-compat            Enable Twee2 syntax compatibility
  --lint                    Lint story structure (broken links, dead ends, orphans)
  --no-trim                 Don't trim passage whitespace
  -t, --test                Enable test/debug mode
  -w, --watch               Watch for changes and rebuild
  -l, --log-stats           Log compilation statistics (to standard error)
  --log-files               Log the files read (to standard error)
  --list-formats            List available story formats
  --init                    Initialize a new project
  --format-index <url>      SFA-compatible format index URL (repeatable)
  --format-url <url>        Direct format.js URL (repeatable)
  --tag-alias <alias=target> Map a tag to a special tag (repeatable)
  --exclude <glob>          Leave out source files matching a glob (repeatable)
  --source-info             Emit source file/line as data- attributes on passages
  --word-count-method <m>   Word counting method: tweego (default), whitespace
  --no-remote               Disable remote format fetching
  -c, --config <file>       Config file path (default: ${configFilename})
  --no-config               Skip config file loading
  -h, --help                Show this help
  -v, --version             Show version

Use -- before sources whose names start with - (or a first source named cache).

Subcommands:
  cache list                List cached remote formats
  cache clear [name]        Clear cached formats (all or by name)
  cache size                Show total cache size
  cache path                Print cache directory path

Exit status: 0 success, 1 build or lint errors, 2 usage errors.`;
}

/** The help text of the cache subcommand. */
export const CACHE_USAGE = `Usage: twee-ts cache <list|clear|size|path>

  list          List cached formats with name, version, size
  clear         Delete all cached formats
  clear <name>  Delete cached formats matching name
  size          Show total cache size
  path          Print cache directory path`;

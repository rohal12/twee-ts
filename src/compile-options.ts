/**
 * The one check of the compile options as a JavaScript caller may pass them, whatever their types say:
 * compile(), compileToFile(), watch(), compileIncremental(), lint() and the bundler plugins' `compileOptions`.
 *
 * An option a config file also sets is checked by that config key's decoder in CONFIG_SPEC, so an option holds
 * the same values from the API, the plugins and the config file; the command line refuses empty values and
 * merges with the config. The options a config file can't set (inline sources, `{ base, glob }` excludes, the
 * signal, the output file and the callbacks) are checked here.
 */
import type { Diagnostic, WatchOptions } from './types.js';
import { CONFIG_KEYS, configValueError } from './config.js';
import { TweeTsError } from './errors.js';
import { isRecord, similarKey } from './util.js';

/**
 * Every option compile(), compileToFile() and watch() read. `satisfies` keeps the list complete: an option
 * added to the types and not here, or listed here and not in the types, is a compile error.
 */
const OPTION_KEYS: readonly string[] = Object.keys({
  sources: true,
  exclude: true,
  outputMode: true,
  formatId: true,
  startPassage: true,
  formatPaths: true,
  useTweegoPath: true,
  modules: true,
  headFile: true,
  trim: true,
  twee2Compat: true,
  testMode: true,
  formatIndices: true,
  formatUrls: true,
  noRemote: true,
  signal: true,
  formatFetchTimeout: true,
  formatResolutionTimeout: true,
  useDefaultFormatIndices: true,
  tagAliases: true,
  sourceInfo: true,
  wordCountMethod: true,
  outFile: true,
  onBuild: true,
  onError: true,
} satisfies Record<keyof WatchOptions, true>);

/** What the options of the plugins and the config file are called in the compile options. */
const OTHER_NAMES: ReadonlyMap<string, string> = new Map([
  ['format', 'formatId'],
  ['output', 'outFile'],
]);

/**
 * A warning for each option the build does not read, as for a key a config file does not define: called from
 * JavaScript, or with a spread config object, a misspelt option (`format` for `formatId`) would otherwise be
 * left at its default without a word.
 */
export function unknownOptionWarnings(options: object): Diagnostic[] {
  return Object.keys(options)
    .filter((key) => !OPTION_KEYS.includes(key))
    .map((key): Diagnostic => {
      const suggestion = OTHER_NAMES.get(key) ?? similarKey(key, OPTION_KEYS);
      const hint = suggestion === undefined ? '' : ` (did you mean "${suggestion}"?)`;
      return { level: 'warning', message: `Unknown compile option "${key}"${hint}; it is ignored.` };
    });
}

/** Whether `value` is an `ExcludeGlob`: exactly a non-empty `base` and a non-empty `glob`, both strings. */
function isExcludeGlob(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    ['base', 'glob'].every((key) => typeof value[key] === 'string' && value[key] !== '')
  );
}

/** Whether `value` is an `InlineSource`: a non-empty `filename` and a string or Buffer `content`. */
function isInlineSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { filename, content } = value;
  return typeof filename === 'string' && filename !== '' && (typeof content === 'string' || Buffer.isBuffer(content));
}

const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value !== '';

/** The options a config file can't set (or sets differently), each with its check and what it must be. */
const OWN_CHECKS: ReadonlyMap<string, { readonly valid: (value: unknown) => boolean; readonly expected: string }> =
  new Map([
    [
      'sources',
      {
        valid: (value) =>
          Array.isArray(value) && value.every((item: unknown) => nonEmptyString(item) || isInlineSource(item)),
        expected: 'an array of non-empty paths and { filename, content } inline sources',
      },
    ],
    [
      'exclude',
      {
        valid: (value) =>
          Array.isArray(value) && value.every((item: unknown) => nonEmptyString(item) || isExcludeGlob(item)),
        expected: 'an array of non-empty strings and { base, glob } objects',
      },
    ],
    ['signal', { valid: (value) => value instanceof AbortSignal, expected: 'an AbortSignal' }],
    ['outFile', { valid: nonEmptyString, expected: 'a non-empty string' }],
    ['onBuild', { valid: (value) => typeof value === 'function', expected: 'a function' }],
    ['onError', { valid: (value) => typeof value === 'function', expected: 'a function' }],
  ]);

/** The compile options a config file sets with the same meaning, checked by its decoders. */
const CONFIG_CHECKED = CONFIG_KEYS.filter((key) => !OWN_CHECKS.has(key) && key !== 'output');

/** The time limits, which from JavaScript may also be `Infinity`, a number JSON can't hold: no limit, as 0 is. */
const TIME_LIMITS: ReadonlySet<string> = new Set(['formatFetchTimeout', 'formatResolutionTimeout']);

/**
 * What is wrong with `options` as compile options, one message per option, each naming the option with
 * `prefix` before it (a plugin's `compileOptions.`). An option set to `undefined` is the same as one left out;
 * the options in `required` must be set. Options the build does not read are left to unknownOptionWarnings().
 */
export function compileOptionErrors(
  options: unknown,
  required: readonly ('sources' | 'outFile')[],
  prefix = '',
): string[] {
  // A plugin checks that its `compileOptions` is an object before it gets here.
  if (!isRecord(options)) return ['The compile options must be an object.'];
  const value = (key: string): unknown => (Object.hasOwn(options, key) ? options[key] : undefined);
  const missing = required.filter((key) => value(key) === undefined).map((key) => `"${prefix}${key}" must be set.`);
  const own = [...OWN_CHECKS].flatMap(([key, check]) => {
    const given = value(key);
    return given === undefined || check.valid(given) ? [] : [`"${prefix}${key}" must be ${check.expected}.`];
  });
  const shared = CONFIG_CHECKED.flatMap((key) => {
    const given = value(key);
    const noCheck = given === undefined || (given === Number.POSITIVE_INFINITY && TIME_LIMITS.has(key));
    const error = noCheck ? undefined : configValueError(key, given, `${prefix}${key}`);
    return error === undefined ? [] : [error];
  });
  return [...missing, ...own, ...shared];
}

/** Throws a TweeTsError (`INVALID_OPTIONS`) naming each option that compileOptionErrors() finds wrong. */
export function validateCompileOptions(options: unknown, required: readonly ('sources' | 'outFile')[]): void {
  const errors = compileOptionErrors(options, required);
  if (errors.length === 0) return;
  const message = !isRecord(options)
    ? errors.join('')
    : errors.length === 1
      ? `Invalid compile option: ${errors.join('')}`
      : `Invalid compile options:\n  ${errors.join('\n  ')}`;
  throw new TweeTsError(message, [], { code: 'INVALID_OPTIONS' });
}

/**
 * Config file loading and validation for twee-ts.
 *
 * One table, CONFIG_SPEC, says what each key may hold. validateConfig() checks a config against it, and
 * configJsonSchema() renders it as the JSON Schema shipped in schemas/twee-ts.config.schema.json; a test
 * keeps the two equal, so the schema an editor checks with and the checks twee-ts makes cannot drift apart.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Diagnostic, TweeTsConfig, OutputMode, WordCountMethod } from './types.js';
import { readUTF8 } from './util.js';
import { identify } from './path-identity.js';
import { failureOfError, inputProblem } from './input-policy.js';
import type { InputDiscovery } from './input-policy.js';
import { TweeTsError } from './compiler.js';
import { JsonObject, field, formatJsonPath, ownRecord, parseJSON, readObject } from './json-decode.js';
import type { Decoder, DecodeIssue, FieldReader, JsonPath, JsonValue } from './json-decode.js';

export const CONFIG_FILENAME = 'twee-ts.config.json';

const VALID_OUTPUT_MODES: readonly OutputMode[] = [
  'html',
  'twee3',
  'twee1',
  'twine2-archive',
  'twine1-archive',
  'json',
];
const VALID_WORD_COUNT_METHODS: readonly WordCountMethod[] = ['tweego', 'whitespace'];

/** A tag name: at least one character and no whitespace, since Twee separates tags with spaces. */
const TAG_PATTERN = '^\\S+$';
const TAG_RE = new RegExp(TAG_PATTERN, 'u');

/** What one config key may hold, as the JSON schema states it. */
type FieldSpec = { readonly description: string; readonly default?: unknown } & (
  | { readonly kind: 'string'; readonly minLength?: number }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'number'; readonly minimum: number }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'string-array' }
  | { readonly kind: 'tag-map' }
);

/** A config key's spec, and the decoder that reads its value (its errors name the key as `label`). */
interface ConfigField<T> {
  readonly spec: FieldSpec;
  readonly decoder: (label: string) => Decoder<T>;
}

/** Every config key with its spec, each decoder giving the type TweeTsConfig names for the key. */
type ConfigSpec = { readonly [K in keyof TweeTsConfig]-?: ConfigField<NonNullable<TweeTsConfig[K]>> };

/** Records a config error and rejects the value. */
function invalid(issues: DecodeIssue[], path: JsonPath, message: string): { readonly ok: false } {
  issues.push({ kind: 'type', path, message });
  return { ok: false };
}

function stringField(
  description: string,
  options: { readonly minLength?: number; readonly default?: string } = {},
): ConfigField<string> {
  const { minLength } = options;
  return {
    spec: {
      kind: 'string',
      description,
      ...(minLength === undefined ? {} : { minLength }),
      ...(options.default === undefined ? {} : { default: options.default }),
    },
    decoder: (label) => (value, path, issues) => {
      if (typeof value !== 'string') return invalid(issues, path, `${label} must be a string.`);
      if (minLength !== undefined && value.length < minLength) {
        return invalid(issues, path, `${label} must not be empty.`);
      }
      return { ok: true, value };
    },
  };
}

function booleanField(description: string, defaultValue: boolean): ConfigField<boolean> {
  return {
    spec: {
      kind: 'boolean',
      description,
      default: defaultValue,
    },
    decoder: (label) => (value, path, issues) =>
      typeof value === 'boolean' ? { ok: true, value } : invalid(issues, path, `${label} must be a boolean.`),
  };
}

/** A number of milliseconds, `minimum` or more. */
function millisecondsField(description: string, minimum: number, defaultValue: number): ConfigField<number> {
  return {
    spec: {
      kind: 'number',
      description,
      minimum,
      default: defaultValue,
    },
    decoder: (label) => (value, path, issues) =>
      typeof value === 'number' && Number.isFinite(value) && value >= minimum
        ? { ok: true, value }
        : invalid(issues, path, `${label} must be a number of milliseconds, ${minimum} or more.`),
  };
}

function enumField<T extends string>(values: readonly T[], defaultValue: T, description: string): ConfigField<T> {
  return {
    spec: {
      kind: 'enum',
      values,
      description,
      default: defaultValue,
    },
    decoder: (label) => (value, path, issues) => {
      const known = values.find((v) => v === value);
      return known === undefined
        ? invalid(issues, path, `${label} must be one of: ${values.join(', ')}.`)
        : { ok: true, value: known };
    },
  };
}

function stringArrayField(description: string): ConfigField<string[]> {
  return {
    spec: {
      kind: 'string-array',
      description,
    },
    decoder: (label) => (value, path, issues) => {
      if (!Array.isArray(value)) return invalid(issues, path, `${label} must be an array.`);
      const items: readonly JsonValue[] = value;
      const strings = items.filter((item): item is string => typeof item === 'string');
      if (strings.length !== items.length) return invalid(issues, path, `${label} must be an array of strings.`);
      if (strings.includes('')) return invalid(issues, path, `${label} must not hold an empty string.`);
      return { ok: true, value: strings };
    },
  };
}

function tagMapField(description: string): ConfigField<Record<string, string>> {
  return {
    spec: {
      kind: 'tag-map',
      description,
    },
    decoder: (label) => (value, path, issues) => {
      if (!(value instanceof JsonObject)) return invalid(issues, path, `${label} must be an object.`);
      const entries: [string, string][] = [];
      for (const { key: alias, value: target } of value.members) {
        if (typeof target !== 'string') {
          return invalid(issues, [...path, alias], `${label.slice(0, -1)}.${alias}" must be a string.`);
        }
        const problem = tagAliasProblem(alias, target);
        if (problem !== undefined) return invalid(issues, [...path, alias], `${label}: ${problem}.`);
        entries.push([alias, target]);
      }
      // Own properties, so an alias `__proto__` is kept (#241).
      return { ok: true, value: ownRecord(entries) };
    },
  };
}

/** Every config key, with what it may hold. The JSON schema is generated from this (configJsonSchema()). */
export const CONFIG_SPEC: ConfigSpec = {
  sources: stringArrayField('Files or directories to compile, relative to the config file.'),
  exclude: stringArrayField(
    'Glob patterns for files to leave out of sources, relative to the config file (e.g. "**/*.png", "src/art/**").',
  ),
  output: stringField('Output file path, relative to the config file; "-" for standard output.', { minLength: 1 }),
  outputMode: enumField(VALID_OUTPUT_MODES, 'html', 'Output mode.'),
  formatId: stringField("Story format directory ID (e.g. 'sugarcube-2')."),
  startPassage: stringField('Name of the starting passage.', { default: 'Start' }),
  formatPaths: stringArrayField('Extra directories to search for story formats, relative to the config file.'),
  formatIndices: stringArrayField('URLs to SFA-compatible index.json files for remote format lookup.'),
  formatUrls: stringArrayField('Direct URLs to format.js files.'),
  useTweegoPath: booleanField('Also search TWEEGO_PATH env for formats.', true),
  modules: stringArrayField('Module files to inject into <head>, relative to the config file.'),
  headFile: stringField('Raw HTML file to append to <head>, relative to the config file; "" for none.'),
  trim: booleanField('Trim passage whitespace.', true),
  twee2Compat: booleanField('Twee2 compatibility mode.', false),
  testMode: booleanField('Enable debug/test mode option.', false),
  noRemote: booleanField('Disable remote format fetching.', false),
  formatFetchTimeout: millisecondsField(
    'Milliseconds each story format request (an index or a format.js) may take before it fails with a warning and the next source is tried. 0 turns the limit off.',
    0,
    30000,
  ),
  tagAliases: tagMapField(
    'Map alias tags to canonical special tags (e.g. { "library": "script" }). Tags are non-empty and hold no whitespace.',
  ),
  sourceInfo: booleanField('Emit source file and line as data- attributes on passage elements.', false),
  wordCountMethod: enumField(
    VALID_WORD_COUNT_METHODS,
    'tweego',
    "Word counting method. 'tweego': NFKD normalize, divide chars by 5 (matches Tweego). 'whitespace': split on whitespace after stripping comments and markup.",
  ),
};

/** The keys a config file may hold besides `$schema`; the JSON schema's `properties` list the same keys. */
export const CONFIG_KEYS: readonly (keyof TweeTsConfig)[] = Object.keys(CONFIG_SPEC).filter(
  (key): key is keyof TweeTsConfig => Object.hasOwn(CONFIG_SPEC, key),
);

/** The key that only references the JSON schema, for editors. */
const SCHEMA_KEY = '$schema';

/** A key folded so that spellings differing only in letter case, `-` or `_` compare equal. */
const foldKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, '');

/** Why a tag alias can't be used, or undefined when it can. The CLI's --tag-alias checks the same. */
export function tagAliasProblem(alias: string, target: string): string | undefined {
  if (!TAG_RE.test(alias)) return `the alias "${alias}" must be a non-empty tag name without whitespace`;
  if (!TAG_RE.test(target))
    return `the target "${target}" of alias "${alias}" must be a non-empty tag name without whitespace`;
  return undefined;
}

/**
 * Load a config file from the given directory (default: cwd). Returns null if not found.
 *
 * @param diagnostics Receives warnings that do not stop the config from loading: keys the config does not
 *   define, and a file that is not valid UTF-8 (it is read as Windows-1252).
 * @throws A TweeTsError when the file exists but cannot be read, is not valid JSON or fails {@link validateConfig}.
 */
export function loadConfig(dir?: string, diagnostics?: Diagnostic[]): TweeTsConfig | null {
  const base = dir ?? process.cwd();
  const configPath = join(base, CONFIG_FILENAME);

  if (!existsSync(configPath)) return null;

  return readConfig(configPath, 'found', diagnostics);
}

/**
 * Load a config from a specific file path.
 *
 * The paths in it (`sources`, `output`, `modules`, `headFile`, `formatPaths`) are relative to the folder
 * that holds the config file, and so are the `exclude` globs: the config is returned with them rebased onto
 * the working directory (see {@link rebaseConfigPaths}).
 *
 * @param diagnostics Receives warnings that do not stop the config from loading: keys the config does not
 *   define, and a file that is not valid UTF-8 (it is read as Windows-1252).
 * @throws A TweeTsError when the file cannot be read, is not valid JSON or fails {@link validateConfig}.
 */
export function loadConfigFile(filePath: string, diagnostics?: Diagnostic[]): TweeTsConfig {
  return readConfig(filePath, 'named', diagnostics);
}

function readConfig(filePath: string, discovery: InputDiscovery, diagnostics: Diagnostic[] | undefined): TweeTsConfig {
  const readDiagnostics: Diagnostic[] = [];
  let raw: string;
  try {
    raw = readUTF8(filePath, readDiagnostics);
  } catch (e) {
    const problem = inputProblem('config', discovery, failureOfError(e), filePath, e);
    throw new TweeTsError(`Cannot read config file ${filePath}: ${problem.reason}`, [], {
      code: 'INPUT_UNAVAILABLE',
      cause: e,
    });
  }

  const config = parseConfig(raw, filePath, readDiagnostics);
  diagnostics?.push(...readDiagnostics);
  return rebaseConfigPaths(config, filePath);
}

/**
 * Parse and validate the text of the config file at `path` (strict JSON, see json-decode.ts). Unknown and
 * repeated keys are added to `diagnostics` as warnings, so a config with a stray key keeps loading.
 */
function parseConfig(raw: string, path: string, diagnostics: Diagnostic[]): TweeTsConfig {
  const parsed = parseJSON(raw);
  if (!parsed.ok) {
    throw new TweeTsError(`Invalid JSON in ${path}: ${parsed.error.message}`, [], { code: 'INVALID_OPTIONS' });
  }
  const decoded = decodeConfig(parsed.value);
  if (decoded.errors.length > 0) {
    throw new TweeTsError(`Invalid config in ${path}:\n  ${decoded.errors.join('\n  ')}`, [], {
      code: 'INVALID_OPTIONS',
    });
  }
  diagnostics.push(
    ...decoded.warnings.map((message): Diagnostic => ({
      level: 'warning',
      message: `${path}: ${message}`,
      file: path,
    })),
  );
  return decoded.config;
}

/** A config value as JSON: what `JSON.parse` would give back, a value JSON can't hold read as `null`. */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return new JsonObject(Object.entries(value).map(([key, item]) => ({ key, value: toJsonValue(item) })));
  }
  return null;
}

/** The warning for a key the config does not define, with the key it may stand for. */
function unknownKeyWarning(key: string): string {
  const suggestion = CONFIG_KEYS.find((known) => foldKey(known) === foldKey(key));
  const hint = suggestion === undefined ? '' : ` (did you mean "${suggestion}"?)`;
  return `Unknown config key "${key}"${hint}; it is ignored.`;
}

/** A config read from JSON: what it sets, the errors that make it unusable, and the warnings. */
interface DecodedConfig {
  readonly config: TweeTsConfig;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Reads a config with the decoders of json-decode.ts, every key checked as CONFIG_SPEC says. */
function decodeConfig(value: JsonValue): DecodedConfig {
  const issues: DecodeIssue[] = [];
  const warnings: string[] = [];
  const config: TweeTsConfig = {};
  // `specs` is CONFIG_SPEC, typed over the one key so that its decoder has that key's type.
  const reader = <K extends keyof TweeTsConfig>(
    key: K,
    specs: { readonly [P in K]: ConfigField<NonNullable<TweeTsConfig[P]>> },
  ): FieldReader =>
    field(specs[key].decoder(`"${key}"`), (v) => {
      config[key] = v;
    });
  const fields: Record<string, FieldReader> = ownRecord([
    // `$schema` is only checked: it names the schema for editors and sets nothing.
    [SCHEMA_KEY, field(stringField('').decoder(`"${SCHEMA_KEY}"`), () => undefined)],
    ...CONFIG_KEYS.map((key): [string, FieldReader] => [key, reader(key, CONFIG_SPEC)]),
  ]);
  const isObject = readObject(value, [], issues, {
    fields,
    keys: 'exact',
    unknown: (member) => warnings.push(unknownKeyWarning(member.key)),
  });
  if (!isObject) return { config: {}, errors: ['Config must be a JSON object.'], warnings: [] };
  for (const issue of issues) {
    if (issue.kind === 'duplicate-key') {
      warnings.push(`${formatJsonPath(issue.path)} is given more than once; the last one is used.`);
    }
  }
  return { config, errors: issues.filter((i) => i.kind === 'type').map((i) => i.message), warnings };
}

/**
 * Validate a config object. Returns an array of error strings (empty = valid).
 * Keys the config does not define are not errors; {@link unknownConfigKeyWarnings} reports them.
 */
export function validateConfig(data: unknown): string[] {
  return [...decodeConfig(toJsonValue(data)).errors];
}

/**
 * Warnings for the keys of a config object that the config does not define (the JSON schema's
 * `additionalProperties: false`), other than `$schema`. twee-ts ignores such a key, so a misspelt one would
 * otherwise leave its option at the default without a word. A key that differs from a defined one only in
 * letter case, `-` or `_` (`formatID`, `output-mode`) gets a suggestion. Returns `[]` for anything that is not
 * an object, which {@link validateConfig} reports.
 */
export function unknownConfigKeyWarnings(data: unknown): string[] {
  return [...decodeConfig(toJsonValue(data)).warnings];
}

/** The JSON Schema of one field. */
function fieldSchema(spec: FieldSpec): Record<string, unknown> {
  const base = (() => {
    switch (spec.kind) {
      case 'string':
        return { type: 'string', ...(spec.minLength === undefined ? {} : { minLength: spec.minLength }) };
      case 'boolean':
        return { type: 'boolean' };
      case 'number':
        return { type: 'number', minimum: spec.minimum };
      case 'enum':
        return { type: 'string', enum: [...spec.values] };
      case 'string-array':
        return { type: 'array', items: { type: 'string', minLength: 1 } };
      case 'tag-map':
        return {
          type: 'object',
          propertyNames: { pattern: TAG_PATTERN },
          additionalProperties: { type: 'string', pattern: TAG_PATTERN },
        };
      default: {
        const _exhaustive: never = spec;
        throw new Error(`unhandled config field kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  })();
  return { ...base, ...('default' in spec ? { default: spec.default } : {}), description: spec.description };
}

/** The JSON Schema for config files, as schemas/twee-ts.config.schema.json holds it. */
export function configJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://unpkg.com/@rohal12/twee-ts/schemas/twee-ts.config.schema.json',
    title: 'twee-ts Configuration',
    description: 'Configuration file for twee-ts, a TypeScript Twee-to-HTML compiler.',
    type: 'object',
    additionalProperties: false,
    properties: {
      [SCHEMA_KEY]: { type: 'string', description: 'JSON Schema reference for editor support.' },
      ...Object.fromEntries(CONFIG_KEYS.map((key) => [key, fieldSchema(CONFIG_SPEC[key].spec)])),
    },
  };
}

/** A glob relative to the folder `dir` (as reported, relative to the working directory or absolute). */
function rebaseGlob(dir: string, glob: string): string {
  const pattern = glob.replace(/^\.[/\\]/, '');
  if (isAbsolute(pattern)) return pattern;
  return `${dir.replace(/\\/g, '/').replace(/\/$/, '')}/${pattern}`;
}

/**
 * The config with the paths in it, which are relative to the folder holding the config file at
 * `configPath`, made relative to the working directory (or absolute, when that folder is outside it).
 * Absolute paths, `"-"` (standard output) and an empty `headFile` stay as they are. A config file in the
 * working directory is returned unchanged.
 */
export function rebaseConfigPaths(config: TweeTsConfig, configPath: string): TweeTsConfig {
  const folder = identify(dirname(configPath));
  if (folder.key === identify('.').key) return config;
  const dir = folder.display;
  const rebase = (path: string): string => (path === '' || path === '-' || isAbsolute(path) ? path : join(dir, path));
  const { sources, exclude, output, modules, headFile, formatPaths } = config;
  return {
    ...config,
    ...(sources === undefined ? {} : { sources: sources.map(rebase) }),
    ...(exclude === undefined ? {} : { exclude: exclude.map((glob) => rebaseGlob(dir, glob)) }),
    ...(output === undefined ? {} : { output: rebase(output) }),
    ...(modules === undefined ? {} : { modules: modules.map(rebase) }),
    ...(headFile === undefined ? {} : { headFile: rebase(headFile) }),
    ...(formatPaths === undefined ? {} : { formatPaths: formatPaths.map(rebase) }),
  };
}

/** Return a default config JSON string for --init scaffolding. */
export function scaffoldConfig(): string {
  const config = {
    $schema: 'https://unpkg.com/@rohal12/twee-ts/schemas/twee-ts.config.schema.json',
    sources: ['src/'],
    output: 'story.html',
  };
  return JSON.stringify(config, null, 2) + '\n';
}

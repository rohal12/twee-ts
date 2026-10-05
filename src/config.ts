/**
 * Config file loading and validation for twee-ts.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic, TweeTsConfig, OutputMode, WordCountMethod } from './types.js';
import { readUTF8 } from './util.js';

export const CONFIG_FILENAME = 'twee-ts.config.json';

const VALID_OUTPUT_MODES: OutputMode[] = ['html', 'twee3', 'twee1', 'twine2-archive', 'twine1-archive', 'json'];
const VALID_WORD_COUNT_METHODS: WordCountMethod[] = ['tweego', 'whitespace'];

/** One entry per {@link TweeTsConfig} key: the compiler rejects a missing or an extra key here. */
const CONFIG_KEY_SET: Readonly<Record<keyof TweeTsConfig, true>> = {
  sources: true,
  exclude: true,
  output: true,
  outputMode: true,
  formatId: true,
  startPassage: true,
  formatPaths: true,
  formatIndices: true,
  formatUrls: true,
  useTweegoPath: true,
  modules: true,
  headFile: true,
  trim: true,
  twee2Compat: true,
  testMode: true,
  noRemote: true,
  formatFetchTimeout: true,
  tagAliases: true,
  sourceInfo: true,
  wordCountMethod: true,
};

/** The keys a config file may hold besides `$schema`; the JSON schema's `properties` list the same keys. */
export const CONFIG_KEYS: readonly (keyof TweeTsConfig)[] = Object.keys(CONFIG_KEY_SET) as (keyof TweeTsConfig)[];

/** The key that only references the JSON schema, for editors. */
const SCHEMA_KEY = '$schema';

/** A key folded so that spellings differing only in letter case, `-` or `_` compare equal. */
const foldKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, '');

/**
 * Load a config file from the given directory (default: cwd). Returns null if not found.
 *
 * @param diagnostics Receives warnings that do not stop the config from loading: keys the config does not
 *   define, and a file that is not valid UTF-8 (it is read as Windows-1252).
 * @throws When the file exists but cannot be read, is not valid JSON or fails {@link validateConfig}.
 */
export function loadConfig(dir?: string, diagnostics?: Diagnostic[]): TweeTsConfig | null {
  const base = dir ?? process.cwd();
  const configPath = join(base, CONFIG_FILENAME);

  if (!existsSync(configPath)) return null;

  return loadConfigFile(configPath, diagnostics);
}

/**
 * Load a config from a specific file path.
 *
 * @param diagnostics Receives warnings that do not stop the config from loading: keys the config does not
 *   define, and a file that is not valid UTF-8 (it is read as Windows-1252).
 * @throws When the file cannot be read, is not valid JSON or fails {@link validateConfig}.
 */
export function loadConfigFile(filePath: string, diagnostics?: Diagnostic[]): TweeTsConfig {
  const readDiagnostics: Diagnostic[] = [];
  let raw: string;
  try {
    raw = readUTF8(filePath, readDiagnostics);
  } catch (e) {
    throw new Error(`Cannot read config file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const config = parseConfig(raw, filePath, readDiagnostics);
  diagnostics?.push(...readDiagnostics);
  return config;
}

/**
 * Parse and validate the text of the config file at `path`. Unknown keys are added to `diagnostics` as
 * warnings, so a config with a stray key keeps loading.
 */
function parseConfig(raw: string, path: string, diagnostics: Diagnostic[]): TweeTsConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const errors = validateConfig(data);
  if (errors.length > 0) {
    throw new Error(`Invalid config in ${path}:\n  ${errors.join('\n  ')}`);
  }

  diagnostics.push(
    ...unknownConfigKeyWarnings(data).map((message): Diagnostic => ({
      level: 'warning',
      message: `${path}: ${message}`,
      file: path,
    })),
  );
  return data as TweeTsConfig;
}

/**
 * Validate a config object. Returns an array of error strings (empty = valid).
 * Keys the config does not define are not errors; {@link unknownConfigKeyWarnings} reports them.
 */
export function validateConfig(data: unknown): string[] {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    errors.push('Config must be a JSON object.');
    return errors;
  }

  const obj = data as Record<string, unknown>;

  // String fields
  for (const key of ['output', 'formatId', 'startPassage', 'headFile'] as const) {
    if (key in obj && typeof obj[key] !== 'string') {
      errors.push(`"${key}" must be a string.`);
    }
  }

  // Boolean fields
  for (const key of ['useTweegoPath', 'trim', 'twee2Compat', 'testMode', 'noRemote', 'sourceInfo'] as const) {
    if (key in obj && typeof obj[key] !== 'boolean') {
      errors.push(`"${key}" must be a boolean.`);
    }
  }

  // String array fields
  for (const key of ['sources', 'exclude', 'formatPaths', 'formatIndices', 'formatUrls', 'modules'] as const) {
    if (key in obj) {
      if (!Array.isArray(obj[key])) {
        errors.push(`"${key}" must be an array.`);
      } else if (!(obj[key] as unknown[]).every((v) => typeof v === 'string')) {
        errors.push(`"${key}" must be an array of strings.`);
      }
    }
  }

  // Non-negative number fields
  if ('formatFetchTimeout' in obj) {
    const timeout = obj['formatFetchTimeout'];
    if (typeof timeout !== 'number' || !(timeout >= 0)) {
      errors.push('"formatFetchTimeout" must be a number of milliseconds, 0 or more.');
    }
  }

  // tagAliases validation
  if ('tagAliases' in obj) {
    if (typeof obj['tagAliases'] !== 'object' || obj['tagAliases'] === null || Array.isArray(obj['tagAliases'])) {
      errors.push('"tagAliases" must be an object.');
    } else {
      const aliases = obj['tagAliases'] as Record<string, unknown>;
      for (const [key, val] of Object.entries(aliases)) {
        if (typeof val !== 'string') {
          errors.push(`"tagAliases.${key}" must be a string.`);
        }
      }
    }
  }

  // OutputMode validation
  if ('outputMode' in obj) {
    if (typeof obj['outputMode'] !== 'string' || !VALID_OUTPUT_MODES.includes(obj['outputMode'] as OutputMode)) {
      errors.push(`"outputMode" must be one of: ${VALID_OUTPUT_MODES.join(', ')}.`);
    }
  }

  // WordCountMethod validation
  if ('wordCountMethod' in obj) {
    if (
      typeof obj['wordCountMethod'] !== 'string' ||
      !VALID_WORD_COUNT_METHODS.includes(obj['wordCountMethod'] as WordCountMethod)
    ) {
      errors.push(`"wordCountMethod" must be one of: ${VALID_WORD_COUNT_METHODS.join(', ')}.`);
    }
  }

  return errors;
}

/**
 * Warnings for the keys of a config object that the config does not define (the JSON schema's
 * `additionalProperties: false`), other than `$schema`. twee-ts ignores such a key, so a misspelt one would
 * otherwise leave its option at the default without a word. A key that differs from a defined one only in
 * letter case, `-` or `_` (`formatID`, `output-mode`) gets a suggestion. Returns `[]` for anything that is not
 * an object, which {@link validateConfig} reports.
 */
export function unknownConfigKeyWarnings(data: unknown): string[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  return Object.keys(data)
    .filter((key) => key !== SCHEMA_KEY && !Object.hasOwn(CONFIG_KEY_SET, key))
    .map((key) => {
      const suggestion = CONFIG_KEYS.find((known) => foldKey(known) === foldKey(key));
      const hint = suggestion === undefined ? '' : ` (did you mean "${suggestion}"?)`;
      return `Unknown config key "${key}"${hint}; it is ignored.`;
    });
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

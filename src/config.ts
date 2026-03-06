/**
 * Config file loading and validation for twee-ts.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TweeTsConfig, OutputMode } from './types.js';

export const CONFIG_FILENAME = 'twee-ts.config.json';

const VALID_OUTPUT_MODES: OutputMode[] = ['html', 'twee3', 'twee1', 'twine2-archive', 'twine1-archive', 'json'];

/** Load a config file from the given directory (default: cwd). Returns null if not found. */
export function loadConfig(dir?: string): TweeTsConfig | null {
  const base = dir ?? process.cwd();
  const configPath = join(base, CONFIG_FILENAME);

  if (!existsSync(configPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const errors = validateConfig(data);
  if (errors.length > 0) {
    throw new Error(`Invalid config in ${configPath}:\n  ${errors.join('\n  ')}`);
  }

  return data as TweeTsConfig;
}

/** Load a config from a specific file path. */
export function loadConfigFile(filePath: string): TweeTsConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(`Cannot read config file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const errors = validateConfig(data);
  if (errors.length > 0) {
    throw new Error(`Invalid config in ${filePath}:\n  ${errors.join('\n  ')}`);
  }

  return data as TweeTsConfig;
}

/** Validate a config object. Returns an array of error strings (empty = valid). */
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
  for (const key of ['sources', 'formatPaths', 'formatIndices', 'formatUrls', 'modules'] as const) {
    if (key in obj) {
      if (!Array.isArray(obj[key])) {
        errors.push(`"${key}" must be an array.`);
      } else if (!(obj[key] as unknown[]).every((v) => typeof v === 'string')) {
        errors.push(`"${key}" must be an array of strings.`);
      }
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

  return errors;
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

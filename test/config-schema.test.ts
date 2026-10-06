/**
 * The config validator and the shipped JSON Schema are one table (CONFIG_SPEC): the schema file must be
 * what configJsonSchema() renders, and a differential test checks that validateConfig() accepts exactly
 * the configs an independent JSON Schema check of that file accepts. The one deliberate difference: a key
 * the schema doesn't define (`additionalProperties: false`) is a warning, not an error, so the check
 * below drops unknown keys before comparing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CONFIG_KEYS,
  CONFIG_SPEC,
  configJsonSchema,
  loadConfig,
  loadConfigFile,
  rebaseConfigPaths,
  tagAliasProblem,
  validateConfig,
} from '../src/config.js';
import { identify } from '../src/path-identity.js';
import { parseJsonObject } from './helpers/json.js';

const SCHEMA_PATH = resolve(import.meta.dirname, '..', 'schemas', 'twee-ts.config.schema.json');
const schema = parseJsonObject(readFileSync(SCHEMA_PATH, 'utf-8'));

it('the shipped schema is the one the config table renders', () => {
  // On a mismatch, regenerate it: JSON.stringify(configJsonSchema(), null, 2), then prettier.
  expect(schema).toEqual(configJsonSchema());
});

/** A JSON Schema (draft-07) check of the keywords the config schema uses; independent of src/config.ts. */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaErrors(node: unknown, value: unknown, at = '$'): string[] {
  if (!isObject(node)) return [];
  const s = node;
  const errors: string[] = [];
  const type = s['type'];
  const typeOk =
    type === undefined ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'number' && typeof value === 'number') ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value));
  if (!typeOk) return [`${at}: not ${JSON.stringify(type)}`];
  if (Array.isArray(s['enum']) && !s['enum'].includes(value)) errors.push(`${at}: not in enum`);
  if (typeof s['minimum'] === 'number' && typeof value === 'number' && value < s['minimum'])
    errors.push(`${at}: < min`);
  if (typeof s['minLength'] === 'number' && typeof value === 'string' && Array.from(value).length < s['minLength']) {
    errors.push(`${at}: too short`);
  }
  if (typeof s['pattern'] === 'string' && typeof value === 'string' && !new RegExp(s['pattern'], 'u').test(value)) {
    errors.push(`${at}: pattern`);
  }
  if (Array.isArray(value) && s['items'] !== undefined) {
    value.forEach((item, i) => errors.push(...schemaErrors(s['items'], item, `${at}[${i}]`)));
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const properties = isObject(s['properties']) ? s['properties'] : {};
    for (const [key, item] of Object.entries(value)) {
      if (s['propertyNames'] !== undefined)
        errors.push(
          ...schemaErrors(
            { type: 'string', ...(isObject(s['propertyNames']) ? s['propertyNames'] : {}) },
            key,
            `${at}~${key}`,
          ),
        );
      if (Object.hasOwn(properties, key)) errors.push(...schemaErrors(properties[key], item, `${at}.${key}`));
      else if (s['additionalProperties'] === false) errors.push(`${at}.${key}: not allowed`);
      else if (typeof s['additionalProperties'] === 'object') {
        errors.push(...schemaErrors(s['additionalProperties'], item, `${at}.${key}`));
      }
    }
  }
  return errors;
}

/** A value for a config key: usually of the right shape, often subtly wrong. */
const anyValue = fc.oneof(
  fc.string(),
  fc.constantFrom('', '-', 'html', 'json', 'tweego', 'whitespace', 'a b', ' ', '\t'),
  fc.boolean(),
  fc.double({ noNaN: true }),
  fc.integer({ min: -5, max: 5 }),
  fc.constant(null),
  fc.array(fc.oneof(fc.string(), fc.constant(''), fc.integer()), { maxLength: 3 }),
  fc.dictionary(
    fc.oneof(fc.string(), fc.constantFrom('__proto__', 'lib', 'a b', '')),
    fc.oneof(fc.string(), fc.constantFrom('script', '', 'a b'), fc.integer()),
    { maxKeys: 3 },
  ),
);

const anyConfig = fc.dictionary(fc.constantFrom(...CONFIG_KEYS, '$schema', 'unknownKey'), anyValue, { maxKeys: 6 });

describe('validateConfig() accepts exactly what the schema accepts', () => {
  it('for generated configs', () => {
    fc.assert(
      fc.property(anyConfig, (config) => {
        const known = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'unknownKey'));
        expect(validateConfig(known).length === 0).toBe(schemaErrors(schema, known).length === 0);
      }),
      { numRuns: 2000 },
    );
  });

  it.each([
    [{ output: '' }, false],
    [{ output: '-' }, true],
    [{ headFile: '' }, true],
    [{ sources: [''] }, false],
    [{ exclude: ['**/*.png'] }, true],
    [{ formatFetchTimeout: -1 }, false],
    [{ formatFetchTimeout: 0 }, true],
    [{ tagAliases: { lib: '' } }, false],
    [{ tagAliases: { '': 'script' } }, false],
    [{ tagAliases: { 'my lib': 'script' } }, false],
    [{ tagAliases: { lib: 'a b' } }, false],
    [{ tagAliases: JSON.parse('{"__proto__":"script"}') }, true],
    [{ $schema: 42 }, false],
    [{ outputMode: 'HTML' }, false],
  ])('%j → valid %s', (config, valid) => {
    expect(validateConfig(config).length === 0).toBe(valid);
    expect(schemaErrors(schema, config).length === 0).toBe(valid);
  });
});

it('names the reason for a bad tag alias', () => {
  expect(tagAliasProblem('lib', 'script')).toBeUndefined();
  expect(tagAliasProblem('', 'script')).toBe('the alias "" must be a non-empty tag name without whitespace');
  expect(tagAliasProblem('lib', 'a\nb')).toMatch(/the target "a\nb" of alias "lib"/);
  expect(validateConfig({ tagAliases: { lib: 'a b' } })).toEqual([
    '"tagAliases": the target "a b" of alias "lib" must be a non-empty tag name without whitespace.',
  ]);
});

describe('paths in a config file are relative to its folder (FS-11)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-config-paths-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rebases every path key and every exclude glob, keeping absolute paths, "-" and an empty headFile', () => {
    const at = identify(dir).display;
    const config = rebaseConfigPaths(
      {
        sources: ['src', '/abs/src'],
        exclude: ['src/**/*.png', './art/**', '/abs/**'],
        output: 'out.html',
        modules: ['m.js'],
        headFile: '',
        formatPaths: ['formats'],
        formatUrls: ['https://example.com/format.js'],
        outputMode: 'json',
      },
      join(dir, 'twee-ts.config.json'),
    );
    const posixAt = at.replace(/\\/g, '/');
    expect(config).toEqual({
      sources: [join(at, 'src'), '/abs/src'],
      exclude: [`${posixAt}/src/**/*.png`, `${posixAt}/art/**`, '/abs/**'],
      output: join(at, 'out.html'),
      modules: [join(at, 'm.js')],
      headFile: '',
      formatPaths: [join(at, 'formats')],
      formatUrls: ['https://example.com/format.js'],
      outputMode: 'json',
    });
    expect(rebaseConfigPaths({ output: '-' }, join(dir, 'c.json'))).toEqual({ output: '-' });
  });

  it('leaves a config in the working directory as it is', () => {
    const config = { sources: ['src'], output: 'out.html' };
    expect(rebaseConfigPaths(config, 'twee-ts.config.json')).toBe(config);
  });

  it('documents each rebased key in the schema as relative to the config file', () => {
    const rebased = ['sources', 'exclude', 'output', 'modules', 'headFile', 'formatPaths'] as const;
    for (const key of CONFIG_KEYS) {
      expect(CONFIG_SPEC[key].spec.description.includes('relative to the config file'), key).toBe(
        new Set<string>(rebased).has(key),
      );
    }
  });

  it('loads both ways with the paths rebased', () => {
    mkdirSync(join(dir, 'proj'));
    writeFileSync(join(dir, 'proj', 'twee-ts.config.json'), JSON.stringify({ sources: ['src'], output: 'out.tw' }));
    const at = identify(join(dir, 'proj')).display;
    const expected = { sources: [join(at, 'src')], output: join(at, 'out.tw') };
    expect(loadConfig(join(dir, 'proj'))).toEqual(expected);
    expect(loadConfigFile(join(dir, 'proj', 'twee-ts.config.json'))).toEqual(expected);
  });
});

describe('defaults the schema states', () => {
  // Left out, formatId and startPassage leave the choice to StoryData, so the schema gives them no default:
  // an editor that fills in defaults would otherwise override StoryData's format or start passage.
  it.each(['formatId', 'startPassage'] as const)('gives %s no default', (key) => {
    expect('default' in CONFIG_SPEC[key].spec).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identify } from '../src/path-identity.js';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import type { Diagnostic } from '../src/types.js';
import {
  validateConfig,
  loadConfig,
  loadConfigFile,
  scaffoldConfig,
  unknownConfigKeyWarnings,
  CONFIG_FILENAME,
  CONFIG_KEYS,
} from '../src/config.js';
import { parseJsonObject } from './helpers/json.js';

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    const errors = validateConfig({
      sources: ['src/'],
      output: 'story.html',
      outputMode: 'html',
      formatId: 'sugarcube-2',
      startPassage: 'Start',
      formatPaths: ['/path/to/formats'],
      formatIndices: ['https://example.com/index.json'],
      formatUrls: ['https://example.com/format.js'],
      useTweegoPath: true,
      modules: ['module.js'],
      headFile: 'head.html',
      trim: true,
      twee2Compat: false,
      testMode: false,
      noRemote: false,
    });
    expect(errors).toEqual([]);
  });

  it('accepts an empty object', () => {
    const errors = validateConfig({});
    expect(errors).toEqual([]);
  });

  it('rejects non-object', () => {
    expect(validateConfig('string')).toContain('Config must be a JSON object.');
    expect(validateConfig(null)).toContain('Config must be a JSON object.');
    expect(validateConfig([])).toContain('Config must be a JSON object.');
  });

  it('rejects wrong type for string fields', () => {
    const errors = validateConfig({ output: 42 });
    expect(errors).toContain('"output" must be a string.');
  });

  it('rejects wrong type for boolean fields', () => {
    const errors = validateConfig({ trim: 'yes' });
    expect(errors).toContain('"trim" must be a boolean.');
  });

  it('rejects wrong type for array fields', () => {
    const errors = validateConfig({ sources: 'not-array' });
    expect(errors).toContain('"sources" must be an array.');
  });

  it('rejects non-string elements in array fields', () => {
    const errors = validateConfig({ sources: ['ok', 42] });
    expect(errors).toContain('"sources" must be an array of strings.');
  });

  it('rejects an invalid or non-string wordCountMethod', () => {
    for (const value of ['syllables', 3, null]) {
      const errors = validateConfig({ wordCountMethod: value });
      expect(errors).toEqual(['"wordCountMethod" must be one of: tweego, whitespace.']);
    }
    for (const value of ['tweego', 'whitespace']) {
      expect(validateConfig({ wordCountMethod: value })).toEqual([]);
    }
  });

  it('rejects a non-string outputMode', () => {
    expect(validateConfig({ outputMode: 7 })).toHaveLength(1);
  });

  it('rejects invalid outputMode', () => {
    const errors = validateConfig({ outputMode: 'invalid' });
    expect(errors.some((e) => e.includes('"outputMode"'))).toBe(true);
  });

  it('accepts valid tagAliases', () => {
    const errors = validateConfig({ tagAliases: { library: 'script', theme: 'stylesheet' } });
    expect(errors).toEqual([]);
  });

  it('rejects non-object tagAliases', () => {
    expect(validateConfig({ tagAliases: 'bad' })).toContain('"tagAliases" must be an object.');
    expect(validateConfig({ tagAliases: ['a'] })).toContain('"tagAliases" must be an object.');
    expect(validateConfig({ tagAliases: null })).toContain('"tagAliases" must be an object.');
  });

  it('rejects non-string values in tagAliases', () => {
    const errors = validateConfig({ tagAliases: { library: 42 } });
    expect(errors).toContain('"tagAliases.library" must be a string.');
  });

  it('rejects wrong type for sourceInfo', () => {
    const errors = validateConfig({ sourceInfo: 'not-a-bool' });
    expect(errors).toContain('"sourceInfo" must be a boolean.');
  });

  it('accepts a formatFetchTimeout of 0 or more milliseconds', () => {
    expect(validateConfig({ formatFetchTimeout: 60000 })).toEqual([]);
    expect(validateConfig({ formatFetchTimeout: 0 })).toEqual([]);
  });

  it('rejects a formatFetchTimeout that is not a number of 0 or more', () => {
    const message = '"formatFetchTimeout" must be a number of milliseconds, 0 or more.';
    expect(validateConfig({ formatFetchTimeout: '30s' })).toContain(message);
    expect(validateConfig({ formatFetchTimeout: -1 })).toContain(message);
    expect(validateConfig({ formatFetchTimeout: null })).toContain(message);
  });

  it('accepts exclude globs', () => {
    expect(validateConfig({ sources: ['src/'], exclude: ['**/*.png', 'src/art/**'] })).toEqual([]);
  });

  it('rejects exclude that is not an array of strings', () => {
    expect(validateConfig({ exclude: '**/*.png' })).toContain('"exclude" must be an array.');
    expect(validateConfig({ exclude: ['**/*.png', 42] })).toContain('"exclude" must be an array of strings.');
  });

  it('accepts valid outputMode values', () => {
    for (const mode of ['html', 'twee3', 'twee1', 'twine2-archive', 'twine1-archive', 'json']) {
      const errors = validateConfig({ outputMode: mode });
      expect(errors).toEqual([]);
    }
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no config file exists', () => {
    const config = loadConfig(dir);
    expect(config).toBeNull();
  });

  it('loads a valid config file', () => {
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ sources: ['src/'] }));
    const config = loadConfig(dir);
    // Paths in a config file are relative to its folder (FS-11).
    expect(config).toEqual({ sources: [join(identify(dir).display, 'src/')] });
  });

  it('throws on invalid JSON', () => {
    writeFileSync(join(dir, CONFIG_FILENAME), '{bad json');
    expect(() => loadConfig(dir)).toThrow('Invalid JSON');
  });

  it('throws on invalid config structure', () => {
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ sources: 42 }));
    expect(() => loadConfig(dir)).toThrow('Invalid config');
  });
});

describe('loading a config file with a BOM, CRLF line endings or another encoding', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A path relative to the config's folder, as loading rebases it. */
  const inDir = (path: string): string => join(identify(dir).display, path);

  // UTF-8 with a BOM and CRLF, as Windows PowerShell 5 `Set-Content -Encoding UTF8` writes it.
  const WITH_BOM = '\uFEFF{\r\n  "sources": ["src/"],\r\n  "output": "story.html"\r\n}\r\n';

  it('loads through loadConfig()', () => {
    writeFileSync(join(dir, CONFIG_FILENAME), WITH_BOM);
    expect(loadConfig(dir)).toEqual({ sources: [inDir('src/')], output: inDir('story.html') });
  });

  it('looks in the working directory when no directory is given', () => {
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ sources: ['src/'] }));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      expect(loadConfig()).toEqual({ sources: ['src/'] });
    } finally {
      cwd.mockRestore();
    }
  });

  it('throws from loadConfigFile() naming the file when it cannot be read', () => {
    const file = join(dir, 'missing.json');
    expect(() => loadConfigFile(file)).toThrow(`Cannot read config file ${file}:`);
  });

  it('throws from loadConfig() naming the file when it exists but cannot be read', () => {
    const file = join(dir, CONFIG_FILENAME);
    mkdirSync(file);
    expect(() => loadConfig(dir)).toThrow(`Cannot read config file ${file}:`);
  });

  it('loads through loadConfigFile()', () => {
    const file = join(dir, 'custom.json');
    writeFileSync(file, WITH_BOM);
    expect(loadConfigFile(file)).toEqual({ sources: [inDir('src/')], output: inDir('story.html') });
  });

  it('reads a Windows-1252 config as Windows-1252 and warns', () => {
    const file = join(dir, CONFIG_FILENAME);
    writeFileSync(file, Buffer.from('{"output": "café.html"}', 'latin1'));
    const diagnostics: Diagnostic[] = [];
    expect(loadConfig(dir, diagnostics)).toEqual({ output: inDir('café.html') });
    expect(diagnostics).toEqual([
      { level: 'warning', message: `read ${file}: Invalid UTF-8; assuming charset is windows-1252.`, file },
    ]);
  });
});

describe('unknown config keys', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('are not errors, so a config with a stray key keeps loading', () => {
    expect(validateConfig({ sources: ['src/'], formatID: 'harlowe-3', notes: 'x' })).toEqual([]);
  });

  it('suggest the key that differs only in letter case', () => {
    expect(unknownConfigKeyWarnings({ formatID: 'harlowe-3', OutputMode: 'twee3' })).toEqual([
      'Unknown config key "formatID" (did you mean "formatId"?); it is ignored.',
      'Unknown config key "OutputMode" (did you mean "outputMode"?); it is ignored.',
    ]);
  });

  it('suggest the key a CLI-style spelling stands for', () => {
    expect(unknownConfigKeyWarnings({ 'word-count-method': 'whitespace', start_passage: 'Begin' })).toEqual([
      'Unknown config key "word-count-method" (did you mean "wordCountMethod"?); it is ignored.',
      'Unknown config key "start_passage" (did you mean "startPassage"?); it is ignored.',
    ]);
  });

  it('report a key with no near match without a suggestion', () => {
    expect(unknownConfigKeyWarnings({ notes: 'x' })).toEqual(['Unknown config key "notes"; it is ignored.']);
  });

  it('leave out $schema and every documented key', () => {
    expect(
      unknownConfigKeyWarnings({
        $schema: 'https://unpkg.com/@rohal12/twee-ts/schemas/twee-ts.config.schema.json',
        ...Object.fromEntries(CONFIG_KEYS.map((key) => [key, undefined])),
      }),
    ).toEqual([]);
  });

  it('return nothing for a value that is not an object, which validateConfig() reports', () => {
    expect(unknownConfigKeyWarnings(['formatID'])).toEqual([]);
    expect(unknownConfigKeyWarnings(null)).toEqual([]);
  });

  it('reach the diagnostics of loadConfig() and loadConfigFile(), naming the file', () => {
    const file = join(dir, CONFIG_FILENAME);
    writeFileSync(file, '{"sources":["src/"],"formatID":"harlowe-3"}');
    const expected: Diagnostic = {
      level: 'warning',
      message: `${file}: Unknown config key "formatID" (did you mean "formatId"?); it is ignored.`,
      file,
    };

    // The unknown key is left out of the config returned.
    const sources = [join(identify(dir).display, 'src/')];
    const fromDir: Diagnostic[] = [];
    expect(loadConfig(dir, fromDir)).toEqual({ sources });
    expect(fromDir).toEqual([expected]);

    const fromFile: Diagnostic[] = [];
    expect(loadConfigFile(file, fromFile)).toEqual({ sources });
    expect(fromFile).toEqual([expected]);
  });
});

describe('scaffoldConfig', () => {
  it('returns valid JSON with $schema, sources, and output', () => {
    const json = scaffoldConfig();
    const parsed = parseJsonObject(json);
    expect(parsed['$schema']).toBe('https://unpkg.com/@rohal12/twee-ts/schemas/twee-ts.config.schema.json');
    expect(parsed['sources']).toEqual(['src/']);
    expect(parsed['output']).toBe('story.html');
  });

  it('names the schema of the installed release, so an editor checks the keys it reads (#250)', () => {
    for (const version of ['2.0.0', '2.0.0-rc.1']) {
      expect(parseJsonObject(scaffoldConfig(version))['$schema'], version).toBe(
        `https://unpkg.com/@rohal12/twee-ts@${version}/schemas/twee-ts.config.schema.json`,
      );
    }
    for (const version of ['0.0.0-development', '', '2.0']) {
      expect(parseJsonObject(scaffoldConfig(version))['$schema'], version).toBe(
        'https://unpkg.com/@rohal12/twee-ts/schemas/twee-ts.config.schema.json',
      );
    }
  });
});

describe('JSON Schema', () => {
  it('is valid JSON and covers all TweeTsConfig fields', () => {
    const schemaPath = join(__dirname, '..', 'schemas', 'twee-ts.config.schema.json');
    const schema = parseJsonObject(readFileSync(schemaPath, 'utf-8'));

    expect(schema['type']).toBe('object');

    const expectedFields = [
      'sources',
      'exclude',
      'output',
      'outputMode',
      'formatId',
      'startPassage',
      'formatPaths',
      'formatIndices',
      'formatUrls',
      'useTweegoPath',
      'modules',
      'headFile',
      'trim',
      'twee2Compat',
      'testMode',
      'noRemote',
      'formatFetchTimeout',
      'formatResolutionTimeout',
      'useDefaultFormatIndices',
      'tagAliases',
      'sourceInfo',
    ];

    for (const field of expectedFields) {
      expect(schema['properties']).toHaveProperty(field);
    }
  });

  it('defines exactly the keys the validator knows', () => {
    const schemaPath = join(__dirname, '..', 'schemas', 'twee-ts.config.schema.json');
    const schema = parseJsonObject(readFileSync(schemaPath, 'utf-8'));

    expect(schema['additionalProperties']).toBe(false);
    const properties = schema['properties'];
    expect(properties).toBeTypeOf('object');
    // Checked just above.
    expect(Object.keys(properties as object).sort()).toEqual(['$schema', ...CONFIG_KEYS].sort());
  });

  it('accepts $schema field in config validation', () => {
    const errors = validateConfig({
      $schema: 'https://unpkg.com/@rohal12/twee-ts/schemas/twee-ts.config.schema.json',
      sources: ['src/'],
    });
    expect(errors).toEqual([]);
  });
});

describe('tag alias names follow the Twee whitespace grammar', () => {
  const spaces = [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ];
  const tag = (name: string): { tagAliases: Record<string, string> } => ({ tagAliases: { library: name } });

  it.each(spaces)('rejects U+%s inside, before and after an alias target and key', (unit) => {
    const ch = String.fromCodePoint(unit);
    for (const name of [`a${ch}b`, `${ch}a`, `a${ch}`, ch]) {
      expect(validateConfig(tag(name))).not.toEqual([]);
      expect(validateConfig({ tagAliases: { [name]: 'script' } })).not.toEqual([]);
    }
  });

  it.each(['script', 'a﻿b', 'script﻿', 'né', '日本', '​'])('accepts the single tag %j', (name) => {
    expect(validateConfig(tag(name))).toEqual([]);
    expect(validateConfig({ tagAliases: { [name]: 'script' } })).toEqual([]);
  });

  it('rejects the empty name', () => {
    expect(validateConfig(tag(''))).not.toEqual([]);
  });
});

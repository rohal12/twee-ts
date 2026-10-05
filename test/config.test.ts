import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

const TMP_DIR = join(__dirname, '.tmp-config-test');

function setup() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
}

function teardown() {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

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
  it('returns null when no config file exists', () => {
    setup();
    try {
      const config = loadConfig(TMP_DIR);
      expect(config).toBeNull();
    } finally {
      teardown();
    }
  });

  it('loads a valid config file', () => {
    setup();
    try {
      writeFileSync(join(TMP_DIR, CONFIG_FILENAME), JSON.stringify({ sources: ['src/'] }));
      const config = loadConfig(TMP_DIR);
      expect(config).toEqual({ sources: ['src/'] });
    } finally {
      teardown();
    }
  });

  it('throws on invalid JSON', () => {
    setup();
    try {
      writeFileSync(join(TMP_DIR, CONFIG_FILENAME), '{bad json');
      expect(() => loadConfig(TMP_DIR)).toThrow('Invalid JSON');
    } finally {
      teardown();
    }
  });

  it('throws on invalid config structure', () => {
    setup();
    try {
      writeFileSync(join(TMP_DIR, CONFIG_FILENAME), JSON.stringify({ sources: 42 }));
      expect(() => loadConfig(TMP_DIR)).toThrow('Invalid config');
    } finally {
      teardown();
    }
  });
});

describe('loading a config file with a BOM, CRLF line endings or another encoding', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // UTF-8 with a BOM and CRLF, as Windows PowerShell 5 `Set-Content -Encoding UTF8` writes it.
  const WITH_BOM = '\uFEFF{\r\n  "sources": ["src/"],\r\n  "output": "story.html"\r\n}\r\n';

  it('loads through loadConfig()', () => {
    writeFileSync(join(dir, CONFIG_FILENAME), WITH_BOM);
    expect(loadConfig(dir)).toEqual({ sources: ['src/'], output: 'story.html' });
  });

  it('loads through loadConfigFile()', () => {
    const file = join(dir, 'custom.json');
    writeFileSync(file, WITH_BOM);
    expect(loadConfigFile(file)).toEqual({ sources: ['src/'], output: 'story.html' });
  });

  it('reads a Windows-1252 config as Windows-1252 and warns', () => {
    const file = join(dir, CONFIG_FILENAME);
    writeFileSync(file, Buffer.from('{"output": "café.html"}', 'latin1'));
    const diagnostics: Diagnostic[] = [];
    expect(loadConfig(dir, diagnostics)).toEqual({ output: 'café.html' });
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
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

    const fromDir: Diagnostic[] = [];
    expect(loadConfig(dir, fromDir)).toEqual({ sources: ['src/'], formatID: 'harlowe-3' });
    expect(fromDir).toEqual([expected]);

    const fromFile: Diagnostic[] = [];
    expect(loadConfigFile(file, fromFile)).toEqual({ sources: ['src/'], formatID: 'harlowe-3' });
    expect(fromFile).toEqual([expected]);
  });
});

describe('scaffoldConfig', () => {
  it('returns valid JSON with $schema, sources, and output', () => {
    const json = scaffoldConfig();
    const parsed = JSON.parse(json);
    expect(parsed.$schema).toBe('https://unpkg.com/@rohal12/twee-ts/schemas/twee-ts.config.schema.json');
    expect(parsed.sources).toEqual(['src/']);
    expect(parsed.output).toBe('story.html');
  });
});

describe('JSON Schema', () => {
  it('is valid JSON and covers all TweeTsConfig fields', () => {
    const schemaPath = join(__dirname, '..', 'schemas', 'twee-ts.config.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

    expect(schema.type).toBe('object');

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
      'tagAliases',
      'sourceInfo',
    ];

    for (const field of expectedFields) {
      expect(schema.properties).toHaveProperty(field);
    }
  });

  it('defines exactly the keys the validator knows', () => {
    const schemaPath = join(__dirname, '..', 'schemas', 'twee-ts.config.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(['$schema', ...CONFIG_KEYS].sort());
  });

  it('accepts $schema field in config validation', () => {
    const errors = validateConfig({
      $schema: 'https://unpkg.com/@rohal12/twee-ts/schemas/twee-ts.config.schema.json',
      sources: ['src/'],
    });
    expect(errors).toEqual([]);
  });
});

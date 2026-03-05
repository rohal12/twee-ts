import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { validateConfig, loadConfig, scaffoldConfig, CONFIG_FILENAME } from '../src/config.js';

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

describe('scaffoldConfig', () => {
  it('returns valid JSON with sources and output', () => {
    const json = scaffoldConfig();
    const parsed = JSON.parse(json);
    expect(parsed.sources).toEqual(['src/']);
    expect(parsed.output).toBe('story.html');
  });
});

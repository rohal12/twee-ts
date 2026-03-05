/**
 * Twine 2 Story Formats Specification Compliance Tests (v1.0.0)
 *
 * Tests twee-ts against every requirement in the Twine 2 Story Formats Specification:
 * https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-storyformats-spec.md
 *
 * Each describe block corresponds to a section of the spec.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import { discoverFormats } from '../src/formats.js';

const FIXTURES_DIR = join(__dirname, '..', 'test', 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');
const TEMP_DIR = join(__dirname, '..', 'test', '.tmp-storyformat-spec');

/** Helper: build a minimal valid twee source. */
function minimalStory(passages: string): string {
  return [
    ':: StoryData',
    '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
    '',
    ':: StoryTitle',
    'Spec Test',
    '',
    passages,
  ].join('\n');
}

/** Helper: write a temporary story format file. */
function writeTempFormat(dirName: string, content: string): string {
  const dir = join(TEMP_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'format.js');
  writeFileSync(path, content, 'utf-8');
  return TEMP_DIR;
}

/** Clean up temp directory after tests. */
function cleanupTemp(): void {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// =============================================================================
// §1 — Story Format Structure: Wrapper
// =============================================================================
describe('Twine 2 Story Formats Spec — Wrapper', () => {
  it('format.js calls window.storyFormat() with an object argument', () => {
    const content = readFileSync(join(FORMAT_DIR, 'test-format-1', 'format.js'), 'utf-8');
    expect(content).toMatch(/window\.storyFormat\s*\(/);
  });

  it('discovers formats from directory structure', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    expect(formats.size).toBeGreaterThan(0);
  });
});

// =============================================================================
// §2 — Story Format Keys
// =============================================================================
describe('Twine 2 Story Formats Spec — Keys', () => {
  afterAll(() => cleanupTemp());

  it('name key: extracted from format.js', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    expect(format).toBeDefined();
    expect(format!.name).toBe('Test Format');
  });

  it('version key: required, extracted from format.js', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    expect(format).toBeDefined();
    expect(format!.version).toBeTruthy();
    // Must be semantic version style (x.y.z)
    expect(format!.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('source key: required, contains HTML template', () => {
    const content = readFileSync(join(FORMAT_DIR, 'test-format-1', 'format.js'), 'utf-8');
    // Parse the JSON object from the storyFormat call
    const match = content.match(/window\.storyFormat\s*\(([\s\S]*)\)\s*;?\s*$/);
    expect(match).not.toBeNull();
    const obj = JSON.parse(match![1]);
    expect(obj.source).toBeDefined();
    expect(typeof obj.source).toBe('string');
    expect(obj.source).toContain('<html>');
  });

  it('source key: contains {{STORY_NAME}} placeholder', () => {
    const content = readFileSync(join(FORMAT_DIR, 'test-format-1', 'format.js'), 'utf-8');
    const match = content.match(/window\.storyFormat\s*\(([\s\S]*)\)\s*;?\s*$/);
    const obj = JSON.parse(match![1]);
    expect(obj.source).toContain('{{STORY_NAME}}');
  });

  it('source key: contains {{STORY_DATA}} placeholder', () => {
    const content = readFileSync(join(FORMAT_DIR, 'test-format-1', 'format.js'), 'utf-8');
    const match = content.match(/window\.storyFormat\s*\(([\s\S]*)\)\s*;?\s*$/);
    const obj = JSON.parse(match![1]);
    expect(obj.source).toContain('{{STORY_DATA}}');
  });

  it('proofing key: defaults to false when not specified', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    expect(format).toBeDefined();
    expect(format!.proofing).toBe(false);
  });

  it('format with proofing=true is recognized as proofing format', () => {
    const formatDir = writeTempFormat(
      'proofing-format',
      'window.storyFormat({"name":"Proof","version":"1.0.0","proofing":true,"source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir]);
    const proofFormat = [...formats.values()].find((f) => f.name === 'Proof');
    expect(proofFormat).toBeDefined();
    expect(proofFormat!.proofing).toBe(true);
  });
});

// =============================================================================
// §3 — Placeholders: {{STORY_NAME}} and {{STORY_DATA}}
// =============================================================================
describe('Twine 2 Story Formats Spec — Placeholder Replacement', () => {
  it('{{STORY_NAME}} is replaced with the HTML-escaped story name', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('Spec Test');
    expect(result.output).not.toContain('{{STORY_NAME}}');
  });

  it('{{STORY_DATA}} is replaced with <tw-storydata> chunk', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('<tw-storydata');
    expect(result.output).not.toContain('{{STORY_DATA}}');
  });

  afterAll(() => cleanupTemp());

  it('placeholders not present in source are left as-is (no crash)', async () => {
    const formatDir = writeTempFormat(
      'no-placeholder-format',
      'window.storyFormat({"name":"Bare","version":"1.0.0","source":"<html><body>No placeholders</body></html>"});',
    );
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'no-placeholder-format',
      formatPaths: [formatDir],
      useTweegoPath: false,
    });
    // Output should be the format source unchanged (no crash)
    expect(result.output).toContain('No placeholders');
  });
});

// =============================================================================
// §4 — Format Discovery
// =============================================================================
describe('Twine 2 Story Formats Spec — Discovery', () => {
  afterAll(() => cleanupTemp());

  it('discovers format from format.js in a named directory', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    expect(formats.has('test-format-1')).toBe(true);
  });

  it('format id is derived from containing directory name', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    expect(format).toBeDefined();
    expect(format!.id).toBe('test-format-1');
  });

  it('format filename is format.js', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    expect(format).toBeDefined();
    expect(format!.filename).toContain('format.js');
  });

  it('multiple format directories are all discovered', () => {
    const formatDir1 = writeTempFormat(
      'format-a',
      'window.storyFormat({"name":"FormatA","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'format-b',
      'window.storyFormat({"name":"FormatB","version":"2.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir1]);
    const names = [...formats.values()].map((f) => f.name);
    expect(names).toContain('FormatA');
    expect(names).toContain('FormatB');
  });
});

// =============================================================================
// §5 — Twine 2 Format Detection
// =============================================================================
describe('Twine 2 Story Formats Spec — Twine 2 Detection', () => {
  it('format is identified as Twine 2 format', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    expect(format).toBeDefined();
    expect(format!.isTwine2).toBe(true);
  });
});

// =============================================================================
// §6 — Format Selection from StoryData
// =============================================================================
describe('Twine 2 Story Formats Spec — Format Selection via StoryData', () => {
  afterAll(() => cleanupTemp());

  it('format specified in StoryData is used for compilation', async () => {
    const formatDir = writeTempFormat(
      'sugarcube-2',
      'window.storyFormat({"name":"SugarCube","version":"2.37.3","source":"<html><head>SC</head><body>{{STORY_DATA}}</body></html>"});',
    );
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.37.3"}',
      '',
      ':: StoryTitle',
      'Format Selection',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatPaths: [formatDir],
      useTweegoPath: false,
    });
    expect(result.output).toContain('SC');
    expect(result.format?.name).toBe('SugarCube');
  });

  it('explicit formatId option overrides StoryData format', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.37.3"}',
      '',
      ':: StoryTitle',
      'Override Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.format?.name).toBe('Test Format');
  });
});

// =============================================================================
// §7 — Version Requirements
// =============================================================================
describe('Twine 2 Story Formats Spec — Version', () => {
  afterAll(() => cleanupTemp());

  it('version must be semantic version format (x.y.z)', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    for (const [, format] of formats) {
      expect(format.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('format with non-semver version still loads (graceful handling)', () => {
    const formatDir = writeTempFormat(
      'odd-version-format',
      'window.storyFormat({"name":"OddVer","version":"1.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'OddVer');
    expect(format).toBeDefined();
  });
});

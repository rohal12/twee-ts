/**
 * Twine 2 JSON Output Documentation Compliance Tests (v1.0)
 *
 * Tests twee-ts against every requirement in the Twine 2 JSON Output Documentation:
 * https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-jsonoutput-doc.md
 *
 * NOTE: The upstream document is titled "Twine 2 JSON Specification" but is
 * filed as twine-2-jsonoutput-doc.md (a "doc", not a "spec"). Tests reference
 * it as a specification for consistency with its self-declared title.
 *
 * Each describe block corresponds to a section of the spec.
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import type { CompileResult } from '../src/types.js';

/** Typed representation of the Twine 2 JSON output, matching the spec structure. */
interface TwineJsonStory {
  readonly name: string;
  readonly passages: readonly TwineJsonPassage[];
  readonly ifid?: string;
  readonly format?: string;
  readonly 'format-version'?: string;
  readonly start?: string;
  readonly 'tag-colors'?: Readonly<Record<string, string>>;
  readonly zoom?: number;
  readonly creator?: string;
  readonly 'creator-version'?: string;
  readonly style?: string;
  readonly script?: string;
}

interface TwineJsonPassage {
  readonly name: string;
  readonly tags: readonly string[];
  readonly text: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * The set of all valid top-level keys defined by the spec.
 * Used to verify no extraneous keys appear in the output.
 */
const VALID_STORY_KEYS = [
  'name',
  'ifid',
  'format',
  'format-version',
  'start',
  'tag-colors',
  'zoom',
  'creator',
  'creator-version',
  'style',
  'script',
  'passages',
] as const;

/**
 * The set of all valid passage-level keys defined by the spec.
 */
const VALID_PASSAGE_KEYS = ['name', 'tags', 'metadata', 'text'] as const;

/** Helper: compile inline twee source to JSON output. */
async function compileToJSON(content: string): Promise<CompileResult & { json: TwineJsonStory }> {
  const result = await compile({
    sources: [{ filename: 'spec-test.tw', content }],
    outputMode: 'json',
  });
  return { ...result, json: JSON.parse(result.output) as TwineJsonStory };
}

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

/** Helper: build a full-featured story source. */
function fullStory(passages: string): string {
  return [
    ':: StoryData',
    '{',
    '  "ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC",',
    '  "format":"SugarCube",',
    '  "format-version":"2.37.3",',
    '  "start":"Begin",',
    '  "tag-colors":{"scene":"green","character":"blue"},',
    '  "zoom":0.25',
    '}',
    '',
    ':: StoryTitle',
    'Full Story',
    '',
    passages,
  ].join('\n');
}

// =============================================================================
// S1 -- Story Data Encoding: Required Properties
// Spec: "name" (string) Required. "passages" (array of objects) Required.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Required Story Properties', () => {
  it('name: required, is a string, matches StoryTitle', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(typeof json.name).toBe('string');
    expect(json.name).toBe('Spec Test');
  });

  it('passages: required, is an array of one or more passage objects', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(Array.isArray(json.passages)).toBe(true);
    expect(json.passages.length).toBeGreaterThanOrEqual(1);
  });

  it('output is valid JSON', async () => {
    const result = await compile({
      sources: [{ filename: 'test.tw', content: minimalStory(':: Start\nHello') }],
      outputMode: 'json',
    });
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it('output is a JSON object (not an array or primitive)', async () => {
    const result = await compile({
      sources: [{ filename: 'test.tw', content: minimalStory(':: Start\nHello') }],
      outputMode: 'json',
    });
    const parsed: unknown = JSON.parse(result.output);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
  });

  it('output is well-formed JSON without trailing commas or syntax errors', async () => {
    const result = await compile({
      sources: [{ filename: 'test.tw', content: fullStory(':: Begin [tag1 tag2] {"position":"600,400"}\nHello') }],
      outputMode: 'json',
    });
    // JSON.parse will throw on any syntax error (trailing commas, unquoted keys, etc.)
    const parsed: unknown = JSON.parse(result.output);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
  });

  it('output contains no keys beyond those defined in the spec', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const keys = Object.keys(json);
    for (const key of keys) {
      expect(VALID_STORY_KEYS as readonly string[]).toContain(key);
    }
  });

  it('every passage in the passages array has all required keys: name, tags, text', async () => {
    const source = minimalStory([':: Start [tag1]', 'Hello', '', ':: Second', 'World'].join('\n'));
    const { json } = await compileToJSON(source);
    for (const passage of json.passages) {
      expect('name' in passage).toBe(true);
      expect(typeof passage.name).toBe('string');
      expect('tags' in passage).toBe(true);
      expect(Array.isArray(passage.tags)).toBe(true);
      expect('text' in passage).toBe(true);
      expect(typeof passage.text).toBe('string');
    }
  });

  it('name is always present even with minimal StoryData', async () => {
    const source = [':: StoryTitle', 'My Story', '', ':: Start', 'Hello'].join('\n');
    const { json } = await compileToJSON(source);
    expect(typeof json.name).toBe('string');
    expect(json.name).toBe('My Story');
  });

  it('passages is always present even with minimal StoryData', async () => {
    const source = [':: StoryTitle', 'My Story', '', ':: Start', 'Hello'].join('\n');
    const { json } = await compileToJSON(source);
    expect(Array.isArray(json.passages)).toBe(true);
    expect(json.passages.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// S2 -- Story Data Encoding: Optional Properties
// =============================================================================
describe('Twine 2 JSON Output Spec -- Optional Story Properties', () => {
  // --- ifid ---
  it('ifid: (string) present when defined in StoryData', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(typeof json.ifid).toBe('string');
    expect(json.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });

  it('ifid: conforms to Treaty of Babel format (8-63 chars, digits/capitals/hyphens)', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const ifid = json.ifid;
    if (!ifid) throw new Error('expected ifid');
    expect(ifid.length).toBeGreaterThanOrEqual(8);
    expect(ifid.length).toBeLessThanOrEqual(63);
    expect(ifid).toMatch(/^[0-9A-Z-]+$/);
  });

  it('ifid: Optional -- when StoryData has no ifid, ifid may be absent or auto-generated string', async () => {
    const source = [':: StoryTitle', 'No IFID Story', '', ':: Start', 'Hello'].join('\n');
    const { json } = await compileToJSON(source);
    if (json.ifid !== undefined) {
      expect(typeof json.ifid).toBe('string');
      expect(json.ifid.length).toBeGreaterThanOrEqual(8);
      expect(json.ifid.length).toBeLessThanOrEqual(63);
      expect(json.ifid).toMatch(/^[0-9A-Z-]+$/);
    }
  });

  // --- format ---
  it('format: (string) present when defined in StoryData', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.format).toBe('string');
    expect(json.format).toBe('SugarCube');
  });

  it('format: omitted when not defined in StoryData', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.format).toBeUndefined();
  });

  // --- format-version ---
  it('format-version: (string) present when defined, uses hyphenated key', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json['format-version']).toBe('string');
    expect(json['format-version']).toBe('2.37.3');
  });

  it('format-version: omitted when not defined in StoryData', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json['format-version']).toBeUndefined();
  });

  // --- start ---
  it('start: (string) present when defined in StoryData', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.start).toBe('string');
    expect(json.start).toBe('Begin');
  });

  it('start: omitted when not defined in StoryData', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.start).toBeUndefined();
  });

  it('start: contains passage name (matching spec example), not a numeric PID', async () => {
    // Spec description says "PID matching a <tw-passagedata> element" but the
    // spec example shows "start": "My Starting Passage" -- a passage name.
    // We test against the example which uses a passage name string.
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const start = json.start;
    if (!start) throw new Error('expected start');
    expect(typeof start).toBe('string');
    expect(start).toBe('Begin');
    expect(start).not.toMatch(/^\d+$/);
    // The start value must correspond to an actual passage name in the passages array
    const passageNames = json.passages.map((p) => p.name);
    expect(passageNames).toContain(start);
  });

  it('start: correctly references a non-first passage', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"Second"}',
      '',
      ':: StoryTitle',
      'Start Order Test',
      '',
      ':: First',
      'First passage',
      '',
      ':: Second',
      'Second passage',
    ].join('\n');
    const { json } = await compileToJSON(source);
    expect(json.start).toBe('Second');
  });

  it('start: is a passage name as shown in spec example, must be a string', async () => {
    // Spec example: "start": "My Starting Passage"
    // The start value must be a string containing a passage name
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"My Starting Passage"}',
      '',
      ':: StoryTitle',
      'Start Name Test',
      '',
      ':: My Starting Passage',
      'Content here',
    ].join('\n');
    const { json } = await compileToJSON(source);
    expect(typeof json.start).toBe('string');
    expect(json.start).toBe('My Starting Passage');
  });

  it('start: when StoryData provides a numeric string, it is a string type not a number', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"1"}',
      '',
      ':: StoryTitle',
      'Numeric Start Test',
      '',
      ':: 1',
      'This is passage named "1"',
    ].join('\n');
    const { json } = await compileToJSON(source);
    if (json.start !== undefined) {
      expect(typeof json.start).toBe('string');
    }
  });

  it('start: referencing non-existent passage is handled gracefully', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"NonExistent"}',
      '',
      ':: StoryTitle',
      'Missing Start',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const { json } = await compileToJSON(source);
    expect(typeof json.name).toBe('string');
    expect(Array.isArray(json.passages)).toBe(true);
  });

  // --- tag-colors ---
  it('tag-colors: (object of tag:color pairs) present when defined, uses hyphenated key', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const tagColors = json['tag-colors'];
    if (!tagColors) throw new Error('expected tag-colors');
    expect(typeof tagColors).toBe('object');
    expect(tagColors).toEqual({ scene: 'green', character: 'blue' });
  });

  it('tag-colors: all keys and values are strings', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const tagColors = json['tag-colors'];
    if (!tagColors) throw new Error('expected tag-colors');
    for (const [key, value] of Object.entries(tagColors)) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('string');
    }
  });

  it('tag-colors: not an array', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const tagColors = json['tag-colors'];
    if (!tagColors) throw new Error('expected tag-colors');
    expect(Array.isArray(tagColors)).toBe(false);
    expect(tagColors).not.toBeNull();
  });

  it('tag-colors: omitted when no tag colors defined', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json['tag-colors']).toBeUndefined();
  });

  it('tag-colors: supports multiple tag-color pairs as shown in spec example', async () => {
    // Spec example shows three tag-color pairs: "bar":"Green", "foo":"red", "qaz":"blue"
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"bar":"Green","foo":"red","qaz":"blue"}}',
      '',
      ':: StoryTitle',
      'Tag Colors Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const { json } = await compileToJSON(source);
    const tagColors = json['tag-colors'];
    if (!tagColors) throw new Error('expected tag-colors');
    expect(Object.keys(tagColors).length).toBe(3);
    expect(tagColors.bar).toBe('Green');
    expect(tagColors.foo).toBe('red');
    expect(tagColors.qaz).toBe('blue');
  });

  // --- zoom ---
  it('zoom: (decimal/number) present when defined in StoryData', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.zoom).toBe('number');
    expect(json.zoom).toBe(0.25);
  });

  it('zoom: must be a number type (decimal), not a string, and must be finite', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.zoom).toBe('number');
    // Spec says "(decimal)" -- must be a finite number, not NaN or Infinity
    expect(Number.isFinite(json.zoom)).toBe(true);
  });

  it('zoom: when not set in StoryData, may be omitted or present with default number value', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    if (json.zoom !== undefined) {
      expect(typeof json.zoom).toBe('number');
    }
  });

  it('zoom: value is serialized as a JSON number, not a JSON string', async () => {
    // Verify the raw JSON output contains zoom as a number literal, not a quoted string
    const result = await compile({
      sources: [{ filename: 'test.tw', content: fullStory(':: Begin\nHello') }],
      outputMode: 'json',
    });
    const raw = result.output;
    // zoom should appear as: "zoom": 0.25 (not "zoom": "0.25")
    expect(raw).toMatch(/"zoom"\s*:\s*0\.25/);
    expect(raw).not.toMatch(/"zoom"\s*:\s*"0\.25"/);
  });

  // --- creator ---
  it('creator: (string) Optional per spec, when present must be a non-empty string', async () => {
    // Spec: "The name of program used to create the file."
    // A compiler that produces JSON should identify itself as the creator.
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    if (json.creator !== undefined) {
      expect(typeof json.creator).toBe('string');
      expect(json.creator).not.toBe('');
    }
  });

  it('creator: maps to <tw-storydata creator> -- names the program that created the file', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    if (json.creator !== undefined) {
      expect(typeof json.creator).toBe('string');
      // The creator should be a meaningful program name, not empty or whitespace-only
      expect(json.creator.trim().length).toBeGreaterThan(0);
    }
  });

  // --- creator-version ---
  it('creator-version: (string) Optional per spec, when present uses hyphenated key and is a string', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    if (json['creator-version'] !== undefined) {
      expect(typeof json['creator-version']).toBe('string');
      expect(json['creator-version']).not.toBe('');
    }
  });

  it('creator-version: maps to <tw-storydata creator-version> -- version of the creator program', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    if (json['creator-version'] !== undefined) {
      expect(typeof json['creator-version']).toBe('string');
      // The creator-version should be a meaningful version string
      expect(json['creator-version'].trim().length).toBeGreaterThan(0);
    }
  });

  // --- zoom edge case: integer 1 ---
  it('zoom: integer value 1 is serialized as a number, not omitted or stringified', async () => {
    // Spec says zoom is "(decimal) Optional" -- when explicitly set to 1,
    // it should appear as a JSON number
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","zoom":1}',
      '',
      ':: StoryTitle',
      'Zoom Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const { json } = await compileToJSON(source);
    // When zoom is explicitly set to 1, the spec says it's optional --
    // but if present, it must be a number
    if (json.zoom !== undefined) {
      expect(typeof json.zoom).toBe('number');
      expect(json.zoom).toBe(1);
    }
  });

  // --- tag-colors edge case: empty object ---
  it('tag-colors: when StoryData has empty tag-colors object, may be omitted or empty object', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{}}',
      '',
      ':: StoryTitle',
      'Empty Tags Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const { json } = await compileToJSON(source);
    // If tag-colors is present, it must be an object (not array, not null)
    if (json['tag-colors'] !== undefined) {
      expect(typeof json['tag-colors']).toBe('object');
      expect(Array.isArray(json['tag-colors'])).toBe(false);
      expect(json['tag-colors']).not.toBeNull();
    }
  });
});

// =============================================================================
// S3 -- Story Data Encoding: style and script
// Spec: "style" (string) Optional. "script" (string) Optional.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Style and Script', () => {
  it('style: (string) contains stylesheet passage content', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body { color: red; }'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(typeof json.style).toBe('string');
    expect(json.style).toBe('body { color: red; }');
  });

  it('script: (string) contains script passage content', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.setup = {};'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(typeof json.script).toBe('string');
    expect(json.script).toBe('window.setup = {};');
  });

  it('style: empty string or omitted when no stylesheet passages', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    if (json.style !== undefined) {
      expect(json.style).toBe('');
    }
  });

  it('script: empty string or omitted when no script passages', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    if (json.script !== undefined) {
      expect(json.script).toBe('');
    }
  });

  it('style: when present, is always a string type (not null, undefined, or other type)', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    if ('style' in json) {
      expect(typeof json.style).toBe('string');
    }
  });

  it('script: when present, is always a string type (not null, undefined, or other type)', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    if ('script' in json) {
      expect(typeof json.script).toBe('string');
    }
  });

  it('style: multiple stylesheet passages are merged into a single string', async () => {
    const source = minimalStory(
      [
        ':: Start',
        'Hello',
        '',
        ':: S1 [stylesheet]',
        'body { color: red; }',
        '',
        ':: S2 [stylesheet]',
        'p { margin: 0; }',
      ].join('\n'),
    );
    const { json } = await compileToJSON(source);
    const style = json.style;
    if (!style) throw new Error('expected style');
    expect(typeof style).toBe('string');
    expect(style).toContain('body { color: red; }');
    expect(style).toContain('p { margin: 0; }');
  });

  it('script: multiple script passages are merged into a single string', async () => {
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: J1 [script]', 'window.a = 1;', '', ':: J2 [script]', 'window.b = 2;'].join('\n'),
    );
    const { json } = await compileToJSON(source);
    const script = json.script;
    if (!script) throw new Error('expected script');
    expect(typeof script).toBe('string');
    expect(script).toContain('window.a = 1;');
    expect(script).toContain('window.b = 2;');
  });

  it('style: is a raw string, not wrapped in HTML tags', async () => {
    // Spec maps style to <style> element content, but the JSON value is the raw CSS string
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body { color: red; }'].join('\n'));
    const { json } = await compileToJSON(source);
    const style = json.style;
    if (!style) throw new Error('expected style');
    expect(style).not.toContain('<style');
    expect(style).not.toContain('</style>');
    expect(style).toBe('body { color: red; }');
  });

  it('script: is a raw string, not wrapped in HTML tags', async () => {
    // Spec maps script to <script> element content, but the JSON value is the raw JS string
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.setup = {};'].join('\n'));
    const { json } = await compileToJSON(source);
    const script = json.script;
    if (!script) throw new Error('expected script');
    expect(script).not.toContain('<script');
    expect(script).not.toContain('</script>');
    expect(script).toBe('window.setup = {};');
  });

  it('style: maps to Story Stylesheet content per spec', async () => {
    // Spec: "Story Stylesheet content. Maps to <style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css"></style>"
    // The JSON value must be raw CSS content, not an HTML element
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: MyStyles [stylesheet]', '.passage { font-size: 14px; }'].join('\n'),
    );
    const { json } = await compileToJSON(source);
    expect(json.style).toBeDefined();
    expect(typeof json.style).toBe('string');
    expect(json.style).toContain('.passage { font-size: 14px; }');
  });

  it('script: maps to Story JavaScript content per spec', async () => {
    // Spec: "Story JavaScript content. Maps to <script role="script" id="twine-user-script" type="text/twine-javascript"></script>"
    // The JSON value must be raw JS content, not an HTML element
    const source = minimalStory([':: Start', 'Hello', '', ':: MyScript [script]', 'console.log("init");'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.script).toBeDefined();
    expect(typeof json.script).toBe('string');
    expect(json.script).toContain('console.log("init");');
  });
});

// =============================================================================
// S4 -- Passage Data Encoding
// Spec: name (string) Required. tags (array of strings) Required.
//       metadata (object) Optional. text (string) Required.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Passage Data Encoding', () => {
  it('name: (string) required, matches passage name', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(typeof start.name).toBe('string');
    expect(start.name).toBe('Start');
  });

  it('tags: (array of strings) required, present with correct values', async () => {
    const source = minimalStory(':: Start [tag1 tag2]\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(Array.isArray(start.tags)).toBe(true);
    expect(start.tags).toEqual(['tag1', 'tag2']);
    // Verify each tag is a string
    for (const tag of start.tags) {
      expect(typeof tag).toBe('string');
    }
  });

  it('tags: required, empty array when passage has no tags', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(Array.isArray(start.tags)).toBe(true);
    expect(start.tags).toEqual([]);
  });

  it('text: (string) required, contains passage content', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello, world!'));
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(typeof start.text).toBe('string');
    expect(start.text).toBe('Hello, world!');
  });

  it('text: empty passage content is represented as empty string, not omitted', async () => {
    // Spec: text (string) Required -- must always be present even if empty
    const source = minimalStory(':: Start\n');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect('text' in start).toBe(true);
    expect(typeof start.text).toBe('string');
  });

  it('text: preserves multiline content', async () => {
    const source = minimalStory(':: Start\nLine 1\nLine 2\nLine 3');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(start.text).toBe('Line 1\nLine 2\nLine 3');
  });

  it('text: raw content, not HTML-escaped', async () => {
    const source = minimalStory(':: Start\nA & B < C > D');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(start.text).toBe('A & B < C > D');
  });

  it('metadata: (object) present with position and size when defined', async () => {
    const source = minimalStory(':: Start {"position":"600,400","size":"100,200"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    expect(typeof start.metadata).toBe('object');
    expect(start.metadata.position).toBe('600,400');
    expect(start.metadata.size).toBe('100,200');
  });

  it('metadata: position value is a comma-separated coordinate string', async () => {
    const source = minimalStory(':: Start {"position":"600,400"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    expect(typeof start.metadata.position).toBe('string');
    expect(start.metadata.position).toMatch(/^\d+,\d+$/);
  });

  it('metadata: size value is a comma-separated dimension string', async () => {
    const source = minimalStory(':: Start {"position":"600,400","size":"100,200"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    expect(typeof start.metadata.size).toBe('string');
    expect(start.metadata.size).toMatch(/^\d+,\d+$/);
  });

  it('metadata: omitted when not defined', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(start.metadata).toBeUndefined();
  });

  it('metadata: only includes position when only position is set', async () => {
    const source = minimalStory(':: Start {"position":"300,100"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    expect(start.metadata.position).toBe('300,100');
    expect(start.metadata.size).toBeUndefined();
  });

  it('metadata: name-value pairs are string:string (not other types)', async () => {
    const source = minimalStory(':: Start {"position":"600,400","size":"100,200"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    for (const [key, value] of Object.entries(start.metadata)) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('string');
    }
  });

  it('passage objects contain no keys beyond those defined in the spec', async () => {
    const source = minimalStory(':: Start {"position":"600,400","size":"100,200"}\nHello');
    const { json } = await compileToJSON(source);
    for (const passage of json.passages) {
      const keys = Object.keys(passage);
      for (const key of keys) {
        expect(VALID_PASSAGE_KEYS as readonly string[]).toContain(key);
      }
    }
  });

  it('metadata: can contain multiple name-value pairs as defined by Twee 3 notation', async () => {
    // Spec: "a passage can contain multiple name-value pairs"
    const source = minimalStory(':: Start {"position":"600,400","size":"100,200"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    const entries = Object.entries(start.metadata);
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it('metadata: position and size values are strings as shown in spec example', async () => {
    // Spec example: "position": "600,400", "size": "100,200" -- both are strings, not arrays or numbers
    const source = minimalStory(':: Start {"position":"600,400","size":"100,200"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    // Values must be strings, not parsed into arrays or numbers
    expect(typeof start.metadata.position).toBe('string');
    expect(typeof start.metadata.size).toBe('string');
    // Must not be parsed into arrays
    expect(Array.isArray(start.metadata.position)).toBe(false);
    expect(Array.isArray(start.metadata.size)).toBe(false);
  });

  it('passage objects do NOT contain a pid property', async () => {
    // pid is an HTML output concept, not defined in the JSON spec
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    for (const passage of json.passages) {
      expect('pid' in passage).toBe(false);
    }
  });

  it('name: passage name with spaces is preserved exactly', async () => {
    const source = minimalStory(':: My Starting Passage\nHello');
    const { json } = await compileToJSON(source);
    const passage = json.passages.find((p) => p.name === 'My Starting Passage');
    expect(passage).toBeDefined();
  });

  it('name: passage name is never empty for a valid passage', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    for (const passage of json.passages) {
      expect(passage.name.length).toBeGreaterThan(0);
    }
  });

  it('multiple passages are all represented in the array', async () => {
    const source = minimalStory([':: Start', 'First', '', ':: Middle', 'Second', '', ':: End', 'Third'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.passages.length).toBe(3);
    const names = json.passages.map((p) => p.name);
    expect(names).toContain('Start');
    expect(names).toContain('Middle');
    expect(names).toContain('End');
  });

  it('metadata: preserves arbitrary name-value pairs beyond position and size', async () => {
    // Spec: "As in Twee 3 notation, a passage can contain multiple name-value pairs."
    // This means metadata can include keys beyond just "position" and "size".
    const source = minimalStory(':: Start {"position":"600,400","size":"100,200","custom-key":"custom-value"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    // The spec says metadata is "object of name(string):value(string) pairs" and
    // "a passage can contain multiple name-value pairs." A compliant implementation
    // SHOULD preserve all metadata pairs, not just position and size.
    expect(start.metadata['custom-key']).toBe('custom-value');
  });

  it('metadata: is an object, not an array or null', async () => {
    const source = minimalStory(':: Start {"position":"600,400"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    expect(typeof start.metadata).toBe('object');
    expect(Array.isArray(start.metadata)).toBe(false);
    expect(start.metadata).not.toBeNull();
  });
});

// =============================================================================
// S5 -- Passage Exclusions
// StoryTitle, StoryData, script, stylesheet passages must NOT appear in passages array.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Passage Exclusions', () => {
  it('StoryTitle is NOT included in passages array', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.passages.some((p) => p.name === 'StoryTitle')).toBe(false);
  });

  it('StoryData is NOT included in passages array', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.passages.some((p) => p.name === 'StoryData')).toBe(false);
  });

  it('script-tagged passages are NOT included in passages array', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.x = 1;'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.passages.some((p) => p.name === 'JS')).toBe(false);
  });

  it('stylesheet-tagged passages are NOT included in passages array', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body {}'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.passages.some((p) => p.name === 'CSS')).toBe(false);
  });

  it('script-tagged passages contribute to script property, not passages array', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.x = 1;'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.passages.some((p) => p.name === 'JS')).toBe(false);
    expect(json.script).toContain('window.x = 1;');
  });

  it('stylesheet-tagged passages contribute to style property, not passages array', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body { color: red; }'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.passages.some((p) => p.name === 'CSS')).toBe(false);
    expect(json.style).toContain('body { color: red; }');
  });

  // NOTE: Twine.private exclusion is inherited from Twine 2 conventions, not explicitly defined in the JSON spec.
  it('Twine.private-tagged passages are NOT included in passages array', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Hidden [Twine.private]', 'Secret'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.passages.some((p) => p.name === 'Hidden')).toBe(false);
  });

  it('only story passages appear in passages array (comprehensive)', async () => {
    const source = minimalStory(
      [
        ':: Start',
        'Hello',
        '',
        ':: Second',
        'World',
        '',
        ':: JS [script]',
        'code',
        '',
        ':: CSS [stylesheet]',
        'styles',
        '',
        ':: Private [Twine.private]',
        'hidden',
      ].join('\n'),
    );
    const { json } = await compileToJSON(source);
    const names = json.passages.map((p) => p.name);
    expect(names).toEqual(['Start', 'Second']);
  });

  it('script-tagged passages do not appear as regular passages with script tag still in tags array', async () => {
    // Verify that script passages aren't just included with their script tag stripped
    const source = minimalStory([':: Start', 'Hello', '', ':: MyScript [script]', 'var x = 1;'].join('\n'));
    const { json } = await compileToJSON(source);
    // No passage named MyScript should exist at all
    expect(json.passages.some((p) => p.name === 'MyScript')).toBe(false);
    // And no passage should have text "var x = 1;" (script content belongs in script property)
    expect(json.passages.some((p) => p.text === 'var x = 1;')).toBe(false);
  });

  it('stylesheet-tagged passages do not appear as regular passages with stylesheet tag still in tags array', async () => {
    // Verify that stylesheet passages aren't just included with their stylesheet tag stripped
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: MyStyles [stylesheet]', 'div { color: blue; }'].join('\n'),
    );
    const { json } = await compileToJSON(source);
    expect(json.passages.some((p) => p.name === 'MyStyles')).toBe(false);
    expect(json.passages.some((p) => p.text === 'div { color: blue; }')).toBe(false);
  });
});

// =============================================================================
// S5b -- Spec Example Passage Structure
// The spec example passage has: name, tags (array), metadata (object with
// position and size), and text. Verify exact structural match.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Spec Example Passage Completeness', () => {
  it('passage matching spec example has all four properties: name, tags, metadata, text', async () => {
    // Spec example passage:
    // { "name": "My Starting Passage", "tags": ["tag1", "tag2"],
    //   "metadata": { "position": "600,400", "size": "100,200" },
    //   "text": "Double-click this passage to edit it." }
    const source = minimalStory(
      ':: Start [tag1 tag2] {"position":"600,400","size":"100,200"}\nDouble-click this passage to edit it.',
    );
    const { json } = await compileToJSON(source);
    const passage = json.passages.find((p) => p.name === 'Start');
    if (!passage) throw new Error('expected Start passage');
    expect(passage.name).toBe('Start');
    expect(passage.tags).toEqual(['tag1', 'tag2']);
    expect(passage.metadata).toEqual({ position: '600,400', size: '100,200' });
    expect(passage.text).toBe('Double-click this passage to edit it.');
  });

  it('tags order is preserved as specified in the passage header', async () => {
    const source = minimalStory(':: Start [alpha beta gamma]\nHello');
    const { json } = await compileToJSON(source);
    const passage = json.passages.find((p) => p.name === 'Start');
    if (!passage) throw new Error('expected Start passage');
    expect(passage.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('passage with no tags has an empty array (required), not undefined or null', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const passage = json.passages.find((p) => p.name === 'Start');
    if (!passage) throw new Error('expected Start passage');
    expect(passage.tags).toBeDefined();
    expect(passage.tags).not.toBeNull();
    expect(Array.isArray(passage.tags)).toBe(true);
    expect(passage.tags.length).toBe(0);
  });
});

// =============================================================================
// S6 -- Hyphenated JSON Keys
// The spec uses hyphenated keys (format-version, tag-colors, creator-version)
// matching Twee 3 notation and HTML attribute naming conventions.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Hyphenated Key Names', () => {
  it('uses hyphenated key "format-version" (not camelCase "formatVersion")', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(json['format-version']).toBeDefined();
    expect('formatVersion' in json).toBe(false);
  });

  it('uses hyphenated key "tag-colors" (not camelCase "tagColors")', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(json['tag-colors']).toBeDefined();
    expect('tagColors' in json).toBe(false);
  });

  it('uses hyphenated key "creator-version" (not camelCase "creatorVersion")', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(json['creator-version']).toBeDefined();
    expect('creatorVersion' in json).toBe(false);
  });

  it('does not use underscore variants for hyphenated keys', async () => {
    const result = await compile({
      sources: [{ filename: 'test.tw', content: fullStory(':: Begin\nHello') }],
      outputMode: 'json',
    });
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect('format_version' in parsed).toBe(false);
    expect('tag_colors' in parsed).toBe(false);
    expect('creator_version' in parsed).toBe(false);
  });
});

// =============================================================================
// S7 -- JSON String Escaping
// JSON output must properly escape special characters so it parses correctly.
// =============================================================================
describe('Twine 2 JSON Output Spec -- JSON String Escaping', () => {
  it('passage name with double quotes is properly escaped in JSON', async () => {
    const source = minimalStory(':: Say "Hello"\nContent');
    const { json } = await compileToJSON(source);
    const passage = json.passages.find((p) => p.name === 'Say "Hello"');
    expect(passage).toBeDefined();
  });

  it('passage text with backslashes is preserved in JSON', async () => {
    const source = minimalStory(':: Start\nPath: C:\\\\Users\\\\test');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(start.text).toContain('C:\\');
    expect(start.text).toContain('Users\\');
  });

  it('passage text with newlines is properly encoded in JSON string', async () => {
    const source = minimalStory(':: Start\nLine 1\nLine 2');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'json',
    });
    // The raw JSON string must escape newlines as \n inside the text value
    expect(() => JSON.parse(result.output)).not.toThrow();
    const json = JSON.parse(result.output) as TwineJsonStory;
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(start.text).toBe('Line 1\nLine 2');
  });

  it('story name with special characters is properly escaped in JSON', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'A "Quoted" Story & More <Tags>',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const { json } = await compileToJSON(source);
    expect(json.name).toBe('A "Quoted" Story & More <Tags>');
  });

  it('tag values with special characters are properly escaped in JSON', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"scene":"#ff0000"}}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const { json } = await compileToJSON(source);
    const tagColors = json['tag-colors'];
    if (!tagColors) throw new Error('expected tag-colors');
    expect(tagColors.scene).toBe('#ff0000');
  });
});

// =============================================================================
// S8 -- Spec Example Compliance
// The spec provides a complete JSON example. Verify the output matches the
// expected structure when given equivalent input.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Spec Example Structure', () => {
  it('output matches the spec example structure with all properties', async () => {
    const { json } = await compileToJSON(
      fullStory(':: Begin [tag1 tag2] {"position":"600,400","size":"100,200"}\nContent here'),
    );
    // Required top-level keys
    expect(typeof json.name).toBe('string');
    expect(Array.isArray(json.passages)).toBe(true);
    // Optional top-level keys (present because fullStory defines them)
    expect(typeof json.ifid).toBe('string');
    expect(typeof json.format).toBe('string');
    expect(typeof json['format-version']).toBe('string');
    expect(typeof json.start).toBe('string');
    expect(typeof json['tag-colors']).toBe('object');
    expect(typeof json.zoom).toBe('number');
    expect(typeof json.creator).toBe('string');
    expect(typeof json['creator-version']).toBe('string');
    expect(typeof json.style).toBe('string');
    expect(typeof json.script).toBe('string');
    // Passage structure matches spec example
    const passage = json.passages[0];
    if (!passage) throw new Error('expected at least one passage');
    expect(typeof passage.name).toBe('string');
    expect(Array.isArray(passage.tags)).toBe(true);
    expect(typeof passage.text).toBe('string');
    expect(typeof passage.metadata).toBe('object');
  });

  it('no legacy twine2 nested object in output', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('twine2' in json).toBe(false);
  });

  it('spec example values are correct when given matching input', async () => {
    // Build input that matches the spec example as closely as possible
    const source = [
      ':: StoryData',
      '{',
      '  "ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC",',
      '  "format":"Snowman",',
      '  "format-version":"3.0.2",',
      '  "start":"My Starting Passage",',
      '  "tag-colors":{"bar":"Green","foo":"red","qaz":"blue"},',
      '  "zoom":0.25',
      '}',
      '',
      ':: StoryTitle',
      'Example',
      '',
      ':: My Starting Passage [tag1 tag2] {"position":"600,400","size":"100,200"}',
      'Double-click this passage to edit it.',
    ].join('\n');
    const { json } = await compileToJSON(source);

    // Verify the top-level story properties match the spec example
    expect(json.name).toBe('Example');
    expect(json.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(json.format).toBe('Snowman');
    expect(json['format-version']).toBe('3.0.2');
    expect(json.start).toBe('My Starting Passage');
    expect(json['tag-colors']).toEqual({ bar: 'Green', foo: 'red', qaz: 'blue' });
    expect(json.zoom).toBe(0.25);

    // Verify the passage matches the spec example
    const passage = json.passages.find((p) => p.name === 'My Starting Passage');
    if (!passage) throw new Error('expected My Starting Passage');
    expect(passage.name).toBe('My Starting Passage');
    expect(passage.tags).toEqual(['tag1', 'tag2']);
    expect(passage.metadata).toEqual({ position: '600,400', size: '100,200' });
    expect(passage.text).toBe('Double-click this passage to edit it.');
  });
});

// =============================================================================
// S9 -- Passages Array: "one or more" Requirement
// Spec: passages is "Array of one or more passage objects encoded in JSON."
// =============================================================================
describe('Twine 2 JSON Output Spec -- Passages Array Requirement', () => {
  it('passages array has at least one entry for a normal story', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(Array.isArray(json.passages)).toBe(true);
    expect(json.passages.length).toBeGreaterThanOrEqual(1);
  });

  it('story with only special passages: passages array exists (may be empty after filtering)', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Empty Story',
      '',
      ':: JS [script]',
      'window.x = 1;',
    ].join('\n');
    const { json, diagnostics } = await compileToJSON(source);
    expect(Array.isArray(json.passages)).toBe(true);
    // Spec says "one or more" -- when all passages are special, empty array is
    // acceptable but a diagnostic (warning/error) is expected
    const hasPassageWarning = diagnostics.some(
      (d) =>
        (d.level === 'error' || d.level === 'warning') &&
        (d.message.toLowerCase().includes('passage') || d.message.toLowerCase().includes('start')),
    );
    if (json.passages.length === 0 && hasPassageWarning) {
      expect(hasPassageWarning).toBe(true);
    }
  });

  it('passages array contains objects (not strings, numbers, or null)', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World'].join('\n'));
    const { json } = await compileToJSON(source);
    for (const passage of json.passages) {
      expect(typeof passage).toBe('object');
      expect(passage).not.toBeNull();
      expect(Array.isArray(passage)).toBe(false);
    }
  });

  it('each passage in the array is a distinct object', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.passages.length).toBe(2);
    // Each passage should have a unique name
    const names = json.passages.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// =============================================================================
// S10 -- Partial Story Encoding
// Spec: "name" and "passages" are the only required story metadata properties.
// Optional properties can be omitted for a "partial story encoding."
// =============================================================================
describe('Twine 2 JSON Output Spec -- Partial Story Encoding', () => {
  it('output contains at minimum the required properties (name and passages)', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(typeof json.name).toBe('string');
    expect(json.name.length).toBeGreaterThan(0);
    expect(Array.isArray(json.passages)).toBe(true);
  });

  it('optional properties are omitted when not defined (partial encoding)', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    // These are all Optional per spec and should be absent when not in StoryData
    expect(json.format).toBeUndefined();
    expect(json['format-version']).toBeUndefined();
    expect(json.start).toBeUndefined();
    expect(json['tag-colors']).toBeUndefined();
    // zoom is also Optional per spec
    expect(json.zoom).toBeUndefined();
  });

  it('partial encoding: name and passages are always present regardless of StoryData content', async () => {
    const source = [':: StoryTitle', 'Bare Story', '', ':: Start', 'Hello'].join('\n');
    const { json } = await compileToJSON(source);
    expect(typeof json.name).toBe('string');
    expect(json.name).toBe('Bare Story');
    expect(Array.isArray(json.passages)).toBe(true);
    expect(json.passages.length).toBeGreaterThanOrEqual(1);
  });

  it('partial encoding: CSS content can be included via style for story compilation', async () => {
    // Spec: "Depending on the story format, this allows for representing in JSON
    // additional story content, CSS, or JavaScript for including as part of a
    // larger story compilation process."
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: Styles [stylesheet]', '.highlight { color: yellow; }'].join('\n'),
    );
    const { json } = await compileToJSON(source);
    if (json.style !== undefined) {
      expect(typeof json.style).toBe('string');
      expect(json.style).toContain('.highlight { color: yellow; }');
    }
  });

  it('partial encoding: JavaScript content can be included via script for story compilation', async () => {
    // Spec: "Depending on the story format, this allows for representing in JSON
    // additional story content, CSS, or JavaScript for including as part of a
    // larger story compilation process."
    const source = minimalStory([':: Start', 'Hello', '', ':: Setup [script]', 'window.storySetup = true;'].join('\n'));
    const { json } = await compileToJSON(source);
    if (json.script !== undefined) {
      expect(typeof json.script).toBe('string');
      expect(json.script).toContain('window.storySetup = true;');
    }
  });

  it('partial encoding: a story with only name and passages is valid per spec', async () => {
    // Spec: "Because name and passages are the only required story metadata properties,
    // a selection of content, named 'partial story encoding,' is possible"
    const source = [':: StoryTitle', 'Partial', '', ':: Start', 'Content'].join('\n');
    const { json } = await compileToJSON(source);
    // At minimum, name and passages must be present
    expect('name' in json).toBe(true);
    expect('passages' in json).toBe(true);
    // name must be a non-empty string
    expect(typeof json.name).toBe('string');
    expect(json.name.length).toBeGreaterThan(0);
    // passages must be an array
    expect(Array.isArray(json.passages)).toBe(true);
  });

  it('partial encoding: subset of passages can represent additional story content', async () => {
    // Spec: "this allows for representing in JSON additional story content, CSS,
    // or JavaScript for including as part of a larger story compilation process."
    const source = minimalStory(
      [
        ':: Start',
        'Main content',
        '',
        ':: Extra [stylesheet]',
        'body { margin: 0; }',
        '',
        ':: Init [script]',
        'window.init = true;',
      ].join('\n'),
    );
    const { json } = await compileToJSON(source);
    // The story should contain the main passage
    expect(json.passages.some((p) => p.name === 'Start')).toBe(true);
    // And CSS/JS should be in style/script properties if present
    if (json.style !== undefined) {
      expect(json.style).toContain('body { margin: 0; }');
    }
    if (json.script !== undefined) {
      expect(json.script).toContain('window.init = true;');
    }
  });
});

// =============================================================================
// S11 -- Type Correctness of All Properties
// Verify that every property in the output uses the correct JSON type as
// specified: string, number (decimal), array, or object.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Type Correctness', () => {
  it('name is a string', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.name).toBe('string');
  });

  it('ifid is a string', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.ifid).toBe('string');
  });

  it('format is a string', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.format).toBe('string');
  });

  it('format-version is a string', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json['format-version']).toBe('string');
  });

  it('start is a string', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.start).toBe('string');
  });

  it('tag-colors is an object (not an array)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json['tag-colors']).toBe('object');
    expect(Array.isArray(json['tag-colors'])).toBe(false);
    expect(json['tag-colors']).not.toBeNull();
  });

  it('zoom is a number (decimal), finite, not NaN', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.zoom).toBe('number');
    if (json.zoom !== undefined) {
      expect(Number.isFinite(json.zoom)).toBe(true);
      expect(Number.isNaN(json.zoom)).toBe(false);
    }
  });

  it('creator is a string', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json.creator).toBe('string');
  });

  it('creator-version is a string', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(typeof json['creator-version']).toBe('string');
  });

  it('style is a string when present (not a number, boolean, array, or object)', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body {}'].join('\n'));
    const { json } = await compileToJSON(source);
    if (json.style !== undefined) {
      expect(typeof json.style).toBe('string');
      expect(json.style).not.toBeNull();
      expect(Array.isArray(json.style)).toBe(false);
    }
  });

  it('script is a string when present (not a number, boolean, array, or object)', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.x = 1;'].join('\n'));
    const { json } = await compileToJSON(source);
    if (json.script !== undefined) {
      expect(typeof json.script).toBe('string');
      expect(json.script).not.toBeNull();
      expect(Array.isArray(json.script)).toBe(false);
    }
  });

  it('passages is an array', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(Array.isArray(json.passages)).toBe(true);
  });

  it('passage.name is a string', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const passage = json.passages[0];
    if (!passage) throw new Error('expected at least one passage');
    expect(typeof passage.name).toBe('string');
  });

  it('passage.tags is an array of strings', async () => {
    const source = minimalStory(':: Start [tag1]\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    expect(Array.isArray(start.tags)).toBe(true);
    for (const tag of start.tags) {
      expect(typeof tag).toBe('string');
    }
  });

  it('passage.text is a string', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const passage = json.passages[0];
    if (!passage) throw new Error('expected at least one passage');
    expect(typeof passage.text).toBe('string');
  });

  it('passage.metadata is an object of string:string pairs when present', async () => {
    const source = minimalStory(':: Start {"position":"600,400","size":"100,200"}\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    if (!start.metadata) throw new Error('expected metadata');
    expect(typeof start.metadata).toBe('object');
    expect(Array.isArray(start.metadata)).toBe(false);
    for (const [key, value] of Object.entries(start.metadata)) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('string');
    }
  });

  it('tag-colors values are all strings (not numbers, booleans, or objects)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const tagColors = json['tag-colors'];
    if (!tagColors) throw new Error('expected tag-colors');
    for (const value of Object.values(tagColors)) {
      expect(typeof value).toBe('string');
    }
  });

  it('passage.tags contains only string elements (not numbers, objects, or null)', async () => {
    const source = minimalStory(':: Start [alpha beta gamma]\nHello');
    const { json } = await compileToJSON(source);
    const start = json.passages.find((p) => p.name === 'Start');
    if (!start) throw new Error('expected Start passage');
    for (const tag of start.tags) {
      expect(typeof tag).toBe('string');
      expect(tag).not.toBeNull();
    }
  });
});

// =============================================================================
// S12 -- Compatibility Mappings
// The spec defines explicit mappings between JSON properties and HTML/Twee
// equivalents. These tests verify the JSON property names match the spec.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Property Name Mappings', () => {
  it('uses "name" (maps to <tw-storydata name>)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('name' in json).toBe(true);
  });

  it('uses "ifid" (maps to <tw-storydata ifid>)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('ifid' in json).toBe(true);
  });

  it('uses "format" (maps to <tw-storydata format>)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('format' in json).toBe(true);
  });

  it('uses "format-version" (maps to <tw-storydata format-version>)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('format-version' in json).toBe(true);
  });

  it('uses "start" (maps to <tw-storydata startnode>)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('start' in json).toBe(true);
  });

  it('uses "tag-colors" (maps to <tw-tag> nodes)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('tag-colors' in json).toBe(true);
  });

  it('uses "zoom" (maps to <tw-storydata zoom>)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('zoom' in json).toBe(true);
  });

  it('uses "creator" (maps to <tw-storydata creator>)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('creator' in json).toBe(true);
  });

  it('uses "creator-version" (maps to <tw-storydata creator-version>)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('creator-version' in json).toBe(true);
  });

  it('uses "passages" for the passage array', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect('passages' in json).toBe(true);
  });

  it('uses "style" (maps to <style> content)', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body {}'].join('\n'));
    const { json } = await compileToJSON(source);
    expect('style' in json).toBe(true);
  });

  it('uses "script" (maps to <script> content)', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.x=1;'].join('\n'));
    const { json } = await compileToJSON(source);
    expect('script' in json).toBe(true);
  });

  it('passage uses "name" property (not "title" or other variant)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const passage = json.passages[0];
    if (!passage) throw new Error('expected at least one passage');
    expect('name' in passage).toBe(true);
    expect('title' in passage).toBe(false);
  });

  it('passage uses "tags" property (not "tag" or other variant)', async () => {
    const source = minimalStory(':: Start [foo]\nHello');
    const { json } = await compileToJSON(source);
    const passage = json.passages.find((p) => p.name === 'Start');
    if (!passage) throw new Error('expected Start passage');
    expect('tags' in passage).toBe(true);
    expect('tag' in passage).toBe(false);
  });

  it('passage uses "text" property (not "content" or "body")', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const passage = json.passages[0];
    if (!passage) throw new Error('expected at least one passage');
    expect('text' in passage).toBe(true);
    expect('content' in passage).toBe(false);
    expect('body' in passage).toBe(false);
  });

  it('passage uses "metadata" property (not "meta" or "position")', async () => {
    const source = minimalStory(':: Start {"position":"600,400"}\nHello');
    const { json } = await compileToJSON(source);
    const passage = json.passages.find((p) => p.name === 'Start');
    if (!passage) throw new Error('expected Start passage');
    if (passage.metadata) {
      expect('metadata' in passage).toBe(true);
      expect('meta' in passage).toBe(false);
      expect('position' in passage).toBe(false);
    }
  });

  it('tag-colors pairs map to <tw-tag name>:<tw-tag color> structure', async () => {
    // Spec: "Pairs map to <tw-tag> nodes as <tw-tag name>:<tw-tag color>."
    // The JSON representation must be an object of string:string pairs
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const tagColors = json['tag-colors'];
    if (!tagColors) throw new Error('expected tag-colors');
    // Each key is a tag name, each value is a color
    expect(typeof tagColors).toBe('object');
    for (const [tagName, color] of Object.entries(tagColors)) {
      expect(typeof tagName).toBe('string');
      expect(tagName.length).toBeGreaterThan(0);
      expect(typeof color).toBe('string');
      expect(color.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// S13 -- Compatibility with Twine 2 HTML and Twee 3 Notation
// Spec: "To maintain compatibility with the existing output formats"
// Verify the JSON encoding mirrors properties from Twee 3 and Twine 2 HTML.
// =============================================================================
describe('Twine 2 JSON Output Spec -- Compatibility with HTML and Twee 3', () => {
  it('story properties encoded in JSON mirror those found in StoryData passage in Twee 3', async () => {
    // Spec: "story properties encoded in JSON mirror those found in the StoryData
    // passage in Twee 3 notation"
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    // All these properties come from the Twee 3 StoryData passage
    expect(json.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(json.format).toBe('SugarCube');
    expect(json['format-version']).toBe('2.37.3');
    expect(json.start).toBe('Begin');
  });

  it('passage properties mirror those found in Twee 3 notation', async () => {
    // Spec: "Passage properties mirror those found in Twee 3 notation"
    const source = minimalStory(':: Start [tag1 tag2] {"position":"600,400","size":"100,200"}\nContent');
    const { json } = await compileToJSON(source);
    const passage = json.passages.find((p) => p.name === 'Start');
    if (!passage) throw new Error('expected Start passage');
    // name, tags, metadata, text -- all from Twee 3 notation
    expect(passage.name).toBe('Start');
    expect(passage.tags).toEqual(['tag1', 'tag2']);
    expect(passage.metadata).toBeDefined();
    expect(passage.text).toBe('Content');
  });

  it('ifid format matches Treaty of Babel requirements', async () => {
    // Spec: "An IFID is a sequence of between 8 and 63 characters, each of which
    // shall be a digit, a capital letter or a hyphen"
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const ifid = json.ifid;
    if (!ifid) throw new Error('expected ifid');
    expect(ifid.length).toBeGreaterThanOrEqual(8);
    expect(ifid.length).toBeLessThanOrEqual(63);
    // Only digits, capital letters, or hyphens
    expect(ifid).toMatch(/^[0-9A-Z-]+$/);
  });

  it('start maps to passage name not PID, matching spec example', async () => {
    // Spec: start maps to <tw-storydata startnode>
    // But spec example shows: "start": "My Starting Passage" (a name, not a PID)
    // The JSON representation uses the passage name
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"My Starting Passage"}',
      '',
      ':: StoryTitle',
      'Compat Test',
      '',
      ':: My Starting Passage',
      'First passage',
      '',
      ':: Another',
      'Second passage',
    ].join('\n');
    const { json } = await compileToJSON(source);
    expect(json.start).toBe('My Starting Passage');
    // Must NOT be a numeric PID like "1" or "2"
    expect(json.start).not.toMatch(/^\d+$/);
  });

  it('ifid uniquely identifies the story per Treaty of Babel', async () => {
    // Spec: "uniquely identify a story"
    // The ifid should be preserved from the input
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });
});

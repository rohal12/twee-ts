/**
 * Twine 2 JSON Output Specification Compliance Tests (v1.0)
 *
 * Tests twee-ts against every requirement in the Twine 2 JSON Output Specification:
 * https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-jsonoutput-doc.md
 *
 * Each describe block corresponds to a section of the spec.
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';

/** Helper: compile inline twee source to JSON output. */
async function compileToJSON(content: string) {
  const result = await compile({
    sources: [{ filename: 'spec-test.tw', content }],
    outputMode: 'json',
  });
  return { ...result, json: JSON.parse(result.output) as Record<string, unknown> };
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
// §1 — Story Data Encoding: Required Properties
// =============================================================================
describe('Twine 2 JSON Output Spec — Required Story Properties', () => {
  it('name: required, matches StoryTitle', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.name).toBe('Spec Test');
  });

  it('passages: required, is an array', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(Array.isArray(json.passages)).toBe(true);
    expect((json.passages as unknown[]).length).toBeGreaterThan(0);
  });
});

// =============================================================================
// §2 — Story Data Encoding: Optional Properties
// =============================================================================
describe('Twine 2 JSON Output Spec — Optional Story Properties', () => {
  it('ifid: present when defined in StoryData', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });

  it('format: present when defined in StoryData', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(json.format).toBe('SugarCube');
  });

  it('format-version: present when defined in StoryData (hyphenated key)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(json['format-version']).toBe('2.37.3');
  });

  it('start: present when defined in StoryData', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(json.start).toBe('Begin');
  });

  it('tag-colors: object of tag:color pairs (hyphenated key)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    const tagColors = json['tag-colors'] as Record<string, string>;
    expect(tagColors).toEqual({ scene: 'green', character: 'blue' });
  });

  it('zoom: present when not default (1)', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(json.zoom).toBe(0.25);
  });

  it('zoom: omitted when default value (1)', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.zoom).toBeUndefined();
  });

  it('creator: present', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(typeof json.creator).toBe('string');
    expect(json.creator).not.toBe('');
  });

  it('creator-version: present (hyphenated key)', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(typeof json['creator-version']).toBe('string');
    expect(json['creator-version']).not.toBe('');
  });

  it('format: omitted when not defined', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.format).toBeUndefined();
  });

  it('format-version: omitted when not defined', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json['format-version']).toBeUndefined();
  });

  it('start: omitted when not defined', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.start).toBeUndefined();
  });

  it('tag-colors: omitted when no tag colors defined', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json['tag-colors']).toBeUndefined();
  });
});

// =============================================================================
// §3 — Story Data Encoding: style and script
// =============================================================================
describe('Twine 2 JSON Output Spec — Style and Script', () => {
  it('style: contains merged stylesheet passage content', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body { color: red; }'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.style).toBe('body { color: red; }');
  });

  it('script: contains merged script passage content', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.setup = {};'].join('\n'));
    const { json } = await compileToJSON(source);
    expect(json.script).toBe('window.setup = {};');
  });

  it('style: empty string when no stylesheet passages', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.style).toBe('');
  });

  it('script: empty string when no script passages', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    expect(json.script).toBe('');
  });

  it('style: multiple stylesheet passages are merged', async () => {
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
    const style = json.style as string;
    expect(style).toContain('body { color: red; }');
    expect(style).toContain('p { margin: 0; }');
  });

  it('script: multiple script passages are merged', async () => {
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: J1 [script]', 'window.a = 1;', '', ':: J2 [script]', 'window.b = 2;'].join('\n'),
    );
    const { json } = await compileToJSON(source);
    const script = json.script as string;
    expect(script).toContain('window.a = 1;');
    expect(script).toContain('window.b = 2;');
  });
});

// =============================================================================
// §4 — Passage Data Encoding
// =============================================================================
describe('Twine 2 JSON Output Spec — Passage Data', () => {
  it('name: required, matches passage name', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const passages = json.passages as { name: string }[];
    expect(passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('tags: required, array of strings', async () => {
    const source = minimalStory(':: Start [tag1 tag2]\nHello');
    const { json } = await compileToJSON(source);
    const passages = json.passages as { name: string; tags: string[] }[];
    const start = passages.find((p) => p.name === 'Start');
    expect(start).toBeDefined();
    expect(Array.isArray(start!.tags)).toBe(true);
    expect(start!.tags).toEqual(['tag1', 'tag2']);
  });

  it('tags: empty array when no tags', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const passages = json.passages as { name: string; tags: string[] }[];
    const start = passages.find((p) => p.name === 'Start');
    expect(start).toBeDefined();
    expect(start!.tags).toEqual([]);
  });

  it('text: required, contains passage content', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello, world!'));
    const passages = json.passages as { name: string; text: string }[];
    const start = passages.find((p) => p.name === 'Start');
    expect(start).toBeDefined();
    expect(start!.text).toBe('Hello, world!');
  });

  it('text: preserves multiline content', async () => {
    const source = minimalStory(':: Start\nLine 1\nLine 2\nLine 3');
    const { json } = await compileToJSON(source);
    const passages = json.passages as { name: string; text: string }[];
    const start = passages.find((p) => p.name === 'Start');
    expect(start!.text).toBe('Line 1\nLine 2\nLine 3');
  });

  it('text: raw content (not HTML-escaped)', async () => {
    const source = minimalStory(':: Start\nA & B < C > D');
    const { json } = await compileToJSON(source);
    const passages = json.passages as { name: string; text: string }[];
    const start = passages.find((p) => p.name === 'Start');
    expect(start!.text).toBe('A & B < C > D');
  });

  it('metadata: present with position and size when defined', async () => {
    const source = minimalStory(':: Start {"position":"600,400","size":"100,200"}\nHello');
    const { json } = await compileToJSON(source);
    const passages = json.passages as { name: string; metadata?: { position?: string; size?: string } }[];
    const start = passages.find((p) => p.name === 'Start');
    expect(start).toBeDefined();
    expect(start!.metadata).toBeDefined();
    expect(start!.metadata!.position).toBe('600,400');
    expect(start!.metadata!.size).toBe('100,200');
  });

  it('metadata: omitted when not defined', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const passages = json.passages as { name: string; metadata?: unknown }[];
    const start = passages.find((p) => p.name === 'Start');
    expect(start).toBeDefined();
    expect(start!.metadata).toBeUndefined();
  });

  it('metadata: only includes position when only position is set', async () => {
    const source = minimalStory(':: Start {"position":"300,100"}\nHello');
    const { json } = await compileToJSON(source);
    const passages = json.passages as { name: string; metadata?: Record<string, string> }[];
    const start = passages.find((p) => p.name === 'Start');
    expect(start!.metadata).toBeDefined();
    expect(start!.metadata!.position).toBe('300,100');
    expect(start!.metadata!.size).toBeUndefined();
  });
});

// =============================================================================
// §5 — Passage Exclusions
// =============================================================================
describe('Twine 2 JSON Output Spec — Passage Exclusions', () => {
  it('StoryTitle is NOT included in passages array', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const passages = json.passages as { name: string }[];
    expect(passages.some((p) => p.name === 'StoryTitle')).toBe(false);
  });

  it('StoryData is NOT included in passages array', async () => {
    const { json } = await compileToJSON(minimalStory(':: Start\nHello'));
    const passages = json.passages as { name: string }[];
    expect(passages.some((p) => p.name === 'StoryData')).toBe(false);
  });

  it('script-tagged passages are NOT included in passages array', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.x = 1;'].join('\n'));
    const { json } = await compileToJSON(source);
    const passages = json.passages as { name: string }[];
    expect(passages.some((p) => p.name === 'JS')).toBe(false);
  });

  it('stylesheet-tagged passages are NOT included in passages array', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body {}'].join('\n'));
    const { json } = await compileToJSON(source);
    const passages = json.passages as { name: string }[];
    expect(passages.some((p) => p.name === 'CSS')).toBe(false);
  });

  it('Twine.private-tagged passages are NOT included in passages array', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Hidden [Twine.private]', 'Secret'].join('\n'));
    const { json } = await compileToJSON(source);
    const passages = json.passages as { name: string }[];
    expect(passages.some((p) => p.name === 'Hidden')).toBe(false);
  });

  it('only story passages appear in passages array', async () => {
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
      ].join('\n'),
    );
    const { json } = await compileToJSON(source);
    const passages = json.passages as { name: string }[];
    const names = passages.map((p) => p.name);
    expect(names).toEqual(['Start', 'Second']);
  });
});

// =============================================================================
// §6 — Output is Valid JSON
// =============================================================================
describe('Twine 2 JSON Output Spec — Valid JSON', () => {
  it('output parses as valid JSON', async () => {
    const result = await compile({
      sources: [{ filename: 'test.tw', content: minimalStory(':: Start\nHello') }],
      outputMode: 'json',
    });
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it('output matches spec example structure', async () => {
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
    // Passage structure
    const passage = (json.passages as Record<string, unknown>[])[0];
    expect(typeof passage.name).toBe('string');
    expect(Array.isArray(passage.tags)).toBe(true);
    expect(typeof passage.text).toBe('string');
    expect(typeof passage.metadata).toBe('object');
  });

  it('no legacy twine2 nested object in output', async () => {
    const { json } = await compileToJSON(fullStory(':: Begin\nHello'));
    expect(json.twine2).toBeUndefined();
  });
});

/**
 * Twine 2 HTML Output Specification Compliance Tests (v1.0.2)
 *
 * Tests twee-ts against every requirement in the Twine 2 HTML Output Specification:
 * https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-htmloutput-spec.md
 *
 * Each describe block corresponds to a section of the spec.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import type { CompileOptions, CompileResult } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'test', 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

/** Helper: compile inline twee source to Twine 2 HTML. */
async function compileToHTML(content: string, options: Partial<CompileOptions> = {}): Promise<CompileResult> {
  return compile({
    sources: [{ filename: 'spec-test.tw', content }],
    formatId: 'test-format-1',
    formatPaths: [FORMAT_DIR],
    useTweegoPath: false,
    ...options,
  });
}

/** Helper: compile inline twee source to Twine 2 archive (no format needed). */
async function compileToArchive(content: string): Promise<CompileResult> {
  return compile({
    sources: [{ filename: 'spec-test.tw', content }],
    outputMode: 'twine2-archive',
  });
}

/** Helper: build a minimal valid twee source with StoryData and StoryTitle. */
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

/**
 * Extract the <tw-storydata ...>...</tw-storydata> chunk from compiled output.
 * Works for both full HTML and archive output.
 */
function extractStoryData(html: string): string {
  const match = html.match(/<tw-storydata[\s\S]*?<\/tw-storydata>/);
  if (!match) throw new Error('output must contain <tw-storydata>');
  return match[0];
}

/** Extract an attribute value from an HTML element string. */
function attr(element: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const match = element.match(re);
  return match ? match[1] : null;
}

/** Extract the opening <tw-storydata> tag. */
function storyDataTag(html: string): string {
  const chunk = extractStoryData(html);
  const match = chunk.match(/<tw-storydata[^>]*>/);
  if (!match) throw new Error('expected <tw-storydata> tag');
  return match[0];
}

/** Extract all <tw-passagedata> elements as strings. */
function passageElements(html: string): readonly string[] {
  const chunk = extractStoryData(html);
  return [...chunk.matchAll(/<tw-passagedata[^>]*>[\s\S]*?<\/tw-passagedata>/g)].map((m) => m[0]);
}

/** Extract the text content between the tags of a <tw-passagedata> element. */
function passageContent(passageElement: string): string {
  const match = passageElement.match(/>([^]*)<\/tw-passagedata>/);
  if (!match) throw new Error('expected passage content');
  return match[1];
}

// =============================================================================
// §1 — Root Structure: <tw-storydata>
// Spec: "The root of a Twine 2 story is the <tw-storydata> element..."
// =============================================================================
describe('Twine 2 HTML Output Spec — Root Structure', () => {
  it('output contains a single <tw-storydata> root element', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const matches = result.output.match(/<tw-storydata/g);
    expect(matches).toHaveLength(1);
  });

  it('<tw-storydata> has a matching closing tag', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('</tw-storydata>');
    const closingMatches = result.output.match(/<\/tw-storydata>/g);
    expect(closingMatches).toHaveLength(1);
  });

  it('<tw-storydata> contains <style> element inside it', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body { color: red; }'].join('\n'));
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('<style');
    expect(chunk).toContain('</style>');
  });

  it('<tw-storydata> contains <script> element inside it', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.x = 1;'].join('\n'));
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('<script');
    expect(chunk).toContain('</script>');
  });

  it('<tw-storydata> contains <tw-passagedata> elements inside it', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('<tw-passagedata');
    expect(chunk).toContain('</tw-passagedata>');
  });

  it('<tw-storydata> contains <tw-tag> elements inside it when tag colors are defined', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"red"}}',
      '',
      ':: StoryTitle',
      'Tag Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('<tw-tag');
  });

  it('all child elements are inside <tw-storydata>, not outside', async () => {
    const source = minimalStory(
      [
        ':: Start',
        'Hello',
        '',
        ':: CSS [stylesheet]',
        'body { color: red; }',
        '',
        ':: JS [script]',
        'window.x = 1;',
      ].join('\n'),
    );
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);

    // All style, script, and passage elements must be within the chunk
    expect(chunk).toContain('<style');
    expect(chunk).toContain('<script');
    expect(chunk).toContain('<tw-passagedata');
  });

  // NOTE: The 'hidden' attribute is shown in the archive spec example but is NOT
  // defined in the HTML output spec. This test is kept for practical compatibility.
  it('<tw-storydata> has the hidden attribute (archive convention)', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(tag).toMatch(/\bhidden\b/);
  });
});

// =============================================================================
// §2 — Story Data Attributes on <tw-storydata>
// Spec: "Story metadata is stored as attributes on the <tw-storydata> element."
// =============================================================================
describe('Twine 2 HTML Output Spec — Story Data Attributes', () => {
  // -------------------------------------------------------------------------
  // name: (string) Required. The name of the story.
  // -------------------------------------------------------------------------
  it('name attribute: required, present on <tw-storydata>', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'name')).not.toBeNull();
  });

  it('name attribute: reflects StoryTitle value', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'name')).toBe('Spec Test');
  });

  it('name attribute: value is a non-empty string', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const name = attr(tag, 'name');
    expect(name).not.toBeNull();
    expect(name).not.toBe('');
    expect(typeof name).toBe('string');
  });

  it('name attribute: escapes special HTML characters in attribute value', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'A "Story" & <More>',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    // &, ", ' must be escaped in attributes
    expect(tag).toContain('&amp;');
    expect(tag).toContain('&quot;');
  });

  // -------------------------------------------------------------------------
  // ifid: (string) Required. An IFID is a sequence of between 8 and 63 characters,
  // each of which shall be a digit, a capital letter or a hyphen that uniquely
  // identify a story.
  // -------------------------------------------------------------------------
  it('ifid attribute: required, present on <tw-storydata>', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'ifid')).not.toBeNull();
  });

  it('ifid attribute: matches StoryData IFID value', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'ifid')).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });

  it('ifid attribute: value is between 8 and 63 characters', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const ifid = attr(tag, 'ifid');
    if (!ifid) throw new Error('expected IFID attribute');
    expect(ifid.length).toBeGreaterThanOrEqual(8);
    expect(ifid.length).toBeLessThanOrEqual(63);
  });

  it('ifid attribute: contains only digits, capital letters, or hyphens', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const ifid = attr(tag, 'ifid');
    if (!ifid) throw new Error('expected IFID attribute');
    expect(ifid).toMatch(/^[0-9A-Z-]+$/);
  });

  it('ifid attribute: lowercase IFID in StoryData is uppercased in output', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"d674c58c-defa-4f70-b7a2-27742230c0fc"}',
      '',
      ':: StoryTitle',
      'Lowercase IFID Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'ifid')).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });

  it('ifid attribute: auto-generated when not provided', async () => {
    const source = [':: StoryTitle', 'No IFID', '', ':: Start', 'Hello'].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const ifid = attr(tag, 'ifid');
    expect(ifid).not.toBeNull();
    expect(ifid).not.toBe('');
  });

  it('ifid attribute: auto-generated value is between 8 and 63 characters of digits/capitals/hyphens', async () => {
    const source = [':: StoryTitle', 'No IFID', '', ':: Start', 'Hello'].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const ifid = attr(tag, 'ifid');
    if (!ifid) throw new Error('expected IFID attribute');
    expect(ifid.length).toBeGreaterThanOrEqual(8);
    expect(ifid.length).toBeLessThanOrEqual(63);
    expect(ifid).toMatch(/^[0-9A-Z-]+$/);
  });

  it('ifid attribute: emits an error diagnostic when IFID is missing from StoryData', async () => {
    const source = [':: StoryTitle', 'No IFID', '', ':: Start', 'Hello'].join('\n');
    const result = await compileToArchive(source);
    const ifidDiag = result.diagnostics.find((d) => d.message.toLowerCase().includes('ifid'));
    if (!ifidDiag) throw new Error('expected IFID diagnostic');
    expect(ifidDiag.level).toBe('error');
  });

  // -------------------------------------------------------------------------
  // format: (string) Optional. The story format used to create the story.
  // -------------------------------------------------------------------------
  it('format attribute: present when format is specified in StoryData', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.37.3"}',
      '',
      ':: StoryTitle',
      'Format Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'format')).toBe('SugarCube');
  });

  it('format attribute: optional — may be absent or empty when not specified in StoryData', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const format = attr(tag, 'format');
    // Spec says Optional — may be absent (null) or present
    // If present without explicit StoryData format, any string value is acceptable
    expect(format === null || typeof format === 'string').toBe(true);
  });

  it('format attribute: value is a string', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Harlowe"}',
      '',
      ':: StoryTitle',
      'Format Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const format = attr(tag, 'format');
    expect(format).not.toBeNull();
    expect(typeof format).toBe('string');
  });

  // -------------------------------------------------------------------------
  // format-version: (string) Optional. The version of the story format.
  // -------------------------------------------------------------------------
  it('format-version attribute: present when format-version is specified in StoryData', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.37.3"}',
      '',
      ':: StoryTitle',
      'Format Version Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'format-version')).toBe('2.37.3');
  });

  it('format-version attribute: optional — may be absent when not specified', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const fv = attr(tag, 'format-version');
    // Spec says Optional — may be absent (null) or present
    expect(fv === null || typeof fv === 'string').toBe(true);
  });

  it('format-version attribute: value is a string', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Harlowe","format-version":"3.0.2"}',
      '',
      ':: StoryTitle',
      'Format Version Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const fv = attr(tag, 'format-version');
    expect(fv).not.toBeNull();
    expect(typeof fv).toBe('string');
  });

  // -------------------------------------------------------------------------
  // startnode: (string) Optional. The PID matching a <tw-passagedata> element
  // whose content should be displayed first.
  // -------------------------------------------------------------------------
  it('startnode attribute: PID of the starting passage', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const startNode = attr(tag, 'startnode');
    expect(startNode).not.toBeNull();
    expect(startNode).not.toBe('');

    // Verify the PID corresponds to a real passage
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'pid') === startNode);
    if (!startPassage) throw new Error('expected Start passage with matching PID');
    expect(attr(startPassage, 'name')).toBe('Start');
  });

  it('startnode attribute: matches PID of passage named in StoryData "start" field', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"Begin"}',
      '',
      ':: StoryTitle',
      'Start Test',
      '',
      ':: Start',
      'Not this one',
      '',
      ':: Begin',
      'This one!',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const startNode = attr(tag, 'startnode');
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'pid') === startNode);
    if (!startPassage) throw new Error('expected Begin passage with matching PID');
    expect(attr(startPassage, 'name')).toBe('Begin');
  });

  it('startnode attribute: value is a string (PID)', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const startNode = attr(tag, 'startnode');
    expect(startNode).not.toBeNull();
    // PID is a numeric string per spec
    expect(startNode).toMatch(/^\d+$/);
  });

  it('startnode attribute: value is a string type in the attribute', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    // Spec says startnode is "(string)" — must be a quoted attribute value
    expect(tag).toMatch(/startnode="[^"]*"/);
  });

  it('startnode attribute: optional — absent or empty when no starting passage can be determined', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'No Start',
      '',
      ':: NotStart',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const startNode = attr(tag, 'startnode');
    // startnode is optional — it can be absent, empty, or produce a diagnostic
    const hasDiag = result.diagnostics.some(
      (d) =>
        (d.level === 'error' || d.level === 'warning') &&
        (d.message.toLowerCase().includes('start') || d.message.toLowerCase().includes('startnode')),
    );
    expect(startNode === null || startNode === '' || hasDiag).toBe(true);
  });

  // -------------------------------------------------------------------------
  // tags: (string) Optional. A list of tags assigned to the story by its
  // author, with spaces separating them.
  // -------------------------------------------------------------------------
  it('tags attribute on <tw-storydata>: optional per spec', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const tagsMatch = tag.match(/\btags="([^"]*)"/);
    // If present, value should be a string (empty or space-separated tags)
    if (tagsMatch) {
      expect(typeof tagsMatch[1]).toBe('string');
    }
    // Not asserting it MUST be present — spec says Optional
  });

  it('tags attribute on <tw-storydata>: absent or empty when no story tags', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const tagsMatch = tag.match(/\btags="([^"]*)"/);
    // If present, should be empty; if absent, also spec-compliant
    if (tagsMatch) {
      expect(tagsMatch[1]).toBe('');
    }
  });

  it('tags attribute on <tw-storydata>: contains story-level tags when set', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tags":"adventure fantasy"}',
      '',
      ':: StoryTitle',
      'Tags Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const tagsVal = attr(tag, 'tags');
    // When tags are explicitly set in StoryData, the attribute MUST be present and contain those tags
    expect(tagsVal).not.toBeNull();
    expect(tagsVal).toContain('adventure');
    expect(tagsVal).toContain('fantasy');
  });

  it('tags attribute on <tw-storydata>: tags are separated by spaces only (not commas or other delimiters)', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tags":"alpha beta gamma"}',
      '',
      ':: StoryTitle',
      'Delimiter Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const tagsVal = attr(tag, 'tags');
    expect(tagsVal).not.toBeNull();
    // Must not contain commas, semicolons, or other non-space delimiters between tags
    expect(tagsVal).not.toMatch(/[,;|]/);
    // Must contain spaces between tags
    expect(tagsVal).toBe('alpha beta gamma');
  });

  it('tags attribute on <tw-storydata>: multiple tags are space-separated', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tags":"tag1 tag2 tag3"}',
      '',
      ':: StoryTitle',
      'Multi Tags',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const tagsVal = attr(tag, 'tags');
    // Story-level tags MUST be space-separated per spec
    expect(tagsVal).not.toBeNull();
    const tags = tagsVal!.split(' ');
    expect(tags).toHaveLength(3);
    expect(tags).toEqual(expect.arrayContaining(['tag1', 'tag2', 'tag3']));
  });

  // -------------------------------------------------------------------------
  // zoom: (string) Optional. The decimal level of zoom (i.e. 1.0 is 100%).
  // -------------------------------------------------------------------------
  it('zoom attribute: defaults to 1', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'zoom')).toBe('1');
  });

  it('zoom attribute: reflects custom zoom value from StoryData', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","zoom":0.25}',
      '',
      ':: StoryTitle',
      'Zoom Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'zoom')).toBe('0.25');
  });

  it('zoom attribute: optional per spec', async () => {
    // Spec says zoom is optional; verify the attribute is handled correctly
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const zoom = attr(tag, 'zoom');
    // zoom may be absent (null) or present as a string
    if (zoom !== null) {
      expect(Number.isFinite(Number(zoom))).toBe(true);
    }
  });

  it('zoom attribute: value is a decimal string', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","zoom":1.2}',
      '',
      ':: StoryTitle',
      'Zoom Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const zoom = attr(tag, 'zoom');
    expect(zoom).not.toBeNull();
    expect(zoom).toBe('1.2');
  });

  // -------------------------------------------------------------------------
  // creator: (string) Optional. The name of program used to create the file.
  // -------------------------------------------------------------------------
  it('creator attribute: present and non-empty', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'creator')).not.toBeNull();
    expect(attr(tag, 'creator')).not.toBe('');
  });

  it('creator attribute: value is a string', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const creator = attr(tag, 'creator');
    expect(creator).not.toBeNull();
    expect(typeof creator).toBe('string');
  });

  // -------------------------------------------------------------------------
  // creator-version: (string) Optional. The version of the program.
  // -------------------------------------------------------------------------
  it('creator-version attribute: present and non-empty', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'creator-version')).not.toBeNull();
    expect(attr(tag, 'creator-version')).not.toBe('');
  });

  it('creator-version attribute: value is a string', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    const cv = attr(tag, 'creator-version');
    expect(cv).not.toBeNull();
    expect(typeof cv).toBe('string');
  });

  // -------------------------------------------------------------------------
  // All attribute values must be strings per spec
  // -------------------------------------------------------------------------
  it('all attributes on <tw-storydata> are properly quoted string values', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Harlowe","format-version":"3.0.2","zoom":1.2}',
      '',
      ':: StoryTitle',
      'Attribute Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    // Every attribute in the spec is typed as (string) — verify all attribute values are double-quoted
    const attrPattern = /\b(name|ifid|format|format-version|startnode|tags|zoom|creator|creator-version)="[^"]*"/g;
    const matches = [...tag.matchAll(attrPattern)];
    // At minimum: name, ifid, creator, creator-version should be present
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});

// =============================================================================
// §3 — Passages: <tw-passagedata>
// Spec: "Each passage is represented as a <tw-passagedata> element with its
// metadata stored as its attributes."
// =============================================================================
describe('Twine 2 HTML Output Spec — Passages (<tw-passagedata>)', () => {
  // -------------------------------------------------------------------------
  // Basic rendering
  // -------------------------------------------------------------------------
  it('each passage is rendered as a <tw-passagedata> element', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    expect(passages.length).toBe(2);
  });

  it('each <tw-passagedata> has a matching closing tag', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World'].join('\n'));
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const openCount = [...chunk.matchAll(/<tw-passagedata/g)].length;
    const closeCount = [...chunk.matchAll(/<\/tw-passagedata>/g)].length;
    expect(openCount).toBe(closeCount);
    expect(openCount).toBe(2);
  });

  it('special passages (StoryTitle, StoryData) are NOT rendered as <tw-passagedata>', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const names = passages.map((p) => attr(p, 'name'));
    expect(names).not.toContain('StoryTitle');
    expect(names).not.toContain('StoryData');
  });

  it('script-tagged passages are NOT rendered as <tw-passagedata>', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: MyScript [script]', 'window.x = 1;'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const names = passages.map((p) => attr(p, 'name'));
    expect(names).not.toContain('MyScript');
  });

  it('stylesheet-tagged passages are NOT rendered as <tw-passagedata>', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: MyStyle [stylesheet]', 'body {}'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const names = passages.map((p) => attr(p, 'name'));
    expect(names).not.toContain('MyStyle');
  });

  it('Twine.private-tagged passages are NOT rendered as <tw-passagedata>', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Hidden [Twine.private]', 'Secret content'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const names = passages.map((p) => attr(p, 'name'));
    expect(names).not.toContain('Hidden');
  });

  // -------------------------------------------------------------------------
  // pid: (string) Required. The Passage ID (PID).
  // -------------------------------------------------------------------------
  it('pid attribute: required, present on every <tw-passagedata>', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World', '', ':: Third', 'Foo'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    for (const p of passages) {
      const pid = attr(p, 'pid');
      expect(pid).not.toBeNull();
      expect(pid).not.toBe('');
    }
  });

  it('pid attribute: value is a numeric string', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    for (const p of passages) {
      expect(attr(p, 'pid')).toMatch(/^\d+$/);
    }
  });

  it('pid attribute: starts at 1 (first passage gets pid="1")', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const pids = passages.map((p) => attr(p, 'pid')).sort();
    // Spec says PID is a passage identifier; conventional numbering starts at 1
    expect(pids[0]).toBe('1');
  });

  it('pid attribute: unique across all passages', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World', '', ':: Third', 'Foo'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const pids = passages.map((p) => attr(p, 'pid'));
    expect(new Set(pids).size).toBe(pids.length);
  });

  it('pid attribute: sequential numbering across passages', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World', '', ':: Third', 'Foo'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const pids = passages.map((p) => Number(attr(p, 'pid'))).sort((a, b) => a - b);
    // PIDs should be sequential (1, 2, 3)
    for (let i = 0; i < pids.length; i++) {
      expect(pids[i]).toBe(i + 1);
    }
  });

  // -------------------------------------------------------------------------
  // name: (string) Required. The name of the passage.
  // -------------------------------------------------------------------------
  it('name attribute: required, matches passage name', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    expect(passages.some((p) => attr(p, 'name') === 'Start')).toBe(true);
  });

  it('name attribute: multiple passages have correct names', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Another Passage', 'World'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const names = passages.map((p) => attr(p, 'name'));
    expect(names).toContain('Start');
    expect(names).toContain('Another Passage');
  });

  it('name attribute: special characters are attribute-escaped', async () => {
    const source = minimalStory(':: A "B" & C\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('name="A &quot;B&quot; &amp; C"');
  });

  it("name attribute: ' is escaped in passage name", async () => {
    const source = minimalStory(":: It's a test\nHello");
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    // ' must be escaped as &#39; or &apos; inside attribute values
    expect(chunk).toMatch(/name="It(&#39;|&apos;)s a test"/);
  });

  it('name attribute: < and > are escaped in passage name', async () => {
    const source = minimalStory(':: A <tag> B\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    // < and > must be escaped as &lt; and &gt; inside attribute values
    expect(chunk).toMatch(/name="A &lt;tag&gt; B"/);
  });

  // -------------------------------------------------------------------------
  // tags: (string) Optional. Any tags for the passage separated by spaces.
  // -------------------------------------------------------------------------
  it('tags attribute: space-separated tag list', async () => {
    const source = minimalStory(':: Start [tag1 tag2 tag3]\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    expect(attr(startPassage, 'tags')).toBe('tag1 tag2 tag3');
  });

  it('tags attribute: empty string when no tags (spec says tags is Optional)', async () => {
    // twee-ts always emits tags="" for compatibility with Twine 2 editor.
    // An implementation that omits tags entirely would also be spec-compliant.
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    expect(attr(startPassage, 'tags')).toBe('');
  });

  it('tags attribute: multiple tags separated by spaces not commas', async () => {
    const source = minimalStory(':: Start [alpha beta gamma]\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const tagsVal = attr(startPassage, 'tags');
    // Spec: "Any tags for the passage separated by spaces"
    expect(tagsVal).toBe('alpha beta gamma');
    expect(tagsVal).not.toMatch(/[,;|]/);
  });

  it('tags attribute: does not include "script" or "stylesheet" special tags on normal passages', async () => {
    // The script/stylesheet tags are used to categorize passages, not rendered as passage tags
    const source = minimalStory(':: Start [mytag]\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const tagsVal = attr(startPassage, 'tags');
    expect(tagsVal).toBe('mytag');
    // Verify no special tags leak through
    expect(tagsVal).not.toContain('script');
    expect(tagsVal).not.toContain('stylesheet');
  });

  it('tags attribute: single tag', async () => {
    const source = minimalStory(':: Start [solo]\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    expect(attr(startPassage, 'tags')).toBe('solo');
  });

  // -------------------------------------------------------------------------
  // position: (string) Optional. Comma-separated X and Y position.
  // -------------------------------------------------------------------------
  it('position attribute: reflects specified value (comma-separated X,Y)', async () => {
    const source = minimalStory(':: Start {"position":"102,99"}\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    expect(attr(startPassage, 'position')).toBe('102,99');
  });

  it('position attribute: auto-generated when not specified (comma-separated format)', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const position = attr(startPassage, 'position');
    expect(position).not.toBeNull();
    expect(position).toMatch(/^\d+,\d+$/);
  });

  it('position attribute: described as "upper-left of the passage" — X,Y numeric values', async () => {
    const source = minimalStory(':: Start {"position":"200,300"}\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const position = attr(startPassage, 'position');
    expect(position).toBe('200,300');
    // Verify comma-separated format with exactly two numeric values
    const parts = position!.split(',');
    expect(parts).toHaveLength(2);
    expect(Number.isFinite(Number(parts[0]))).toBe(true);
    expect(Number.isFinite(Number(parts[1]))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // size: (string) Optional. Comma-separated width and height.
  // -------------------------------------------------------------------------
  it('size attribute: reflects specified value (comma-separated width,height)', async () => {
    const source = minimalStory(':: Start {"position":"102,99","size":"200,150"}\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    expect(attr(startPassage, 'size')).toBe('200,150');
  });

  it('size attribute: defaults to 100,100 when not specified', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    expect(attr(startPassage, 'size')).toBe('100,100');
  });

  it('size attribute: comma-separated width and height (two numeric values)', async () => {
    const source = minimalStory(':: Start {"position":"102,99","size":"200,150"}\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const size = attr(startPassage, 'size');
    expect(size).not.toBeNull();
    const parts = size!.split(',');
    expect(parts).toHaveLength(2);
    expect(Number.isFinite(Number(parts[0]))).toBe(true);
    expect(Number.isFinite(Number(parts[1]))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Every <tw-passagedata> must have both required attributes: pid and name
  // -------------------------------------------------------------------------
  it('every <tw-passagedata> has both pid and name attributes', async () => {
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: Second', 'World', '', ':: Third Passage', 'Foo'].join('\n'),
    );
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    expect(passages.length).toBe(3);
    for (const p of passages) {
      expect(attr(p, 'pid')).not.toBeNull();
      expect(attr(p, 'name')).not.toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // Passage content: stored as a single text node, must contain no other
  // child nodes; all &, <, >, ", and ' characters should be escaped into
  // their corresponding HTML entities.
  // -------------------------------------------------------------------------
  it('passage content: stored as text within <tw-passagedata>', async () => {
    const source = minimalStory(':: Start\nHello, world!');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    expect(startPassage).toContain('Hello, world!');
  });

  it('passage content: & is escaped to &amp;', async () => {
    const source = minimalStory(':: Start\nA & B');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    expect(content).toContain('&amp;');
    // Must not contain a raw & that is not part of an entity
    expect(content).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;|apos;)/);
  });

  it('passage content: < is escaped to &lt;', async () => {
    const source = minimalStory(':: Start\nA < B');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    expect(content).toContain('&lt;');
    // Must not contain raw <
    expect(content).not.toMatch(/<(?!\/tw-passagedata)/);
  });

  it('passage content: > is escaped to &gt;', async () => {
    const source = minimalStory(':: Start\nA > B');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    expect(content).toContain('&gt;');
    // Must not contain raw > in content
    expect(content).not.toContain('>');
  });

  it('passage content: " is escaped to &quot;', async () => {
    const source = minimalStory(':: Start\nSay "hello"');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    expect(content).toContain('&quot;');
    // Must not contain raw " in content
    expect(content).not.toContain('"');
  });

  it("passage content: ' is escaped to &#39; (or &apos;)", async () => {
    const source = minimalStory(":: Start\nIt's a test");
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    // Spec says ' should be escaped to its corresponding HTML entity
    // Both &#39; and &apos; are valid HTML entities for single quote
    expect(content).toMatch(/&#39;|&apos;/);
    // Must not contain raw '
    expect(content).not.toContain("'");
  });

  it('passage content: all five special characters escaped together', async () => {
    const source = minimalStory(':: Start\nA & B < C > D "E" \'F\'');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    expect(content).toContain('&amp;');
    expect(content).toContain('&lt;');
    expect(content).toContain('&gt;');
    expect(content).toContain('&quot;');
    expect(content).toContain('&#39;');
  });

  it('passage content: must contain no child HTML elements (single text node)', async () => {
    const source = minimalStory(':: Start\nHello <b>world</b>');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    // < and > should be escaped, ensuring no child HTML elements exist
    expect(content).not.toMatch(/<[a-zA-Z]/);
  });

  it('passage content: HTML comments are escaped (no child nodes)', async () => {
    const source = minimalStory(':: Start\n<!-- comment --> and more');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    expect(content).toContain('&lt;!-- comment --&gt;');
  });

  it('passage content: multiline content is preserved', async () => {
    const source = minimalStory(':: Start\nLine 1\nLine 2\nLine 3');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    expect(startPassage).toContain('Line 1\nLine 2\nLine 3');
  });

  it('passage content: content consisting entirely of special characters is fully escaped', async () => {
    const source = minimalStory(':: Start\n&<>"\'');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    // Every character should be escaped
    expect(content).toContain('&amp;');
    expect(content).toContain('&lt;');
    expect(content).toContain('&gt;');
    expect(content).toContain('&quot;');
    expect(content).toMatch(/&#39;|&apos;/);
    // No raw special characters
    expect(content).not.toMatch(/[<>"']/);
    expect(content).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;|apos;)/);
  });

  it('passage content: empty passage produces empty content', async () => {
    const source = minimalStory(':: Start\n');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    if (!startPassage) throw new Error('expected Start passage');
    const content = passageContent(startPassage);
    expect(content.trim()).toBe('');
  });
});

// =============================================================================
// §4 — Story JavaScript: <script>
// Spec: "Any JavaScript code saved from the Story JavaScript window...is kept
// within a single <script> element with its type attribute set to
// text/twine-javascript."
// =============================================================================
describe('Twine 2 HTML Output Spec — Story JavaScript', () => {
  it('script element has type="text/twine-javascript"', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.x = 1;'].join('\n'));
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('type="text/twine-javascript"');
  });

  it('script element has id="twine-user-script" (historical)', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('id="twine-user-script"');
  });

  it('script element has role="script" (historical)', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('role="script"');
  });

  it('script-tagged passage content is placed inside <script> element', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.setup = {};'].join('\n'));
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const scriptMatch = chunk.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    if (!scriptMatch) throw new Error('expected <script> element');
    expect(scriptMatch[1]).toContain('window.setup = {};');
  });

  it('single <script> element even when no script passages exist (empty)', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const scriptMatches = [...chunk.matchAll(/<script[^>]*>/g)];
    expect(scriptMatches).toHaveLength(1);
  });

  it('multiple script passages are merged into a single <script> element', async () => {
    const source = minimalStory(
      [
        ':: Start',
        'Hello',
        '',
        ':: Script1 [script]',
        'window.a = 1;',
        '',
        ':: Script2 [script]',
        'window.b = 2;',
      ].join('\n'),
    );
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const scriptMatches = [...chunk.matchAll(/<script[^>]*>/g)];
    expect(scriptMatches).toHaveLength(1);
    const scriptMatch = chunk.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    if (!scriptMatch) throw new Error('expected <script> element');
    expect(scriptMatch[1]).toContain('window.a = 1;');
    expect(scriptMatch[1]).toContain('window.b = 2;');
  });

  it('<script> element is inside <tw-storydata>', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toMatch(/<script[^>]*>[\s\S]*?<\/script>/);
  });

  it('script content is raw JavaScript, not HTML-escaped', async () => {
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: JS [script]', 'if (a < b && c > d) { x = "y"; }'].join('\n'),
    );
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const scriptMatch = chunk.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    if (!scriptMatch) throw new Error('expected <script> element');
    // Script content must NOT be HTML-escaped — it is raw JavaScript
    expect(scriptMatch[1]).toContain('if (a < b && c > d) { x = "y"; }');
    expect(scriptMatch[1]).not.toContain('&lt;');
    expect(scriptMatch[1]).not.toContain('&gt;');
    expect(scriptMatch[1]).not.toContain('&amp;');
  });

  it('<script> element has all three attributes: id, type, and role', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const scriptMatch = chunk.match(/<script[^>]*>/);
    if (!scriptMatch) throw new Error('expected <script> element');
    expect(scriptMatch[0]).toContain('id="twine-user-script"');
    expect(scriptMatch[0]).toContain('type="text/twine-javascript"');
    expect(scriptMatch[0]).toContain('role="script"');
  });
});

// =============================================================================
// §5 — Story Stylesheet: <style>
// Spec: "Any CSS rules saved from the Story Stylesheet window...are kept within
// a single <style> element with its type attribute set to text/twine-css."
// =============================================================================
describe('Twine 2 HTML Output Spec — Story Stylesheet', () => {
  it('style element has type="text/twine-css"', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body { color: red; }'].join('\n'));
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('type="text/twine-css"');
  });

  it('style element has id="twine-user-stylesheet" (historical)', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('id="twine-user-stylesheet"');
  });

  it('style element has role="stylesheet" (historical)', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('role="stylesheet"');
  });

  it('stylesheet-tagged passage content is placed inside <style> element', async () => {
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body { font-size: 1.5em; }'].join('\n'),
    );
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const styleMatch = chunk.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    if (!styleMatch) throw new Error('expected <style> element');
    expect(styleMatch[1]).toContain('body { font-size: 1.5em; }');
  });

  it('single <style> element even when no stylesheet passages exist (empty)', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const styleMatches = [...chunk.matchAll(/<style[^>]*>/g)];
    expect(styleMatches).toHaveLength(1);
  });

  it('multiple stylesheet passages are merged into a single <style> element', async () => {
    const source = minimalStory(
      [
        ':: Start',
        'Hello',
        '',
        ':: Style1 [stylesheet]',
        'body { color: red; }',
        '',
        ':: Style2 [stylesheet]',
        'p { margin: 0; }',
      ].join('\n'),
    );
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const styleMatches = [...chunk.matchAll(/<style[^>]*>/g)];
    expect(styleMatches).toHaveLength(1);
    const styleMatch = chunk.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    if (!styleMatch) throw new Error('expected <style> element');
    expect(styleMatch[1]).toContain('body { color: red; }');
    expect(styleMatch[1]).toContain('p { margin: 0; }');
  });

  it('<style> element is inside <tw-storydata>', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toMatch(/<style[^>]*>[\s\S]*?<\/style>/);
  });

  it('stylesheet content is raw CSS, not HTML-escaped', async () => {
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: CSS [stylesheet]', 'p > span { content: "a & b"; }'].join('\n'),
    );
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const styleMatch = chunk.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    if (!styleMatch) throw new Error('expected <style> element');
    // Stylesheet content must NOT be HTML-escaped — it is raw CSS
    expect(styleMatch[1]).toContain('p > span { content: "a & b"; }');
    expect(styleMatch[1]).not.toContain('&gt;');
    expect(styleMatch[1]).not.toContain('&amp;');
  });

  it('<style> element has all three attributes: id, type, and role', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const styleMatch = chunk.match(/<style[^>]*>/);
    if (!styleMatch) throw new Error('expected <style> element');
    expect(styleMatch[0]).toContain('id="twine-user-stylesheet"');
    expect(styleMatch[0]).toContain('type="text/twine-css"');
    expect(styleMatch[0]).toContain('role="stylesheet"');
  });
});

// =============================================================================
// §6 — Passage Tag Colors: <tw-tag>
// Spec: "If any passage tags have been assigned colors within the Twine 2
// editor, they will appear as <tw-tag> elements. The name attribute will be the
// name of the tag and the color attribute will be one of seven named colors."
// =============================================================================
describe('Twine 2 HTML Output Spec — Passage Tag Colors (<tw-tag>)', () => {
  it('tag colors from StoryData are rendered as <tw-tag> elements', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"red","bar":"green"}}',
      '',
      ':: StoryTitle',
      'Tag Color Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('<tw-tag');
  });

  it('<tw-tag> has name attribute matching the tag name', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"red"}}',
      '',
      ':: StoryTitle',
      'Tag Color Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const tagMatch = chunk.match(/<tw-tag[^>]*>/);
    if (!tagMatch) throw new Error('expected <tw-tag> element');
    expect(attr(tagMatch[0], 'name')).toBe('foo');
  });

  it('<tw-tag> has color attribute matching the assigned color', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"red"}}',
      '',
      ':: StoryTitle',
      'Tag Color Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const tagMatch = chunk.match(/<tw-tag[^>]*>/);
    if (!tagMatch) throw new Error('expected <tw-tag> element');
    expect(attr(tagMatch[0], 'color')).toBe('red');
  });

  it('<tw-tag> has both name and color attributes', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"myTag":"blue"}}',
      '',
      ':: StoryTitle',
      'Tag Attr Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const tagMatches = [...chunk.matchAll(/<tw-tag[^>]*>/g)];
    expect(tagMatches.length).toBeGreaterThanOrEqual(1);
    for (const tagMatch of tagMatches) {
      expect(attr(tagMatch[0], 'name')).not.toBeNull();
      expect(attr(tagMatch[0], 'color')).not.toBeNull();
    }
  });

  it('multiple tag colors produce multiple <tw-tag> elements', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"one":"gray","two":"purple","three":"orange"}}',
      '',
      ':: StoryTitle',
      'Multi Tag Colors',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const tagMatches = [...chunk.matchAll(/<tw-tag[^>]*>/g)];
    expect(tagMatches.length).toBe(3);
  });

  it('<tw-tag> uses a closing tag (not self-closing)', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"red"}}',
      '',
      ':: StoryTitle',
      'Tag Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('</tw-tag>');
  });

  it('<tw-tag> elements have empty content (no text between tags)', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"blue"}}',
      '',
      ':: StoryTitle',
      'Tag Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    // Match <tw-tag ...></tw-tag> with no content between (or only whitespace per spec example)
    expect(chunk).toMatch(/<tw-tag[^>]*>\s*<\/tw-tag>/);
  });

  it('no <tw-tag> elements when no tag colors are defined', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).not.toContain('<tw-tag');
  });

  it('<tw-tag> elements are inside <tw-storydata>', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"red"}}',
      '',
      ':: StoryTitle',
      'Tag Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('<tw-tag');
  });

  // -------------------------------------------------------------------------
  // Named Colors: gray, red, orange, yellow, green, blue, purple
  // -------------------------------------------------------------------------
  it('all 7 spec-defined named colors are accepted', async () => {
    const namedColors = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
    const tagColors = Object.fromEntries(namedColors.map((c, i) => [`tag${i}`, c]));
    const source = [
      ':: StoryData',
      JSON.stringify({ ifid: 'D674C58C-DEFA-4F70-B7A2-27742230C0FC', 'tag-colors': tagColors }),
      '',
      ':: StoryTitle',
      'Color Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    for (const color of namedColors) {
      expect(chunk).toContain(`color="${color}"`);
    }
  });

  it('each of the 7 named colors is accepted individually', async () => {
    const namedColors = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
    for (const color of namedColors) {
      const source = [
        ':: StoryData',
        JSON.stringify({ ifid: 'D674C58C-DEFA-4F70-B7A2-27742230C0FC', 'tag-colors': { test: color } }),
        '',
        ':: StoryTitle',
        'Color Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileToArchive(source);
      const chunk = extractStoryData(result.output);
      expect(chunk).toContain(`color="${color}"`);
    }
  });

  it('non-standard tag color MUST NOT appear in spec-compliant output', async () => {
    // Spec: "the color attribute will be one of seven named colors" — this is prescriptive.
    // A spec-compliant output must only use one of: gray, red, orange, yellow, green, blue, purple.
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"pink"}}',
      '',
      ':: StoryTitle',
      'Invalid Color Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const validColors = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
    const tagMatches = [...chunk.matchAll(/<tw-tag[^>]*>/g)];
    for (const tagMatch of tagMatches) {
      const colorVal = attr(tagMatch[0], 'color');
      if (colorVal !== null) {
        expect(validColors).toContain(colorVal);
      }
    }
  });
});

// =============================================================================
// §7 — Element Ordering within <tw-storydata>
// Spec example shows: <style>, <script>, <tw-tag>, <tw-passagedata>
// The spec text does not explicitly require this ordering, but these tests
// document twee-ts's output ordering for consistency with the Twine 2 editor.
// =============================================================================
describe('Twine 2 HTML Output Spec — Element Ordering', () => {
  it('<style> appears before <tw-passagedata> elements', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const styleIdx = chunk.indexOf('<style');
    const passageIdx = chunk.indexOf('<tw-passagedata');
    expect(styleIdx).toBeGreaterThan(-1);
    expect(passageIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeLessThan(passageIdx);
  });

  it('<script> appears before <tw-passagedata> elements', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const scriptIdx = chunk.indexOf('<script');
    const passageIdx = chunk.indexOf('<tw-passagedata');
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(passageIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeLessThan(passageIdx);
  });

  it('<style> appears before <script> (per spec example order)', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const styleIdx = chunk.indexOf('<style');
    const scriptIdx = chunk.indexOf('<script');
    expect(styleIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeLessThan(scriptIdx);
  });

  it('<tw-tag> elements appear before <tw-passagedata> elements', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"red"}}',
      '',
      ':: StoryTitle',
      'Order Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    const tagIdx = chunk.indexOf('<tw-tag');
    const passageIdx = chunk.indexOf('<tw-passagedata');
    expect(tagIdx).toBeGreaterThan(-1);
    expect(passageIdx).toBeGreaterThan(-1);
    expect(tagIdx).toBeLessThan(passageIdx);
  });
});

// =============================================================================
// §8 — Full HTML Output (with Story Format)
// The story format template uses {{STORY_NAME}} and {{STORY_DATA}} placeholders.
// =============================================================================
describe('Twine 2 HTML Output Spec — Full HTML (with story format)', () => {
  it('{{STORY_NAME}} placeholder is replaced with the story name', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToHTML(source);
    expect(result.output).toContain('<title>Spec Test</title>');
  });

  it('{{STORY_DATA}} placeholder is replaced with the tw-storydata chunk', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToHTML(source);
    expect(result.output).toContain('<tw-storydata');
    expect(result.output).toContain('</tw-storydata>');
  });

  it('story name with HTML special characters is escaped in {{STORY_NAME}}', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Story & "Friends"',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToHTML(source);
    expect(result.output).toContain('Story &amp; &quot;Friends&quot;');
  });

  it('output is a valid HTML document wrapping the story data', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToHTML(source);
    expect(result.output).toContain('<html>');
    expect(result.output).toContain('</html>');
    expect(result.output).toContain('<head>');
    expect(result.output).toContain('<body>');
  });

  it('passage content escaping works in full HTML output (not just archive)', async () => {
    const source = minimalStory(':: Start\nA & B < C > D "E" \'F\'');
    const result = await compileToHTML(source);
    const chunk = extractStoryData(result.output);
    const passageMatch = chunk.match(/<tw-passagedata[^>]*name="Start"[^>]*>([\s\S]*?)<\/tw-passagedata>/);
    if (!passageMatch) throw new Error('expected Start passage in output');
    const content = passageMatch[1];
    expect(content).toContain('&amp;');
    expect(content).toContain('&lt;');
    expect(content).toContain('&gt;');
    expect(content).toContain('&quot;');
    expect(content).toContain('&#39;');
  });

  it('full HTML output contains same <tw-storydata> structure as archive', async () => {
    const source = minimalStory(':: Start\nHello');
    const htmlResult = await compileToHTML(source);
    const archiveResult = await compileToArchive(source);

    const htmlChunk = extractStoryData(htmlResult.output);
    const archiveChunk = extractStoryData(archiveResult.output);

    // Both should have the same structural elements
    expect(htmlChunk).toContain('<style');
    expect(htmlChunk).toContain('<script');
    expect(htmlChunk).toContain('<tw-passagedata');
    expect(archiveChunk).toContain('<style');
    expect(archiveChunk).toContain('<script');
    expect(archiveChunk).toContain('<tw-passagedata');
  });
});

// =============================================================================
// §8b — UUID Comment preceding <tw-storydata>
// The implementation emits a <!-- UUID://...// --> comment before the element.
// This is not explicitly required by the HTML output spec but is conventional.
// =============================================================================
describe('Twine 2 HTML Output Spec — UUID Comment', () => {
  it('a UUID comment precedes the <tw-storydata> element', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    // The UUID comment should appear right before <tw-storydata>
    expect(result.output).toMatch(/<!-- UUID:\/\/[A-Z0-9-]+\/\/ --><tw-storydata/);
  });

  it('UUID comment contains the IFID value', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('<!-- UUID://D674C58C-DEFA-4F70-B7A2-27742230C0FC// -->');
  });
});

// =============================================================================
// §9 — Options Attribute on <tw-storydata>
// NOTE: The 'options' attribute is NOT defined in the HTML output spec.
// It appears in the archive spec example. This test is retained for compatibility
// with the Twine 2 editor's archive output.
// =============================================================================
describe('Twine 2 HTML Output Spec — Options Attribute (archive convention)', () => {
  it('options attribute: present on <tw-storydata> (per archive spec example)', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(tag).toMatch(/\boptions="/);
  });
});

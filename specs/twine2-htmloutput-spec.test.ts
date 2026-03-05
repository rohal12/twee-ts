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
import type { CompileResult } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'test', 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

/** Helper: compile inline twee source to Twine 2 HTML. */
async function compileToHTML(content: string, options: Record<string, unknown> = {}): Promise<CompileResult> {
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
  expect(match, 'output must contain <tw-storydata>').not.toBeNull();
  return match![0];
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
  expect(match).not.toBeNull();
  return match![0];
}

/** Extract all <tw-passagedata> elements as strings. */
function passageElements(html: string): string[] {
  const chunk = extractStoryData(html);
  return [...chunk.matchAll(/<tw-passagedata[^>]*>[\s\S]*?<\/tw-passagedata>/g)].map((m) => m[0]);
}

// =============================================================================
// §1 — Root Structure: <tw-storydata>
// =============================================================================
describe('Twine 2 HTML Output Spec — Root Structure', () => {
  it('output contains a single <tw-storydata> root element', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const matches = result.output.match(/<tw-storydata/g);
    expect(matches).toHaveLength(1);
    expect(result.output).toContain('</tw-storydata>');
  });

  it('<tw-storydata> wraps <style>, <script>, <tw-tag>, and <tw-passagedata> elements', async () => {
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

    expect(chunk).toContain('<style');
    expect(chunk).toContain('<script');
    expect(chunk).toContain('<tw-passagedata');
  });

  it('<tw-storydata> has the hidden attribute', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(tag).toContain('hidden');
  });
});

// =============================================================================
// §2 — Story Data Attributes on <tw-storydata>
// =============================================================================
describe('Twine 2 HTML Output Spec — Story Data Attributes', () => {
  it('name attribute: required, reflects StoryTitle', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'name')).toBe('Spec Test');
  });

  it('ifid attribute: required, matches StoryData IFID', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'ifid')).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });

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
    expect(startPassage).toBeDefined();
    expect(attr(startPassage!, 'name')).toBe('Start');
  });

  it('startnode matches the passage named in StoryData "start" field', async () => {
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
    expect(startPassage).toBeDefined();
    expect(attr(startPassage!, 'name')).toBe('Begin');
  });

  it('zoom attribute: defaults to 1', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'zoom')).toBe('1');
  });

  it('zoom attribute: reflects custom zoom value', async () => {
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

  it('creator attribute: present on output', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'creator')).not.toBeNull();
    expect(attr(tag, 'creator')).not.toBe('');
  });

  it('creator-version attribute: present on output', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tag = storyDataTag(result.output);
    expect(attr(tag, 'creator-version')).not.toBeNull();
    expect(attr(tag, 'creator-version')).not.toBe('');
  });

  it('name attribute escapes special HTML characters', async () => {
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
    // Attribute values should have &, ", ' escaped; < and > are not escaped in attrEscape
    expect(tag).toContain('name="A &quot;Story&quot; &amp;');
    expect(tag).toContain('&amp;');
  });
});

// =============================================================================
// §3 — Passages: <tw-passagedata>
// =============================================================================
describe('Twine 2 HTML Output Spec — Passages (<tw-passagedata>)', () => {
  it('each passage rendered as <tw-passagedata> element', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    expect(passages.length).toBe(2);
  });

  it('pid attribute: required, unique integer', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World', '', ':: Third', 'Foo'].join('\n'));
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const pids = passages.map((p) => attr(p, 'pid'));
    // All PIDs must be present
    for (const pid of pids) {
      expect(pid).not.toBeNull();
      expect(pid).toMatch(/^\d+$/);
    }
    // All PIDs must be unique
    expect(new Set(pids).size).toBe(pids.length);
  });

  it('name attribute: required, matches passage name', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    expect(passages.some((p) => attr(p, 'name') === 'Start')).toBe(true);
  });

  it('tags attribute: space-separated tag list', async () => {
    const source = minimalStory(':: Start [tag1 tag2 tag3]\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    expect(attr(startPassage!, 'tags')).toBe('tag1 tag2 tag3');
  });

  it('tags attribute: empty string when no tags', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    expect(attr(startPassage!, 'tags')).toBe('');
  });

  it('position attribute: present (comma-separated X,Y)', async () => {
    const source = minimalStory(':: Start {"position":"102,99"}\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    expect(attr(startPassage!, 'position')).toBe('102,99');
  });

  it('position attribute: auto-generated when not specified', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    const position = attr(startPassage!, 'position');
    expect(position).not.toBeNull();
    expect(position).toMatch(/^\d+,\d+$/);
  });

  it('size attribute: present (comma-separated width,height)', async () => {
    const source = minimalStory(':: Start {"position":"102,99","size":"200,150"}\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    expect(attr(startPassage!, 'size')).toBe('200,150');
  });

  it('size attribute: defaults to 100,100 when not specified', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    expect(attr(startPassage!, 'size')).toBe('100,100');
  });

  it('passage content: stored as text node within <tw-passagedata>', async () => {
    const source = minimalStory(':: Start\nHello, world!');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    expect(startPassage).toContain('Hello, world!');
  });

  it('passage content: & < > " \' are escaped to HTML entities', async () => {
    const source = minimalStory(':: Start\nA & B < C > D "E" \'F\'');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    expect(startPassage).toContain('&amp;');
    expect(startPassage).toContain('&lt;');
    expect(startPassage).toContain('&gt;');
    expect(startPassage).toContain('&quot;');
    expect(startPassage).toContain('&#39;');
    // Should NOT contain raw special characters in content
    expect(startPassage).not.toMatch(/>.*[&](?!amp;|lt;|gt;|quot;|#39;).*</);
  });

  it('passage name with special characters is attribute-escaped', async () => {
    const source = minimalStory(':: A "B" & C\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('name="A &quot;B&quot; &amp; C"');
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
});

// =============================================================================
// §4 — Story JavaScript: <script>
// =============================================================================
describe('Twine 2 HTML Output Spec — Story JavaScript', () => {
  it('script element has type="text/twine-javascript"', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: JS [script]', 'window.x = 1;'].join('\n'));
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('type="text/twine-javascript"');
  });

  it('script element has id="twine-user-script"', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('id="twine-user-script"');
  });

  it('script element has role="script"', async () => {
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
    expect(scriptMatch).not.toBeNull();
    expect(scriptMatch![1]).toContain('window.setup = {};');
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
    expect(scriptMatch![1]).toContain('window.a = 1;');
    expect(scriptMatch![1]).toContain('window.b = 2;');
  });
});

// =============================================================================
// §5 — Story Stylesheet: <style>
// =============================================================================
describe('Twine 2 HTML Output Spec — Story Stylesheet', () => {
  it('style element has type="text/twine-css"', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: CSS [stylesheet]', 'body { color: red; }'].join('\n'));
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('type="text/twine-css"');
  });

  it('style element has id="twine-user-stylesheet"', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).toContain('id="twine-user-stylesheet"');
  });

  it('style element has role="stylesheet"', async () => {
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
    expect(styleMatch).not.toBeNull();
    expect(styleMatch![1]).toContain('body { font-size: 1.5em; }');
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
    expect(styleMatch![1]).toContain('body { color: red; }');
    expect(styleMatch![1]).toContain('p { margin: 0; }');
  });
});

// =============================================================================
// §6 — Passage Tag Colors: <tw-tag>
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
    expect(tagMatch).not.toBeNull();
    expect(attr(tagMatch![0], 'name')).toBe('foo');
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
    expect(tagMatch).not.toBeNull();
    expect(attr(tagMatch![0], 'color')).toBe('red');
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

  it('<tw-tag> elements are self-closing (empty content)', async () => {
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
    expect(chunk).toMatch(/<tw-tag[^>]*><\/tw-tag>/);
  });

  it('no <tw-tag> elements when no tag colors are defined', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const chunk = extractStoryData(result.output);
    expect(chunk).not.toContain('<tw-tag');
  });
});

// =============================================================================
// §7 — Full HTML Output (with Story Format)
// =============================================================================
describe('Twine 2 HTML Output Spec — Full HTML (with story format)', () => {
  it('{{STORY_NAME}} placeholder is replaced with the story name', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToHTML(source);
    // The test format template has {{STORY_NAME}} in <title>
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
});

// =============================================================================
// §8 — Element Ordering within <tw-storydata>
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
// §9 — IFID Generation
// =============================================================================
describe('Twine 2 HTML Output Spec — IFID', () => {
  it('IFID is auto-generated when not provided', async () => {
    const source = [':: StoryTitle', 'No IFID', '', ':: Start', 'Hello'].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const ifid = attr(tag, 'ifid');
    expect(ifid).not.toBeNull();
    expect(ifid).not.toBe('');
    // Must be uppercase hex with hyphens (UUID format)
    expect(ifid).toMatch(/^[0-9A-F-]+$/);
  });

  it('IFID uses uppercase letters (Treaty of Babel compliance)', async () => {
    const source = [':: StoryTitle', 'No IFID', '', ':: Start', 'Hello'].join('\n');
    const result = await compileToArchive(source);
    const tag = storyDataTag(result.output);
    const ifid = attr(tag, 'ifid');
    expect(ifid).toBe(ifid!.toUpperCase());
  });

  it('emits an error when IFID is missing', async () => {
    const source = [':: StoryTitle', 'No IFID', '', ':: Start', 'Hello'].join('\n');
    const result = await compileToArchive(source);
    const ifidDiag = result.diagnostics.find((d) => d.message.toLowerCase().includes('ifid'));
    expect(ifidDiag).toBeDefined();
    expect(ifidDiag!.level).toBe('error');
  });
});

// =============================================================================
// §10 — Multiline Passage Content
// =============================================================================
describe('Twine 2 HTML Output Spec — Multiline Content', () => {
  it('multiline passage content is preserved (HTML-escaped)', async () => {
    const source = minimalStory(':: Start\nLine 1\nLine 2\nLine 3');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    expect(startPassage).toContain('Line 1\nLine 2\nLine 3');
  });

  it('empty passage produces empty <tw-passagedata> content', async () => {
    const source = minimalStory(':: Start\n');
    const result = await compileToArchive(source);
    const passages = passageElements(result.output);
    const startPassage = passages.find((p) => attr(p, 'name') === 'Start');
    expect(startPassage).toBeDefined();
    // Content between tags should be empty
    const contentMatch = startPassage!.match(/>([^]*)<\/tw-passagedata>/);
    expect(contentMatch).not.toBeNull();
    expect(contentMatch![1].trim()).toBe('');
  });
});

/**
 * Twine 2 Archive Specification Compliance Tests (v1.0.0)
 *
 * Tests twee-ts against every requirement in the Twine 2 Archive Specification:
 * https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-archive-spec.md
 *
 * The archive format is a collection of one or more stories, each following
 * the Twine 2 HTML Output Specification, without outer HTML wrapping.
 *
 * Spec text (in full):
 *   "For exporting a library, Twine 2 produces an archive format."
 *   "A library is defined as a collection of one or more stories with each
 *    following the Twine 2 HTML Output Specification."
 *   The example shows two <tw-storydata> blocks separated by a blank line,
 *   each containing <style>, <script>, and <tw-passagedata> child elements.
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import type { CompileResult } from '../src/types.js';

// =============================================================================
// Helpers
// =============================================================================

/** Helper: compile inline twee source to Twine 2 archive. */
async function compileToArchive(content: string): Promise<CompileResult> {
  return compile({
    sources: [{ filename: 'spec-test.tw', content }],
    outputMode: 'twine2-archive',
  });
}

/** Helper: build a minimal valid twee source with a given story name and passages. */
function minimalStory(name: string, passages: string): string {
  return [
    ':: StoryData',
    '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
    '',
    ':: StoryTitle',
    name,
    '',
    passages,
  ].join('\n');
}

/** Helper: extract the first <tw-storydata ...> opening tag from output. */
function extractStoryDataTag(output: string): string {
  const match = output.match(/<tw-storydata[^>]*>/);
  if (!match) throw new Error('Expected <tw-storydata> tag in output');
  return match[0];
}

/** Helper: extract the full <tw-storydata>...</tw-storydata> block from output. */
function extractStoryDataBlock(output: string): string {
  const match = output.match(/<tw-storydata[\s\S]*?<\/tw-storydata>/);
  if (!match) throw new Error('Expected <tw-storydata>...</tw-storydata> block in output');
  return match[0];
}

// =============================================================================
// Spec Requirement: Archive is a collection of <tw-storydata> elements
// "For exporting a library, Twine 2 produces an archive format."
// =============================================================================
describe('Twine 2 Archive Spec -- Archive Structure', () => {
  it('archive output contains a <tw-storydata> element with closing tag', async () => {
    const result = await compileToArchive(minimalStory('Archive Test', ':: Start\nHello'));
    expect(result.output).toContain('<tw-storydata');
    expect(result.output).toContain('</tw-storydata>');
  });

  it('archive output does NOT contain outer <html>, <head>, or <body> wrapping', async () => {
    const result = await compileToArchive(minimalStory('Archive Test', ':: Start\nHello'));
    expect(result.output).not.toContain('<html');
    expect(result.output).not.toContain('</html>');
    expect(result.output).not.toContain('<head');
    expect(result.output).not.toContain('</head>');
    expect(result.output).not.toContain('<body');
    expect(result.output).not.toContain('</body>');
  });

  it('archive output does NOT contain <!DOCTYPE> declaration', async () => {
    const result = await compileToArchive(minimalStory('Archive Test', ':: Start\nHello'));
    expect(result.output.toLowerCase()).not.toContain('<!doctype');
  });

  it('archive output does NOT contain story format template markers', async () => {
    const result = await compileToArchive(minimalStory('Template Test', ':: Start\nHello'));
    expect(result.output).not.toContain('{{STORY_NAME}}');
    expect(result.output).not.toContain('{{STORY_DATA}}');
  });

  it('archive output does NOT contain <title> element', async () => {
    const result = await compileToArchive(minimalStory('Title Test', ':: Start\nHello'));
    expect(result.output).not.toContain('<title');
    expect(result.output).not.toContain('</title>');
  });

  it('archive output consists only of <tw-storydata> blocks (plus optional comments/whitespace)', async () => {
    const result = await compileToArchive(minimalStory('Structure Test', ':: Start\nHello'));
    const trimmed = result.output.trim();
    // After removing comments and whitespace, the output should start with <tw-storydata
    expect(trimmed).toMatch(/^(<!--[\s\S]*?-->\s*)?<tw-storydata/);
    // And end with </tw-storydata>
    expect(trimmed).toMatch(/<\/tw-storydata>$/);
  });

  it('archive output ends with a trailing newline for clean concatenation', async () => {
    const result = await compileToArchive(minimalStory('Newline Test', ':: Start\nHello'));
    expect(result.output.endsWith('\n')).toBe(true);
  });

  it('archive output contains no content after </tw-storydata> except whitespace', async () => {
    const result = await compileToArchive(minimalStory('Clean End', ':: Start\nHello'));
    const parts = result.output.split('</tw-storydata>');
    const afterClosing = parts[1];
    if (afterClosing === undefined) throw new Error('Expected content after </tw-storydata>');
    expect(afterClosing.trim()).toBe('');
  });
});

// =============================================================================
// Spec Requirement: Each story follows the Twine 2 HTML Output Specification
// "A library is defined as a collection of one or more stories with each
//  following the Twine 2 HTML Output Specification."
//
// The spec example shows these attributes on <tw-storydata>:
//   name, startnode, creator, creator-version, format, format-version,
//   ifid, options, tags, zoom, hidden
// =============================================================================
describe('Twine 2 Archive Spec -- <tw-storydata> Attributes', () => {
  it('has "name" attribute with the story name', async () => {
    const result = await compileToArchive(minimalStory('My Great Story', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    expect(tag).toContain('name="My Great Story"');
  });

  it('has "startnode" attribute with a positive integer value', async () => {
    const result = await compileToArchive(minimalStory('Startnode Test', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    expect(tag).toMatch(/startnode="\d+"/);
    // The startnode must be a positive integer (per spec example: startnode="1")
    const startnodeMatch = tag.match(/startnode="(\d+)"/);
    expect(startnodeMatch).not.toBeNull();
    const startnodeValue = parseInt(startnodeMatch![1]!, 10);
    expect(startnodeValue).toBeGreaterThan(0);
  });

  it('startnode references a pid that exists among <tw-passagedata> elements', async () => {
    const result = await compileToArchive(minimalStory('Startnode Ref', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    const startnodeMatch = tag.match(/startnode="(\d+)"/);
    expect(startnodeMatch).not.toBeNull();
    const startnode = startnodeMatch![1];
    // The startnode value must match one of the pid attributes
    expect(result.output).toContain(`pid="${startnode}"`);
  });

  it('has "creator" attribute', async () => {
    const result = await compileToArchive(minimalStory('Creator Test', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    expect(tag).toMatch(/creator="[^"]+"/);
  });

  it('has "creator-version" attribute', async () => {
    const result = await compileToArchive(minimalStory('Creator Ver', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    expect(tag).toMatch(/creator-version="[^"]+"/);
  });

  it('has "ifid" attribute preserving the story IFID', async () => {
    const result = await compileToArchive(minimalStory('IFID Test', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    expect(tag).toContain('ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"');
  });

  it('has "format" attribute when format is specified', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Harlowe","format-version":"3.3.7"}',
      '',
      ':: StoryTitle',
      'Format Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = extractStoryDataTag(result.output);
    expect(tag).toContain('format="Harlowe"');
  });

  it('has "format-version" attribute when format-version is specified', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Harlowe","format-version":"3.3.7"}',
      '',
      ':: StoryTitle',
      'FmtVer Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = extractStoryDataTag(result.output);
    expect(tag).toContain('format-version="3.3.7"');
  });

  it('has "options" attribute defaulting to empty string (per spec example: options="")', async () => {
    const result = await compileToArchive(minimalStory('Options Test', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    // The spec example explicitly shows options="" (empty string)
    expect(tag).toContain('options=""');
  });

  it('has "tags" attribute defaulting to empty string (per spec example: tags="")', async () => {
    // The spec example explicitly shows tags="" on <tw-storydata>.
    // A spec-compliant archive MUST include this attribute with an empty value by default.
    const result = await compileToArchive(minimalStory('Tags Test', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    expect(tag).toContain('tags=""');
  });

  it('has "zoom" attribute defaulting to "1" (per spec example: zoom="1")', async () => {
    const result = await compileToArchive(minimalStory('Zoom Test', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    // The spec example explicitly shows zoom="1" as the default
    expect(tag).toContain('zoom="1"');
  });

  it('preserves zoom value from StoryData', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","zoom":1.2}',
      '',
      ':: StoryTitle',
      'Zoom Value Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = extractStoryDataTag(result.output);
    expect(tag).toContain('zoom="1.2"');
  });

  it('has "hidden" boolean attribute with no value (per spec example)', async () => {
    const result = await compileToArchive(minimalStory('Hidden Test', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    // The spec example shows "hidden" as a standalone boolean attribute (no ="...")
    // It must be present as a word boundary match (not hidden="something")
    expect(tag).toMatch(/\bhidden\b/);
    // Must NOT have a value assignment — it's a boolean HTML attribute
    expect(tag).not.toMatch(/\bhidden="/);
  });

  it('has "hidden" attribute inside <tw-storydata> opening tag, not elsewhere', async () => {
    const result = await compileToArchive(minimalStory('Hidden Location', ':: Start\nHello'));
    // Extract the opening tag specifically and verify hidden is there
    const tag = extractStoryDataTag(result.output);
    expect(tag).toMatch(/\bhidden\b/);
    // Verify it appears before the closing > of the opening tag
    expect(tag).toMatch(/\bhidden\s*>/);
  });
});

describe('Twine 2 Archive Spec -- <tw-storydata> Complete Attribute Set', () => {
  it('has all attributes shown in the spec example: name, startnode, creator, creator-version, format, format-version, ifid, options, tags, zoom, hidden', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Harlowe","format-version":"3.3.7"}',
      '',
      ':: StoryTitle',
      'Full Attrs Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = extractStoryDataTag(result.output);
    // Every attribute from the spec example must be present
    expect(tag).toMatch(/\bname="/);
    expect(tag).toMatch(/\bstartnode="/);
    expect(tag).toMatch(/\bcreator="/);
    expect(tag).toMatch(/\bcreator-version="/);
    expect(tag).toMatch(/\bformat="/);
    expect(tag).toMatch(/\bformat-version="/);
    expect(tag).toMatch(/\bifid="/);
    expect(tag).toMatch(/\boptions="/);
    expect(tag).toMatch(/\btags="/);
    expect(tag).toMatch(/\bzoom="/);
    expect(tag).toMatch(/\bhidden\b/);
  });
});

// =============================================================================
// Spec Requirement: <style> and <script> child elements inside <tw-storydata>
// The spec example shows:
//   <style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css"></style>
//   <script role="script" id="twine-user-script" type="text/twine-javascript"></script>
// =============================================================================
describe('Twine 2 Archive Spec -- <style> and <script> Elements', () => {
  it('contains <style> element with role="stylesheet"', async () => {
    const result = await compileToArchive(minimalStory('Style Test', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    expect(block).toContain('<style');
    expect(block).toContain('role="stylesheet"');
  });

  it('contains <style> element with id="twine-user-stylesheet"', async () => {
    const result = await compileToArchive(minimalStory('Style ID', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    expect(block).toContain('id="twine-user-stylesheet"');
  });

  it('contains <style> element with type="text/twine-css"', async () => {
    const result = await compileToArchive(minimalStory('Style Type', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    expect(block).toContain('type="text/twine-css"');
  });

  it('contains a single <style> element with all three required attributes', async () => {
    // The spec example shows: <style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">
    // All three attributes must appear on the SAME <style> element
    const result = await compileToArchive(minimalStory('Style All Attrs', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    const styleMatch = block.match(/<style[^>]*>/);
    if (!styleMatch) throw new Error('Expected <style> element in output');
    const styleTag = styleMatch[0];
    expect(styleTag).toContain('role="stylesheet"');
    expect(styleTag).toContain('id="twine-user-stylesheet"');
    expect(styleTag).toContain('type="text/twine-css"');
  });

  it('contains <script> element with role="script"', async () => {
    const result = await compileToArchive(minimalStory('Script Test', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    expect(block).toContain('<script');
    expect(block).toContain('role="script"');
  });

  it('contains <script> element with id="twine-user-script"', async () => {
    const result = await compileToArchive(minimalStory('Script ID', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    expect(block).toContain('id="twine-user-script"');
  });

  it('contains <script> element with type="text/twine-javascript"', async () => {
    const result = await compileToArchive(minimalStory('Script Type', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    expect(block).toContain('type="text/twine-javascript"');
  });

  it('contains a single <script> element with all three required attributes', async () => {
    // The spec example shows: <script role="script" id="twine-user-script" type="text/twine-javascript">
    // All three attributes must appear on the SAME <script> element
    const result = await compileToArchive(minimalStory('Script All Attrs', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    const scriptMatch = block.match(/<script[^>]*>/);
    if (!scriptMatch) throw new Error('Expected <script> element in output');
    const scriptTag = scriptMatch[0];
    expect(scriptTag).toContain('role="script"');
    expect(scriptTag).toContain('id="twine-user-script"');
    expect(scriptTag).toContain('type="text/twine-javascript"');
  });

  it('stylesheet-tagged passage content goes into <style> element, not <tw-passagedata>', async () => {
    const source = minimalStory(
      'CSS Inclusion',
      [':: Start', 'Hello', '', ':: MyStyles [stylesheet]', 'body { color: red; }'].join('\n'),
    );
    const result = await compileToArchive(source);
    const block = extractStoryDataBlock(result.output);
    // Content should be inside style element
    expect(block).toContain('body { color: red; }');
    // Should NOT appear as a passage
    expect(block).not.toMatch(/<tw-passagedata[^>]*name="MyStyles"/);
  });

  it('script-tagged passage content goes into <script> element, not <tw-passagedata>', async () => {
    const source = minimalStory(
      'JS Inclusion',
      [':: Start', 'Hello', '', ':: MyScript [script]', 'alert("hi");'].join('\n'),
    );
    const result = await compileToArchive(source);
    const block = extractStoryDataBlock(result.output);
    // Content should be inside script element
    expect(block).toContain('alert("hi");');
    // Should NOT appear as a passage
    expect(block).not.toMatch(/<tw-passagedata[^>]*name="MyScript"/);
  });
});

// =============================================================================
// Spec Requirement: <tw-passagedata> elements for each story passage
// The spec example shows:
//   <tw-passagedata pid="1" name="Untitled Passage" tags="" position="900,400" size="100,100">
//   </tw-passagedata>
// =============================================================================
describe('Twine 2 Archive Spec -- <tw-passagedata> Elements', () => {
  it('contains <tw-passagedata> for each normal passage', async () => {
    const source = minimalStory(
      'Passages Test',
      [':: Start', 'Hello', '', ':: Second', 'World', '', ':: Third', 'Foo'].join('\n'),
    );
    const result = await compileToArchive(source);
    const passages = [...result.output.matchAll(/<tw-passagedata/g)];
    expect(passages).toHaveLength(3);
  });

  it('passage has "pid" attribute with numeric value', async () => {
    const result = await compileToArchive(minimalStory('PID Test', ':: Start\nHello'));
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    expect(passageMatch[0]).toMatch(/pid="\d+"/);
  });

  it('passage has "name" attribute with the passage name', async () => {
    const result = await compileToArchive(minimalStory('Name Test', ':: Start\nHello'));
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    expect(passageMatch[0]).toContain('name="Start"');
  });

  it('passage has "tags" attribute defaulting to empty string (per spec example: tags="")', async () => {
    const result = await compileToArchive(minimalStory('Tags Test', ':: Start\nHello'));
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    // The spec example shows tags="" for passages without tags
    expect(passageMatch[0]).toContain('tags=""');
  });

  it('passage tags attribute contains space-separated tag names', async () => {
    const source = minimalStory('Tag Values', ':: Start [alpha beta]\nHello');
    const result = await compileToArchive(source);
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    expect(passageMatch[0]).toMatch(/tags="alpha beta"/);
  });

  it('passage has "position" attribute (per spec example)', async () => {
    const source = minimalStory('Pos Test', ':: Start {"position":"100,200"}\nHello');
    const result = await compileToArchive(source);
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    expect(passageMatch[0]).toMatch(/position="100,200"/);
  });

  it('passage has "size" attribute (per spec example)', async () => {
    const source = minimalStory('Size Test', ':: Start {"size":"150,100"}\nHello');
    const result = await compileToArchive(source);
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    expect(passageMatch[0]).toMatch(/size="150,100"/);
  });

  it('each passage has a unique pid', async () => {
    const source = minimalStory(
      'Unique PID',
      [':: Start', 'Hello', '', ':: Second', 'World', '', ':: Third', 'Foo'].join('\n'),
    );
    const result = await compileToArchive(source);
    const pidMatches = [...result.output.matchAll(/pid="(\d+)"/g)];
    expect(pidMatches.length).toBe(3);
    const pids = pidMatches.map((m) => m[1]);
    const uniquePids = new Set(pids);
    expect(uniquePids.size).toBe(3);
  });

  it('pids start at 1 and increment (per spec example: pid="1")', async () => {
    const result = await compileToArchive(minimalStory('PID Start', ':: Start\nHello'));
    const pidMatch = result.output.match(/pid="(\d+)"/);
    if (!pidMatch) throw new Error('Expected pid attribute');
    expect(pidMatch[1]).toBe('1');
  });

  it('<tw-passagedata> has all attributes from spec example: pid, name, tags, position, size', async () => {
    const result = await compileToArchive(minimalStory('All Attrs', ':: Start\nHello'));
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    const passageTag = passageMatch[0];
    expect(passageTag).toMatch(/\bpid="/);
    expect(passageTag).toMatch(/\bname="/);
    expect(passageTag).toMatch(/\btags="/);
    expect(passageTag).toMatch(/\bposition="/);
    expect(passageTag).toMatch(/\bsize="/);
  });

  it('passage has default "position" attribute even without explicit metadata', async () => {
    // The spec example shows position="900,400" — a position must always be present
    const result = await compileToArchive(minimalStory('Default Pos', ':: Start\nHello'));
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    expect(passageMatch[0]).toMatch(/position="[^"]+"/);
  });

  it('passage has default "size" attribute even without explicit metadata', async () => {
    // The spec example shows size="100,100" — a size must always be present
    const result = await compileToArchive(minimalStory('Default Size', ':: Start\nHello'));
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    expect(passageMatch[0]).toMatch(/size="[^"]+"/);
  });

  it('position attribute format is "x,y" with numeric values', async () => {
    const source = minimalStory('Pos Format', ':: Start {"position":"100,200"}\nHello');
    const result = await compileToArchive(source);
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    expect(passageMatch[0]).toMatch(/position="\d+,\d+"/);
  });

  it('size attribute format is "w,h" with numeric values', async () => {
    const source = minimalStory('Size Format', ':: Start {"size":"150,100"}\nHello');
    const result = await compileToArchive(source);
    const passageMatch = result.output.match(/<tw-passagedata[^>]*>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> in output');
    expect(passageMatch[0]).toMatch(/size="\d+,\d+"/);
  });

  it('passage content is HTML-escaped', async () => {
    const source = minimalStory('Escape Test', ':: Start\nA & B < C > D');
    const result = await compileToArchive(source);
    expect(result.output).toContain('A &amp; B &lt; C &gt; D');
  });

  it('passage content with double quotes is escaped', async () => {
    const source = minimalStory('Quote Escape', ':: Start\nHe said "hello"');
    const result = await compileToArchive(source);
    // Inside <tw-passagedata>, double quotes in content must be escaped
    const block = extractStoryDataBlock(result.output);
    const passageMatch = block.match(/<tw-passagedata[^>]*>([\s\S]*?)<\/tw-passagedata>/);
    if (!passageMatch) throw new Error('Expected passage content');
    expect(passageMatch[1]).toContain('He said');
    // Content should not contain unescaped quotes that break XML structure
    expect(block).toContain('</tw-passagedata>');
  });

  it('passage text content appears between <tw-passagedata> opening and closing tags', async () => {
    const source = minimalStory('Content Test', ':: Start\nThis is passage content');
    const result = await compileToArchive(source);
    const block = extractStoryDataBlock(result.output);
    const passageMatch = block.match(/<tw-passagedata[^>]*>([\s\S]*?)<\/tw-passagedata>/);
    if (!passageMatch) throw new Error('Expected <tw-passagedata> with content');
    expect(passageMatch[1]).toContain('This is passage content');
  });

  it('every <tw-passagedata> element has a proper </tw-passagedata> closing tag', async () => {
    const source = minimalStory('Closing Tags', [':: Start', 'Hello', '', ':: Second', 'World'].join('\n'));
    const result = await compileToArchive(source);
    const openCount = [...result.output.matchAll(/<tw-passagedata/g)].length;
    const closeCount = [...result.output.matchAll(/<\/tw-passagedata>/g)].length;
    expect(openCount).toBe(2);
    expect(closeCount).toBe(2);
  });
});

// =============================================================================
// Spec Requirement: Special passages excluded from <tw-passagedata>
// StoryTitle and StoryData are metadata passages, not story content.
// =============================================================================
describe('Twine 2 Archive Spec -- Special Passage Exclusion', () => {
  it('StoryTitle is NOT included as a <tw-passagedata> element', async () => {
    const result = await compileToArchive(minimalStory('Exclusion Test', ':: Start\nHello'));
    expect(result.output).not.toMatch(/<tw-passagedata[^>]*name="StoryTitle"/);
  });

  it('StoryData is NOT included as a <tw-passagedata> element', async () => {
    const result = await compileToArchive(minimalStory('Exclusion Test', ':: Start\nHello'));
    expect(result.output).not.toMatch(/<tw-passagedata[^>]*name="StoryData"/);
  });

  it('script-tagged passages are NOT included as <tw-passagedata> elements', async () => {
    const source = minimalStory(
      'Script Exclusion',
      [':: Start', 'Hello', '', ':: MyJS [script]', 'code here'].join('\n'),
    );
    const result = await compileToArchive(source);
    expect(result.output).not.toMatch(/<tw-passagedata[^>]*name="MyJS"/);
  });

  it('stylesheet-tagged passages are NOT included as <tw-passagedata> elements', async () => {
    const source = minimalStory(
      'Style Exclusion',
      [':: Start', 'Hello', '', ':: MyCSS [stylesheet]', 'styles here'].join('\n'),
    );
    const result = await compileToArchive(source);
    expect(result.output).not.toMatch(/<tw-passagedata[^>]*name="MyCSS"/);
  });
});

// =============================================================================
// Spec Requirement: <tw-tag> elements for tag colors
// The HTML output spec allows tag-colors metadata to produce <tw-tag> elements.
// =============================================================================
describe('Twine 2 Archive Spec -- <tw-tag> Elements', () => {
  it('archive contains <tw-tag> elements when tag-colors are defined', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"scene":"green"}}',
      '',
      ':: StoryTitle',
      'Tag Color Archive',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    expect(result.output).toContain('<tw-tag');
    expect(result.output).toMatch(/name="scene"/);
    expect(result.output).toMatch(/color="green"/);
  });

  it('archive contains multiple <tw-tag> elements for multiple tag-colors', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"scene":"green","action":"red"}}',
      '',
      ':: StoryTitle',
      'Multi Tag Colors',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tagElements = [...result.output.matchAll(/<tw-tag/g)];
    expect(tagElements.length).toBeGreaterThanOrEqual(2);
    expect(result.output).toMatch(/name="scene"/);
    expect(result.output).toMatch(/name="action"/);
  });
});

// =============================================================================
// Spec Requirement: Archive is a "collection of one or more stories"
// The spec example shows two <tw-storydata> blocks separated by a blank line.
// =============================================================================
describe('Twine 2 Archive Spec -- Multi-Story Archives', () => {
  it('single-story archive produces exactly one <tw-storydata> block', async () => {
    const result = await compileToArchive(minimalStory('Single Story', ':: Start\nHello'));
    const blocks = [...result.output.matchAll(/<tw-storydata/g)];
    expect(blocks).toHaveLength(1);
  });

  it('two archives can be concatenated into a valid multi-story archive', async () => {
    // The spec example shows two <tw-storydata> elements separated by blank lines
    const result1 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
        '',
        ':: StoryTitle',
        'Story One',
        '',
        ':: Start',
        'First story',
      ].join('\n'),
    );
    const result2 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"A1B2C3D4-E5F6-7890-ABCD-EF1234567890"}',
        '',
        ':: StoryTitle',
        'Story Two',
        '',
        ':: Start',
        'Second story',
      ].join('\n'),
    );
    const combined = result1.output + '\n' + result2.output;
    const storyDataMatches = [...combined.matchAll(/<tw-storydata/g)];
    expect(storyDataMatches).toHaveLength(2);
    expect(combined).toContain('name="Story One"');
    expect(combined).toContain('name="Story Two"');
  });

  it('concatenated archives: each <tw-storydata> block is self-contained', async () => {
    const result1 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
        '',
        ':: StoryTitle',
        'Story One',
        '',
        ':: Start',
        'First story',
      ].join('\n'),
    );
    const result2 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"A1B2C3D4-E5F6-7890-ABCD-EF1234567890"}',
        '',
        ':: StoryTitle',
        'Story Two',
        '',
        ':: Start',
        'Second story',
      ].join('\n'),
    );
    const combined = result1.output + '\n' + result2.output;
    const blocks = [...combined.matchAll(/<tw-storydata[\s\S]*?<\/tw-storydata>/g)];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      // Each block must open with <tw-storydata and close with </tw-storydata>
      expect(block[0]).toMatch(/^<tw-storydata[\s\S]*<\/tw-storydata>$/);
    }
  });

  it('concatenated archives: each story has its own IFID', async () => {
    const result1 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
        '',
        ':: StoryTitle',
        'Story One',
        '',
        ':: Start',
        'First',
      ].join('\n'),
    );
    const result2 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"A1B2C3D4-E5F6-7890-ABCD-EF1234567890"}',
        '',
        ':: StoryTitle',
        'Story Two',
        '',
        ':: Start',
        'Second',
      ].join('\n'),
    );
    const combined = result1.output + '\n' + result2.output;
    expect(combined).toContain('ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"');
    expect(combined).toContain('ifid="A1B2C3D4-E5F6-7890-ABCD-EF1234567890"');
  });

  it('concatenated archives: each story block contains its own <style>, <script>, and <tw-passagedata>', async () => {
    const result1 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
        '',
        ':: StoryTitle',
        'Story One',
        '',
        ':: Start',
        'First',
      ].join('\n'),
    );
    const result2 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"A1B2C3D4-E5F6-7890-ABCD-EF1234567890"}',
        '',
        ':: StoryTitle',
        'Story Two',
        '',
        ':: Start',
        'Second',
      ].join('\n'),
    );
    const combined = result1.output + '\n' + result2.output;
    const blocks = [...combined.matchAll(/<tw-storydata[\s\S]*?<\/tw-storydata>/g)];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      // Each block must contain style, script, and passagedata elements
      expect(block[0]).toContain('<style');
      expect(block[0]).toContain('</style>');
      expect(block[0]).toContain('<script');
      expect(block[0]).toContain('</script>');
      expect(block[0]).toContain('<tw-passagedata');
      expect(block[0]).toContain('</tw-passagedata>');
    }
  });

  it('concatenated archives: each story block has the hidden attribute', async () => {
    const result1 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
        '',
        ':: StoryTitle',
        'Story One',
        '',
        ':: Start',
        'First',
      ].join('\n'),
    );
    const result2 = await compileToArchive(
      [
        ':: StoryData',
        '{"ifid":"A1B2C3D4-E5F6-7890-ABCD-EF1234567890"}',
        '',
        ':: StoryTitle',
        'Story Two',
        '',
        ':: Start',
        'Second',
      ].join('\n'),
    );
    const combined = result1.output + '\n' + result2.output;
    // Extract each <tw-storydata ...> opening tag
    const openTags = [...combined.matchAll(/<tw-storydata[^>]*>/g)];
    expect(openTags).toHaveLength(2);
    for (const tag of openTags) {
      expect(tag[0]).toMatch(/\bhidden\b/);
    }
  });

  it('multi-source compilation produces at least one <tw-storydata> block', async () => {
    // Spec: "A library is defined as a collection of one or more stories"
    // When compiling multiple source files, the archive should contain <tw-storydata> blocks.
    const source1 = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Story Alpha',
      '',
      ':: Start',
      'Alpha content',
    ].join('\n');
    const source2 = [
      ':: StoryData',
      '{"ifid":"A1B2C3D4-E5F6-7890-ABCD-EF1234567890"}',
      '',
      ':: StoryTitle',
      'Story Beta',
      '',
      ':: Start',
      'Beta content',
    ].join('\n');
    const result = await compile({
      sources: [
        { filename: 'alpha.tw', content: source1 },
        { filename: 'beta.tw', content: source2 },
      ],
      outputMode: 'twine2-archive',
    });
    const blocks = [...result.output.matchAll(/<tw-storydata/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(result.output).toContain('</tw-storydata>');
  });
});

// =============================================================================
// Spec Example Conformance
// The spec example shows the exact structure of archive output.
// These tests verify conformance to the example's structure.
// =============================================================================
describe('Twine 2 Archive Spec -- Example Conformance', () => {
  it('spec example structure: <tw-storydata> contains <style> then <script> then <tw-passagedata>', async () => {
    const result = await compileToArchive(minimalStory('Order Test', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    const stylePos = block.indexOf('<style');
    const scriptPos = block.indexOf('<script');
    const passagePos = block.indexOf('<tw-passagedata');
    // All must be present
    expect(stylePos).toBeGreaterThan(-1);
    expect(scriptPos).toBeGreaterThan(-1);
    expect(passagePos).toBeGreaterThan(-1);
    // Style comes before script, script comes before passages (per spec example order)
    expect(stylePos).toBeLessThan(scriptPos);
    expect(scriptPos).toBeLessThan(passagePos);
  });

  it('spec example: <style> element is a child of <tw-storydata>, not a sibling', async () => {
    const result = await compileToArchive(minimalStory('Nesting Test', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    // The style element must be within the tw-storydata block
    expect(block).toContain('<style');
    expect(block).toContain('</style>');
  });

  it('spec example: <script> element is a child of <tw-storydata>, not a sibling', async () => {
    const result = await compileToArchive(minimalStory('Nesting Test', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    expect(block).toContain('<script');
    expect(block).toContain('</script>');
  });

  it('spec example: <tw-passagedata> elements are children of <tw-storydata>', async () => {
    const result = await compileToArchive(minimalStory('Nesting Test', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    expect(block).toContain('<tw-passagedata');
    expect(block).toContain('</tw-passagedata>');
  });

  it('spec example: empty <style> and <script> when no stylesheet/script passages exist', async () => {
    // The spec example shows <style ...></style> and <script ...></script> (empty)
    const result = await compileToArchive(minimalStory('Empty Elements', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    // Style and script elements must be present even if empty
    expect(block).toMatch(/<style[^>]*><\/style>/);
    expect(block).toMatch(/<script[^>]*><\/script>/);
  });
});

// =============================================================================
// Spec: Metadata Preservation
// The archive must faithfully reproduce story metadata from StoryData.
// =============================================================================
describe('Twine 2 Archive Spec -- Metadata Preservation', () => {
  it('story name from StoryTitle is preserved', async () => {
    const result = await compileToArchive(minimalStory('Preserved Name', ':: Start\nHello'));
    expect(result.output).toContain('name="Preserved Name"');
  });

  it('IFID from StoryData is preserved', async () => {
    const result = await compileToArchive(minimalStory('IFID Pres', ':: Start\nHello'));
    expect(result.output).toContain('ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"');
  });

  it('format from StoryData is preserved', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube"}',
      '',
      ':: StoryTitle',
      'Format Pres',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    expect(result.output).toContain('format="SugarCube"');
  });

  it('format-version from StoryData is preserved', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format-version":"2.37.3"}',
      '',
      ':: StoryTitle',
      'FmtVer Pres',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    expect(result.output).toContain('format-version="2.37.3"');
  });

  it('story name with special characters is properly attribute-escaped', async () => {
    const result = await compileToArchive(minimalStory('A "Quoted" & <Bold> Story', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    // Must be attribute-escaped so the HTML is valid
    expect(tag).toContain('name="');
    expect(tag).not.toContain('name="A "Quoted"'); // unescaped quotes would break
  });
});

// =============================================================================
// Spec Example Conformance: Attribute Order
// The spec example shows a specific attribute order on <tw-storydata>.
// While HTML does not require attribute ordering, it reflects the spec's intent.
// =============================================================================
describe('Twine 2 Archive Spec -- Attribute Presence on <tw-storydata>', () => {
  it('all spec example attributes are present even with minimal input', async () => {
    // Even without specifying format/format-version in StoryData, the attributes
    // should still be present (possibly empty) per the spec example structure
    const result = await compileToArchive(minimalStory('Minimal Attrs', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    // These attributes are shown in the spec example and must always be present
    expect(tag).toMatch(/\bname="/);
    expect(tag).toMatch(/\bstartnode="/);
    expect(tag).toMatch(/\bcreator="/);
    expect(tag).toMatch(/\bcreator-version="/);
    expect(tag).toMatch(/\bifid="/);
    expect(tag).toMatch(/\bformat="/);
    expect(tag).toMatch(/\bformat-version="/);
    expect(tag).toMatch(/\boptions="/);
    expect(tag).toMatch(/\btags="/);
    expect(tag).toMatch(/\bzoom="/);
    expect(tag).toMatch(/\bhidden\b/);
  });

  it('format attribute defaults to empty string when not specified', async () => {
    const result = await compileToArchive(minimalStory('No Format', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    // format attribute must be present (per spec example), value may be empty
    expect(tag).toMatch(/\bformat="/);
  });

  it('format-version attribute defaults to empty string when not specified', async () => {
    const result = await compileToArchive(minimalStory('No FmtVer', ':: Start\nHello'));
    const tag = extractStoryDataTag(result.output);
    // format-version attribute must be present (per spec example), value may be empty
    expect(tag).toMatch(/\bformat-version="/);
  });
});

// =============================================================================
// Implementation Convention: UUID Comment
// NOTE: The spec example does NOT include UUID comments. These are a twee-ts
// convention. Tests are retained to document actual behavior but marked as
// non-spec-required.
// =============================================================================
describe('Twine 2 Archive Spec -- UUID Comment (implementation convention, NOT in spec)', () => {
  it('twee-ts includes UUID comment before <tw-storydata> (implementation convention)', async () => {
    const result = await compileToArchive(minimalStory('UUID Test', ':: Start\nHello'));
    // twee-ts outputs <!-- UUID://IFID// --> before <tw-storydata>
    // NOTE: This is NOT required by the archive spec
    expect(result.output).toMatch(/<!-- UUID:\/\/.*\/\/ -->/);
  });

  it('UUID comment contains the story IFID (implementation convention)', async () => {
    const result = await compileToArchive(minimalStory('UUID IFID', ':: Start\nHello'));
    expect(result.output).toContain('UUID://D674C58C-DEFA-4F70-B7A2-27742230C0FC//');
  });

  it('UUID comments do not break archive structure -- <tw-storydata> remains parseable', async () => {
    const result = await compileToArchive(minimalStory('UUID Structure', ':: Start\nHello'));
    // Even with comments, the <tw-storydata> block must be intact
    const blocks = [...result.output.matchAll(/<tw-storydata[\s\S]*?<\/tw-storydata>/g)];
    expect(blocks).toHaveLength(1);
  });
});

// =============================================================================
// Spec Requirement: Exactly one <style> and one <script> per <tw-storydata>
// The spec example shows exactly one of each inside each <tw-storydata> block.
// =============================================================================
describe('Twine 2 Archive Spec -- Exactly One <style> and <script> Per Story', () => {
  it('archive output contains exactly one <style> element per <tw-storydata> block', async () => {
    const result = await compileToArchive(minimalStory('Single Style', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    const styleMatches = [...block.matchAll(/<style\b/g)];
    expect(styleMatches).toHaveLength(1);
  });

  it('archive output contains exactly one <script> element per <tw-storydata> block', async () => {
    const result = await compileToArchive(minimalStory('Single Script', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    const scriptMatches = [...block.matchAll(/<script\b/g)];
    expect(scriptMatches).toHaveLength(1);
  });

  it('exactly one <style> even with multiple stylesheet passages', async () => {
    const source = minimalStory(
      'Multi CSS',
      [':: Start', 'Hello', '', ':: CSS1 [stylesheet]', 'body {}', '', ':: CSS2 [stylesheet]', 'p {}'].join('\n'),
    );
    const result = await compileToArchive(source);
    const block = extractStoryDataBlock(result.output);
    const styleMatches = [...block.matchAll(/<style\b/g)];
    expect(styleMatches).toHaveLength(1);
    // Both stylesheet contents should be merged into the single <style> element
    expect(block).toContain('body {}');
    expect(block).toContain('p {}');
  });

  it('exactly one <script> even with multiple script passages', async () => {
    const source = minimalStory(
      'Multi JS',
      [':: Start', 'Hello', '', ':: JS1 [script]', 'var a=1;', '', ':: JS2 [script]', 'var b=2;'].join('\n'),
    );
    const result = await compileToArchive(source);
    const block = extractStoryDataBlock(result.output);
    const scriptMatches = [...block.matchAll(/<script\b/g)];
    expect(scriptMatches).toHaveLength(1);
    // Both script contents should be merged into the single <script> element
    expect(block).toContain('var a=1;');
    expect(block).toContain('var b=2;');
  });
});

// =============================================================================
// Spec Requirement: Twine.private passages excluded
// Passages tagged Twine.private must not appear in archive output.
// =============================================================================
describe('Twine 2 Archive Spec -- Twine.private Exclusion', () => {
  it('Twine.private-tagged passages are NOT included as <tw-passagedata>', async () => {
    const source = minimalStory(
      'Private Test',
      [':: Start', 'Hello', '', ':: SecretPassage [Twine.private]', 'This is private'].join('\n'),
    );
    const result = await compileToArchive(source);
    expect(result.output).not.toMatch(/<tw-passagedata[^>]*name="SecretPassage"/);
    expect(result.output).not.toContain('This is private');
  });
});

// =============================================================================
// Spec Requirement: <tw-storydata> options attribute reflects StoryData options
// The spec example shows options="" — the options attribute value must
// contain the active options from StoryData.
// =============================================================================
describe('Twine 2 Archive Spec -- Options Attribute', () => {
  it('options attribute contains option name when option is set in StoryData', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","options":["debug"]}',
      '',
      ':: StoryTitle',
      'Options Set',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = extractStoryDataTag(result.output);
    expect(tag).toContain('options="debug"');
  });

  it('options attribute contains space-separated options when multiple are set', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","options":["debug","test"]}',
      '',
      ':: StoryTitle',
      'Multi Options',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tag = extractStoryDataTag(result.output);
    // Both options must appear in the options attribute
    expect(tag).toMatch(/options="[^"]*debug[^"]*"/);
    expect(tag).toMatch(/options="[^"]*test[^"]*"/);
  });
});

// =============================================================================
// Spec Requirement: <tw-storydata> must be well-formed
// The archive output must produce valid, parseable HTML/XML structure.
// =============================================================================
describe('Twine 2 Archive Spec -- Well-Formed Structure', () => {
  it('every opening <tw-storydata> has a matching </tw-storydata> closing tag', async () => {
    const result = await compileToArchive(minimalStory('Wellformed', ':: Start\nHello'));
    const openCount = [...result.output.matchAll(/<tw-storydata\b/g)].length;
    const closeCount = [...result.output.matchAll(/<\/tw-storydata>/g)].length;
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  it('every <style> has a matching </style>', async () => {
    const result = await compileToArchive(minimalStory('Style Close', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    const openCount = [...block.matchAll(/<style\b/g)].length;
    const closeCount = [...block.matchAll(/<\/style>/g)].length;
    expect(openCount).toBe(closeCount);
  });

  it('every <script> has a matching </script>', async () => {
    const result = await compileToArchive(minimalStory('Script Close', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    const openCount = [...block.matchAll(/<script\b/g)].length;
    const closeCount = [...block.matchAll(/<\/script>/g)].length;
    expect(openCount).toBe(closeCount);
  });

  it('<style> element appears inside <tw-storydata>, not outside', async () => {
    const result = await compileToArchive(minimalStory('Style Inside', ':: Start\nHello'));
    const storyDataStart = result.output.indexOf('<tw-storydata');
    const storyDataEnd = result.output.indexOf('</tw-storydata>');
    const stylePos = result.output.indexOf('<style');
    expect(stylePos).toBeGreaterThan(storyDataStart);
    expect(stylePos).toBeLessThan(storyDataEnd);
  });

  it('<script> element appears inside <tw-storydata>, not outside', async () => {
    const result = await compileToArchive(minimalStory('Script Inside', ':: Start\nHello'));
    const storyDataStart = result.output.indexOf('<tw-storydata');
    const storyDataEnd = result.output.indexOf('</tw-storydata>');
    const scriptPos = result.output.indexOf('<script');
    expect(scriptPos).toBeGreaterThan(storyDataStart);
    expect(scriptPos).toBeLessThan(storyDataEnd);
  });

  it('passage name attribute values are properly escaped for HTML attributes', async () => {
    const source = minimalStory(
      'Name Escaping',
      ':: Start\nHello\n\n:: A&B<C>"D\nContent',
    );
    const result = await compileToArchive(source);
    // The passage name with special chars must be escaped so the attribute is valid HTML
    const block = extractStoryDataBlock(result.output);
    // Should not contain raw < > " & inside attribute values
    const passageTags = [...block.matchAll(/<tw-passagedata[^>]*>/g)];
    for (const m of passageTags) {
      const tag = m[0];
      // Extract all name="..." values and verify they don't contain unescaped special chars
      const nameMatch = tag.match(/name="([^"]*)"/);
      if (nameMatch) {
        const nameVal = nameMatch[1]!;
        // Inside attribute values, & < > " must be escaped
        expect(nameVal).not.toMatch(/[<>"]/);
        // & is only valid as part of an entity (e.g. &amp;)
        if (nameVal.includes('&')) {
          expect(nameVal).toMatch(/&amp;|&lt;|&gt;|&quot;/);
        }
      }
    }
  });

  it('archive output does NOT contain <tw-storydata> elements nested inside each other', async () => {
    const result = await compileToArchive(minimalStory('No Nesting', ':: Start\nHello'));
    const block = extractStoryDataBlock(result.output);
    // Only one opening tag should appear inside the block
    const innerOpens = [...block.matchAll(/<tw-storydata\b/g)];
    expect(innerOpens).toHaveLength(1);
  });
});

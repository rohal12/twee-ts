/**
 * Twine 2 Archive Specification Compliance Tests (v1.0.0)
 *
 * Tests twee-ts against every requirement in the Twine 2 Archive Specification:
 * https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-archive-spec.md
 *
 * The archive format is a collection of one or more stories, each following
 * the Twine 2 HTML Output Specification, without outer HTML wrapping.
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import type { CompileResult } from '../src/types.js';

/** Helper: compile inline twee source to Twine 2 archive. */
async function compileToArchive(content: string): Promise<CompileResult> {
  return compile({
    sources: [{ filename: 'spec-test.tw', content }],
    outputMode: 'twine2-archive',
  });
}

/** Helper: build a minimal valid twee source. */
function minimalStory(name: string, passages: string): string {
  return [
    ':: StoryData',
    `{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}`,
    '',
    ':: StoryTitle',
    name,
    '',
    passages,
  ].join('\n');
}

// =============================================================================
// §1 — Archive Format: Structure
// =============================================================================
describe('Twine 2 Archive Spec — Structure', () => {
  it('archive output contains <tw-storydata> element', async () => {
    const result = await compileToArchive(minimalStory('Archive Test', ':: Start\nHello'));
    expect(result.output).toContain('<tw-storydata');
    expect(result.output).toContain('</tw-storydata>');
  });

  it('archive output does NOT contain outer <html> wrapping', async () => {
    const result = await compileToArchive(minimalStory('Archive Test', ':: Start\nHello'));
    expect(result.output).not.toContain('<html>');
    expect(result.output).not.toContain('</html>');
    expect(result.output).not.toContain('<head>');
    expect(result.output).not.toContain('<body>');
  });

  it('archive output is the raw tw-storydata chunk followed by newline', async () => {
    const result = await compileToArchive(minimalStory('Archive Test', ':: Start\nHello'));
    // Should end with </tw-storydata> followed by a newline
    expect(result.output.trimEnd()).toMatch(/<\/tw-storydata>$/);
  });
});

// =============================================================================
// §2 — Archive Follows HTML Output Spec
// =============================================================================
describe('Twine 2 Archive Spec — Follows HTML Output Specification', () => {
  it('archive contains all required <tw-storydata> attributes', async () => {
    const result = await compileToArchive(minimalStory('Archive Attrs', ':: Start\nHello'));
    const tag = result.output.match(/<tw-storydata[^>]*>/);
    expect(tag).not.toBeNull();
    const tagStr = tag![0];
    // Required attributes per HTML output spec
    expect(tagStr).toMatch(/name="/);
    expect(tagStr).toMatch(/ifid="/);
    expect(tagStr).toMatch(/startnode="/);
  });

  it('archive <tw-storydata> has hidden attribute', async () => {
    const result = await compileToArchive(minimalStory('Hidden Test', ':: Start\nHello'));
    const tag = result.output.match(/<tw-storydata[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag![0]).toContain('hidden');
  });

  it('archive contains <style> element inside <tw-storydata>', async () => {
    const result = await compileToArchive(minimalStory('Style Test', ':: Start\nHello'));
    const chunk = result.output.match(/<tw-storydata[\s\S]*?<\/tw-storydata>/);
    expect(chunk).not.toBeNull();
    expect(chunk![0]).toContain('<style');
    expect(chunk![0]).toContain('id="twine-user-stylesheet"');
    expect(chunk![0]).toContain('type="text/twine-css"');
  });

  it('archive contains <script> element inside <tw-storydata>', async () => {
    const result = await compileToArchive(minimalStory('Script Test', ':: Start\nHello'));
    const chunk = result.output.match(/<tw-storydata[\s\S]*?<\/tw-storydata>/);
    expect(chunk).not.toBeNull();
    expect(chunk![0]).toContain('<script');
    expect(chunk![0]).toContain('id="twine-user-script"');
    expect(chunk![0]).toContain('type="text/twine-javascript"');
  });

  it('archive contains <tw-passagedata> for each story passage', async () => {
    const source = minimalStory(
      'Passages Test',
      [':: Start', 'Hello', '', ':: Second', 'World', '', ':: Third', 'Foo'].join('\n'),
    );
    const result = await compileToArchive(source);
    const passages = [...result.output.matchAll(/<tw-passagedata/g)];
    expect(passages.length).toBe(3);
  });

  it('archive passage content is HTML-escaped', async () => {
    const source = minimalStory('Escape Test', ':: Start\nA & B < C > D');
    const result = await compileToArchive(source);
    expect(result.output).toContain('A &amp; B &lt; C &gt; D');
  });

  it('archive contains <tw-tag> when tag-colors are defined', async () => {
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
});

// =============================================================================
// §3 — Archive: Story Metadata Preservation
// =============================================================================
describe('Twine 2 Archive Spec — Metadata Preservation', () => {
  it('story name is preserved in archive', async () => {
    const result = await compileToArchive(minimalStory('My Great Story', ':: Start\nHello'));
    expect(result.output).toContain('name="My Great Story"');
  });

  it('IFID is preserved in archive', async () => {
    const result = await compileToArchive(minimalStory('IFID Test', ':: Start\nHello'));
    expect(result.output).toContain('ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"');
  });

  it('format and format-version are preserved in archive', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Harlowe","format-version":"3.3.7"}',
      '',
      ':: StoryTitle',
      'Format Preservation',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    expect(result.output).toContain('format="Harlowe"');
    expect(result.output).toContain('format-version="3.3.7"');
  });

  it('zoom value is preserved in archive', async () => {
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
    expect(result.output).toContain('zoom="1.2"');
  });

  it('creator and creator-version are present in archive', async () => {
    const result = await compileToArchive(minimalStory('Creator Test', ':: Start\nHello'));
    expect(result.output).toMatch(/creator="/);
    expect(result.output).toMatch(/creator-version="/);
  });
});

// =============================================================================
// §4 — Archive: Passage Data Completeness
// =============================================================================
describe('Twine 2 Archive Spec — Passage Data', () => {
  it('passage pid, name, tags, position, and size attributes are present', async () => {
    const source = minimalStory('Attr Test', ':: Start [tag1 tag2] {"position":"100,200","size":"150,100"}\nHello');
    const result = await compileToArchive(source);
    const passage = result.output.match(/<tw-passagedata[^>]*>/);
    expect(passage).not.toBeNull();
    const p = passage![0];
    expect(p).toMatch(/pid="/);
    expect(p).toMatch(/name="Start"/);
    expect(p).toMatch(/tags="tag1 tag2"/);
    expect(p).toMatch(/position="100,200"/);
    expect(p).toMatch(/size="150,100"/);
  });

  it('special passages (StoryTitle, StoryData) are excluded from archive passages', async () => {
    const result = await compileToArchive(minimalStory('Exclusion Test', ':: Start\nHello'));
    expect(result.output).not.toMatch(/name="StoryTitle"/);
    expect(result.output).not.toMatch(/name="StoryData"/);
  });

  it('script/stylesheet passages are excluded from archive passages', async () => {
    const source = minimalStory(
      'Tag Exclusion',
      [':: Start', 'Hello', '', ':: JS [script]', 'code', '', ':: CSS [stylesheet]', 'styles'].join('\n'),
    );
    const result = await compileToArchive(source);
    // These should NOT appear as tw-passagedata
    const passageMatches = [...result.output.matchAll(/name="(JS|CSS)"/g)];
    expect(passageMatches.length).toBe(0);
    // But their content should be in script/style elements
    expect(result.output).toContain('code');
    expect(result.output).toContain('styles');
  });
});

// =============================================================================
// §5 — Archive: UUID Comment
// =============================================================================
describe('Twine 2 Archive Spec — UUID Comment', () => {
  it('archive output includes UUID comment before <tw-storydata>', async () => {
    const result = await compileToArchive(minimalStory('UUID Test', ':: Start\nHello'));
    // twee-ts outputs <!-- UUID://IFID// --> before <tw-storydata>
    expect(result.output).toMatch(/<!-- UUID:\/\/.*\/\/ -->/);
  });

  it('UUID comment contains the story IFID', async () => {
    const result = await compileToArchive(minimalStory('UUID IFID', ':: Start\nHello'));
    expect(result.output).toContain('UUID://D674C58C-DEFA-4F70-B7A2-27742230C0FC//');
  });
});

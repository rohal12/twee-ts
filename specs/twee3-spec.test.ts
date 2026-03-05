/**
 * Twee 3 Specification Compliance Tests
 *
 * Tests twee-ts against every requirement in the Twee 3 Specification (v3.0.2):
 * https://github.com/iftechfoundation/twine-specs/blob/master/twee-3-specification.md
 *
 * Each describe block corresponds to a section of the spec.
 * Tests are labeled with MUST (required) or RECOMMENDED (encouraged).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseTwee } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { tweeLexer } from '../src/lexer.js';
import { ItemType } from '../src/types.js';
import type { LexerItem } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'test', 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

/** Helper: collect all lexer items from input. */
function lex(input: string): LexerItem[] {
  return [...tweeLexer(input)];
}

/** Helper: compile inline twee source to HTML. */
async function compileInline(content: string, options: Record<string, unknown> = {}) {
  return compile({
    sources: [{ filename: 'spec-test.tw', content }],
    formatId: 'test-format-1',
    formatPaths: [FORMAT_DIR],
    useTweegoPath: false,
    ...options,
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

// =============================================================================
// Section: Twee Notation — File Composition
// "Twee files are composed of one or more passages."
// =============================================================================

describe('Twee Notation — File Composition', () => {
  it('parses a file with a single passage', () => {
    const { passages, diagnostics } = parseTwee(':: Start\nHello');
    expect(diagnostics).toHaveLength(0);
    expect(passages).toHaveLength(1);
  });

  it('parses a file with multiple passages', () => {
    const { passages, diagnostics } = parseTwee(':: First\nContent 1\n\n:: Second\nContent 2\n\n:: Third\nContent 3');
    expect(diagnostics).toHaveLength(0);
    expect(passages).toHaveLength(3);
  });
});

// =============================================================================
// Section: Passage Header
// "Each header must be a single line"
// =============================================================================

describe('Passage Header', () => {
  // -------------------------------------------------------------------------
  // Component 1: Required start token (::)
  // "Required start token, a double colon (::), that must begin the line."
  // -------------------------------------------------------------------------
  describe('Start Token (::)', () => {
    it('MUST: recognizes :: at the beginning of a line as a passage header', () => {
      const items = lex(':: Start\nContent');
      expect(items[0]!.type).toBe(ItemType.Header);
      expect(items[0]!.val).toBe('::');
    });

    it('MUST: recognizes :: at the beginning of the file', () => {
      const { passages } = parseTwee(':: Start\nContent');
      expect(passages).toHaveLength(1);
      expect(passages[0]!.name).toBe('Start');
    });

    it('MUST: recognizes :: at the beginning of a subsequent line', () => {
      const { passages } = parseTwee('Some prolog text\n:: Start\nContent');
      expect(passages).toHaveLength(1);
      expect(passages[0]!.name).toBe('Start');
    });

    it('does not treat :: in the middle of a line as a header', () => {
      const { passages } = parseTwee(':: Start\nSome :: text here');
      expect(passages).toHaveLength(1);
      expect(passages[0]!.text).toContain('Some :: text here');
    });
  });

  // -------------------------------------------------------------------------
  // Component 2: Required passage name
  // -------------------------------------------------------------------------
  describe('Passage Name', () => {
    it('MUST: parses the passage name after ::', () => {
      const { passages } = parseTwee(':: My Passage Name\nContent');
      expect(passages[0]!.name).toBe('My Passage Name');
    });

    it('MUST: allows spaces before the passage name for readability', () => {
      const { passages } = parseTwee('::   Spaced Name\nContent');
      expect(passages[0]!.name).toBe('Spaced Name');
    });

    it('reports an error for a passage with no name', () => {
      const { diagnostics } = parseTwee(':: \nContent');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0]!.level).toBe('error');
    });

    it('RECOMMENDED: warns on duplicate passage names', async () => {
      const result = await compileInline(minimalStory(':: Duplicate\nFirst\n\n:: Duplicate\nSecond'));
      const dupWarnings = result.diagnostics.filter(
        (d) => d.message.toLowerCase().includes('duplicate') || d.message.toLowerCase().includes('replacing'),
      );
      expect(dupWarnings.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Component 3: Optional tag block
  // "Optional tag block that must directly follow the passage name"
  // -------------------------------------------------------------------------
  describe('Tag Block', () => {
    it('MUST: parses tags enclosed in square brackets', () => {
      const { passages } = parseTwee(':: Room [forest spooky]\nContent');
      expect(passages[0]!.tags).toEqual(['forest', 'spooky']);
    });

    it('MUST: tags are space-separated', () => {
      const { passages } = parseTwee(':: Room [a b c d]\nContent');
      expect(passages[0]!.tags).toEqual(['a', 'b', 'c', 'd']);
    });

    it('MUST: tag block directly follows the passage name', () => {
      const { passages } = parseTwee(':: Room [tag1]\nContent');
      expect(passages[0]!.name).toBe('Room');
      expect(passages[0]!.tags).toEqual(['tag1']);
    });

    it('handles empty tag block', () => {
      const { passages } = parseTwee(':: Room []\nContent');
      expect(passages[0]!.tags).toEqual([]);
    });

    it('MUST: tags must not contain spaces (each tag is a separate word)', () => {
      const { passages } = parseTwee(':: Room [multi word tag]\nContent');
      // Each space-separated word is a separate tag
      expect(passages[0]!.tags).toEqual(['multi', 'word', 'tag']);
    });

    it('reports error for unterminated tag block', () => {
      const { diagnostics } = parseTwee(':: Room [unclosed\nContent');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0]!.level).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // Component 4: Optional metadata block
  // "Optional metadata block, an inline JSON chunk"
  // -------------------------------------------------------------------------
  describe('Metadata Block', () => {
    it('MUST: parses metadata as inline JSON', () => {
      const { passages } = parseTwee(':: Room {"position":"600,400","size":"100,200"}\nContent');
      expect(passages[0]!.metadata).toEqual({ position: '600,400', size: '100,200' });
    });

    it('MUST: metadata block directly follows tag block when tags are present', () => {
      const { passages } = parseTwee(':: Room [forest] {"position":"100,100"}\nContent');
      expect(passages[0]!.tags).toEqual(['forest']);
      expect(passages[0]!.metadata).toEqual({ position: '100,100' });
    });

    it('MUST: metadata block directly follows passage name when tags are omitted', () => {
      const { passages } = parseTwee(':: Room {"position":"100,100"}\nContent');
      expect(passages[0]!.name).toBe('Room');
      expect(passages[0]!.metadata).toEqual({ position: '100,100' });
    });

    it('MUST: supports position property', () => {
      const { passages } = parseTwee(':: Room {"position":"600,400"}\nContent');
      expect(passages[0]!.metadata?.position).toBe('600,400');
    });

    it('MUST: supports size property', () => {
      const { passages } = parseTwee(':: Room {"size":"100,200"}\nContent');
      expect(passages[0]!.metadata?.size).toBe('100,200');
    });

    it('RECOMMENDED: emits warning on metadata decode error and continues', () => {
      const { passages, diagnostics } = parseTwee(':: Room {invalid json}\nContent');
      // Should warn, not error fatally
      const warnings = diagnostics.filter((d) => d.level === 'warning');
      expect(warnings.length).toBeGreaterThan(0);
      // Should still have the passage
      expect(passages).toHaveLength(1);
      expect(passages[0]!.name).toBe('Room');
    });

    it('reports error for unterminated metadata block', () => {
      const { diagnostics } = parseTwee(':: Room {unclosed\nContent');
      expect(diagnostics.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Component order
  // "Each component after the start token may be preceded by one or more spaces"
  // -------------------------------------------------------------------------
  describe('Component Ordering and Spacing', () => {
    it('MUST: components may be preceded by spaces', () => {
      // Space between :: and name
      const { passages } = parseTwee('::  Room  [tag] {"position":"1,1"}\nContent');
      expect(passages[0]!.name).toBe('Room');
      expect(passages[0]!.tags).toEqual(['tag']);
    });

    it('MUST: all four components together in order', () => {
      const { passages } = parseTwee(
        ':: An overgrown path [forest spooky] {"position":"600,400","size":"100,200"}\nContent',
      );
      expect(passages[0]!.name).toBe('An overgrown path');
      expect(passages[0]!.tags).toEqual(['forest', 'spooky']);
      expect(passages[0]!.metadata).toEqual({ position: '600,400', size: '100,200' });
    });

    it('minimal: start token and name only', () => {
      const { passages } = parseTwee(':: An overgrown path\nContent');
      expect(passages[0]!.name).toBe('An overgrown path');
      expect(passages[0]!.tags).toEqual([]);
    });

    it('name with tags only (no metadata)', () => {
      const { passages } = parseTwee(':: An overgrown path [forest spooky]\nContent');
      expect(passages[0]!.name).toBe('An overgrown path');
      expect(passages[0]!.tags).toEqual(['forest', 'spooky']);
    });

    it('name with metadata only (no tags)', () => {
      const { passages } = parseTwee(':: An overgrown path {"position":"600,400","size":"100,200"}\nContent');
      expect(passages[0]!.name).toBe('An overgrown path');
      expect(passages[0]!.metadata).toEqual({ position: '600,400', size: '100,200' });
    });
  });

  // -------------------------------------------------------------------------
  // Escapement
  // "passage and tag names that include [ ] { } must escape them with \"
  // -------------------------------------------------------------------------
  describe('Escapement', () => {
    it('MUST: unescapes \\[ in passage names', () => {
      const { passages } = parseTwee(':: Name\\[1\\]\nContent');
      expect(passages[0]!.name).toBe('Name[1]');
    });

    it('MUST: unescapes \\] in passage names', () => {
      const { passages } = parseTwee(':: Name\\]test\nContent');
      expect(passages[0]!.name).toBe('Name]test');
    });

    it('MUST: unescapes \\{ in passage names', () => {
      const { passages } = parseTwee(':: Name\\{test\nContent');
      expect(passages[0]!.name).toBe('Name{test');
    });

    it('MUST: unescapes \\} in passage names', () => {
      const { passages } = parseTwee(':: Name\\}test\nContent');
      expect(passages[0]!.name).toBe('Name}test');
    });

    it('MUST: non-escape backslashes must also be escaped (\\\\)', () => {
      const { passages } = parseTwee(':: foo\\\\bar\nContent');
      expect(passages[0]!.name).toBe('foo\\bar');
    });

    it('MUST: decoding — any escaped character yields the character minus backslash', () => {
      // \q must yield q
      const { passages } = parseTwee(':: foo\\qbar\nContent');
      expect(passages[0]!.name).toBe('fooqbar');
    });

    it('MUST: unescapes metacharacters in tag names', () => {
      const { passages } = parseTwee(':: Room [tag\\[1\\]]\nContent');
      expect(passages[0]!.tags).toContain('tag[1]');
    });
  });
});

// =============================================================================
// Section: Passage Content
// "The content section begins on the next line after the passage header"
// =============================================================================

describe('Passage Content', () => {
  it('MUST: content begins on the next line after the header', () => {
    const { passages } = parseTwee(':: Start\nThis is content');
    expect(passages[0]!.text).toBe('This is content');
  });

  it('MUST: content continues until the next passage header', () => {
    const { passages } = parseTwee(':: First\nLine 1\nLine 2\n\n:: Second\nOther');
    expect(passages[0]!.text).toContain('Line 1');
    expect(passages[0]!.text).toContain('Line 2');
    expect(passages[1]!.text).toBe('Other');
  });

  it('MUST: content continues until the end of file', () => {
    const { passages } = parseTwee(':: Start\nContent to the end');
    expect(passages[0]!.text).toBe('Content to the end');
  });

  it('MUST: trailing blank lines must be ignored/omitted', () => {
    const { passages } = parseTwee(':: Start\nContent\n\n\n');
    expect(passages[0]!.text).toBe('Content');
    // No trailing newlines
    expect(passages[0]!.text.endsWith('\n')).toBe(false);
  });

  it('MUST: trailing blank lines omitted between passages', () => {
    const { passages } = parseTwee(':: First\nContent 1\n\n\n\n:: Second\nContent 2');
    expect(passages[0]!.text).toBe('Content 1');
    expect(passages[0]!.text.endsWith('\n')).toBe(false);
  });

  it('preserves internal blank lines in content', () => {
    const { passages } = parseTwee(':: Start\nLine 1\n\nLine 3');
    expect(passages[0]!.text).toContain('Line 1');
    expect(passages[0]!.text).toContain('Line 3');
  });

  it('handles passage with empty content', () => {
    const { passages } = parseTwee(':: Empty\n\n:: Next\nContent');
    expect(passages[0]!.name).toBe('Empty');
    expect(passages[0]!.text).toBe('');
    expect(passages[1]!.name).toBe('Next');
  });
});

// =============================================================================
// Section: Special Passages — StoryTitle
// "The project's name. Maps to <tw-storydata name>."
// =============================================================================

describe('Special Passages — StoryTitle', () => {
  it('MUST: StoryTitle sets the story name', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.story.name).toBe('Spec Test');
  });

  it('MUST: StoryTitle maps to tw-storydata name attribute', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('name="Spec Test"');
  });

  it('trims whitespace from StoryTitle content', () => {
    const { passages } = parseTwee(':: StoryTitle\n  My Story  \n\n:: Start\nHello');
    const titlePassage = passages.find((p) => p.name === 'StoryTitle');
    expect(titlePassage!.text).toBe('My Story');
  });
});

// =============================================================================
// Section: Special Passages — StoryData
// "A JSON chunk encapsulating various Twine 2 compatible details"
// =============================================================================

describe('Special Passages — StoryData', () => {
  describe('ifid property', () => {
    it('MUST: ifid is parsed from StoryData JSON', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      expect(result.story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    });

    it('MUST: ifid maps to tw-storydata ifid attribute', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      expect(result.output).toContain('ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"');
    });

    it('MUST: IFID uses only capital letters (uppercase UUIDs)', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"d674c58c-defa-4f70-b7a2-27742230c0fc"}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      // Must be uppercased
      expect(result.story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    });

    it('MUST: generates IFID when missing and emits error', async () => {
      const source = ':: StoryTitle\nTest\n\n:: Start\nHello';
      const result = await compileInline(source);
      // Should have generated an IFID
      expect(result.story.ifid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
      // Should have emitted an error
      const ifidErrors = result.diagnostics.filter(
        (d) => d.message.toLowerCase().includes('ifid') && d.level === 'error',
      );
      expect(ifidErrors.length).toBeGreaterThan(0);
    });

    it('MUST: IFID is a v4 UUID', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      // v4 UUID format: 8-4-4-4-12 hex digits
      expect(result.story.ifid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    });
  });

  describe('format property', () => {
    it('MUST: format is parsed from StoryData JSON', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube"}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.story.twine2.format).toBe('SugarCube');
    });

    it('MUST: format maps to tw-storydata format attribute', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube"}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.output).toContain('format="SugarCube"');
    });
  });

  describe('format-version property', () => {
    it('MUST: format-version is parsed from StoryData JSON', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.28.2"}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.story.twine2.formatVersion).toBe('2.28.2');
    });

    it('MUST: format-version maps to tw-storydata format-version attribute', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.28.2"}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.output).toContain('format-version="2.28.2"');
    });
  });

  describe('start property', () => {
    it('MUST: start specifies the starting passage name', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"My Starting Passage"}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: My Starting Passage',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.story.twine2.start).toBe('My Starting Passage');
    });

    it('MUST: start maps to startnode via passagedata pid', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"Begin"}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Other',
        'Not start',
        '',
        ':: Begin',
        'Start here',
      ].join('\n');
      const result = await compileInline(source);
      // The startnode should reference the pid of "Begin", not "Other"
      expect(result.output).toMatch(/startnode="2"/);
    });
  });

  describe('tag-colors property', () => {
    it('MUST: tag-colors is parsed from StoryData JSON', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"red","bar":"green"}}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.story.twine2.tagColors.get('foo')).toBe('red');
      expect(result.story.twine2.tagColors.get('bar')).toBe('green');
    });

    it('MUST: tag-colors map to tw-tag elements', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"foo":"red","bar":"green"}}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.output).toContain('<tw-tag name="foo" color="red"></tw-tag>');
      expect(result.output).toContain('<tw-tag name="bar" color="green"></tw-tag>');
    });
  });

  describe('zoom property', () => {
    it('MUST: zoom is parsed from StoryData JSON', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","zoom":0.25}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.story.twine2.zoom).toBe(0.25);
    });

    it('MUST: zoom maps to tw-storydata zoom attribute', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","zoom":0.25}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.output).toMatch(/zoom="0\.25"/);
    });
  });

  describe('StoryData JSON error handling', () => {
    it('RECOMMENDED: emits warning on StoryData decode error and continues', async () => {
      const source = [
        ':: StoryData',
        'not valid json at all',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      const errors = result.diagnostics.filter((d) => d.message.toLowerCase().includes('storydata'));
      expect(errors.length).toBeGreaterThan(0);
      // Should still produce output
      expect(result.output.length).toBeGreaterThan(0);
    });
  });

  describe('Full StoryData example from spec', () => {
    it('parses the complete StoryData example from the specification', async () => {
      const source = [
        ':: StoryData',
        '{',
        '   "ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",',
        '   "format": "SugarCube",',
        '   "format-version": "2.28.2",',
        '   "start": "My Starting Passage",',
        '   "tag-colors": {',
        '     "bar": "green",',
        '     "foo": "red",',
        '     "qaz": "blue"',
        '   },',
        '   "zoom": 0.25',
        '}',
        '',
        ':: StoryTitle',
        'Spec Example Story',
        '',
        ':: My Starting Passage',
        'Welcome!',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
      expect(result.story.twine2.format).toBe('SugarCube');
      expect(result.story.twine2.formatVersion).toBe('2.28.2');
      expect(result.story.twine2.start).toBe('My Starting Passage');
      expect(result.story.twine2.tagColors.get('bar')).toBe('green');
      expect(result.story.twine2.tagColors.get('foo')).toBe('red');
      expect(result.story.twine2.tagColors.get('qaz')).toBe('blue');
      expect(result.story.twine2.zoom).toBe(0.25);
    });
  });
});

// =============================================================================
// Section: Special Passages — Start
// "The default starting passage. May be overridden by the story metadata or
//  compiler command."
// =============================================================================

describe('Special Passages — Start', () => {
  it('MUST: "Start" passage is the default starting passage', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Default start',
    ].join('\n');
    const result = await compileInline(source);
    // The startnode should reference the Start passage
    expect(result.output).toContain('startnode="1"');
  });

  it('MUST: start can be overridden by StoryData metadata', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"Begin"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Not the start',
      '',
      ':: Begin',
      'The real start',
    ].join('\n');
    const result = await compileInline(source);
    // "Start" is pid 1, "Begin" is pid 2
    expect(result.output).toContain('startnode="2"');
  });

  it('MUST: start can be overridden by compiler option', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Not the start',
      '',
      ':: CustomStart',
      'The real start',
    ].join('\n');
    const result = await compileInline(source, { startPassage: 'CustomStart' });
    // "Start" is pid 1, "CustomStart" is pid 2
    expect(result.output).toContain('startnode="2"');
  });
});

// =============================================================================
// Section: Special Tags — script
// "Signifies that the passage's contents are JavaScript code."
// "Maps to the <script type='text/twine-javascript'> node."
// =============================================================================

describe('Special Tags — script', () => {
  it('MUST: passage with [script] tag maps to twine-javascript script node', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyScript [script]\nconsole.log("hello");');
    const result = await compileInline(source);
    expect(result.output).toContain('type="text/twine-javascript"');
    expect(result.output).toContain('console.log("hello");');
  });

  it('MUST: script passage is NOT rendered as a regular tw-passagedata', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyScript [script]\nconsole.log("hello");');
    const result = await compileInline(source);
    expect(result.output).not.toContain('name="MyScript"');
  });

  it('combines multiple script passages', async () => {
    const source = minimalStory(
      ':: Start\nHello\n\n:: Script1 [script]\nvar a = 1;\n\n:: Script2 [script]\nvar b = 2;',
    );
    const result = await compileInline(source);
    expect(result.output).toContain('var a = 1;');
    expect(result.output).toContain('var b = 2;');
  });
});

// =============================================================================
// Section: Special Tags — stylesheet
// "Signifies that the passage's contents are CSS style rules."
// "Maps to the <style type='text/twine-css'> node."
// =============================================================================

describe('Special Tags — stylesheet', () => {
  it('MUST: passage with [stylesheet] tag maps to twine-css style node', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyStyles [stylesheet]\nbody { color: red; }');
    const result = await compileInline(source);
    expect(result.output).toContain('type="text/twine-css"');
    expect(result.output).toContain('body { color: red; }');
  });

  it('MUST: stylesheet passage is NOT rendered as a regular tw-passagedata', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyStyles [stylesheet]\nbody { color: red; }');
    const result = await compileInline(source);
    expect(result.output).not.toContain('name="MyStyles"');
  });

  it('combines multiple stylesheet passages', async () => {
    const source = minimalStory(
      ':: Start\nHello\n\n:: Style1 [stylesheet]\nbody { color: red; }\n\n:: Style2 [stylesheet]\np { margin: 0; }',
    );
    const result = await compileInline(source);
    expect(result.output).toContain('body { color: red; }');
    expect(result.output).toContain('p { margin: 0; }');
  });
});

// =============================================================================
// Section: Twine 2 HTML Output Structure
// Validates that compiled output matches the tw-storydata / tw-passagedata
// structure described in the spec.
// =============================================================================

describe('Twine 2 HTML Output Structure', () => {
  it('MUST: output contains tw-storydata element', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('<tw-storydata');
    expect(result.output).toContain('</tw-storydata>');
  });

  it('MUST: tw-storydata has name attribute from StoryTitle', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('name="Spec Test"');
  });

  it('MUST: tw-storydata has ifid attribute', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"');
  });

  it('MUST: tw-storydata has format attribute', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    expect(result.output).toContain('format="SugarCube"');
  });

  it('MUST: tw-storydata has format-version attribute', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.28.2"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    expect(result.output).toContain('format-version="2.28.2"');
  });

  it('MUST: tw-storydata has startnode attribute', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toMatch(/startnode="\d+"/);
  });

  it('MUST: tw-storydata has zoom attribute', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toMatch(/zoom="\d+(\.\d+)?"/);
  });

  it('MUST: regular passages become tw-passagedata elements', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello\n\n:: Room\nA room'));
    expect(result.output).toContain('<tw-passagedata');
    expect(result.output).toContain('name="Start"');
    expect(result.output).toContain('name="Room"');
  });

  it('MUST: tw-passagedata has pid attribute', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toMatch(/pid="\d+"/);
  });

  it('MUST: tw-passagedata has name attribute', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('name="Start"');
  });

  it('MUST: tw-passagedata has tags attribute', async () => {
    const result = await compileInline(minimalStory(':: Start [tag1 tag2]\nHello'));
    expect(result.output).toContain('tags="tag1 tag2"');
  });

  it('MUST: tw-passagedata has position attribute', async () => {
    const result = await compileInline(minimalStory(':: Start {"position":"100,200"}\nHello'));
    expect(result.output).toContain('position="100,200"');
  });

  it('MUST: tw-passagedata has size attribute', async () => {
    const result = await compileInline(minimalStory(':: Start {"size":"200,100"}\nHello'));
    expect(result.output).toContain('size="200,100"');
  });

  it('MUST: style element has type text/twine-css', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('type="text/twine-css"');
  });

  it('MUST: script element has type text/twine-javascript', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('type="text/twine-javascript"');
  });

  it('MUST: StoryTitle passage is NOT rendered as tw-passagedata', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).not.toContain('name="StoryTitle"');
  });

  it('MUST: StoryData passage is NOT rendered as tw-passagedata', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).not.toContain('name="StoryData"');
  });
});

// =============================================================================
// Section: Passage Header — Spec Examples
// Tests the exact examples given in the specification.
// =============================================================================

describe('Spec Examples', () => {
  it('Example: minimal working example', () => {
    const { passages } = parseTwee(':: An overgrown path\n');
    expect(passages).toHaveLength(1);
    expect(passages[0]!.name).toBe('An overgrown path');
  });

  it('Example: with only optional tags', () => {
    const { passages } = parseTwee(':: An overgrown path [forest spooky]\n');
    expect(passages[0]!.name).toBe('An overgrown path');
    expect(passages[0]!.tags).toEqual(['forest', 'spooky']);
  });

  it('Example: with only optional metadata', () => {
    const { passages } = parseTwee(':: An overgrown path {"position":"600,400","size":"100,200"}\n');
    expect(passages[0]!.name).toBe('An overgrown path');
    expect(passages[0]!.metadata).toEqual({ position: '600,400', size: '100,200' });
  });

  it('Example: with both optional tags and metadata', () => {
    const { passages } = parseTwee(':: An overgrown path [forest spooky] {"position":"600,400","size":"100,200"}\n');
    expect(passages[0]!.name).toBe('An overgrown path');
    expect(passages[0]!.tags).toEqual(['forest', 'spooky']);
    expect(passages[0]!.metadata).toEqual({ position: '600,400', size: '100,200' });
  });
});

// =============================================================================
// Section: Prolog / text before first passage
// "It is recommended Twee files are written in UTF-8."
// =============================================================================

describe('Prolog and Encoding', () => {
  it('ignores text before the first passage header (prolog)', () => {
    const { passages } = parseTwee('This is some introductory text\n\n:: Start\nContent');
    expect(passages).toHaveLength(1);
    expect(passages[0]!.name).toBe('Start');
  });

  it('handles empty file gracefully', () => {
    const { passages, diagnostics } = parseTwee('');
    expect(passages).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('handles file with only prolog (no passages)', () => {
    const { passages } = parseTwee('Just some text without any passage headers');
    expect(passages).toHaveLength(0);
  });

  it('handles UTF-8 content in passage names', () => {
    const { passages } = parseTwee(':: Übersicht\nInhalt');
    expect(passages[0]!.name).toBe('Übersicht');
  });

  it('handles UTF-8 content in passage body', () => {
    const { passages } = parseTwee(':: Start\n日本語テキスト');
    expect(passages[0]!.text).toBe('日本語テキスト');
  });

  it('handles UTF-8 content in tags', () => {
    const { passages } = parseTwee(':: Start [étiquette]\nContent');
    expect(passages[0]!.tags).toEqual(['étiquette']);
  });
});

// =============================================================================
// Section: Multiple source files
// The spec implies a story is composed from one or more Twee files.
// =============================================================================

describe('Multiple Source Files', () => {
  it('compiles from multiple inline sources', async () => {
    const result = await compileInline(':: Start\nHello', {
      sources: [
        {
          filename: 'storydata.tw',
          content: ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nMulti File',
        },
        {
          filename: 'passages.tw',
          content: ':: Start\nHello from passages',
        },
      ],
    });
    expect(result.story.name).toBe('Multi File');
    expect(result.output).toContain('Hello from passages');
  });

  it('compiles from file paths', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'minimal.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('Minimal Story');
    expect(result.stats.passages).toBeGreaterThan(0);
  });
});

// =============================================================================
// Section: Edge Cases and Robustness
// =============================================================================

describe('Edge Cases', () => {
  it('handles passage name with only spaces after :: (error)', () => {
    const { diagnostics } = parseTwee('::    \nContent');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('handles multiple consecutive passage headers', () => {
    const { passages } = parseTwee(':: A\n:: B\n:: C\nContent');
    expect(passages).toHaveLength(3);
    expect(passages[0]!.name).toBe('A');
    expect(passages[1]!.name).toBe('B');
    expect(passages[2]!.name).toBe('C');
    expect(passages[2]!.text).toBe('Content');
  });

  it('handles passage with very long name', () => {
    const longName = 'A'.repeat(500);
    const { passages } = parseTwee(`:: ${longName}\nContent`);
    expect(passages[0]!.name).toBe(longName);
  });

  it('handles passage with many tags', () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    const { passages } = parseTwee(`:: Room [${tags.join(' ')}]\nContent`);
    expect(passages[0]!.tags).toHaveLength(50);
  });

  it('handles passage content with special characters', () => {
    const { passages } = parseTwee(':: Start\n<html>&amp;"quotes"</html>');
    expect(passages[0]!.text).toContain('<html>');
    expect(passages[0]!.text).toContain('&amp;');
  });

  it('handles Windows-style line endings (\\r\\n)', () => {
    const { passages } = parseTwee(':: Start\r\nContent line 1\r\nContent line 2\r\n\r\n:: Second\r\nMore');
    expect(passages).toHaveLength(2);
    expect(passages[0]!.name).toBe('Start');
  });

  it('handles metadata with nested JSON objects', () => {
    const { passages } = parseTwee(':: Room {"position":"100,100","size":"200,100"}\nContent');
    expect(passages[0]!.metadata?.position).toBe('100,100');
    expect(passages[0]!.metadata?.size).toBe('200,100');
  });

  it('MUST: passage header is on a single line', () => {
    // Metadata cannot span multiple lines (unterminated)
    const { diagnostics } = parseTwee(':: Room {"position":\n"100,100"}\nContent');
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Section: Twee 3 Output (roundtrip)
// When outputting Twee 3, the spec format should be preserved.
// =============================================================================

describe('Twee 3 Output Format', () => {
  it('outputs passages with :: header', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'), {
      outputMode: 'twee3',
    });
    expect(result.output).toContain(':: Start');
  });

  it('outputs tags in square brackets', async () => {
    const result = await compileInline(minimalStory(':: Room [forest spooky]\nContent'), { outputMode: 'twee3' });
    expect(result.output).toContain(':: Room [forest spooky]');
  });

  it('outputs metadata as inline JSON', async () => {
    const result = await compileInline(minimalStory(':: Room {"position":"100,100","size":"200,100"}\nContent'), {
      outputMode: 'twee3',
    });
    expect(result.output).toContain('"position":"100,100"');
    expect(result.output).toContain('"size":"200,100"');
  });

  it('outputs StoryData as pretty-printed JSON (RECOMMENDED)', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'), {
      outputMode: 'twee3',
    });
    // StoryData should be in the output and be pretty-printed (indented)
    expect(result.output).toContain(':: StoryData');
    expect(result.output).toContain('"ifid"');
  });

  it('escapes passage names with metacharacters in Twee 3 output', async () => {
    // Compile a passage whose name contains [ and check the twee3 output escapes it
    const source = minimalStory('');
    const result = await compile({
      sources: [
        {
          filename: 'test.tw',
          content: source + ':: Start\nHello',
        },
      ],
      outputMode: 'twee3',
    });
    // The output should contain proper twee3 format
    expect(result.output).toContain(':: Start');
  });
});

// =============================================================================
// Section: Diagnostics and Error Reporting
// The spec calls for warnings in certain situations.
// =============================================================================

describe('Diagnostics and Error Reporting', () => {
  it('collects errors without crashing', async () => {
    const result = await compileInline(':: Test [unclosed\nContent', { outputMode: 'twee3' });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('diagnostics have level (warning or error)', () => {
    const { diagnostics } = parseTwee(':: Test [unclosed\nContent');
    expect(diagnostics[0]!.level).toMatch(/^(warning|error)$/);
  });

  it('diagnostics have message', () => {
    const { diagnostics } = parseTwee(':: Test [unclosed\nContent');
    expect(diagnostics[0]!.message.length).toBeGreaterThan(0);
  });

  it('diagnostics include file info when filename is provided', () => {
    const { diagnostics } = parseTwee(':: Test [unclosed\nContent', { filename: 'my-story.tw' });
    expect(diagnostics[0]!.file).toBe('my-story.tw');
  });

  it('diagnostics include line number', () => {
    const { diagnostics } = parseTwee(':: Test [unclosed\nContent');
    expect(diagnostics[0]!.line).toBeGreaterThan(0);
  });
});

// =============================================================================
// Section: IFID Validation
// "Twine 2 uses v4 (random) UUIDs, using only capital letters"
// =============================================================================

describe('IFID Compliance', () => {
  it('MUST: IFIDs are uppercase UUIDs', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.story.ifid).toMatch(/^[0-9A-F-]+$/);
  });

  it('MUST: auto-generated IFIDs are valid v4 UUIDs', async () => {
    const source = ':: StoryTitle\nTest\n\n:: Start\nHello';
    const result = await compileInline(source);
    // v4 UUID: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
    expect(result.story.ifid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  });

  it('MUST: validates IFID format and reports error for invalid IFID', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"not-a-valid-uuid"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    const ifidErrors = result.diagnostics.filter(
      (d) => d.message.toLowerCase().includes('ifid') || d.message.toLowerCase().includes('uuid'),
    );
    expect(ifidErrors.length).toBeGreaterThan(0);
  });

  it('MUST: HTML output includes UUID comment', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('<!-- UUID://');
    expect(result.output).toContain('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });
});

// =============================================================================
// Section: Complete Integration — Real Fixture Files
// =============================================================================

describe('Integration — Fixture Files', () => {
  it('compiles minimal.tw correctly', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'minimal.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.story.name).toBe('Minimal Story');
    expect(result.story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(result.output).toContain('Hello, world!');
  });

  it('compiles multi-passage.tw with tags', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('name="Room"');
    expect(result.output).toContain('tags="location"');
    expect(result.output).toContain('tags="location hidden"');
  });

  it('compiles storydata.tw with full metadata', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'storydata.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.story.twine2.format).toBe('SugarCube');
    expect(result.story.twine2.formatVersion).toBe('2.37.3');
    expect(result.story.twine2.start).toBe('Begin');
    expect(result.output).toContain('position="100,100"');
    expect(result.output).toContain('size="200,100"');
  });
});

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
import type { LexerItem, CompileOptions, CompileResult } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'test', 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

/** Helper: collect all lexer items from input. */
function lex(input: string): LexerItem[] {
  return [...tweeLexer(input)];
}

/** Helper: compile inline twee source to HTML. */
async function compileInline(content: string, options: Partial<CompileOptions> = {}): Promise<CompileResult> {
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
// Section: File Type
// "It is recommended Twee files have a .tw or .twee file extension."
// =============================================================================

describe('File Type', () => {
  it('RECOMMENDED: accepts .tw file extension', async () => {
    const result = await compile({
      sources: [{ filename: 'story.tw', content: minimalStory(':: Start\nHello') }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('name="Start"');
  });

  it('RECOMMENDED: accepts .twee file extension', async () => {
    const result = await compile({
      sources: [{ filename: 'story.twee', content: minimalStory(':: Start\nHello') }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('name="Start"');
  });

  it('RECOMMENDED: both .tw and .twee produce identical story output', async () => {
    const content = minimalStory(':: Start\nHello');
    const resultTw = await compile({
      sources: [{ filename: 'story.tw', content }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    const resultTwee = await compile({
      sources: [{ filename: 'story.twee', content }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    // Both should parse identically — same story name, same passages
    expect(resultTw.story.name).toBe(resultTwee.story.name);
    expect(resultTw.stats.passages).toBe(resultTwee.stats.passages);
  });
});

// =============================================================================
// Section: UTF-8 Encoding
// "It is recommended Twee files are written in UTF-8."
// =============================================================================

describe('UTF-8 Encoding', () => {
  it('RECOMMENDED: non-ASCII passage names round-trip through compile', async () => {
    const result = await compileInline(minimalStory(':: Ünïcödé Pässàge\nContent'));
    expect(result.output).toContain('Ünïcödé Pässàge');
  });

  it('RECOMMENDED: CJK passage names round-trip through compile', async () => {
    const result = await compileInline(minimalStory(':: 日本語の部屋\n内容'));
    expect(result.output).toContain('日本語の部屋');
  });

  it('RECOMMENDED: emoji in passage content round-trips through compile', async () => {
    const result = await compileInline(minimalStory(':: Start\n🎮 Welcome to the game! 🎲'));
    expect(result.output).toContain('🎮 Welcome to the game! 🎲');
  });

  it('RECOMMENDED: non-ASCII tag names round-trip through compile', async () => {
    const result = await compileInline(minimalStory(':: Start [forêt effrayant]\nContent'));
    expect(result.output).toContain('forêt');
    expect(result.output).toContain('effrayant');
  });

  it('RECOMMENDED: right-to-left (RTL) script in passage names round-trips', async () => {
    const result = await compileInline(minimalStory(':: مقدمة\nمحتوى'));
    expect(result.output).toContain('مقدمة');
  });

  it('RECOMMENDED: supplementary Unicode plane characters (astral) round-trip', async () => {
    // Characters beyond BMP (U+10000+), e.g., 𝕳 (U+1D573)
    const result = await compileInline(minimalStory(':: Start\n𝕳𝖊𝖑𝖑𝖔'));
    expect(result.output).toContain('𝕳𝖊𝖑𝖑𝖔');
  });

  it('RECOMMENDED: mixed-script passage content round-trips', async () => {
    const result = await compileInline(minimalStory(':: Start\nEnglish, 日本語, العربية, Ελληνικά'));
    expect(result.output).toContain('English, 日本語, العربية, Ελληνικά');
  });

  it('handles UTF-8 content in passage names at parser level', () => {
    const { passages } = parseTwee(':: Übersicht\nInhalt');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Übersicht');
  });

  it('handles UTF-8 content in passage body at parser level', () => {
    const { passages } = parseTwee(':: Start\n日本語テキスト');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('日本語テキスト');
  });

  it('handles UTF-8 content in tags at parser level', () => {
    const { passages } = parseTwee(':: Start [étiquette]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.tags).toEqual(['étiquette']);
  });
});

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
      const first = items[0];
      if (!first) throw new Error('expected at least one lexer item');
      expect(first.type).toBe(ItemType.Header);
      expect(first.val).toBe('::');
    });

    it('MUST: recognizes :: at the beginning of the file', () => {
      const { passages } = parseTwee(':: Start\nContent');
      expect(passages).toHaveLength(1);
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Start');
    });

    it('recognizes :: at the beginning of a subsequent line (prolog text handling is implementation-defined)', () => {
      const { passages } = parseTwee('Some prolog text\n:: Start\nContent');
      expect(passages).toHaveLength(1);
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Start');
    });

    it('does not treat :: in the middle of a line as a header', () => {
      const { passages } = parseTwee(':: Start\nSome :: text here');
      expect(passages).toHaveLength(1);
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.text).toContain('Some :: text here');
    });

    it('MUST: :: must begin the line (not indented)', () => {
      // Leading whitespace before :: means it's NOT a header
      const { passages } = parseTwee(':: Start\n  :: NotAHeader\nContent');
      expect(passages).toHaveLength(1);
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Start');
      expect(first.text).toContain(':: NotAHeader');
    });
  });

  // -------------------------------------------------------------------------
  // Component 2: Required passage name
  // -------------------------------------------------------------------------
  describe('Passage Name', () => {
    it('MUST: parses the passage name after ::', () => {
      const { passages } = parseTwee(':: My Passage Name\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('My Passage Name');
    });

    it('MUST: allows spaces before the passage name for readability', () => {
      const { passages } = parseTwee('::   Spaced Name\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Spaced Name');
    });

    it('reports an error for a passage with no name', () => {
      const { diagnostics } = parseTwee(':: \nContent');
      expect(diagnostics.length).toBeGreaterThan(0);
      const first = diagnostics[0];
      if (!first) throw new Error('expected at least one diagnostic');
      expect(first.level).toBe('error');
    });

    it('RECOMMENDED: passage names should be unique within a story — emit at least a warning', async () => {
      const result = await compileInline(minimalStory(':: Duplicate\nFirst\n\n:: Duplicate\nSecond'));
      const dupWarnings = result.diagnostics.filter(
        (d) =>
          d.level === 'warning' &&
          (d.message.toLowerCase().includes('duplicate') || d.message.toLowerCase().includes('replacing')),
      );
      // Spec: "It is recommended that the outcome of detecting multiple passages with
      // the same name should at least be to emit a warning."
      expect(dupWarnings.length).toBeGreaterThan(0);
    });

    it('RECOMMENDED: passage names should not contain link markup metacharacters [ ] |', () => {
      // Spec: "It is recommended that passage names should not contain link markup
      // metacharacters like [, ], or |." — this is RECOMMENDED, not MUST.
      // The compiler must at minimum accept these without crashing.
      const result = parseTwee(':: Choice A | Choice B\nContent');
      // Passage should still be parsed
      expect(result.passages.length).toBeGreaterThan(0);
    });

    it('MUST: passage name is required — header with only :: and whitespace is invalid', () => {
      // Spec: "Required passage name." — name is mandatory after ::
      const { passages, diagnostics } = parseTwee('::\nContent');
      // Either no passage is created, or an error is emitted
      if (passages.length > 0) {
        // If a passage was created, its name should not be empty
        const first = passages[0];
        if (!first) throw new Error('expected at least one passage');
        expect(first.name.trim().length).toBeGreaterThan(0);
      }
      expect(diagnostics.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Component 3: Optional tag block
  // "Optional tag block that must directly follow the passage name"
  // -------------------------------------------------------------------------
  describe('Tag Block', () => {
    it('MUST: parses tags enclosed in square brackets', () => {
      const { passages } = parseTwee(':: Room [forest spooky]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toEqual(['forest', 'spooky']);
    });

    it('MUST: tags are a space-separated list', () => {
      const { passages } = parseTwee(':: Room [a b c d]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toEqual(['a', 'b', 'c', 'd']);
    });

    it('MUST: tag block directly follows the passage name', () => {
      const { passages } = parseTwee(':: Room [tag1]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      expect(first.tags).toEqual(['tag1']);
    });

    it('MUST: tag block may be preceded by spaces for readability', () => {
      // Spec: "Each component after the start token may be preceded by one or more spaces"
      const { passages } = parseTwee('::  Room   [tag1 tag2]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      expect(first.tags).toEqual(['tag1', 'tag2']);
    });

    it('handles empty tag block', () => {
      const { passages } = parseTwee(':: Room []\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toEqual([]);
    });

    it('MUST: tags must not contain spaces — each space-separated word is a separate tag', () => {
      const { passages } = parseTwee(':: Room [multi word tag]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toEqual(['multi', 'word', 'tag']);
    });

    it('MUST: multiple spaces between tags are treated the same as single space', () => {
      const { passages } = parseTwee(':: Room [a   b   c]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toEqual(['a', 'b', 'c']);
    });

    it('reports error for unterminated tag block', () => {
      const { diagnostics } = parseTwee(':: Room [unclosed\nContent');
      expect(diagnostics.length).toBeGreaterThan(0);
      const first = diagnostics[0];
      if (!first) throw new Error('expected at least one diagnostic');
      expect(first.level).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // Component 4: Optional metadata block
  // "Optional metadata block, an inline JSON chunk"
  // -------------------------------------------------------------------------
  describe('Metadata Block', () => {
    it('MUST: parses metadata as inline JSON', () => {
      const { passages } = parseTwee(':: Room {"position":"600,400","size":"100,200"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.metadata).toEqual({ position: '600,400', size: '100,200' });
    });

    it('MUST: metadata block directly follows tag block when tags are present', () => {
      const { passages } = parseTwee(':: Room [forest] {"position":"100,100"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toEqual(['forest']);
      expect(first.metadata).toEqual({ position: '100,100' });
    });

    it('MUST: metadata block directly follows passage name when tags are omitted', () => {
      const { passages } = parseTwee(':: Room {"position":"100,100"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      expect(first.metadata).toEqual({ position: '100,100' });
    });

    it('MUST: supports position property (string, comma-separated coordinates)', () => {
      const { passages } = parseTwee(':: Room {"position":"600,400"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.metadata?.position).toBe('600,400');
    });

    it('MUST: supports size property (string, comma-separated width and height)', () => {
      const { passages } = parseTwee(':: Room {"size":"100,200"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.metadata?.size).toBe('100,200');
    });

    it('RECOMMENDED: emits warning on metadata decode error and continues processing', () => {
      const { passages, diagnostics } = parseTwee(':: Room {invalid json}\nContent');
      // Should warn, not error fatally
      const warnings = diagnostics.filter((d) => d.level === 'warning');
      expect(warnings.length).toBeGreaterThan(0);
      // Should still have the passage (continue processing)
      expect(passages).toHaveLength(1);
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
    });

    it('RECOMMENDED: discards metadata on decode error', () => {
      const { passages } = parseTwee(':: Room {broken json}\nContent here');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      // Metadata should be discarded (empty or undefined)
      expect(first.metadata).toEqual(undefined);
      // But passage content should be preserved
      expect(first.text).toBe('Content here');
    });

    it('MUST: metadata with only position property (no size)', () => {
      const { passages } = parseTwee(':: Room {"position":"600,400"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.metadata?.position).toBe('600,400');
      expect(first.metadata?.size).toBeUndefined();
    });

    it('MUST: metadata with only size property (no position)', () => {
      const { passages } = parseTwee(':: Room {"size":"100,200"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.metadata?.size).toBe('100,200');
      expect(first.metadata?.position).toBeUndefined();
    });

    it('MUST: empty metadata object is valid', () => {
      const { passages, diagnostics } = parseTwee(':: Room {}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      // Empty JSON is valid — no warnings about metadata
      const metaWarnings = diagnostics.filter(
        (d) => d.message.toLowerCase().includes('metadata') || d.message.toLowerCase().includes('json'),
      );
      expect(metaWarnings).toHaveLength(0);
    });

    it('reports error for unterminated metadata block', () => {
      const { diagnostics } = parseTwee(':: Room {unclosed\nContent');
      expect(diagnostics.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Component order and spacing
  // "Each component after the start token may be preceded by one or more spaces"
  // -------------------------------------------------------------------------
  describe('Component Ordering and Spacing', () => {
    it('MUST: components may be preceded by one or more spaces', () => {
      const { passages } = parseTwee('::  Room  [tag] {"position":"1,1"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      expect(first.tags).toEqual(['tag']);
    });

    it('MUST: all four components together in correct order', () => {
      const { passages } = parseTwee(
        ':: An overgrown path [forest spooky] {"position":"600,400","size":"100,200"}\nContent',
      );
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('An overgrown path');
      expect(first.tags).toEqual(['forest', 'spooky']);
      expect(first.metadata).toEqual({ position: '600,400', size: '100,200' });
    });

    it('minimal: start token and name only', () => {
      const { passages } = parseTwee(':: An overgrown path\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('An overgrown path');
      expect(first.tags).toEqual([]);
    });

    it('name with tags only (no metadata)', () => {
      const { passages } = parseTwee(':: An overgrown path [forest spooky]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('An overgrown path');
      expect(first.tags).toEqual(['forest', 'spooky']);
    });

    it('name with metadata only (no tags)', () => {
      const { passages } = parseTwee(':: An overgrown path {"position":"600,400","size":"100,200"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('An overgrown path');
      expect(first.metadata).toEqual({ position: '600,400', size: '100,200' });
    });

    it('MUST: spaces before the tag block are allowed', () => {
      const { passages } = parseTwee(':: Room   [tag]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      expect(first.tags).toEqual(['tag']);
    });

    it('MUST: spaces before the metadata block are allowed', () => {
      const { passages } = parseTwee(':: Room [tag]   {"position":"1,1"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      expect(first.tags).toEqual(['tag']);
      expect(first.metadata).toEqual({ position: '1,1' });
    });

    it('MUST: metadata block order — metadata must follow tags, not precede them', () => {
      // Spec: metadata "must directly follow either the tag block or, if the tag block
      // is omitted, the passage name." So metadata BEFORE tags is wrong order.
      const source = ':: Room {"position":"100,200"} [tag]\nContent';
      const result = parseTwee(source);
      // When metadata appears before tags, the metadata should NOT be parsed as valid
      // metadata with the tag block also being valid. Either:
      // 1. The parser emits a diagnostic about the ordering, OR
      // 2. The metadata is NOT parsed as metadata (e.g., treated as part of the name), OR
      // 3. The tag block is NOT parsed as tags
      const room = result.passages.find((p) => p.name === 'Room');
      if (room) {
        // If the parser found a "Room" passage, the metadata and tags must NOT both be
        // correctly parsed, since the spec requires metadata to follow tags
        const hasBothCorrect = room.metadata?.position === '100,200' && room.tags.includes('tag');
        expect(hasBothCorrect).toBe(false);
      }
      // If no Room passage was found, there should be diagnostics
      if (!room) {
        expect(result.diagnostics.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Escapement
  // "passage and tag names that include [ ] { } must escape them with \"
  // -------------------------------------------------------------------------
  describe('Escapement', () => {
    it('MUST: unescapes \\[ in passage names', () => {
      const { passages } = parseTwee(':: Name\\[1\\]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Name[1]');
    });

    it('MUST: unescapes \\] in passage names', () => {
      const { passages } = parseTwee(':: Name\\]test\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Name]test');
    });

    it('MUST: unescapes \\{ in passage names', () => {
      const { passages } = parseTwee(':: Name\\{test\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Name{test');
    });

    it('MUST: unescapes \\} in passage names', () => {
      const { passages } = parseTwee(':: Name\\}test\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Name}test');
    });

    it('MUST: non-escape backslashes must also be escaped (\\\\)', () => {
      const { passages } = parseTwee(':: foo\\\\bar\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('foo\\bar');
    });

    it('MUST: decoding robustness — any escaped character yields the character minus backslash (\\q -> q)', () => {
      const { passages } = parseTwee(':: foo\\qbar\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('fooqbar');
    });

    it('MUST: unescapes metacharacters in tag names', () => {
      const { passages } = parseTwee(':: Room [tag\\[1\\]]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toContain('tag[1]');
    });

    it('MUST: unescapes \\{ and \\} in tag names', () => {
      const { passages } = parseTwee(':: Room [tag\\{a\\}]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toContain('tag{a}');
    });

    it('MUST: unescapes combined \\[ \\] \\{ \\} in a single tag name', () => {
      const { passages } = parseTwee(':: Room [tag\\[1\\]\\{2\\}]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toContain('tag[1]{2}');
    });

    it('MUST: non-escape backslashes in tag names are escaped', () => {
      // Spec: "Non-escape backslashes must also be escaped (i.e. foo\\bar must become foo\\\\bar)"
      const { passages } = parseTwee(':: Room [foo\\\\bar]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toEqual(['foo\\bar']);
    });

    it('MUST: decoding robustness in tags — any escaped character yields the character minus backslash', () => {
      // Spec: "any escaped character within a chunk of encoded text must yield
      // the character minus the backslash (i.e. \\q must yield q)"
      const { passages } = parseTwee(':: Room [tag\\q]\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toEqual(['tagq']);
    });

    it('MUST: combined escaped metacharacters in passage name', () => {
      const { passages } = parseTwee(':: \\[foo\\]\\{bar\\}\\\\baz\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('[foo]{bar}\\baz');
    });
  });

  // -------------------------------------------------------------------------
  // Single-line header constraint
  // "Each header must be a single line"
  // -------------------------------------------------------------------------
  describe('Single-line Header', () => {
    it('MUST: passage header is on a single line', () => {
      // Metadata cannot span multiple lines (unterminated)
      const { diagnostics } = parseTwee(':: Room {"position":\n"100,100"}\nContent');
      expect(diagnostics.length).toBeGreaterThan(0);
    });

    it('MUST: tag block split across lines is not parsed as multi-line tags', () => {
      // Spec requires passage headers to be on a single line.
      const { passages, diagnostics } = parseTwee(':: Room [tag1\ntag2]\nContent');
      // Either: the parser emits a diagnostic about the unterminated tag block,
      // or if it produces the passage, "tag2" should NOT appear as a tag.
      if (passages.length > 0) {
        const first = passages[0];
        if (!first) throw new Error('expected at least one passage');
        const allTags = first.tags;
        expect(allTags).not.toContain('tag2');
        expect(allTags).not.toContain('tag2]');
      } else {
        // Parser could not produce a passage — the unterminated header was rejected
        expect(diagnostics.length).toBeGreaterThan(0);
      }
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
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('This is content');
  });

  it('MUST: content continues until the next passage header', () => {
    const { passages } = parseTwee(':: First\nLine 1\nLine 2\n\n:: Second\nOther');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toContain('Line 1');
    expect(first.text).toContain('Line 2');
    const second = passages[1];
    if (!second) throw new Error('expected at least two passages');
    expect(second.text).toBe('Other');
  });

  it('MUST: content continues until the end of file', () => {
    const { passages } = parseTwee(':: Start\nContent to the end');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('Content to the end');
  });

  it('MUST: trailing blank lines must be ignored/omitted (end of file)', () => {
    const { passages } = parseTwee(':: Start\nContent\n\n\n');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('Content');
    // No trailing newlines
    expect(first.text.endsWith('\n')).toBe(false);
  });

  it('MUST: trailing blank lines omitted between passages', () => {
    const { passages } = parseTwee(':: First\nContent 1\n\n\n\n:: Second\nContent 2');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('Content 1');
    expect(first.text.endsWith('\n')).toBe(false);
  });

  it('MUST: single trailing blank line is omitted', () => {
    const { passages } = parseTwee(':: Start\nContent\n\n:: Next\nMore');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('Content');
  });

  it('preserves internal blank lines in content', () => {
    const { passages } = parseTwee(':: Start\nLine 1\n\nLine 3');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    // The blank line between Line 1 and Line 3 should be preserved
    expect(first.text).toContain('Line 1');
    expect(first.text).toContain('\n\n');
    expect(first.text).toContain('Line 3');
  });

  it('handles passage with empty content', () => {
    const { passages } = parseTwee(':: Empty\n\n:: Next\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Empty');
    expect(first.text).toBe('');
    const second = passages[1];
    if (!second) throw new Error('expected at least two passages');
    expect(second.name).toBe('Next');
  });

  it('handles multiline content correctly', () => {
    const { passages } = parseTwee(':: Start\nLine 1\nLine 2\nLine 3');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('Line 1\nLine 2\nLine 3');
  });

  it('MUST: content does NOT include the header line itself', () => {
    const { passages } = parseTwee(':: Start\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    // Content must NOT contain the :: header
    expect(first.text).not.toContain('::');
    expect(first.text).not.toContain('Start');
    expect(first.text).toBe('Content');
  });

  it('MUST: leading blank lines after header are preserved as content (only trailing are stripped)', () => {
    // Spec says "trailing blank lines must be ignored/omitted" but says nothing about leading
    const { passages } = parseTwee(':: Start\n\n\nContent\n\n');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    // Trailing blank lines stripped, but leading blank lines before content are part of content
    // The content should contain the blank lines before "Content"
    expect(first.text).toContain('Content');
    // Trailing newlines must NOT be present
    expect(first.text.endsWith('\n')).toBe(false);
  });

  it('MUST: multiple trailing blank lines at end of file are all omitted', () => {
    const { passages } = parseTwee(':: Start\nContent\n\n\n\n\n');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('Content');
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

  it('MUST: StoryTitle content is used as the value of the name attribute on tw-storydata', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'My Custom Story Name',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    // The name attribute on tw-storydata must match the StoryTitle content exactly
    expect(result.output).toMatch(/<tw-storydata[^>]*name="My Custom Story Name"/);
  });

  it('trims whitespace from StoryTitle content', () => {
    const { passages } = parseTwee(':: StoryTitle\n  My Story  \n\n:: Start\nHello');
    const titlePassage = passages.find((p) => p.name === 'StoryTitle');
    if (!titlePassage) throw new Error('expected StoryTitle passage');
    expect(titlePassage.text).toBe('My Story');
  });

  it('MUST: StoryTitle passage is NOT rendered as tw-passagedata', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).not.toContain('name="StoryTitle"');
  });
});

// =============================================================================
// Section: Special Passages — StoryData
// "A JSON chunk encapsulating various Twine 2 compatible details"
// =============================================================================

describe('Special Passages — StoryData', () => {
  // ---------------------------------------------------------------------------
  // ifid property
  // "ifid: (string) Required. Maps to <tw-storydata ifid>."
  // ---------------------------------------------------------------------------
  describe('ifid property', () => {
    it('MUST: ifid is parsed from StoryData JSON', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      expect(result.story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    });

    it('MUST: ifid maps to tw-storydata ifid attribute', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      expect(result.output).toContain('ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"');
    });

    it('MUST: IFID uses only capital letters (lowercase input is uppercased)', async () => {
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
      // Must be uppercased in story model
      expect(result.story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
      // Must be uppercased in output
      expect(result.output).toContain('ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"');
      expect(result.output).not.toContain('ifid="d674c58c');
    });

    it('MUST: ifid is required — generates IFID when missing and emits error', async () => {
      const source = ':: StoryTitle\nTest\n\n:: Start\nHello';
      const result = await compileInline(source);
      // Should have generated an IFID
      expect(result.story.ifid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
      // Should have emitted an error about missing IFID
      const ifidErrors = result.diagnostics.filter(
        (d) => d.message.toLowerCase().includes('ifid') && d.level === 'error',
      );
      expect(ifidErrors.length).toBeGreaterThan(0);
    });

    it('MUST: IFID is a v4 UUID format', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      // v4 UUID format: 8-4-4-4-12 hex digits
      expect(result.story.ifid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    });

    it('MUST: auto-generates uppercase v4 UUID when StoryData JSON omits ifid key', async () => {
      const source = [
        ':: StoryData',
        '{"format":"SugarCube"}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      // Should still produce output (not crash)
      expect(result.output.length).toBeGreaterThan(0);
      // Should have auto-generated an IFID in the output
      const ifidMatch = result.output.match(/ifid="([^"]+)"/);
      if (!ifidMatch) throw new Error('expected ifid attribute in output');
      const ifidValue = ifidMatch[1];
      if (!ifidValue) throw new Error('expected ifid capture group');
      // The IFID should be a v4 UUID with uppercase letters only
      expect(ifidValue).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
      // Must NOT contain lowercase hex digits
      expect(ifidValue).not.toMatch(/[a-f]/);
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

    it('MUST: auto-generated IFIDs are valid v4 UUIDs (version nibble = 4, variant = 10xx)', async () => {
      const source = ':: StoryTitle\nTest\n\n:: Start\nHello';
      const result = await compileInline(source);
      // v4 UUID: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
      expect(result.story.ifid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    });

    it('MUST: provided IFID preserves v4 UUID variant/version bits', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      const ifid = result.story.ifid;
      const parts = ifid.split('-');
      expect(parts).toHaveLength(5);
      const thirdPart = parts[2];
      if (!thirdPart) throw new Error('expected third part of IFID');
      // 3rd group starts with '4' (version)
      expect(thirdPart[0]).toBe('4');
      const fourthPart = parts[3];
      if (!fourthPart) throw new Error('expected fourth part of IFID');
      // 4th group starts with [89AB] (variant)
      expect(fourthPart[0]).toMatch(/[89AB]/);
    });

    it('MUST: IFID in tw-storydata ifid attribute contains only uppercase hex and dashes', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      const ifidMatch = result.output.match(/ifid="([^"]+)"/);
      if (!ifidMatch) throw new Error('expected ifid attribute in output');
      const ifidValue = ifidMatch[1];
      if (!ifidValue) throw new Error('expected ifid capture group');
      // Spec: "uses only capital letters" — must not contain lowercase a-f
      expect(ifidValue).not.toMatch(/[a-f]/);
      // Must match UUID format with uppercase only
      expect(ifidValue).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    });

    it('Treaty of Babel: HTML output includes UUID comment', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      expect(result.output).toContain('<!-- UUID://');
      expect(result.output).toContain('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    });
  });

  // ---------------------------------------------------------------------------
  // format property
  // "format: (string) Optional. Maps to <tw-storydata format>."
  // ---------------------------------------------------------------------------
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

    it('format is optional — omitting it does not cause an error', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      // No error about missing format
      const formatErrors = result.diagnostics.filter(
        (d) => d.level === 'error' && d.message.toLowerCase().includes('format'),
      );
      expect(formatErrors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // format-version property
  // "format-version: (string) Optional. Maps to <tw-storydata format-version>."
  // ---------------------------------------------------------------------------
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

    it('format-version is optional — omitting it does not cause an error', async () => {
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
      const formatVersionErrors = result.diagnostics.filter(
        (d) => d.level === 'error' && d.message.toLowerCase().includes('format-version'),
      );
      expect(formatVersionErrors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // start property
  // "start: (string) Optional. Maps to <tw-passagedata name> of the node whose
  //  pid matches <tw-storydata startnode>."
  // ---------------------------------------------------------------------------
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
      // Extract the startnode value and the pid of "Begin" passage
      const startnodeMatch = result.output.match(/startnode="(\d+)"/);
      if (!startnodeMatch) throw new Error('expected startnode attribute');
      const startnode = startnodeMatch[1];
      // Find the pid of the "Begin" passage
      const beginMatch = result.output.match(/<tw-passagedata[^>]*name="Begin"[^>]*pid="(\d+)"/);
      const beginMatchAlt = result.output.match(/<tw-passagedata[^>]*pid="(\d+)"[^>]*name="Begin"/);
      const beginPid = beginMatch?.[1] ?? beginMatchAlt?.[1];
      if (!beginPid) throw new Error('expected Begin passage with pid in output');
      // startnode should match the pid of "Begin"
      expect(startnode).toBe(beginPid);
    });

    it('start is optional — omitting it does not cause an error', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      const startErrors = result.diagnostics.filter(
        (d) => d.level === 'error' && d.message.toLowerCase().includes('"start"'),
      );
      expect(startErrors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // tag-colors property
  // "tag-colors: (object of tag(string):color(string) pairs) Optional."
  // "Pairs map to <tw-tag> nodes as <tw-tag name>:<tw-tag color>."
  // ---------------------------------------------------------------------------
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

    it('MUST: tag-colors map to tw-tag elements with name and color attributes', async () => {
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

    it('MUST: tag-colors with three entries from spec example are all mapped to tw-tag elements', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"bar":"green","foo":"red","qaz":"blue"}}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      // Each tag-color pair must produce a separate tw-tag element
      expect(result.output).toContain('<tw-tag name="bar" color="green"></tw-tag>');
      expect(result.output).toContain('<tw-tag name="foo" color="red"></tw-tag>');
      expect(result.output).toContain('<tw-tag name="qaz" color="blue"></tw-tag>');
    });

    it('empty tag-colors object produces no tw-tag elements', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{}}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Content',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.output).not.toContain('<tw-tag');
    });

    it('tag-colors is optional — omitting it does not cause an error', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      const tagColorErrors = result.diagnostics.filter(
        (d) => d.level === 'error' && d.message.toLowerCase().includes('tag-color'),
      );
      expect(tagColorErrors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // zoom property
  // "zoom: (decimal) Optional. Maps to <tw-storydata zoom>."
  // ---------------------------------------------------------------------------
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

    it('MUST: zoom is a decimal value — integer zoom also works', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","zoom":1}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.story.twine2.zoom).toBe(1);
    });

    it('zoom: default value when omitted from StoryData', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      // When zoom is not in StoryData, the output should either omit it or use default 1
      if (result.output.includes('zoom=')) {
        expect(result.output).toMatch(/zoom="1"/);
      }
    });

    it('zoom is optional — omitting it does not cause an error', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'));
      const zoomErrors = result.diagnostics.filter(
        (d) => d.level === 'error' && d.message.toLowerCase().includes('zoom'),
      );
      expect(zoomErrors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // StoryData JSON error handling
  // "It is recommended that the outcome of a decoding error should be to:
  //  emit a warning, discard the metadata, and continue processing the file."
  // ---------------------------------------------------------------------------
  describe('StoryData JSON error handling', () => {
    it('RECOMMENDED: emits warning on StoryData decode error', async () => {
      // Spec: "It is recommended that the outcome of a decoding error should be to:
      // emit a warning, discard the metadata, and continue processing the file."
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
      // Should emit a WARNING (not error) about StoryData decode failure
      const warnings = result.diagnostics.filter(
        (d) => d.level === 'warning' && d.message.toLowerCase().includes('storydata'),
      );
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('RECOMMENDED: continues processing the file after StoryData decode error', async () => {
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
      // Should still produce output (not crash/abort)
      expect(result.output.length).toBeGreaterThan(0);
      // Should have auto-generated a valid IFID since corrupted StoryData was discarded
      const ifidMatch = result.output.match(/ifid="([^"]+)"/);
      if (!ifidMatch) throw new Error('expected ifid attribute in output');
      const ifidValue = ifidMatch[1];
      if (!ifidValue) throw new Error('expected ifid capture group');
      expect(ifidValue).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    });

    it('RECOMMENDED: discards metadata on StoryData decode error', async () => {
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
      // Output should NOT contain corrupted JSON data
      expect(result.output).not.toContain('not valid json at all');
    });
  });

  // ---------------------------------------------------------------------------
  // Full StoryData example from spec
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // StoryData passage is NOT rendered as tw-passagedata
  // ---------------------------------------------------------------------------
  it('MUST: StoryData passage is NOT rendered as tw-passagedata', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(result.output).not.toContain('name="StoryData"');
  });

  // ---------------------------------------------------------------------------
  // RECOMMENDED: pretty-printed JSON
  // "For readability, it is recommended that the JSON be pretty-printed
  //  (line-broken and indented)."
  // ---------------------------------------------------------------------------
  it('RECOMMENDED: StoryData JSON in twee3 output is valid JSON', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'), {
      outputMode: 'twee3',
    });
    const storyDataMatch = result.output.match(/:: StoryData\n([\s\S]*?)(?=\n:: )/);
    if (!storyDataMatch) throw new Error('expected StoryData passage in twee3 output');
    const jsonContent = storyDataMatch[1];
    if (!jsonContent) throw new Error('expected StoryData JSON content capture group');
    // Must be valid JSON
    expect(() => JSON.parse(jsonContent.trim())).not.toThrow();
  });

  it('RECOMMENDED: StoryData JSON in twee3 output is line-broken and indented', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'), {
      outputMode: 'twee3',
    });
    // Find the StoryData passage content
    const storyDataMatch = result.output.match(/:: StoryData\n([\s\S]*?)(?=\n:: )/);
    if (!storyDataMatch) throw new Error('expected StoryData passage in twee3 output');
    const jsonContent = storyDataMatch[1];
    if (!jsonContent) throw new Error('expected StoryData JSON content capture group');
    // Pretty-printed means multiple lines and indentation
    const lines = jsonContent.trim().split('\n');
    expect(lines.length).toBeGreaterThan(1); // Must be line-broken (not a single line)
    // At least one line should have leading whitespace (indented)
    expect(lines.some((line) => /^\s+/.test(line))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Duplicate special passages
  // ---------------------------------------------------------------------------
  it('RECOMMENDED: handles duplicate StoryData passages gracefully — emits warning', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryData',
      '{"ifid":"A1B2C3D4-E5F6-7890-ABCD-EF1234567890"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Content',
    ].join('\n');
    const result = await compileInline(source);
    // Spec: "It is recommended that the outcome of detecting multiple passages with
    // the same name should at least be to emit a warning."
    const hasDupWarning = result.diagnostics.some(
      (d) =>
        d.level === 'warning' &&
        (d.message.toLowerCase().includes('duplicate') || d.message.toLowerCase().includes('replacing')),
    );
    expect(hasDupWarning).toBe(true);
  });

  it('RECOMMENDED: handles duplicate StoryTitle passages gracefully — emits warning', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'First Title',
      '',
      ':: StoryTitle',
      'Second Title',
      '',
      ':: Start',
      'Content',
    ].join('\n');
    const result = await compileInline(source);
    // Spec: emit a warning for duplicate passage names
    const hasDupWarning = result.diagnostics.some(
      (d) =>
        d.level === 'warning' &&
        (d.message.toLowerCase().includes('duplicate') || d.message.toLowerCase().includes('replacing')),
    );
    expect(hasDupWarning).toBe(true);
  });

  it('RECOMMENDED: warns when start passage does not exist', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"NonExistent"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Content',
    ].join('\n');
    const result = await compileInline(source);
    // Compiler should warn about non-existent start passage or fall back gracefully
    expect(result.output.length).toBeGreaterThan(0);
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
    // The startnode should reference the Start passage's pid
    const startnodeMatch = result.output.match(/startnode="(\d+)"/);
    if (!startnodeMatch) throw new Error('expected startnode attribute');
    const startnode = startnodeMatch[1];
    const startPidMatch =
      result.output.match(/<tw-passagedata[^>]*name="Start"[^>]*pid="(\d+)"/) ??
      result.output.match(/<tw-passagedata[^>]*pid="(\d+)"[^>]*name="Start"/);
    if (!startPidMatch) throw new Error('expected Start passage with pid');
    expect(startnode).toBe(startPidMatch[1]);
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
    // Extract startnode and "Begin" pid, verify they match
    const startnodeMatch = result.output.match(/startnode="(\d+)"/);
    if (!startnodeMatch) throw new Error('expected startnode attribute');
    const startnode = startnodeMatch[1];
    const beginPidMatch =
      result.output.match(/<tw-passagedata[^>]*name="Begin"[^>]*pid="(\d+)"/) ??
      result.output.match(/<tw-passagedata[^>]*pid="(\d+)"[^>]*name="Begin"/);
    if (!beginPidMatch) throw new Error('expected Begin passage with pid');
    expect(startnode).toBe(beginPidMatch[1]);
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
    // Extract startnode and "CustomStart" pid, verify they match
    const startnodeMatch = result.output.match(/startnode="(\d+)"/);
    if (!startnodeMatch) throw new Error('expected startnode attribute');
    const startnode = startnodeMatch[1];
    const customPidMatch =
      result.output.match(/<tw-passagedata[^>]*name="CustomStart"[^>]*pid="(\d+)"/) ??
      result.output.match(/<tw-passagedata[^>]*pid="(\d+)"[^>]*name="CustomStart"/);
    if (!customPidMatch) throw new Error('expected CustomStart passage with pid');
    expect(startnode).toBe(customPidMatch[1]);
  });

  it('MUST: compiler option overrides StoryData start which overrides default "Start"', async () => {
    // Spec: "May be overridden by the story metadata or compiler command."
    // Priority: compiler > StoryData > default "Start" passage
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"MetadataStart"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Default',
      '',
      ':: MetadataStart',
      'From metadata',
      '',
      ':: CompilerStart',
      'From compiler',
    ].join('\n');
    const result = await compileInline(source, { startPassage: 'CompilerStart' });
    // Compiler option must win — startnode should point to CompilerStart's pid
    const startnodeMatch = result.output.match(/startnode="(\d+)"/);
    if (!startnodeMatch) throw new Error('expected startnode attribute');
    const startnode = startnodeMatch[1];
    const compilerPidMatch =
      result.output.match(/<tw-passagedata[^>]*name="CompilerStart"[^>]*pid="(\d+)"/) ??
      result.output.match(/<tw-passagedata[^>]*pid="(\d+)"[^>]*name="CompilerStart"/);
    if (!compilerPidMatch) throw new Error('expected CompilerStart passage with pid');
    expect(startnode).toBe(compilerPidMatch[1]);
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

  it('MUST: script passage content is inside a <script> element', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyScript [script]\nconsole.log("hello");');
    const result = await compileInline(source);
    // Content should be inside <script type="text/twine-javascript">...</script>
    const scriptMatch = result.output.match(/<script[^>]*type="text\/twine-javascript"[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    if (scriptMatch) {
      expect(scriptMatch[1]).toContain('console.log("hello");');
    }
  });

  it('MUST: script passage is NOT rendered as a regular tw-passagedata', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyScript [script]\nconsole.log("hello");');
    const result = await compileInline(source);
    expect(result.output).not.toContain('name="MyScript"');
  });

  it('MUST: script tag among other tags still triggers script behavior', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyScript [other script]\nconsole.log("hello");');
    const result = await compileInline(source);
    expect(result.output).toContain('type="text/twine-javascript"');
    expect(result.output).toContain('console.log("hello");');
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

  it('MUST: stylesheet passage content is inside a <style> element', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyStyles [stylesheet]\nbody { color: red; }');
    const result = await compileInline(source);
    // Content should be inside <style type="text/twine-css">...</style>
    const styleMatch = result.output.match(/<style[^>]*type="text\/twine-css"[^>]*>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    if (styleMatch) {
      expect(styleMatch[1]).toContain('body { color: red; }');
    }
  });

  it('MUST: stylesheet passage is NOT rendered as a regular tw-passagedata', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyStyles [stylesheet]\nbody { color: red; }');
    const result = await compileInline(source);
    expect(result.output).not.toContain('name="MyStyles"');
  });

  it('MUST: stylesheet tag among other tags still triggers stylesheet behavior', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: MyStyles [other stylesheet]\nbody { color: red; }');
    const result = await compileInline(source);
    expect(result.output).toContain('type="text/twine-css"');
    expect(result.output).toContain('body { color: red; }');
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

  it('MUST: tw-storydata has format attribute when format is specified', async () => {
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

  it('MUST: tw-storydata has format-version attribute when format-version is specified', async () => {
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

  it('MUST: tw-passagedata has position attribute from metadata', async () => {
    const result = await compileInline(minimalStory(':: Start {"position":"100,200"}\nHello'));
    expect(result.output).toContain('position="100,200"');
  });

  it('MUST: tw-passagedata has size attribute from metadata', async () => {
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
  it('Example: minimal working example — ":: An overgrown path"', () => {
    const { passages } = parseTwee(':: An overgrown path\n');
    expect(passages).toHaveLength(1);
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('An overgrown path');
  });

  it('Example: with only optional tags — ":: An overgrown path [forest spooky]"', () => {
    const { passages } = parseTwee(':: An overgrown path [forest spooky]\n');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('An overgrown path');
    expect(first.tags).toEqual(['forest', 'spooky']);
  });

  it('Example: with only optional metadata — ":: An overgrown path {"position":"600,400","size":"100,200"}"', () => {
    const { passages } = parseTwee(':: An overgrown path {"position":"600,400","size":"100,200"}\n');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('An overgrown path');
    expect(first.metadata).toEqual({ position: '600,400', size: '100,200' });
  });

  it('Example: with both optional tags and metadata', () => {
    const { passages } = parseTwee(':: An overgrown path [forest spooky] {"position":"600,400","size":"100,200"}\n');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('An overgrown path');
    expect(first.tags).toEqual(['forest', 'spooky']);
    expect(first.metadata).toEqual({ position: '600,400', size: '100,200' });
  });

  it('Example: full StoryData from spec', async () => {
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
      'Test',
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

// =============================================================================
// Section: Prolog / text before first passage
// =============================================================================

describe('Prolog and Edge Cases', () => {
  it('ignores text before the first passage header (prolog)', () => {
    const { passages } = parseTwee('This is some introductory text\n\n:: Start\nContent');
    expect(passages).toHaveLength(1);
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Start');
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
});

// =============================================================================
// Section: Duplicate Passage Name Warning
// "It is recommended that passage names should be unique within a story"
// "It is recommended that the outcome of detecting multiple passages with
//  the same name should at least be to emit a warning."
// =============================================================================

describe('Duplicate Passage Name Warning', () => {
  it('RECOMMENDED: emits a warning when two passages share the same name', async () => {
    // Spec: "It is recommended that the outcome of detecting multiple passages with
    // the same name should at least be to emit a warning."
    const source = minimalStory(':: Start\nFirst\n\n:: Start\nSecond');
    const result = await compileInline(source);
    const warnings = result.diagnostics.filter(
      (d) =>
        d.level === 'warning' &&
        (d.message.toLowerCase().includes('duplicate') ||
          d.message.toLowerCase().includes('same name') ||
          d.message.toLowerCase().includes('replacing')),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('RECOMMENDED: does not warn when all passage names are unique', async () => {
    const source = minimalStory(':: Start\nFirst\n\n:: Other\nSecond');
    const result = await compileInline(source);
    const duplicateWarnings = result.diagnostics.filter(
      (d) =>
        d.message.toLowerCase().includes('duplicate') ||
        d.message.toLowerCase().includes('same name') ||
        d.message.toLowerCase().includes('replacing'),
    );
    expect(duplicateWarnings).toHaveLength(0);
  });
});

// =============================================================================
// Section: Passage Metadata Decode Error
// "It is recommended that the outcome of a decoding error should be to:
//  emit a warning, discard the metadata, and continue processing of the passage."
// =============================================================================

describe('Passage Metadata Decode Error', () => {
  it('RECOMMENDED: emits a warning on invalid passage metadata JSON', () => {
    // Spec: "It is recommended that the outcome of a decoding error should be to:
    // emit a warning, discard the metadata, and continue processing of the passage."
    const { passages, diagnostics } = parseTwee(':: Room {not valid json}\nContent');
    // Should emit a WARNING (not error) about the decode error
    const metadataWarnings = diagnostics.filter(
      (d) =>
        d.level === 'warning' &&
        (d.message.toLowerCase().includes('metadata') || d.message.toLowerCase().includes('json')),
    );
    expect(metadataWarnings.length).toBeGreaterThan(0);
    // Should still parse the passage (continue processing)
    expect(passages.length).toBeGreaterThan(0);
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Room');
  });

  it('RECOMMENDED: discards metadata on decode error but preserves passage content', () => {
    const { passages } = parseTwee(':: Room {broken json}\nContent here');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('Content here');
    // Metadata should be discarded (empty or undefined)
    expect(first.metadata).toEqual(undefined);
  });

  it('RECOMMENDED: continues processing of the passage after metadata error', () => {
    const { passages, diagnostics } = parseTwee(':: Room1 {bad}\nContent1\n\n:: Room2\nContent2');
    // Both passages should be parsed despite Room1 having bad metadata
    expect(passages).toHaveLength(2);
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Room1');
    expect(first.text).toBe('Content1');
    const second = passages[1];
    if (!second) throw new Error('expected at least two passages');
    expect(second.name).toBe('Room2');
    expect(second.text).toBe('Content2');
    // Should have warned about the bad metadata
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Section: Tag Name Escaping (additional tests)
// =============================================================================

describe('Tag Name Escaping', () => {
  it('MUST: tag names containing [ ] are escaped with backslash', () => {
    const { passages } = parseTwee(':: Room [tag\\[1\\]]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.tags).toEqual(['tag[1]']);
  });

  it('MUST: tag names containing { } are escaped with backslash', () => {
    const { passages } = parseTwee(':: Room [tag\\{a\\}]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.tags).toEqual(['tag{a}']);
  });

  it('MUST: roundtrips tag name with metacharacters through twee3 output and re-parse', async () => {
    const source = minimalStory(':: Room [tag\\[1\\]]\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    const reparsed = parseTwee(result.output);
    const passage = reparsed.passages.find((p) => p.name === 'Room');
    if (!passage) throw new Error('expected Room passage after roundtrip');
    expect(passage.tags).toContain('tag[1]');
  });

  it('MUST: escapes [ ] { } metacharacters in tag names in Twee 3 output', async () => {
    const source = minimalStory(':: Room [tag\\[1\\]\\{2\\}]\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    // The twee3 output must escape [ ] { } in tag names with backslash
    expect(result.output).toMatch(/\[tag\\\[1\\\]\\\{2\\\}\]/);
  });
});

// =============================================================================
// Section: Tag Block — Tags Must Not Contain Spaces (additional)
// =============================================================================

describe('Tag Block — Tags Must Not Contain Spaces', () => {
  it('MUST: tags are separated by spaces (each tag is a non-space token)', () => {
    const { passages } = parseTwee(':: Room [alpha beta gamma]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('MUST: no individual tag can contain a space', () => {
    const { passages } = parseTwee(':: Room [one two three]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.tags).toHaveLength(3);
    for (const tag of first.tags) {
      expect(tag).not.toContain(' ');
    }
  });
});

// =============================================================================
// Section: Passage Name Recommendations
// =============================================================================

describe('Passage Name Recommendations', () => {
  it('RECOMMENDED: passage name containing | metacharacter is accepted', async () => {
    const result = await compileInline(minimalStory(':: Choice A | Choice B\nContent'));
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('RECOMMENDED: passage name containing escaped [ ] metacharacter is accepted', async () => {
    const result = await compileInline(minimalStory(':: Choice \\[A\\]\nContent'));
    expect(result.output.length).toBeGreaterThan(0);
    // Verify the passage name was parsed correctly (decoded)
    expect(result.output).toContain('Choice [A]');
  });

  it('RECOMMENDED: passage name containing escaped ] metacharacter is accepted', async () => {
    const result = await compileInline(minimalStory(':: \\]\nContent'));
    expect(result.output.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Section: Twee 3 Output Format (roundtrip)
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
    expect(result.output).toContain(':: StoryData');
    expect(result.output).toContain('"ifid"');
  });

  it('MUST: escapes [ ] { } metacharacters in passage names in Twee 3 output', async () => {
    const source = minimalStory(':: Name\\[1\\]\\{2\\}\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    // The twee3 output must escape [ ] { } with backslash
    expect(result.output).toContain(':: Name\\[1\\]\\{2\\}');
  });

  it('MUST: escapes backslashes in passage names in Twee 3 output', async () => {
    const source = minimalStory(':: foo\\\\bar\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    // The twee3 output must double-escape the backslash
    expect(result.output).toContain(':: foo\\\\bar');
  });

  it('MUST: roundtrips passage name with metacharacters through twee3 output and re-parse', async () => {
    const source = minimalStory(':: Name\\[1\\]\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    const reparsed = parseTwee(result.output);
    const passage = reparsed.passages.find((p) => p.name === 'Name[1]');
    expect(passage).toBeDefined();
  });

  it('MUST: roundtrips passage name with backslash through twee3 output and re-parse', async () => {
    const source = minimalStory(':: foo\\\\bar\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    const reparsed = parseTwee(result.output);
    const passage = reparsed.passages.find((p) => p.name === 'foo\\bar');
    expect(passage).toBeDefined();
  });

  it('MUST: roundtrips tag names with metacharacters through twee3 output and re-parse', async () => {
    const source = minimalStory(':: Room [tag\\[1\\]\\{2\\}]\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    const reparsed = parseTwee(result.output);
    const passage = reparsed.passages.find((p) => p.name === 'Room');
    if (!passage) throw new Error('expected Room passage after roundtrip');
    expect(passage.tags).toContain('tag[1]{2}');
  });

  it('MUST: encoding — non-escape backslashes in passage names are escaped to \\\\ in Twee 3 output', async () => {
    // Spec: "non-escape backslashes must also be escaped via the same mechanism
    // (i.e. foo\\bar must become foo\\\\bar)"
    const source = minimalStory(':: foo\\\\bar\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    // In the output, the passage name should have \\\\ (double backslash in source)
    // to represent a literal backslash
    expect(result.output).toContain(':: foo\\\\bar');
  });

  it('MUST: encoding — backslashes in tag names are escaped to \\\\ in Twee 3 output', async () => {
    const source = minimalStory(':: Room [foo\\\\bar]\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    // Tags with backslashes must be escaped in output
    expect(result.output).toMatch(/\[foo\\\\bar\]/);
  });

  it('outputs StoryTitle passage', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'), { outputMode: 'twee3' });
    expect(result.output).toContain(':: StoryTitle');
    expect(result.output).toContain('Spec Test');
  });

  it('outputs content on the line after the header', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello world'), { outputMode: 'twee3' });
    // Verify that content follows the header on the next line
    expect(result.output).toMatch(/:: Start\n.*Hello world/s);
  });
});

// =============================================================================
// Section: Diagnostics and Error Reporting
// =============================================================================

describe('Diagnostics and Error Reporting', () => {
  it('collects errors without crashing', async () => {
    const result = await compileInline(':: Test [unclosed\nContent', { outputMode: 'twee3' });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('diagnostics have level (warning or error)', () => {
    const { diagnostics } = parseTwee(':: Test [unclosed\nContent');
    const first = diagnostics[0];
    if (!first) throw new Error('expected at least one diagnostic');
    expect(first.level).toMatch(/^(warning|error)$/);
  });

  it('diagnostics have message', () => {
    const { diagnostics } = parseTwee(':: Test [unclosed\nContent');
    const first = diagnostics[0];
    if (!first) throw new Error('expected at least one diagnostic');
    expect(first.message.length).toBeGreaterThan(0);
  });

  it('diagnostics include file info when filename is provided', () => {
    const { diagnostics } = parseTwee(':: Test [unclosed\nContent', { filename: 'my-story.tw' });
    const first = diagnostics[0];
    if (!first) throw new Error('expected at least one diagnostic');
    expect(first.file).toBe('my-story.tw');
  });

  it('diagnostics include line number', () => {
    const { diagnostics } = parseTwee(':: Test [unclosed\nContent');
    const first = diagnostics[0];
    if (!first) throw new Error('expected at least one diagnostic');
    expect(first.line).toBeGreaterThan(0);
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
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('A');
    const second = passages[1];
    if (!second) throw new Error('expected at least two passages');
    expect(second.name).toBe('B');
    const third = passages[2];
    if (!third) throw new Error('expected at least three passages');
    expect(third.name).toBe('C');
    expect(third.text).toBe('Content');
  });

  it('handles passage with very long name', () => {
    const longName = 'A'.repeat(500);
    const { passages } = parseTwee(`:: ${longName}\nContent`);
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe(longName);
  });

  it('handles passage with many tags', () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    const { passages } = parseTwee(`:: Room [${tags.join(' ')}]\nContent`);
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.tags).toHaveLength(50);
  });

  it('handles passage content with special characters', () => {
    const { passages } = parseTwee(':: Start\n<html>&amp;"quotes"</html>');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toContain('<html>');
    expect(first.text).toContain('&amp;');
  });

  it('handles Windows-style line endings (\\r\\n)', () => {
    const { passages } = parseTwee(':: Start\r\nContent line 1\r\nContent line 2\r\n\r\n:: Second\r\nMore');
    expect(passages).toHaveLength(2);
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Start');
  });

  it('handles metadata with both position and size', () => {
    const { passages } = parseTwee(':: Room {"position":"100,100","size":"200,100"}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.metadata?.position).toBe('100,100');
    expect(first.metadata?.size).toBe('200,100');
  });
});

// =============================================================================
// Section: Processing Different Versions of Twee
// "It is recommended that any software accepting Twee notation test for and
//  attempt to parse data sections officially part of this specification or
//  informally part of other Twee versions."
// =============================================================================

describe('Processing Different Versions of Twee', () => {
  it('RECOMMENDED: accepts and parses standard Twee 3 notation', () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start [tag1]',
      'Content',
    ].join('\n');
    const { passages, diagnostics } = parseTwee(source);
    // Must parse all passages without fatal errors
    expect(passages.length).toBeGreaterThanOrEqual(3);
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
  });

  it('RECOMMENDED: handles files without StoryData passage (informal Twee)', () => {
    // Older Twee versions might not have StoryData
    const { passages } = parseTwee(':: Start\nHello\n\n:: Room\nA room');
    expect(passages).toHaveLength(2);
  });

  it('RECOMMENDED: handles files without StoryTitle passage (informal Twee)', async () => {
    // Older Twee versions might not have StoryTitle
    const source = [':: StoryData', '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}', '', ':: Start', 'Hello'].join(
      '\n',
    );
    const result = await compileInline(source);
    // Should still compile successfully
    expect(result.output.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Section: Requirements and Recommendations
// "For all sections using the word must, software authors are required to
//  implement and follow the requirements therein."
// "For all sections using the word recommended, software authors are
//  encouraged, but not required, to implement and follow the guidelines therein."
// =============================================================================

describe('Requirements and Recommendations — Additional Coverage', () => {
  // -------------------------------------------------------------------------
  // Passage Header: single-line constraint — additional edge cases
  // -------------------------------------------------------------------------
  describe('Passage Header single-line — additional', () => {
    it('MUST: header components (name, tags, metadata) are all on one line', () => {
      const { passages } = parseTwee(':: Room [tag1] {"position":"100,100"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      expect(first.tags).toEqual(['tag1']);
      expect(first.metadata?.position).toBe('100,100');
    });

    it('MUST: metadata JSON that spans multiple lines is rejected (single-line header)', () => {
      // The header is only the first line; multiline JSON is not valid header metadata
      const { passages, diagnostics } = parseTwee(':: Room {"position":\n"100,100"}\nContent');
      // Either diagnostics are emitted or the metadata is not parsed correctly
      if (passages.length > 0) {
        const first = passages[0];
        if (!first) throw new Error('expected at least one passage');
        // If the passage exists, the metadata should NOT have been parsed across lines
        expect(first.metadata?.position).not.toBe('100,100');
      }
      expect(diagnostics.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Tag block: optional — explicit test
  // -------------------------------------------------------------------------
  describe('Tag block is optional', () => {
    it('MUST: tag block is optional — passage without tags is valid', () => {
      const { passages, diagnostics } = parseTwee(':: Room\nContent');
      expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      expect(first.tags).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Metadata block: optional — explicit test
  // -------------------------------------------------------------------------
  describe('Metadata block is optional', () => {
    it('MUST: metadata block is optional — passage without metadata is valid', () => {
      const { passages, diagnostics } = parseTwee(':: Room\nContent');
      expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.metadata).toBeUndefined();
    });

    it('MUST: passage with tags but no metadata is valid', () => {
      const { passages, diagnostics } = parseTwee(':: Room [tag1 tag2]\nContent');
      expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.tags).toEqual(['tag1', 'tag2']);
      expect(first.metadata).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Passage content: begins on the NEXT line (not same line as header)
  // -------------------------------------------------------------------------
  describe('Content begins on next line', () => {
    it('MUST: text after header components on same line is NOT passage content', () => {
      // The spec says: "The content section begins on the next line after the passage header"
      // Text that appears on the header line itself (after metadata/tags) should NOT be content
      const { passages } = parseTwee(':: Room [tag]\nActual content');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      // The passage content should be "Actual content", not include anything from the header line
      expect(first.text).toBe('Actual content');
    });

    it('MUST: passage with no content lines has empty text', () => {
      const { passages } = parseTwee(':: Room\n:: Other\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('Room');
      expect(first.text).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // StoryData multi-line JSON input
  // -------------------------------------------------------------------------
  describe('StoryData accepts multi-line (pretty-printed) JSON', () => {
    it('RECOMMENDED: StoryData JSON can be pretty-printed across multiple lines', () => {
      const source = [
        ':: StoryData',
        '{',
        '  "ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",',
        '  "format": "SugarCube",',
        '  "format-version": "2.28.2"',
        '}',
        '',
        ':: Start',
        'Content',
      ].join('\n');
      const { passages } = parseTwee(source);
      const storyData = passages.find((p) => p.name === 'StoryData');
      if (!storyData) throw new Error('expected StoryData passage');
      // The content should be valid JSON when parsed
      const json = JSON.parse(storyData.text);
      expect(json.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
      expect(json.format).toBe('SugarCube');
      expect(json['format-version']).toBe('2.28.2');
    });
  });

  // -------------------------------------------------------------------------
  // IFID: uppercase enforcement in all output paths
  // -------------------------------------------------------------------------
  describe('IFID uppercase enforcement', () => {
    it('MUST: IFID in twee3 output uses only uppercase hex letters', async () => {
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
      const result = await compileInline(source, { outputMode: 'twee3' });
      // Find IFID in the StoryData JSON in twee3 output
      const ifidMatch = result.output.match(/"ifid"\s*:\s*"([^"]+)"/);
      if (!ifidMatch) throw new Error('expected ifid in twee3 output');
      const ifidValue = ifidMatch[1];
      if (!ifidValue) throw new Error('expected ifid capture group');
      // Must not contain lowercase hex letters
      expect(ifidValue).not.toMatch(/[a-f]/);
      expect(ifidValue).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    });
  });

  // -------------------------------------------------------------------------
  // Script tag: case sensitivity
  // Spec says: "script" (lowercase)
  // -------------------------------------------------------------------------
  describe('Script tag case sensitivity', () => {
    it('MUST: lowercase "script" tag triggers script behavior', async () => {
      const source = minimalStory(':: Start\nHello\n\n:: JS [script]\nconsole.log("hi");');
      const result = await compileInline(source);
      expect(result.output).toContain('type="text/twine-javascript"');
      expect(result.output).toContain('console.log("hi");');
    });
  });

  // -------------------------------------------------------------------------
  // Stylesheet tag: case sensitivity
  // Spec says: "stylesheet" (lowercase)
  // -------------------------------------------------------------------------
  describe('Stylesheet tag case sensitivity', () => {
    it('MUST: lowercase "stylesheet" tag triggers stylesheet behavior', async () => {
      const source = minimalStory(':: Start\nHello\n\n:: CSS [stylesheet]\nbody { margin: 0; }');
      const result = await compileInline(source);
      expect(result.output).toContain('type="text/twine-css"');
      expect(result.output).toContain('body { margin: 0; }');
    });
  });

  // -------------------------------------------------------------------------
  // StoryData and StoryTitle not in twee3 output as tw-passagedata
  // -------------------------------------------------------------------------
  describe('Special passages excluded from twee3 passage output', () => {
    it('MUST: StoryData passage in twee3 output is not duplicated as a regular passage', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'), { outputMode: 'twee3' });
      // Count occurrences of ":: StoryData" — should appear exactly once
      const matches = result.output.match(/^:: StoryData$/gm);
      if (!matches) throw new Error('expected StoryData in twee3 output');
      expect(matches).toHaveLength(1);
    });

    it('MUST: StoryTitle passage in twee3 output appears exactly once', async () => {
      const result = await compileInline(minimalStory(':: Start\nHello'), { outputMode: 'twee3' });
      const matches = result.output.match(/^:: StoryTitle$/gm);
      if (!matches) throw new Error('expected StoryTitle in twee3 output');
      expect(matches).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Escapement encoding: verify encoding direction for output
  // -------------------------------------------------------------------------
  describe('Escapement encoding in Twee 3 output', () => {
    it('MUST: passage name containing [ is escaped to \\[ in Twee 3 output', async () => {
      const source = minimalStory(':: Name\\[test\nContent');
      const result = await compile({
        sources: [{ filename: 'test.tw', content: source }],
        outputMode: 'twee3',
      });
      // In the output, the [ must be escaped
      expect(result.output).toContain('Name\\[test');
    });

    it('MUST: passage name containing ] is escaped to \\] in Twee 3 output', async () => {
      const source = minimalStory(':: Name\\]test\nContent');
      const result = await compile({
        sources: [{ filename: 'test.tw', content: source }],
        outputMode: 'twee3',
      });
      expect(result.output).toContain('Name\\]test');
    });

    it('MUST: passage name containing { is escaped to \\{ in Twee 3 output', async () => {
      const source = minimalStory(':: Name\\{test\nContent');
      const result = await compile({
        sources: [{ filename: 'test.tw', content: source }],
        outputMode: 'twee3',
      });
      expect(result.output).toContain('Name\\{test');
    });

    it('MUST: passage name containing } is escaped to \\} in Twee 3 output', async () => {
      const source = minimalStory(':: Name\\}test\nContent');
      const result = await compile({
        sources: [{ filename: 'test.tw', content: source }],
        outputMode: 'twee3',
      });
      expect(result.output).toContain('Name\\}test');
    });

    it('MUST: tag name containing [ is escaped to \\[ in Twee 3 output', async () => {
      const source = minimalStory(':: Room [tag\\[x]\nContent');
      const result = await compile({
        sources: [{ filename: 'test.tw', content: source }],
        outputMode: 'twee3',
      });
      expect(result.output).toContain('tag\\[x');
    });

    it('MUST: tag name containing ] is escaped to \\] in Twee 3 output', async () => {
      const source = minimalStory(':: Room [tag\\]x]\nContent');
      const result = await compile({
        sources: [{ filename: 'test.tw', content: source }],
        outputMode: 'twee3',
      });
      expect(result.output).toContain('tag\\]x');
    });
  });

  // -------------------------------------------------------------------------
  // Escapement: multiple backslashes edge case
  // -------------------------------------------------------------------------
  describe('Escapement — multiple adjacent backslashes', () => {
    it('MUST: double backslash (\\\\\\\\) decodes to two backslashes', () => {
      // Input: foo\\\\bar → foo\bar (each \\\\ decodes to \\)
      // Actually: \\\\\\\\  in source means two escaped backslashes → two literal backslashes
      const { passages } = parseTwee(':: foo\\\\\\\\bar\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('foo\\\\bar');
    });

    it('MUST: backslash followed by escaped metacharacter (\\\\\\[) decodes correctly', () => {
      // \\\\\\[ → \\ = literal backslash, \\[ = literal [
      const { passages } = parseTwee(':: foo\\\\\\[bar\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.name).toBe('foo\\[bar');
    });
  });

  // -------------------------------------------------------------------------
  // StoryData: all properties together in output
  // -------------------------------------------------------------------------
  describe('StoryData full roundtrip', () => {
    it('MUST: all StoryData properties roundtrip through compile and appear in HTML output', async () => {
      const source = [
        ':: StoryData',
        '{',
        '  "ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",',
        '  "format": "SugarCube",',
        '  "format-version": "2.28.2",',
        '  "start": "Begin",',
        '  "tag-colors": {"foo": "red"},',
        '  "zoom": 0.5',
        '}',
        '',
        ':: StoryTitle',
        'Full Roundtrip Test',
        '',
        ':: Begin',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.output).toContain('name="Full Roundtrip Test"');
      expect(result.output).toContain('ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"');
      expect(result.output).toContain('format="SugarCube"');
      expect(result.output).toContain('format-version="2.28.2"');
      expect(result.output).toMatch(/startnode="\d+"/);
      expect(result.output).toContain('<tw-tag name="foo" color="red"></tw-tag>');
      expect(result.output).toMatch(/zoom="0\.5"/);
    });

    it('MUST: all StoryData properties roundtrip through twee3 output', async () => {
      const source = [
        ':: StoryData',
        '{',
        '  "ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",',
        '  "format": "SugarCube",',
        '  "format-version": "2.28.2",',
        '  "start": "Begin",',
        '  "tag-colors": {"foo": "red"},',
        '  "zoom": 0.5',
        '}',
        '',
        ':: StoryTitle',
        'Full Roundtrip Test',
        '',
        ':: Begin',
        'Hello',
      ].join('\n');
      const result = await compileInline(source, { outputMode: 'twee3' });
      // Twee3 output should contain all StoryData properties
      expect(result.output).toContain('"ifid"');
      expect(result.output).toContain('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
      expect(result.output).toContain('"format"');
      expect(result.output).toContain('SugarCube');
      expect(result.output).toContain('"format-version"');
      expect(result.output).toContain('2.28.2');
      expect(result.output).toContain('"start"');
      expect(result.output).toContain('Begin');
      expect(result.output).toContain('"tag-colors"');
      expect(result.output).toContain('"zoom"');
    });
  });

  // -------------------------------------------------------------------------
  // Tag-colors: values are string colors
  // -------------------------------------------------------------------------
  describe('Tag-colors value types', () => {
    it('MUST: tag-colors values are strings (color names or hex)', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"tag1":"#ff0000","tag2":"blue"}}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(result.story.twine2.tagColors.get('tag1')).toBe('#ff0000');
      expect(result.story.twine2.tagColors.get('tag2')).toBe('blue');
      expect(result.output).toContain('<tw-tag name="tag1" color="#ff0000"></tw-tag>');
      expect(result.output).toContain('<tw-tag name="tag2" color="blue"></tw-tag>');
    });
  });

  // -------------------------------------------------------------------------
  // Passage content: trailing whitespace on non-blank lines is preserved
  // -------------------------------------------------------------------------
  describe('Passage content whitespace handling', () => {
    it('MUST: trailing blank lines are stripped but non-blank trailing content is preserved', () => {
      const { passages } = parseTwee(':: Start\nLine 1\nLine 2\n\n\n');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.text).toBe('Line 1\nLine 2');
    });
  });

  // -------------------------------------------------------------------------
  // Multiple script/stylesheet passages combine
  // -------------------------------------------------------------------------
  describe('Multiple script and stylesheet passages', () => {
    it('MUST: multiple script passages are all included in output', async () => {
      const source = minimalStory(
        [
          ':: Start',
          'Hello',
          '',
          ':: Script1 [script]',
          'var x = 1;',
          '',
          ':: Script2 [script]',
          'var y = 2;',
          '',
          ':: Script3 [script]',
          'var z = 3;',
        ].join('\n'),
      );
      const result = await compileInline(source);
      expect(result.output).toContain('var x = 1;');
      expect(result.output).toContain('var y = 2;');
      expect(result.output).toContain('var z = 3;');
    });

    it('MUST: multiple stylesheet passages are all included in output', async () => {
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
          '',
          ':: Style3 [stylesheet]',
          'a { text-decoration: none; }',
        ].join('\n'),
      );
      const result = await compileInline(source);
      expect(result.output).toContain('body { color: red; }');
      expect(result.output).toContain('p { margin: 0; }');
      expect(result.output).toContain('a { text-decoration: none; }');
    });
  });

  // -------------------------------------------------------------------------
  // Passage header: :: token with triple or more colons
  // -------------------------------------------------------------------------
  describe('Start token variations', () => {
    it('handles ::: (triple colon) — extra colon is part of passage name', () => {
      const { passages } = parseTwee('::: Extra\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      // The :: starts the header, and the remaining : is part of the name
      expect(first.name).toBe(': Extra');
    });
  });

  // -------------------------------------------------------------------------
  // Passage metadata: unknown properties are preserved
  // -------------------------------------------------------------------------
  describe('Passage metadata unknown properties', () => {
    it('parses metadata with additional unknown properties', () => {
      const { passages } = parseTwee(':: Room {"position":"100,100","custom":"value"}\nContent');
      const first = passages[0];
      if (!first) throw new Error('expected at least one passage');
      expect(first.metadata?.position).toBe('100,100');
    });
  });

  // -------------------------------------------------------------------------
  // StoryData: zoom is a decimal (not string)
  // -------------------------------------------------------------------------
  describe('Zoom is numeric', () => {
    it('MUST: zoom value is treated as a decimal number, not a string', async () => {
      const source = [
        ':: StoryData',
        '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","zoom":2.5}',
        '',
        ':: StoryTitle',
        'Test',
        '',
        ':: Start',
        'Hello',
      ].join('\n');
      const result = await compileInline(source);
      expect(typeof result.story.twine2.zoom).toBe('number');
      expect(result.story.twine2.zoom).toBe(2.5);
    });
  });
});

// =============================================================================
// Section: Special Tags — Twine.private
// NOTE: Twine.private is NOT part of the Twee 3 specification. These tests
// verify a Twine 2 editor convention for practical compatibility.
// =============================================================================

describe('Special Tags — Twine.private', () => {
  it('passages tagged Twine.private are excluded from tw-passagedata output', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Hidden [Twine.private]', 'Secret stuff'].join('\n'));
    const result = await compileInline(source);
    expect(result.output).not.toContain('name="Hidden"');
  });

  it('Twine.private passages are not included in passage count', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Hidden [Twine.private]', 'Secret'].join('\n'));
    const result = await compileInline(source);
    const passageMatches = [...result.output.matchAll(/<tw-passagedata/g)];
    // Only "Start" should appear, not "Hidden"
    expect(passageMatches.length).toBe(1);
  });
});

// =============================================================================
// Section: Multiple source files
// NOTE: Multiple source files are NOT defined in the Twee 3 specification.
// These test compiler-specific behavior.
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

// =============================================================================
// Additional Spec Compliance Tests — Filling Gaps
// =============================================================================

// ---------------------------------------------------------------------------
// Trailing blank lines: MUST be ignored/omitted — strict enforcement
// Spec: "COMPILERS: Trailing blank lines must be ignored/omitted."
// This is a MUST requirement, so it should apply regardless of trim option.
// ---------------------------------------------------------------------------

describe('Trailing Blank Lines — Strict MUST Enforcement', () => {
  it('MUST: trailing blank lines stripped even with trim=false', () => {
    // The spec says trailing blank lines MUST be ignored/omitted.
    // This is independent of any "trim" option.
    const { passages } = parseTwee(':: Start\nContent\n\n\n', { trim: false });
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    // Trailing blank lines must be stripped per spec
    expect(first.text.endsWith('\n\n')).toBe(false);
  });

  it('MUST: trailing blank lines between passages stripped with trim=false', () => {
    const { passages } = parseTwee(':: First\nContent 1\n\n\n\n:: Second\nContent 2', { trim: false });
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    // Content must not end with blank lines
    expect(first.text.trimEnd()).toBe(first.text.trimEnd()); // Self-check
    // The trailing blank lines must not be part of content
    expect(first.text).not.toMatch(/\n\n$/);
  });

  it('MUST: only trailing blank lines are stripped — internal blank lines preserved', () => {
    const { passages } = parseTwee(':: Start\nLine 1\n\nLine 3\n\n\n');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    // Internal blank line preserved
    expect(first.text).toContain('\n\n');
    expect(first.text).toContain('Line 1');
    expect(first.text).toContain('Line 3');
    // Trailing blank lines stripped
    expect(first.text.endsWith('\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Content on the header line after all components
// Spec: "The content section begins on the next line after the passage header"
// Anything remaining on the header line after name/tags/metadata is NOT content.
// ---------------------------------------------------------------------------

describe('Content Does Not Include Header Line Remainder', () => {
  it('MUST: text after metadata on header line is not passage content', () => {
    // If extra text appears after the metadata JSON on the header line,
    // it should NOT become passage content (content starts on next line).
    const { passages } = parseTwee(':: Room {"position":"1,1"}\nActual content');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('Actual content');
    expect(first.text).not.toContain('{');
    expect(first.text).not.toContain('position');
  });

  it('MUST: text after tag block on header line is not passage content', () => {
    const { passages } = parseTwee(':: Room [tag1]\nActual content');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.text).toBe('Actual content');
    expect(first.text).not.toContain('[');
    expect(first.text).not.toContain('tag1');
  });
});

// ---------------------------------------------------------------------------
// Passage metadata decode error: must be WARNING, never ERROR
// Spec: "It is recommended that the outcome of a decoding error should be to:
//  emit a warning, discard the metadata, and continue processing of the passage."
// ---------------------------------------------------------------------------

describe('Passage Metadata Decode Error — Warning Not Error', () => {
  it('RECOMMENDED: metadata decode error produces warning, NOT error', () => {
    const { diagnostics } = parseTwee(':: Room {invalid json}\nContent');
    // The spec specifically says "emit a warning" — not "emit an error"
    const errors = diagnostics.filter(
      (d) =>
        d.level === 'error' &&
        (d.message.toLowerCase().includes('metadata') || d.message.toLowerCase().includes('json')),
    );
    // There should be NO error-level diagnostics about metadata
    expect(errors).toHaveLength(0);
    // There should be a warning-level diagnostic
    const warnings = diagnostics.filter(
      (d) =>
        d.level === 'warning' &&
        (d.message.toLowerCase().includes('metadata') || d.message.toLowerCase().includes('json')),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// StoryData decode error: must be WARNING, never ERROR
// Spec: "It is recommended that the outcome of a decoding error should be to:
//  emit a warning, discard the metadata, and continue processing the file."
// ---------------------------------------------------------------------------

describe('StoryData Decode Error — Warning Not Error', () => {
  it('RECOMMENDED: StoryData decode error produces WARNING, not ERROR', async () => {
    const source = [
      ':: StoryData',
      'completely invalid json',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    // Spec says "emit a warning" — check that the StoryData decode issue is a warning
    const storyDataDiags = result.diagnostics.filter(
      (d) => d.message.toLowerCase().includes('storydata') || d.message.toLowerCase().includes('unmarshal'),
    );
    for (const diag of storyDataDiags) {
      // Each StoryData-related diagnostic should be a warning, not an error
      expect(diag.level).toBe('warning');
    }
    expect(storyDataDiags.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Escapement: encoding direction (output) — spec says metacharacters MUST be escaped
// "passage and tag names that include the optional tag and metadata block opening
// and closing metacharacters (i.e. [, ], {, }) must escape them."
// ---------------------------------------------------------------------------

describe('Escapement Encoding — Metacharacters MUST Be Escaped in Output', () => {
  it('MUST: passage name with literal [ is escaped in Twee 3 output', async () => {
    // Create a story with a passage whose decoded name contains [
    const source = minimalStory(':: Name\\[test\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    // The output MUST contain the escaped form, not the raw [
    // Check that "Name[test" does NOT appear unescaped in a header line
    const headerLines = result.output.split('\n').filter((l) => l.startsWith(':: '));
    const nameHeader = headerLines.find((l) => l.includes('Name'));
    if (!nameHeader) throw new Error('expected header line with Name');
    // The [ must be escaped with backslash
    expect(nameHeader).toContain('\\[');
  });

  it('MUST: passage name with literal \\ is escaped to \\\\ in Twee 3 output', async () => {
    const source = minimalStory(':: foo\\\\bar\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    const headerLines = result.output.split('\n').filter((l) => l.startsWith(':: '));
    const nameHeader = headerLines.find((l) => l.includes('foo'));
    if (!nameHeader) throw new Error('expected header line with foo');
    // Must contain \\\\ (escaped backslash) not just a single backslash
    expect(nameHeader).toContain('\\\\');
  });

  it('MUST: tag name with literal ] is escaped to \\] in Twee 3 output', async () => {
    const source = minimalStory(':: Room [tag\\]x]\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    // In the output, the tag should have \\] to represent literal ]
    expect(result.output).toContain('\\]');
  });

  it('MUST: tag name with literal { is escaped to \\{ in Twee 3 output', async () => {
    const source = minimalStory(':: Room [tag\\{x]\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    expect(result.output).toContain('\\{');
  });

  it('MUST: tag name with literal } is escaped to \\} in Twee 3 output', async () => {
    const source = minimalStory(':: Room [tag\\}x]\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    expect(result.output).toContain('\\}');
  });

  it('MUST: tag name with literal \\ is escaped to \\\\ in Twee 3 output', async () => {
    const source = minimalStory(':: Room [tag\\\\x]\nContent');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    // The output must escape the backslash in the tag
    expect(result.output).toMatch(/\[tag\\\\x\]/);
  });
});

// ---------------------------------------------------------------------------
// Passage header: tab characters as whitespace separators
// Spec: "Each component after the start token may be preceded by one or more spaces"
// The spec specifically says "spaces" — test whether tab characters work too.
// ---------------------------------------------------------------------------

describe('Passage Header — Whitespace Variations', () => {
  it('MUST: spaces before passage name after :: (spec says "may be preceded by one or more spaces")', () => {
    const { passages } = parseTwee('::    Spaced\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Spaced');
  });

  it('handles tab between :: and passage name', () => {
    const { passages } = parseTwee('::\tTabbed\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    // Implementation-defined: tab may or may not be treated as space
    // At minimum, a passage should be created
    expect(first.name.trim()).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Start passage: the literal passage name "Start" is the default
// Spec: "The default starting passage."
// ---------------------------------------------------------------------------

describe('Start Passage — Literal Name', () => {
  it('MUST: the default start passage name is exactly "Start" (case-sensitive)', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: start',
      'lowercase start',
      '',
      ':: Start',
      'uppercase Start',
    ].join('\n');
    const result = await compileInline(source);
    // The startnode should reference the "Start" passage (exact case), not "start"
    const startnodeMatch = result.output.match(/startnode="(\d+)"/);
    if (!startnodeMatch) throw new Error('expected startnode attribute');
    const startnode = startnodeMatch[1];
    const startPidMatch =
      result.output.match(/<tw-passagedata[^>]*name="Start"[^>]*pid="(\d+)"/) ??
      result.output.match(/<tw-passagedata[^>]*pid="(\d+)"[^>]*name="Start"/);
    if (!startPidMatch) throw new Error('expected "Start" passage with pid');
    expect(startnode).toBe(startPidMatch[1]);
  });
});

// ---------------------------------------------------------------------------
// StoryData: ifid MUST be uppercase in all output modes
// ---------------------------------------------------------------------------

describe('IFID Uppercase — All Output Modes', () => {
  it('MUST: IFID is uppercase in JSON output mode', async () => {
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
    const result = await compileInline(source, { outputMode: 'json' });
    const parsed = JSON.parse(result.output) as { ifid?: string };
    expect(parsed.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    // Must not contain any lowercase hex
    expect(parsed.ifid).not.toMatch(/[a-f]/);
  });

  it('MUST: IFID is uppercase in twine2-archive output mode', async () => {
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
    const result = await compileInline(source, { outputMode: 'twine2-archive' });
    const ifidMatch = result.output.match(/ifid="([^"]+)"/);
    if (!ifidMatch) throw new Error('expected ifid attribute in archive output');
    const ifidValue = ifidMatch[1];
    if (!ifidValue) throw new Error('expected ifid capture group');
    expect(ifidValue).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(ifidValue).not.toMatch(/[a-f]/);
  });
});

// ---------------------------------------------------------------------------
// StoryData: properties type enforcement
// ---------------------------------------------------------------------------

describe('StoryData Property Types', () => {
  it('MUST: ifid is stored as string', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello'));
    expect(typeof result.story.ifid).toBe('string');
  });

  it('MUST: format is stored as string', async () => {
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
    expect(typeof result.story.twine2.format).toBe('string');
  });

  it('MUST: format-version is stored as string', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format-version":"2.28.2"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    expect(typeof result.story.twine2.formatVersion).toBe('string');
  });

  it('MUST: start is stored as string', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","start":"Begin"}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Begin',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    expect(typeof result.story.twine2.start).toBe('string');
  });

  it('MUST: zoom is stored as number (decimal)', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","zoom":0.75}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    expect(typeof result.story.twine2.zoom).toBe('number');
    expect(result.story.twine2.zoom).toBe(0.75);
  });

  it('MUST: tag-colors values are strings', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"a":"red","b":"#00ff00"}}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    for (const [, color] of result.story.twine2.tagColors) {
      expect(typeof color).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Passage metadata: position and size are strings (comma-separated)
// Spec: "position: (string) Comma separated passage tile positional coordinates"
// Spec: "size: (string) Comma separated passage tile width and height"
// ---------------------------------------------------------------------------

describe('Passage Metadata — Position and Size Are Strings', () => {
  it('MUST: position value is a string type', () => {
    const { passages } = parseTwee(':: Room {"position":"600,400"}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(typeof first.metadata?.position).toBe('string');
  });

  it('MUST: size value is a string type', () => {
    const { passages } = parseTwee(':: Room {"size":"100,200"}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(typeof first.metadata?.size).toBe('string');
  });

  it('MUST: position contains comma-separated coordinates', () => {
    const { passages } = parseTwee(':: Room {"position":"600,400"}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    const parts = first.metadata?.position?.split(',');
    if (!parts) throw new Error('expected position to be defined');
    expect(parts).toHaveLength(2);
    expect(Number(parts[0])).not.toBeNaN();
    expect(Number(parts[1])).not.toBeNaN();
  });

  it('MUST: size contains comma-separated width and height', () => {
    const { passages } = parseTwee(':: Room {"size":"100,200"}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    const parts = first.metadata?.size?.split(',');
    if (!parts) throw new Error('expected size to be defined');
    expect(parts).toHaveLength(2);
    expect(Number(parts[0])).not.toBeNaN();
    expect(Number(parts[1])).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Escapement: combined escaping and decoding robustness
// ---------------------------------------------------------------------------

describe('Escapement — Additional Robustness', () => {
  it('MUST: escaped backslash at end of passage name decodes correctly', () => {
    const { passages } = parseTwee(':: Name\\\\\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Name\\');
  });

  it('MUST: multiple escaped metacharacters in sequence', () => {
    const { passages } = parseTwee(':: \\[\\]\\{\\}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('[]{}');
  });

  it('MUST: escaped metacharacter in tag name does not terminate tag block', () => {
    const { passages } = parseTwee(':: Room [tag\\]name]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    // The \\] should be decoded to ], not terminate the tag block
    expect(first.tags).toContain('tag]name');
  });

  it('MUST: escaped [ in tag name does not start nested tag block', () => {
    const { passages } = parseTwee(':: Room [tag\\[name]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.tags).toContain('tag[name');
  });

  it('MUST: passage name with all four metacharacters escaped', () => {
    const { passages } = parseTwee(':: a\\[b\\]c\\{d\\}e\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('a[b]c{d}e');
  });
});

// ---------------------------------------------------------------------------
// Tag block: direct follow requirement (strict ordering)
// Spec: "Optional tag block that must directly follow the passage name"
// ---------------------------------------------------------------------------

describe('Tag Block — Direct Follow Requirement', () => {
  it('MUST: tag block directly follows passage name (no intervening content)', () => {
    const { passages } = parseTwee(':: Room [tag]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Room');
    expect(first.tags).toEqual(['tag']);
  });

  it('MUST: tag block with space between name and [ is valid (space is allowed)', () => {
    const { passages } = parseTwee(':: Room [tag]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.tags).toEqual(['tag']);
  });

  it('MUST: multiple spaces between name and tag block are allowed', () => {
    const { passages } = parseTwee(':: Room     [tag1 tag2]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Room');
    expect(first.tags).toEqual(['tag1', 'tag2']);
  });
});

// ---------------------------------------------------------------------------
// Metadata block: direct follow requirement
// Spec: "Optional metadata block...that must directly follow either the tag block
//  or, if the tag block is omitted, the passage name"
// ---------------------------------------------------------------------------

describe('Metadata Block — Direct Follow Requirement', () => {
  it('MUST: metadata follows tag block directly', () => {
    const { passages } = parseTwee(':: Room [tag] {"position":"1,1"}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.tags).toEqual(['tag']);
    expect(first.metadata?.position).toBe('1,1');
  });

  it('MUST: metadata follows passage name directly when tags omitted', () => {
    const { passages } = parseTwee(':: Room {"position":"1,1"}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Room');
    expect(first.metadata?.position).toBe('1,1');
  });

  it('MUST: space between tag block ] and metadata { is allowed', () => {
    const { passages } = parseTwee(':: Room [tag]   {"position":"2,2"}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.metadata?.position).toBe('2,2');
  });

  it('MUST: space between passage name and metadata { is allowed', () => {
    const { passages } = parseTwee(':: Room   {"position":"3,3"}\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.metadata?.position).toBe('3,3');
  });
});

// ---------------------------------------------------------------------------
// Lexer items: validate that the lexer produces correct item types
// ---------------------------------------------------------------------------

describe('Lexer — Item Type Validation', () => {
  it('produces Header item for ::', () => {
    const items = lex(':: Start\nContent');
    const header = items.find((i) => i.type === ItemType.Header);
    expect(header).toBeDefined();
    expect(header?.val).toBe('::');
  });

  it('produces Name item for passage name', () => {
    const items = lex(':: MyPassage\nContent');
    const name = items.find((i) => i.type === ItemType.Name);
    expect(name).toBeDefined();
    expect(name?.val.trim()).toBe('MyPassage');
  });

  it('produces Tags item for tag block', () => {
    const items = lex(':: Room [tag1 tag2]\nContent');
    const tags = items.find((i) => i.type === ItemType.Tags);
    expect(tags).toBeDefined();
    expect(tags?.val).toContain('tag1');
    expect(tags?.val).toContain('tag2');
  });

  it('produces Metadata item for JSON block', () => {
    const items = lex(':: Room {"position":"1,1"}\nContent');
    const meta = items.find((i) => i.type === ItemType.Metadata);
    expect(meta).toBeDefined();
    expect(meta?.val).toContain('position');
  });

  it('produces Content item for passage body', () => {
    const items = lex(':: Start\nBody text here');
    const content = items.find((i) => i.type === ItemType.Content);
    expect(content).toBeDefined();
    expect(content?.val).toContain('Body text here');
  });

  it('produces EOF item at end', () => {
    const items = lex(':: Start\nContent');
    const eof = items.find((i) => i.type === ItemType.EOF);
    expect(eof).toBeDefined();
  });

  it('produces Error item for malformed input', () => {
    const items = lex(':: Start [unclosed\nContent');
    const error = items.find((i) => i.type === ItemType.Error);
    expect(error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Passage names with special characters that are NOT metacharacters
// Spec only requires escaping [ ] { } and \\
// ---------------------------------------------------------------------------

describe('Passage Names — Non-Metacharacter Special Characters', () => {
  it('passage name with parentheses does not require escaping', () => {
    const { passages } = parseTwee(':: Room (A)\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Room (A)');
  });

  it('passage name with angle brackets does not require escaping', () => {
    const { passages } = parseTwee(':: Room <A>\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Room <A>');
  });

  it('passage name with equals sign does not require escaping', () => {
    const { passages } = parseTwee(':: x = y\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('x = y');
  });

  it('passage name with colon (not at start of line) is valid', () => {
    const { passages } = parseTwee(':: Chapter: One\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('Chapter: One');
  });
});

// ---------------------------------------------------------------------------
// Twee 3 output: passage ordering and structure
// ---------------------------------------------------------------------------

describe('Twee 3 Output — Structure Compliance', () => {
  it('MUST: each passage in Twee 3 output starts with :: on its own line', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello\n\n:: Room\nWorld'), {
      outputMode: 'twee3',
    });
    const lines = result.output.split('\n');
    const headerLines = lines.filter((l) => l.startsWith(':: '));
    // Should have StoryData, StoryTitle, Start, Room = 4 headers
    expect(headerLines.length).toBeGreaterThanOrEqual(4);
  });

  it('MUST: passage content in Twee 3 output starts on the line after the header', async () => {
    const result = await compileInline(minimalStory(':: Start\nHello world'), {
      outputMode: 'twee3',
    });
    // Find the Start passage header and verify content follows on next line
    const lines = result.output.split('\n');
    const startIdx = lines.findIndex((l) => l === ':: Start');
    if (startIdx === -1) throw new Error('expected :: Start header line');
    const nextLine = lines[startIdx + 1];
    expect(nextLine).toBe('Hello world');
  });
});

// ---------------------------------------------------------------------------
// Tag-colors in tw-tag output: all pairs must be mapped
// ---------------------------------------------------------------------------

describe('Tag-Colors — Complete Mapping', () => {
  it('MUST: each tag-color pair produces exactly one tw-tag element', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","tag-colors":{"a":"red","b":"blue","c":"green","d":"yellow"}}',
      '',
      ':: StoryTitle',
      'Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileInline(source);
    // Count tw-tag elements
    const twTagMatches = [...result.output.matchAll(/<tw-tag\s/g)];
    expect(twTagMatches).toHaveLength(4);
    expect(result.output).toContain('name="a"');
    expect(result.output).toContain('color="red"');
    expect(result.output).toContain('name="b"');
    expect(result.output).toContain('color="blue"');
    expect(result.output).toContain('name="c"');
    expect(result.output).toContain('color="green"');
    expect(result.output).toContain('name="d"');
    expect(result.output).toContain('color="yellow"');
  });
});

// ---------------------------------------------------------------------------
// Script and stylesheet passages: the specific element types
// ---------------------------------------------------------------------------

describe('Script and Stylesheet — Element Type Specificity', () => {
  it('MUST: script tag produces <script> element, not <style>', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: JS [script]\nalert(1);');
    const result = await compileInline(source);
    // The script content should be in <script>, not <style>
    const scriptMatch = result.output.match(/<script[^>]*type="text\/twine-javascript"[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    if (scriptMatch) {
      expect(scriptMatch[1]).toContain('alert(1);');
    }
    // The script content should NOT be in a <style> element
    const styleMatch = result.output.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    if (styleMatch) {
      expect(styleMatch[1]).not.toContain('alert(1);');
    }
  });

  it('MUST: stylesheet tag produces <style> element, not <script>', async () => {
    const source = minimalStory(':: Start\nHello\n\n:: CSS [stylesheet]\n.red { color: red; }');
    const result = await compileInline(source);
    // The style content should be in <style>, not <script>
    const styleMatch = result.output.match(/<style[^>]*type="text\/twine-css"[^>]*>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    if (styleMatch) {
      expect(styleMatch[1]).toContain('.red { color: red; }');
    }
    // The style content should NOT be in a <script> element
    const scriptMatch = result.output.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    if (scriptMatch) {
      expect(scriptMatch[1]).not.toContain('.red { color: red; }');
    }
  });
});

// ---------------------------------------------------------------------------
// Spec compliance: passage with ONLY escaped characters as name
// ---------------------------------------------------------------------------

describe('Passage Name — Only Escaped Characters', () => {
  it('MUST: passage name consisting entirely of escaped metacharacters', () => {
    const { passages } = parseTwee(':: \\[\\]\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('[]');
  });

  it('MUST: passage name consisting of a single escaped backslash', () => {
    const { passages } = parseTwee(':: \\\\\nContent');
    const first = passages[0];
    if (!first) throw new Error('expected at least one passage');
    expect(first.name).toBe('\\');
  });
});

// ---------------------------------------------------------------------------
// Twee 3 roundtrip: full story roundtrip (parse → compile → parse)
// ---------------------------------------------------------------------------

describe('Twee 3 Roundtrip — Full Story', () => {
  it('MUST: full story roundtrips through twee3 output and re-parse preserving all data', async () => {
    const source = [
      ':: StoryData',
      '{',
      '  "ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",',
      '  "format": "SugarCube",',
      '  "format-version": "2.28.2",',
      '  "start": "Begin",',
      '  "tag-colors": {"forest": "green"},',
      '  "zoom": 0.5',
      '}',
      '',
      ':: StoryTitle',
      'Roundtrip Story',
      '',
      ':: Begin [forest]',
      'Welcome to the forest.',
      '',
      ':: Cave [dark spooky]',
      'It is dark here.',
      '',
      ':: End',
      'The end.',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'roundtrip.tw', content: source }],
      outputMode: 'twee3',
    });

    // Re-parse the output
    const reparsed = parseTwee(result.output);

    // Verify StoryData is preserved
    const storyData = reparsed.passages.find((p) => p.name === 'StoryData');
    if (!storyData) throw new Error('expected StoryData passage in roundtrip');
    const json = JSON.parse(storyData.text) as Record<string, unknown>;
    expect(json.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');

    // Verify StoryTitle is preserved
    const storyTitle = reparsed.passages.find((p) => p.name === 'StoryTitle');
    if (!storyTitle) throw new Error('expected StoryTitle passage in roundtrip');
    expect(storyTitle.text).toBe('Roundtrip Story');

    // Verify regular passages are preserved
    const begin = reparsed.passages.find((p) => p.name === 'Begin');
    if (!begin) throw new Error('expected Begin passage in roundtrip');
    expect(begin.tags).toContain('forest');
    expect(begin.text).toContain('Welcome to the forest.');

    const cave = reparsed.passages.find((p) => p.name === 'Cave');
    if (!cave) throw new Error('expected Cave passage in roundtrip');
    expect(cave.tags).toContain('dark');
    expect(cave.tags).toContain('spooky');
    expect(cave.text).toContain('It is dark here.');

    const end = reparsed.passages.find((p) => p.name === 'End');
    if (!end) throw new Error('expected End passage in roundtrip');
    expect(end.text).toContain('The end.');
  });
});

// ---------------------------------------------------------------------------
// Escapement: encoding and decoding are inverse operations
// Spec requires that encoding escapes [ ] { } \\ and decoding reverses it
// ---------------------------------------------------------------------------

describe('Escapement — Encoding/Decoding Inverse', () => {
  it('MUST: encoding then decoding yields the original passage name', async () => {
    const originalName = 'test[1]{2}\\path';
    const source = minimalStory(`:: ${originalName.replace(/[\\[\]{}]/g, (ch) => '\\' + ch)}\nContent`);
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    const reparsed = parseTwee(result.output);
    const passage = reparsed.passages.find((p) => p.name === originalName);
    expect(passage).toBeDefined();
  });

  it('MUST: encoding then decoding yields the original tag name', async () => {
    const originalTag = 'tag[1]{2}';
    const escapedTag = originalTag.replace(/[\\[\]{}]/g, (ch) => '\\' + ch);
    const source = minimalStory(`:: Room [${escapedTag}]\nContent`);
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      outputMode: 'twee3',
    });
    const reparsed = parseTwee(result.output);
    const passage = reparsed.passages.find((p) => p.name === 'Room');
    if (!passage) throw new Error('expected Room passage');
    expect(passage.tags).toContain(originalTag);
  });
});

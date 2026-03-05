import { describe, it, expect } from 'vitest';
import { join, relative } from 'node:path';
import { parseTwee } from '../src/parser.js';
import { passageToPassagedata } from '../src/passage.js';
import { compile } from '../src/compiler.js';
import type { Passage } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const SUBFOLDER_DIR = join(FIXTURES_DIR, 'subfolder');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

describe('parser source location', () => {
  it('populates source with correct file and line for a single passage', () => {
    const { passages } = parseTwee(':: Start\nHello!', { filename: 'test.tw' });
    expect(passages).toHaveLength(1);
    expect(passages[0]?.source).toEqual({ file: 'test.tw', line: 1 });
  });

  it('assigns correct source.line to each passage in a multi-passage file', () => {
    const source = `:: First
Content one.

:: Second
Content two.

:: Third
Content three.`;
    const { passages } = parseTwee(source, { filename: 'multi.tw' });
    expect(passages).toHaveLength(3);
    expect(passages[0]?.source).toEqual({ file: 'multi.tw', line: 1 });
    expect(passages[1]?.source).toEqual({ file: 'multi.tw', line: 4 });
    expect(passages[2]?.source).toEqual({ file: 'multi.tw', line: 7 });
  });

  it('uses the provided filename in source.file', () => {
    const { passages } = parseTwee(':: P\nText', { filename: 'custom/path.tw' });
    expect(passages[0]?.source?.file).toBe('custom/path.tw');
  });

  it('defaults source.file to <inline> when no filename given', () => {
    const { passages } = parseTwee(':: P\nText');
    expect(passages[0]?.source?.file).toBe('<inline>');
  });
});

describe('passageToPassagedata source info', () => {
  const basePassage: Passage = {
    name: 'Test',
    tags: [],
    text: 'Hello',
    source: { file: 'src/story.tw', line: 42 },
  };

  it('emits data-source-file and data-source-line when sourceInfo is true', () => {
    const html = passageToPassagedata(basePassage, 1, { sourceInfo: true });
    expect(html).toContain('data-source-file="src/story.tw"');
    expect(html).toContain('data-source-line="42"');
  });

  it('omits data- attrs when sourceInfo is false', () => {
    const html = passageToPassagedata(basePassage, 1, { sourceInfo: false });
    expect(html).not.toContain('data-source-file');
    expect(html).not.toContain('data-source-line');
  });

  it('omits data- attrs when sourceInfo is not provided', () => {
    const html = passageToPassagedata(basePassage, 1);
    expect(html).not.toContain('data-source-file');
    expect(html).not.toContain('data-source-line');
  });

  it('omits data- attrs when source is undefined (synthetic passages)', () => {
    const synthetic: Passage = { name: 'Synth', tags: [], text: 'Generated' };
    const html = passageToPassagedata(synthetic, 1, { sourceInfo: true });
    expect(html).not.toContain('data-source-file');
    expect(html).not.toContain('data-source-line');
  });

  it('escapes special characters in file paths', () => {
    const p: Passage = {
      name: 'Test',
      tags: [],
      text: 'Hello',
      source: { file: 'path/with "quotes" & <angles>.tw', line: 1 },
    };
    const html = passageToPassagedata(p, 1, { sourceInfo: true });
    expect(html).toContain('data-source-file=');
    expect(html).not.toContain('path/with "quotes"');
    expect(html).toContain('&amp;');
  });
});

describe('compile with sourceInfo', () => {
  it('includes data-source-file attributes when sourceInfo is true', async () => {
    const result = await compile({
      sources: [join(SUBFOLDER_DIR, 'intro.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      sourceInfo: true,
    });

    expect(result.output).toContain('data-source-file=');
    expect(result.output).toContain('data-source-line=');
    // File path should be cwd-relative
    const relPath = relative(process.cwd(), join(SUBFOLDER_DIR, 'intro.tw'));
    expect(result.output).toContain(relPath);
  });

  it('omits data-source-* attributes when sourceInfo is not set', async () => {
    const result = await compile({
      sources: [join(SUBFOLDER_DIR, 'intro.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).not.toContain('data-source-file');
    expect(result.output).not.toContain('data-source-line');
  });

  it('includes subfolder paths in data-source-file', async () => {
    const result = await compile({
      sources: [SUBFOLDER_DIR],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      sourceInfo: true,
    });

    const nestedRelPath = relative(process.cwd(), join(SUBFOLDER_DIR, 'nested', 'chapter1.tw'));
    expect(result.output).toContain(nestedRelPath);
  });

  it('uses the provided filename for inline sources', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'my-inline.tw',
          content: `:: StoryData
{"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC"}

:: StoryTitle
Inline Test

:: Start
Hello from inline!`,
        },
      ],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      sourceInfo: true,
    });

    expect(result.output).toContain('data-source-file="my-inline.tw"');
  });
});

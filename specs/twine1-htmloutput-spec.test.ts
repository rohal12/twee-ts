/**
 * Twine 1 HTML Output Specification Compliance Tests (v1.0)
 *
 * Tests twee-ts against every requirement in the Twine 1 HTML Output Specification:
 * https://github.com/iftechfoundation/twine-specs/blob/master/twine-1-htmloutput-doc.md
 *
 * Each describe block corresponds to a section of the spec.
 *
 * Note: The companion Twine 1 TWS Output spec (twine-1-twsoutput.md) describes a
 * Python 2 pickle binary serialisation format used by the Twine 1 GUI editor.
 * twee-ts does not produce TWS output, so no conformance tests are provided for it.
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import type { CompileResult } from '../src/types.js';

/** Helper: compile inline twee source to Twine 1 archive output. */
async function compileToArchive(content: string): Promise<CompileResult> {
  return compile({
    sources: [{ filename: 'spec-test.tw', content }],
    outputMode: 'twine1-archive',
  });
}

/** Helper: build a minimal valid twee source with StoryTitle. */
function minimalStory(passages: string): string {
  return [':: StoryTitle', 'Spec Test', '', passages].join('\n');
}

/** Extract the <div id="storeArea" ...>...</div> chunk from compiled output. */
function extractStoreArea(html: string): string {
  const match = html.match(/<div id="storeArea"[\s\S]*?<\/div>\s*$/);
  expect(match, 'output must contain <div id="storeArea">').not.toBeNull();
  return match![0];
}

/** Extract all tiddler <div> elements as strings. */
function tiddlerElements(html: string): string[] {
  return [...html.matchAll(/<div tiddler=[^>]*>[\s\S]*?<\/div>/g)].map((m) => m[0]);
}

/** Extract an attribute value from an HTML element string. */
function attr(element: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const match = element.match(re);
  return match ? match[1] : null;
}

/** Extract text content between the opening and closing tags. */
function textContent(element: string): string {
  const match = element.match(/>([^]*)<\/div>/);
  return match ? match[1] : '';
}

// =============================================================================
// §1 — Root Structure: <div id="storeArea">
// =============================================================================
describe('Twine 1 HTML Output Spec — Root Structure', () => {
  it('output contains a <div id="storeArea"> root element', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    expect(result.output).toContain('<div id="storeArea"');
    expect(result.output).toContain('</div>');
  });

  it('storeArea has data-size attribute matching the passage count', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Second', 'World'].join('\n'));
    const result = await compileToArchive(source);
    const storeArea = extractStoreArea(result.output);
    const size = attr(storeArea, 'data-size');
    expect(size).not.toBeNull();
    // StoryTitle is included in passage count for Twine 1
    const tiddlers = tiddlerElements(result.output);
    expect(size).toBe(String(tiddlers.length));
  });

  it('storeArea has the hidden attribute', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const match = result.output.match(/<div id="storeArea"[^>]*>/);
    expect(match).not.toBeNull();
    expect(match![0]).toContain('hidden');
  });

  it('passages are child <div> elements with tiddler attribute', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tiddlers = tiddlerElements(result.output);
    expect(tiddlers.length).toBeGreaterThan(0);
    for (const t of tiddlers) {
      expect(t).toMatch(/^<div tiddler=/);
    }
  });
});

// =============================================================================
// §2 — Passage Attributes
// =============================================================================
describe('Twine 1 HTML Output Spec — Passage Attributes', () => {
  it('tiddler attribute: required, matches passage name', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(startTiddler).toBeDefined();
  });

  it('tags attribute: required, space-separated tag list', async () => {
    const source = minimalStory(':: Start [alpha beta gamma]\nHello');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(startTiddler).toBeDefined();
    expect(attr(startTiddler!, 'tags')).toBe('alpha beta gamma');
  });

  it('tags attribute: empty string when no tags', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(startTiddler).toBeDefined();
    expect(attr(startTiddler!, 'tags')).toBe('');
  });

  it('twine-position attribute: required, comma-separated X,Y', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(startTiddler).toBeDefined();
    const position = attr(startTiddler!, 'twine-position');
    expect(position).not.toBeNull();
    expect(position).toMatch(/^\d+,\d+$/);
  });

  it('twine-position attribute: reflects explicit metadata position', async () => {
    const source = minimalStory(':: Start {"position":"250,300"}\nHello');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(startTiddler).toBeDefined();
    expect(attr(startTiddler!, 'twine-position')).toBe('250,300');
  });

  it('tiddler name with special characters is attribute-escaped', async () => {
    const source = minimalStory(':: A "B" & C\nHello');
    const result = await compileToArchive(source);
    const output = result.output;
    expect(output).toContain('tiddler="A &quot;B&quot; &amp; C"');
  });
});

// =============================================================================
// §3 — Content Encoding (Tiddler Escaping)
// =============================================================================
describe('Twine 1 HTML Output Spec — Content Encoding', () => {
  it('& is encoded as &amp;', async () => {
    const source = minimalStory(':: Start\nA & B');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(textContent(startTiddler!)).toContain('A &amp; B');
  });

  it('< is encoded as &lt;', async () => {
    const source = minimalStory(':: Start\nA < B');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(textContent(startTiddler!)).toContain('A &lt; B');
  });

  it('> is encoded as &gt;', async () => {
    const source = minimalStory(':: Start\nA > B');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(textContent(startTiddler!)).toContain('A &gt; B');
  });

  it('" is encoded as &quot;', async () => {
    const source = minimalStory(':: Start\nSay "hello"');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(textContent(startTiddler!)).toContain('Say &quot;hello&quot;');
  });

  it('backslash is encoded as \\s', async () => {
    const source = minimalStory(':: Start\npath\\to\\file');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(textContent(startTiddler!)).toContain('path\\sto\\sfile');
  });

  it('tab is encoded as \\t', async () => {
    const source = minimalStory(':: Start\ncol1\tcol2');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(textContent(startTiddler!)).toContain('col1\\tcol2');
  });

  it('newline is encoded as \\n', async () => {
    const source = minimalStory(':: Start\nLine 1\nLine 2');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(textContent(startTiddler!)).toContain('Line 1\\nLine 2');
  });

  it('combined encoding: all special characters in one passage', async () => {
    const source = minimalStory(':: Start\n<a href="x">&\\path\ttab');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    const content = textContent(startTiddler!);
    expect(content).toContain('&lt;a href=&quot;x&quot;&gt;');
    expect(content).toContain('&amp;');
    expect(content).toContain('\\spath');
    expect(content).toContain('\\ttab');
  });

  it('empty passage produces empty tiddler content', async () => {
    const source = minimalStory(':: Start\n');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(startTiddler).toBeDefined();
    expect(textContent(startTiddler!)).toBe('');
  });
});

// =============================================================================
// §4 — Special Passages (Story Metadata)
// =============================================================================
describe('Twine 1 HTML Output Spec — Special Passages', () => {
  it('StoryTitle passage is included as a tiddler', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const tiddlers = tiddlerElements(result.output);
    const titleTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'StoryTitle');
    expect(titleTiddler).toBeDefined();
  });

  it('StorySettings passage is included as a tiddler', async () => {
    const source = [
      ':: StoryTitle',
      'Test Story',
      '',
      ':: StorySettings',
      'undo:on',
      'bookmark:off',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const settingsTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'StorySettings');
    expect(settingsTiddler).toBeDefined();
  });

  it('StoryAuthor passage is included as a tiddler', async () => {
    const source = [':: StoryTitle', 'Test Story', '', ':: StoryAuthor', 'Test Author', '', ':: Start', 'Hello'].join(
      '\n',
    );
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const authorTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'StoryAuthor');
    expect(authorTiddler).toBeDefined();
  });

  it('StorySubtitle passage is included as a tiddler', async () => {
    const source = [':: StoryTitle', 'Test Story', '', ':: StorySubtitle', 'A Subtitle', '', ':: Start', 'Hello'].join(
      '\n',
    );
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const subtitleTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'StorySubtitle');
    expect(subtitleTiddler).toBeDefined();
  });
});

// =============================================================================
// §5 — Twine.private Filtering
// =============================================================================
describe('Twine 1 HTML Output Spec — Twine.private Filtering', () => {
  it('passages tagged Twine.private are excluded from output', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Hidden [Twine.private]', 'Secret stuff'].join('\n'));
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const names = tiddlers.map((t) => attr(t, 'tiddler'));
    expect(names).not.toContain('Hidden');
  });

  it('Twine.private passages are not counted in data-size', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Hidden [Twine.private]', 'Secret'].join('\n'));
    const result = await compileToArchive(source);
    const storeArea = extractStoreArea(result.output);
    const size = attr(storeArea, 'data-size');
    const tiddlers = tiddlerElements(result.output);
    expect(size).toBe(String(tiddlers.length));
  });
});

// =============================================================================
// §6 — Passage Count Accuracy
// =============================================================================
describe('Twine 1 HTML Output Spec — Passage Count', () => {
  it('data-size reflects the actual number of tiddler elements', async () => {
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: Chapter 1', 'Content', '', ':: Chapter 2', 'More'].join('\n'),
    );
    const result = await compileToArchive(source);
    const storeArea = extractStoreArea(result.output);
    const size = attr(storeArea, 'data-size');
    const tiddlers = tiddlerElements(result.output);
    expect(Number(size)).toBe(tiddlers.length);
  });

  it('single passage story has correct data-size', async () => {
    const result = await compileToArchive(minimalStory(':: Start\nHello'));
    const storeArea = extractStoreArea(result.output);
    const size = attr(storeArea, 'data-size');
    const tiddlers = tiddlerElements(result.output);
    expect(Number(size)).toBe(tiddlers.length);
  });
});

// =============================================================================
// §7 — Multiple Passages
// =============================================================================
describe('Twine 1 HTML Output Spec — Multiple Passages', () => {
  it('all non-private passages appear as tiddler elements', async () => {
    const source = minimalStory(
      [':: Start', 'Hello', '', ':: Room1', 'First room', '', ':: Room2', 'Second room'].join('\n'),
    );
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const names = tiddlers.map((t) => attr(t, 'tiddler'));
    expect(names).toContain('Start');
    expect(names).toContain('Room1');
    expect(names).toContain('Room2');
  });

  it('each tiddler has unique auto-generated position when not specified', async () => {
    const source = minimalStory([':: Start', 'Hello', '', ':: Room1', 'First', '', ':: Room2', 'Second'].join('\n'));
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const positions = tiddlers.map((t) => attr(t, 'twine-position'));
    // All positions should be valid
    for (const pos of positions) {
      expect(pos).toMatch(/^\d+,\d+$/);
    }
    // All positions should be unique
    expect(new Set(positions).size).toBe(positions.length);
  });
});

// =============================================================================
// §8 — IFID Comment
// =============================================================================
describe('Twine 1 HTML Output Spec — IFID', () => {
  it('archive output does not include IFID comment (only full HTML does)', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'IFID Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    // IFID comment is only added in full HTML output, not archive
    // Archive should still be valid without it
    expect(result.output).toContain('<div id="storeArea"');
  });
});

// =============================================================================
// §9 — StorySettings Values
// =============================================================================
describe('Twine 1 HTML Output Spec — StorySettings', () => {
  it('StorySettings with key:value pairs is stored in a tiddler', async () => {
    const source = [
      ':: StoryTitle',
      'Settings Test',
      '',
      ':: StorySettings',
      'undo:on',
      'bookmark:off',
      'hash:on',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const settingsTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'StorySettings');
    expect(settingsTiddler).toBeDefined();
    // Content should contain the settings (tiddler-escaped)
    const content = textContent(settingsTiddler!);
    expect(content).toContain('undo');
    expect(content).toContain('bookmark');
  });

  it('StorySettings values are parsed into story metadata', async () => {
    const source = [
      ':: StoryTitle',
      'Settings Test',
      '',
      ':: StorySettings',
      'undo:on',
      'jquery:on',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compileToArchive(source);
    expect(result.story.twine1.settings.get('undo')).toBe('on');
    expect(result.story.twine1.settings.get('jquery')).toBe('on');
  });
});

// =============================================================================
// §10 — Tag Handling
// =============================================================================
describe('Twine 1 HTML Output Spec — Tag Handling', () => {
  it('multiple tags are space-separated in the tags attribute', async () => {
    const source = minimalStory(':: Start [tag1 tag2 tag3]\nHello');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(attr(startTiddler!, 'tags')).toBe('tag1 tag2 tag3');
  });

  it('tags with special characters are attribute-escaped', async () => {
    const source = minimalStory(':: Start [tag&one]\nHello');
    const result = await compileToArchive(source);
    const tiddlers = tiddlerElements(result.output);
    const startTiddler = tiddlers.find((t) => attr(t, 'tiddler') === 'Start');
    expect(attr(startTiddler!, 'tags')).toContain('&amp;');
  });
});

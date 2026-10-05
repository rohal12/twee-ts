import { describe, it, expect } from 'vitest';
import { decompileHTML } from '../src/html-parser.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

function twine2(attributes: string, children = ''): string {
  return `<tw-storydata name="S" ${attributes}>${children}</tw-storydata>`;
}

function messages(html: string): string[] {
  return decompileHTML(html).diagnostics.map((d) => d.message);
}

describe('decompileHTML attributes that do not parse', () => {
  it('warns about a startnode that is not an integer and starts at no passage', () => {
    const html = twine2(`startnode="one" ifid="${IFID}"`, '<tw-passagedata pid="1" name="Start">Hi</tw-passagedata>');
    const { story, diagnostics } = decompileHTML(html);

    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message: 'Cannot parse "tw-storydata" content attribute "startnode" as an integer; value "one".',
      },
    ]);
    expect(story.twine2.start).toBe('');
  });

  it('warns about a zoom that is not a number and keeps the default', () => {
    const { story, diagnostics } = decompileHTML(twine2(`zoom="big" ifid="${IFID}"`));

    expect(diagnostics.map((d) => d.message)).toEqual([
      'Cannot parse "tw-storydata" content attribute "zoom" as a float; value "big".',
    ]);
    expect(story.twine2.zoom).toBe(decompileHTML(twine2(`ifid="${IFID}"`)).story.twine2.zoom);
  });

  it('warns about a pid that is not an integer and still reads the passage', () => {
    const html = twine2(`startnode="1" ifid="${IFID}"`, '<tw-passagedata pid="x" name="Start">Hi</tw-passagedata>');
    const { story, diagnostics } = decompileHTML(html);

    expect(diagnostics.map((d) => d.message)).toEqual([
      'Cannot parse "tw-passagedata" content attribute "pid" as an integer; value "x".',
    ]);
    expect(story.passages.map((p) => p.name)).toContain('Start');
    expect(story.twine2.start).toBe('');
  });
});

describe('decompileHTML elements with missing attributes', () => {
  it('warns about a missing IFID', () => {
    expect(messages(twine2(''))).toEqual([
      'Story IFID not found; the "tw-storydata" content attribute "ifid" is missing or empty.',
    ]);
  });

  it('reads a tw-tag without a color as an uncolored tag, and ignores one without a name', () => {
    const { story } = decompileHTML(
      twine2(`ifid="${IFID}"`, '<tw-tag name="plain"></tw-tag><tw-tag color="red"></tw-tag>'),
    );

    expect([...story.twine2.tagColors]).toEqual([['plain', '']]);
  });

  it('reads a tw-passagedata without a name as a passage with an empty name', () => {
    const { story } = decompileHTML(twine2(`ifid="${IFID}"`, '<tw-passagedata pid="1">Hi</tw-passagedata>'));

    expect(story.passages.map((p) => [p.name, p.text])).toContainEqual(['', 'Hi']);
  });

  it('reads a Twine 1 tiddler without tags or position', () => {
    const { story, diagnostics } = decompileHTML('<div id="storeArea"><div tiddler="Start">Hi</div></div>');

    expect(diagnostics).toEqual([]);
    expect(story.passages).toEqual([{ name: 'Start', tags: [], text: 'Hi' }]);
  });

  it('keeps the position of a Twine 1 tiddler', () => {
    const { story } = decompileHTML('<div id="storeArea"><div tiddler="Start" twine-position="5,6">Hi</div></div>');

    expect(story.passages[0]?.metadata).toEqual({ position: '5,6' });
  });
});

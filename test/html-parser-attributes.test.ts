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
      'The "tw-storydata" content attribute "startnode" is 1, but no "tw-passagedata" has that "pid"; the story has no start passage.',
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

/**
 * The numbers in tw-storydata and tw-passagedata are read as Tweego reads them (Go's strconv.Atoi), or as
 * plain decimal numbers (zoom), so a value with anything else in it is reported rather than read in part
 * (#244 U5).
 */
describe('decompileHTML numbers are read whole', () => {
  const START =
    '<tw-passagedata pid="1" name="One">1</tw-passagedata><tw-passagedata pid="2" name="Two">2</tw-passagedata>';

  it.each(['2abc', ' 2', '2 ', '2e0', '0x2', '2.0', '+', '--2', '٢', '99999999999999999999'])(
    'warns about the startnode %j and starts nowhere',
    (value) => {
      const { story, diagnostics } = decompileHTML(twine2(`startnode="${value}" ifid="${IFID}"`, START));
      expect(story.twine2.start).toBe('');
      expect(diagnostics.map((d) => d.message)).toEqual([
        `Cannot parse "tw-storydata" content attribute "startnode" as an integer; value "${value}".`,
      ]);
    },
  );

  it.each([
    ['2', 'Two'],
    ['+2', 'Two'],
    ['02', 'Two'],
  ])('reads the startnode %j', (value, start) => {
    const { story, diagnostics } = decompileHTML(twine2(`startnode="${value}" ifid="${IFID}"`, START));
    expect(diagnostics).toEqual([]);
    expect(story.twine2.start).toBe(start);
  });

  it('warns about a startnode that no passage has as its pid', () => {
    const { story, diagnostics } = decompileHTML(twine2(`startnode="9" ifid="${IFID}"`, START));
    expect(story.twine2.start).toBe('');
    expect(diagnostics.map((d) => d.message)).toEqual([
      'The "tw-storydata" content attribute "startnode" is 9, but no "tw-passagedata" has that "pid"; the story has no start passage.',
    ]);
  });

  it.each(['1junk', ' 1', '1.0', '0x1', 'x'])('warns about the pid %j and does not start at it', (value) => {
    const html = twine2(`startnode="1" ifid="${IFID}"`, `<tw-passagedata pid="${value}" name="P">p</tw-passagedata>`);
    const { story, diagnostics } = decompileHTML(html);
    expect(story.twine2.start).toBe('');
    expect(diagnostics.map((d) => d.message)).toEqual([
      `Cannot parse "tw-passagedata" content attribute "pid" as an integer; value "${value}".`,
      'The "tw-storydata" content attribute "startnode" is 1, but no "tw-passagedata" has that "pid"; the story has no start passage.',
    ]);
  });

  it.each(['1.5x', ' 1', '1,5', 'Infinity', 'NaN', '0x1p0', '1e', '.'])(
    'warns about the zoom %j and keeps the default',
    (value) => {
      const { story, diagnostics } = decompileHTML(twine2(`zoom="${value}" ifid="${IFID}"`));
      expect(story.twine2.zoom).toBe(1);
      expect(diagnostics.map((d) => d.message)).toEqual([
        `Cannot parse "tw-storydata" content attribute "zoom" as a float; value "${value}".`,
      ]);
    },
  );

  it.each([
    ['0.6', 0.6],
    ['1', 1],
    ['.5', 0.5],
    ['5.', 5],
    ['+0.3', 0.3],
    ['6e-1', 0.6],
  ])('reads the zoom %j', (value, zoom) => {
    const { story, diagnostics } = decompileHTML(twine2(`zoom="${value}" ifid="${IFID}"`));
    expect(diagnostics).toEqual([]);
    expect(story.twine2.zoom).toBe(zoom);
  });
});

/**
 * A Twine 2 story's metadata is its tw-storydata attributes: Twine 2 and the story formats read those, and a
 * passage named StoryData or StoryTitle is an ordinary passage to them. In the Twee model these names are
 * special, so such a passage is kept under a free name instead of replacing the metadata (#246 S-1).
 */
describe('decompileHTML passages named like the special passages the attributes decide', () => {
  const attributes = `startnode="1" ifid="${IFID}" format="SugarCube" format-version="2.37.3"`;

  it('keeps the attributes, and a passage named StoryData under a free name, with a warning', () => {
    const html = twine2(
      attributes,
      '<tw-passagedata pid="1" name="Start">Go [[StoryData]]</tw-passagedata>' +
        '<tw-passagedata pid="2" name="StoryData">{"format":"Harlowe"}</tw-passagedata>',
    );
    const { story, diagnostics } = decompileHTML(html);
    expect(story.ifid).toBe(IFID);
    expect(story.twine2.format).toBe('SugarCube');
    expect(story.twine2.formatVersion).toBe('2.37.3');
    expect(story.twine2.start).toBe('Start');
    expect(story.passages.map((p) => [p.name, p.text])).toContainEqual(['StoryData 2', '{"format":"Harlowe"}']);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Passage "StoryData" renamed to "StoryData 2": in Twee, "StoryData" is the special passage that holds the story metadata, which this file\'s "tw-storydata" attributes give. Links to it must be changed by hand.',
    ]);
  });

  it('renames a passage named StoryTitle whose text is not the story name', () => {
    const html = twine2(attributes, '<tw-passagedata pid="1" name="StoryTitle">Other</tw-passagedata>');
    const { story, diagnostics } = decompileHTML(html);
    expect(story.name).toBe('S');
    expect(story.twine2.start).toBe('StoryTitle 2');
    expect(story.passages.map((p) => [p.name, p.text])).toContainEqual(['StoryTitle 2', 'Other']);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Passage "StoryTitle" renamed to "StoryTitle 2": in Twee, "StoryTitle" is the special passage that holds the story name, which this file\'s "tw-storydata" attributes give. Links to it must be changed by hand.',
    ]);
  });

  it('reads a passage named StoryTitle that holds the story name as the story title', () => {
    const html = twine2(`ifid="${IFID}"`, '<tw-passagedata pid="2" name="StoryTitle">S</tw-passagedata>');
    const { story, diagnostics } = decompileHTML(html);
    expect(diagnostics).toEqual([]);
    expect(story.name).toBe('S');
    expect(story.passages.filter((p) => p.name === 'StoryTitle').map((p) => p.text)).toEqual(['S']);
  });
});

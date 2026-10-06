import { describe, it, expect } from 'vitest';
import {
  findJavaScriptPassageLinks,
  findMacroTags,
  findPassageLinks,
  parseMacroArgs,
  scriptBodyCloser,
  tagMatcher,
} from '../src/sugarcube-macros.js';

describe('tag arguments with parts that do not close', () => {
  it('reads a tag whose `//` part ends at a line terminator other than a line feed', () => {
    expect(findMacroTags('<<a // x\r y>>')).toEqual([{ name: 'a', args: '// x\r y', start: 0, end: 13 }]);
  });

  it('reads a tag whose `//` part runs to the end of the text', () => {
    expect(findMacroTags('<<a // x')).toEqual([]);
  });

  it('reads a tag whose quoted part is cut by a backslash before a line break or the end', () => {
    expect(findMacroTags('<<a "x\\\ny">>').map((tag) => tag.args)).toEqual(['"x\\\ny"']);
    expect(findMacroTags('<<a "x\\')).toEqual([]);
  });

  it('reads a tag whose link markup part is cut by a line break', () => {
    expect(findMacroTags('<<a [[x\ny]]>>').map((tag) => tag.args)).toEqual(['[[x\ny]]']);
    expect(findMacroTags('<<a [x]>>').map((tag) => tag.args)).toEqual(['[x]']);
  });

  it('reads a block comment part that is not closed', () => {
    expect(findMacroTags('<<a /* x>>').map((tag) => tag.args)).toEqual(['/* x']);
  });

  it('reports a tag the search cannot finish as no tag', () => {
    expect(tagMatcher('<<>>')(0)).toBeUndefined();
  });
});

describe('parseMacroArgs on link markup that does not close', () => {
  it.each([
    ['a line break in the markup', '[[a\nb]]'],
    ['a backslash before a line break', '[[a\\\nb]]'],
    ['a backslash at the end', '[[a\\'],
    ['markup that never closes', '[[a'],
    ['one bracket', '[a]'],
  ])('rejects %s', (_label, raw) => {
    expect(parseMacroArgs(raw)).toBeUndefined();
  });

  it('keeps nested brackets and escaped characters inside the markup', () => {
    expect(parseMacroArgs('[[a[b]c]]')).toEqual([{ type: 'markup' }]);
    expect(parseMacroArgs('[[a\\]b]]')).toEqual([{ type: 'markup' }]);
  });
});

describe('links in the arguments of a tag', () => {
  it('names the passage image markup as an argument links to, and none for one without a link', () => {
    expect(findPassageLinks('<<button [img[pic.png]]>>')).toEqual([]);
    expect(findPassageLinks('<<button [img[pic.png][Room]]>>').map((l) => l.passage)).toEqual(['Room']);
  });

  it.each([
    String.raw`$.wiki('[img[pic.png][Room]]')`,
    String.raw`$.wiki('[<IMG[pic.png][Room]]')`,
    String.raw`$.wiki('[\x69mg[pic.png][Room]]')`,
    String.raw`$.wiki('\x5bimg[pic.png][Room]]')`,
    String.raw`$.wiki('[>\u0069mg[pic.png][Room]]')`,
  ])('reads the link of image markup a script string holds: %s', (source) => {
    expect(findJavaScriptPassageLinks(source).map((l) => l.passage)).toEqual(['Room']);
  });

  it('splits a closing bracket after link markup off as a word', () => {
    expect(parseMacroArgs('[[a]]]')).toEqual([{ type: 'markup' }, { type: 'string', value: ']' }]);
  });

  it('names no passage for link markup that SugarCube rejects', () => {
    expect(findPassageLinks('<<button [["x]]>>')).toEqual([]);
  });

  it('reads a call put inside a tag whose arguments are cut by an unclosed string', () => {
    expect(findPassageLinks('<<a <<link "x>>')).toEqual([]);
    expect(findPassageLinks('<<a <<goto "Room">>')).toEqual([{ via: 'goto', passage: 'Room' }]);
  });

  it('ignores a call in a tag whose arguments SugarCube cannot split', () => {
    expect(findPassageLinks('<<goto "a\nb">>')).toEqual([]);
  });
});

describe('<script> elements', () => {
  it('reads an opener with no closing angle bracket as text', () => {
    expect(findPassageLinks('<script x [[Room]]')).toEqual([{ via: 'markup', passage: 'Room' }]);
    expect(findPassageLinks('<script x <script y [[Room]]')).toEqual([{ via: 'markup', passage: 'Room' }]);
  });

  it('reads an element whose content is cut by a line terminator as an opener only', () => {
    // Only the opener is read; the text after it is markup, so the call in it still counts.
    expect(findPassageLinks('<script>\r"<<goto A>>"</script> [[Room]]')).toEqual([
      { via: 'goto', passage: 'A' },
      { via: 'markup', passage: 'Room' },
    ]);
    expect(findPassageLinks('<script>[[Room]]\r</script>')).toEqual([{ via: 'markup', passage: 'Room' }]);
  });

  it('reads two openers that share one closing angle bracket', () => {
    expect(findPassageLinks('<script <script>[[Room]]')).toEqual([{ via: 'markup', passage: 'Room' }]);
  });

  it('reads an element that is never closed as an opener only', () => {
    expect(findPassageLinks('<script>[[Room]]')).toEqual([{ via: 'markup', passage: 'Room' }]);
    expect(findPassageLinks('<script>[[A]] <script>[[B]]')).toEqual([
      { via: 'markup', passage: 'A' },
      { via: 'markup', passage: 'B' },
    ]);
  });

  it('reads the strings of a complete element as JavaScript', () => {
    expect(findPassageLinks(`<script>$.wiki('<<goto "Room">>')</script>`)).toEqual([{ via: 'goto', passage: 'Room' }]);
  });
});

describe('scriptBodyCloser for an opener the tag list does not hold', () => {
  const budget = () => ({ left: 10_000 });
  const opener = (start: number, end: number) => ({ name: 'script', args: '', start, end });

  it('scans on from the body to the closing tag', () => {
    const text = '/* <<script>> */ <</script>>';
    expect(scriptBodyCloser(text, budget())(opener(1, 13))?.name).toBe('/script');
  });

  it('gives up when no tag follows', () => {
    const text = '/* <<script>> */';
    expect(scriptBodyCloser(text, budget())(opener(1, 13))).toBeUndefined();
  });

  it('skips a `<<` that starts no tag, and counts a nested <<script>>', () => {
    const text = '/* */ <<>> <<script>> <</script>> <</script>>';
    expect(scriptBodyCloser(text, budget())(opener(0, 5))?.start).toBe(text.lastIndexOf('<</script>>'));
  });

  it('counts an endscript tag as a closer', () => {
    const text = '<<script>> <<endscript>>';
    expect(scriptBodyCloser(text, budget())(opener(0, 10))?.name).toBe('endscript');
  });

  it('stops once the budget is spent', () => {
    const text = 'x <<script>> ' + '<<a>> '.repeat(50);
    expect(scriptBodyCloser(text, { left: 5 })(opener(-3, 2))).toBeUndefined();
  });
});

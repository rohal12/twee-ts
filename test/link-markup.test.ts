import { describe, it, expect } from 'vitest';
import { readSquareBracketedMarkup } from '../src/link-markup.js';

/** The link that markup at the start of `text` names, `null` if SugarCube rejects the markup. */
function link(text: string): string | undefined | null {
  const markup = readSquareBracketedMarkup(text, 0);
  return markup === undefined ? null : markup.link;
}

describe('readSquareBracketedMarkup', () => {
  it('reads each link form', () => {
    expect(link('[[Room]]')).toBe('Room');
    expect(link('[[Go|Room]]')).toBe('Room');
    expect(link('[[Go->Room]]')).toBe('Room');
    expect(link('[[Room<-Go]]')).toBe('Room');
    expect(link('[[ Go | Room ]]')).toBe('Room');
  });

  it('reads a setter after any link form', () => {
    expect(link('[[Room][$x to 1]]')).toBe('Room');
    expect(link('[[Go|Room][$x to 1]]')).toBe('Room');
    expect(link('[[Go->Room][$x to 1]]')).toBe('Room');
    expect(link('[[Room<-Go][$x to 1]]')).toBe('Room');
  });

  it('divides at the first delimiter', () => {
    expect(link('[[a->b->c]]')).toBe('b->c');
    expect(link('[[a|b|c]]')).toBe('b|c');
    expect(link('[[a|b->c]]')).toBe('b->c');
    expect(link('[[a->b|c]]')).toBe('b|c');
    expect(link('[[a<-b->c]]')).toBe('a');
    expect(link('[[a<-b|c]]')).toBe('a');
    expect(link('[[a->b<-c]]')).toBe('b<-c');
    expect(link('[[<<-- Back|Prev]]')).toBe('<');
  });

  it('counts nested square brackets', () => {
    expect(link('[[Go [north]|Room]]')).toBe('Room');
    expect(link('[[Go|Room][$a[0] to 1]]')).toBe('Room');
    expect(link('[[Go|Room][$a[$b[0]][1] to [1, [2]]]]')).toBe('Room');
    expect(readSquareBracketedMarkup('[[Go|Room][$a[0] to 1]] after', 0)?.end).toBe(23);
  });

  it('reads double-quoted strings as units, and single-quoted ones in setters', () => {
    expect(link('[["a|b]"->Room]]')).toBe('Room');
    expect(link('[[Go|Room][$x to "]]"]]')).toBe('Room');
    expect(link("[[Go|Room][$x to ']]']]")).toBe('Room');
    expect(link('[[Go|Room][$x to "a\\"]]"]]')).toBe('Room');
    // Outside a setter, a single quote is text.
    expect(link("[[Don't go|Room]]")).toBe('Room');
  });

  it('drops the ~ that forces an internal link', () => {
    expect(link('[[Go|~Room]]')).toBe('Room');
    expect(link('[[~Room]]')).toBe('Room');
  });

  it('rejects markup SugarCube rejects', () => {
    expect(link('[[Room')).toBeNull();
    expect(link('[[Ro\nom]]')).toBeNull();
    expect(link('[[a]b]]')).toBeNull();
    expect(link('[[a|b]')).toBeNull();
    expect(link('[["a]]')).toBeNull();
    expect(link('[[a|b][$x]y]]')).toBeNull();
    expect(link('[[a|b][$x to "y]]')).toBeNull();
    expect(link("[[a|b][$x to 'y]]")).toBeNull();
    expect(link('[[a|b][$x to "y\\\n"]]')).toBeNull();
    expect(link('[[a|b][$x][$y]]')).toBeNull();
    expect(link('[x]]')).toBeNull();
    expect(link('x')).toBeNull();
  });

  it('reads image markup, whose link component is optional', () => {
    expect(readSquareBracketedMarkup('[img[pic.png]]', 0)).toEqual({ type: 'image', link: undefined, end: 14 });
    expect(readSquareBracketedMarkup('[img[Title|pic.png][Room]]', 0)).toEqual({
      type: 'image',
      link: 'Room',
      end: 26,
    });
    expect(link('[<IMG[pic.png][~Room][$x to "]"]]')).toBe('Room');
    expect(link('[>img[pic.png<-Title][Room]]')).toBe('Room');
    expect(link('[img[pic.png][Room]x]]')).toBeNull();
    expect(link('[imgx[pic.png]]')).toBeNull();
  });

  it('starts where it is told to', () => {
    expect(readSquareBracketedMarkup('ab [[Room]] cd', 3)).toEqual({
      type: 'link',
      link: 'Room',
      label: 'Room',
      end: 11,
    });
  });

  it.each([
    ['[[Continue|The Second Passage]]', 'Continue'],
    ['[[Continue->The Second Passage]]', 'Continue'],
    ['[[The Second Passage<-Continue]]', 'Continue'],
    ['[[Continue|The Second Passage][$score = 1]]', 'Continue'],
    ['[[Continue->The Second Passage][$score = 1]]', 'Continue'],
    ['[[The Second Passage<-Continue][$a = "]" + [1]]]', 'Continue'],
    ['[[Room]]', 'Room'],
  ])('reads the label of %s', (text, label) => {
    expect(readSquareBracketedMarkup(text, 0)?.label).toBe(label);
  });

  it('has no label for image markup', () => {
    expect(readSquareBracketedMarkup('[img[a.png]]', 0)?.label).toBeUndefined();
  });

  it('reads no further than its budget, and spends what it reads', () => {
    const budget = { left: 20 };
    expect(readSquareBracketedMarkup('[[Room]]', 0, budget)?.link).toBe('Room');
    expect(budget.left).toBe(12);
    expect(readSquareBracketedMarkup('[[' + 'a'.repeat(100), 0, budget)).toBeUndefined();
    expect(budget.left).toBeLessThanOrEqual(0);
    expect(readSquareBracketedMarkup('[[Room]]', 0, budget)).toBeUndefined();
  });

  it('spends only what a rejected reading looked at, not the rest of the text', () => {
    const rest = 'x'.repeat(5000);
    for (const [opener, read] of [
      ['[[unfinished\n', 13],
      ['[["unclosed quote\n', 18],
      ['[[a|b][$x to 1\n', 15],
      ['[[a]b]] ', 5],
      ['[[a|b][$x][$y]] ', 11],
      ['[img[pic.png][Room\n', 19],
    ] as const) {
      const budget = { left: 1000 };
      expect(readSquareBracketedMarkup(opener + rest, 0, budget), opener).toBeUndefined();
      expect(1000 - budget.left, opener).toBe(read);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { readSquareBracketedMarkup } from '../src/link-markup.js';

/** The link that markup at the start of `text` names, `null` if SugarCube rejects the markup. */
function link(text: string): string | undefined | null {
  const markup = readSquareBracketedMarkup(text, 0);
  return markup === undefined ? null : markup.link;
}

describe('readSquareBracketedMarkup components that cannot be read to the end', () => {
  it('rejects a link whose setter is never closed', () => {
    expect(link('[[Room][$x to "open]]')).toBeNull();
    expect(link("[[Room][$x to 'open]]")).toBeNull();
  });

  it('reads an apostrophe in an image link as text, not as a quote', () => {
    expect(link("[img[pic.png][Don't]]")).toBe("Don't");
  });

  it('rejects an image link with an unclosed double quote', () => {
    expect(link('[img[pic.png]["Room]]')).toBeNull();
  });

  it('reads an image link that holds square brackets', () => {
    expect(link('[img[pic.png][Room [1]]]')).toBe('Room [1]');
  });
});

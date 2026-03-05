import { describe, it, expect } from 'vitest';
import { attrEscape, htmlEscape, tiddlerEscape, tiddlerUnescape, tweeEscape, tweeUnescape } from '../src/escape.js';

describe('attrEscape', () => {
  it('escapes ampersands, quotes, and apostrophes', () => {
    expect(attrEscape('a&b"c\'d')).toBe('a&amp;b&quot;c&#39;d');
  });
  it('returns empty string unchanged', () => {
    expect(attrEscape('')).toBe('');
  });
  it('does not escape < and >', () => {
    expect(attrEscape('<tag>')).toBe('<tag>');
  });
});

describe('htmlEscape', () => {
  it('escapes all special HTML characters', () => {
    expect(htmlEscape('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });
  it('returns empty string unchanged', () => {
    expect(htmlEscape('')).toBe('');
  });
});

describe('tiddlerEscape', () => {
  it('escapes tiddler special characters', () => {
    expect(tiddlerEscape('a\\b\tc\nd&e<f>g"h')).toBe('a\\sb\\tc\\nd&amp;e&lt;f&gt;g&quot;h');
  });
  it('returns empty string unchanged', () => {
    expect(tiddlerEscape('')).toBe('');
  });
});

describe('tiddlerUnescape', () => {
  it('unescapes tiddler special characters', () => {
    expect(tiddlerUnescape('a\\sb\\tc\\nd')).toBe('a\\b\tc\nd');
  });
  it('is inverse of tiddlerEscape for relevant chars', () => {
    expect(tiddlerUnescape('\\n\\t\\s')).toBe('\n\t\\');
  });
});

describe('tweeEscape', () => {
  it('escapes backslash, brackets, and braces', () => {
    expect(tweeEscape('a\\b[c]d{e}f')).toBe('a\\\\b\\[c\\]d\\{e\\}f');
  });
  it('returns empty string unchanged', () => {
    expect(tweeEscape('')).toBe('');
  });
});

describe('tweeUnescape', () => {
  it('unescapes backslash-prefixed characters', () => {
    expect(tweeUnescape('a\\\\b\\[c\\]d\\{e\\}f')).toBe('a\\b[c]d{e}f');
  });
  it('is inverse of tweeEscape', () => {
    const original = 'name [with] {special} \\chars';
    expect(tweeUnescape(tweeEscape(original))).toBe(original);
  });
  it('handles trailing backslash gracefully', () => {
    expect(tweeUnescape('test\\')).toBe('test\\');
  });
});

import { describe, it, expect } from 'vitest';
import { cssContexts, javaScriptContexts } from '../src/code-context.js';

/** The context of the first occurrence of `needle` in `source`. */
function js(source: string, needle: string, module = false) {
  const start = source.indexOf(needle);
  return javaScriptContexts(source, [{ start, end: start + needle.length }], module)[0]?.context;
}

function css(source: string, needle: string) {
  const start = source.indexOf(needle);
  return cssContexts(source, [{ start, end: start + needle.length }])[0]?.context;
}

describe('javaScriptContexts', () => {
  it('finds strings, and whether the range is the whole literal', () => {
    expect(js('a("X")', 'X')).toEqual({ kind: 'string', quote: '"', whole: false });
    expect(js("a('X')", 'X')).toEqual({ kind: 'string', quote: "'", whole: false });
    expect(js('a("X")', '"X"')).toEqual({ kind: 'string', quote: '"', whole: true });
  });

  it('tells tagged from untagged templates, nested ones included', () => {
    expect(js('a = `X`', 'X')).toEqual({ kind: 'template', tagged: false });
    expect(js('a = tag`X`', 'X')).toEqual({ kind: 'template', tagged: true });
    expect(js('a = f()`X`', 'X')).toEqual({ kind: 'template', tagged: true });
    expect(js('a = `${`X`}`', 'X')).toEqual({ kind: 'template', tagged: false });
    expect(js('a = `${b}X`', 'X')).toEqual({ kind: 'template', tagged: false });
    expect(js('a = t`${`q`}X`', 'X')).toEqual({ kind: 'template', tagged: true });
    expect(js('class A { #p; m() { return this.#p`X`; } }', 'X')).toEqual({ kind: 'template', tagged: true });
  });

  it('tells a regular expression from a division, with its flags', () => {
    expect(js('a = /X/giu', 'X')).toEqual({ kind: 'regexp', flags: 'giu' });
    expect(js('a = b / X / c', 'X')).toEqual({ kind: 'code' });
  });

  it('finds comments, and where a single-line comment starts', () => {
    expect(js('/* X */', 'X')).toEqual({ kind: 'block-comment' });
    expect(js('a; // X', 'X')).toEqual({ kind: 'line-comment', start: 3 });
    expect(js('a;\n<!-- X', '<!--')).toEqual({ kind: 'line-comment', start: 3 });
  });

  it('reads module syntax in a module', () => {
    expect(js('import a from "X";', 'X', true)).toEqual({ kind: 'string', quote: '"', whole: false });
  });

  it('reports source it cannot tokenize', () => {
    expect(js('a = "X', 'X')).toEqual({ kind: 'unparsable', reason: expect.stringContaining('Unterminated string') });
  });

  it('reads code outside literals as code', () => {
    expect(js('var X = 1;', 'X')).toEqual({ kind: 'code' });
  });
});

describe('cssContexts', () => {
  it('finds strings and comments', () => {
    expect(css('a { content: "X"; }', 'X')).toEqual({ kind: 'string', quote: '"' });
    expect(css("a { content: 'X'; }", 'X')).toEqual({ kind: 'string', quote: "'" });
    expect(css('/* X */ a {}', 'X')).toEqual({ kind: 'comment' });
    expect(css('a { color: X; }', 'X')).toEqual({ kind: 'code' });
  });

  it('ends a string at its quote, past escapes, or at a line break (a bad string)', () => {
    expect(css('a { content: "\\"" X; }', 'X')).toEqual({ kind: 'code' });
    expect(css('a { content: "bad\n X; }', 'X')).toEqual({ kind: 'code' });
    expect(css('a { content: "\\\nX"; }', 'X')).toEqual({ kind: 'string', quote: '"' });
  });

  it('runs an unclosed comment or string to the end, and skips escaped quotes outside strings', () => {
    expect(css('/* X', 'X')).toEqual({ kind: 'comment' });
    expect(css('a { content: "X', 'X')).toEqual({ kind: 'string', quote: '"' });
    expect(css('a\\" X', 'X')).toEqual({ kind: 'code' });
  });
});

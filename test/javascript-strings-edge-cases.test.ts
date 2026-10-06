import { describe, it, expect } from 'vitest';
import { SUBSTITUTION, evalStringLiteral, javaScriptStrings } from '../src/javascript-strings.js';
import { evaluateJavaScript } from './helpers/javascript.js';

describe('evalStringLiteral edge cases', () => {
  it.each([
    ['an empty input', ''],
    ['a lone quote', '"'],
    ['mismatched quotes', `"a'`],
    ['no quotes', 'abc'],
    ['a trailing backslash', '"a\\"'],
    ['a NUL escape', '"a\\0b"'],
    ['a short unicode escape', '"\\u12"'],
    ['a non-hexadecimal unicode escape', '"\\u12G4"'],
    ['a non-hexadecimal braced unicode escape', '"\\u{12G}"'],
    ['an unclosed braced unicode escape', '"\\u{41"'],
    ['an empty braced unicode escape', '"\\u{}"'],
    ['a line feed continuation', '"a\\\nb"'],
    ['a carriage-return line continuation', '"a\\\rb"'],
    ['a CRLF line continuation', '"a\\\r\nb"'],
    ['a line separator continuation', '"a\\ b"'],
    ['a paragraph separator continuation', '"a\\ b"'],
    ['a raw line feed', '"a\nb"'],
  ])('matches strict-mode JavaScript for %s', (_label, literal) => {
    let expected: string | undefined;
    try {
      expected = evaluateJavaScript(`"use strict"; return ${literal};`) as string;
    } catch {
      expected = undefined;
    }
    expect(evalStringLiteral(literal)).toBe(expected);
  });
});

describe('javaScriptStrings edge cases', () => {
  it('reads a regular expression with a class, an escape and flags as one token', () => {
    expect(javaScriptStrings(`x = /["'/\\]]+/gi; y = "kept"`)).toEqual(['kept']);
  });

  it('reads a slash as division when the regular expression does not close on its line', () => {
    expect(javaScriptStrings(`x = /abc\ny = "kept"`)).toEqual(['kept']);
    expect(javaScriptStrings(`x = /abc\\`)).toEqual([]);
    expect(javaScriptStrings(`x = /abc\\\ny = "kept"`)).toEqual(['kept']);
    expect(javaScriptStrings(`x = /abc`)).toEqual([]);
  });

  it('reads a regular expression after a keyword but division after a property of that name', () => {
    expect(javaScriptStrings(`return /"/.test(s) && "kept"`)).toEqual(['kept']);
    expect(javaScriptStrings(`a.return / "x" / b`)).toEqual(['x']);
  });

  it('reads a slash after ++, --, a bracket or a number as division', () => {
    expect(javaScriptStrings(`a++ / "x" / b`)).toEqual(['x']);
    expect(javaScriptStrings(`a-- / "x" / b`)).toEqual(['x']);
    expect(javaScriptStrings(`(a) / "x" / b`)).toEqual(['x']);
    expect(javaScriptStrings(`3 / "x" / 4`)).toEqual(['x']);
  });

  it('skips a line comment to its end, or to the end of the source', () => {
    expect(javaScriptStrings(`// "a"\n"b"`)).toEqual(['b']);
    expect(javaScriptStrings(`"b" // "a"`)).toEqual(['b']);
    expect(javaScriptStrings(`"b" /* "a"`)).toEqual(['b']);
  });

  it('reads words with non-ASCII letters whole', () => {
    expect(javaScriptStrings(`é = "kept"`)).toEqual(['kept']);
    expect(javaScriptStrings(`éreturn / "x" / b`)).toEqual(['x']);
  });

  it('keeps the braces of a substitution paired', () => {
    expect(javaScriptStrings('`a${ {k: "v"} }b`')).toEqual(['v', `a${SUBSTITUTION}b`]);
    expect(javaScriptStrings('`a${ x } ${ y }b`')).toEqual([`a${SUBSTITUTION} ${SUBSTITUTION}b`]);
  });

  it('drops a template literal that holds an escape strict mode rejects', () => {
    expect(javaScriptStrings('`a\\1b`')).toEqual([]);
    expect(javaScriptStrings('`a\\1${"x"}b`')).toEqual(['x']);
  });

  it('skips an escaped character in a template literal', () => {
    expect(javaScriptStrings('`a\\`b`')).toEqual(['a`b']);
  });

  it('reads on after a stray closing brace or an unclosed template', () => {
    expect(javaScriptStrings(`} "kept"`)).toEqual(['kept']);
    expect(javaScriptStrings('`abc')).toEqual([]);
    expect(javaScriptStrings('`abc${ "x"')).toEqual(['x']);
  });

  it('normalizes line breaks in a template literal and keeps a continued string whole', () => {
    expect(javaScriptStrings('`a\r\nb\rc`')).toEqual(['a\nb\nc']);
    expect(javaScriptStrings('"a\\\r\nb"')).toEqual(['ab']);
  });

  it('leaves out a string that holds an escape strict mode rejects', () => {
    expect(javaScriptStrings(`"\\1" "kept"`)).toEqual(['kept']);
  });

  it('skips the rest of the line where a string does not close', () => {
    // Read from inside an unclosed string, "b" would be a string the author never wrote.
    expect(javaScriptStrings(`'a "b" c\n"d"`)).toEqual(['d']);
    expect(javaScriptStrings(`"a\\`)).toEqual([]);
  });
});

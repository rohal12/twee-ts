import { describe, it, expect } from 'vitest';
import { parseRelaxedJSON } from '../src/relaxed-json.js';

/** What JavaScript evaluation gives for a literal. */
const evaluate = (literal: string): unknown => new Function(`return (${literal});`)();

describe('parseRelaxedJSON', () => {
  it('reads strict JSON the way JSON.parse does', () => {
    const json = '{"a": [1, -2.5e3, true, false, null], "b": {"c": "d\\u00e9\\n"}}';
    expect(parseRelaxedJSON(json)).toEqual(JSON.parse(json));
  });

  it.each([
    ['single quotes', `{'a': 'it\\'s "x"'}`],
    ['unquoted and numeric keys', '{a: 1, $b_2: 2, 3: "three"}'],
    ['trailing commas', '{"a": [1, 2,], "b": {"c": 1,},}'],
    ['comments', '{ // line\n "a": /* block */ 1 }'],
    ['JavaScript escapes', `{"a": "\\x41\\u{1F600}\\v\\0\\q\\/", "b": 'line \\\ncontinued'}`],
    ['other number forms', '{"a": 0x1F, "b": 0o17, "c": 0b101, "d": .5, "e": 5., "f": +1}'],
    ['strings that look like structure', `{"a": "b, }", "c": "d: e", 'f': "{g:1,h:2,}"}`],
  ])('reads %s as JavaScript does', (_label, literal) => {
    expect(parseRelaxedJSON(literal)).toEqual(evaluate(literal));
  });

  it('keeps a "__proto__" key as an ordinary property', () => {
    const value = parseRelaxedJSON('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('parses only the given range, and reports positions in the whole text', () => {
    const text = 'window.storyFormat({\n  a: 1,\n});';
    expect(parseRelaxedJSON(text, text.indexOf('{'), text.lastIndexOf('}') + 1)).toEqual({ a: 1 });
    const broken = 'window.storyFormat({\n  a: 1,\n  b: nope,\n});';
    expect(() => parseRelaxedJSON(broken, broken.indexOf('{'), broken.lastIndexOf('}') + 1)).toThrow(
      'Unexpected identifier "nope" at line 3, column 6',
    );
  });

  it.each([
    ['a function value', '{"setup": function () {}}', /Unexpected identifier "function"/],
    ['a variable', '{"a": b}', /Unexpected identifier "b"/],
    ['an unterminated string', '{"a": "b}', /Unterminated string/],
    ['a raw line break in a string', '{"a": "b\nc"}', /Unterminated string/],
    ['an unterminated comment', '{"a": 1 /* }', /Unterminated comment/],
    ['a missing comma', '{"a": 1 "b": 2}', /Expected "," or "}"/],
    ['an array hole', '[1,,2]', /Unexpected ","/],
    ['text after the value', '{} x', /after the value/],
    ['an octal escape', '{"a": "\\1"}', /Octal escape/],
    ['a zero followed by a digit in an escape', '{"a": "\\01"}', /Octal escape/],
    ['a backslash at the end of the input', '"a\\', /Unterminated string/],
    ['a short hexadecimal escape', '"\\x4"', /Invalid hexadecimal escape/],
    ['a non-hexadecimal unicode escape', '"\\u12G4"', /Invalid hexadecimal escape/],
    ['an unclosed braced unicode escape', '"\\u{41"', /Invalid Unicode escape/],
    ['a code point beyond the Unicode range', '"\\u{110000}"', /Undefined Unicode code-point/],
    ['a missing colon', '{"a" 1}', /Expected ":" but found "1"/],
    ['an invalid property name', '{[1]: 2}', /Expected a property name but found "\["/],
    ['a property name at the end of the input', '{', /Expected a property name but found end of input/],
    ['a number glued to an identifier', '[1a]', /Invalid number/],
    ['a missing array comma', '[1 2]', /Expected "," or "\]"/],
    ['an unexpected character', '@', /Unexpected "@"/],
    ['an empty input', '', /Unexpected end of input/],
  ])('rejects %s', (_label, literal, message) => {
    expect(() => parseRelaxedJSON(literal)).toThrow(message);
  });

  it.each([
    ['a line comment ended by a line feed', '[1] // done\n'],
    ['a carriage-return line continuation', '"a\\\r\nb"'],
    ['a lone carriage-return line continuation', '"a\\\rb"'],
    ['a Unicode line separator continuation', '"a\\ b"'],
    ['a line comment ended by a carriage return', '[1, // c\r2]'],
    ['a braced unicode escape', '"\\u{41}\\u{1f600}"'],
  ])('reads %s as JavaScript does', (_label, literal) => {
    expect(parseRelaxedJSON(literal)).toEqual(evaluate(literal));
  });

  it('reads a line comment that runs to the end of the input', () => {
    expect(parseRelaxedJSON('[1] // done')).toEqual([1]);
  });

  it('does not read a comment that runs past the end of the range', () => {
    const text = '[1 /* x */ ]';
    expect(() => parseRelaxedJSON(text, 0, text.indexOf('*/') + 1)).toThrow(/Unterminated comment/);
  });

  it('does not read a token that runs past the end of the range', () => {
    expect(() => parseRelaxedJSON('[truex]', 0, 5)).toThrow(/Unexpected "t"/);
  });
});

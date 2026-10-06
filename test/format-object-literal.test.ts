/**
 * The format object's literal subset (see `src/format-decode.ts`): what is read, and what is
 * rejected with a diagnostic, with V8 itself as the oracle for every value read.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getLineInfo } from 'acorn';
import { readFormatObject } from '../src/format-decode.js';
import { canonical, runFormatScript } from './helpers/story-format-oracle.js';
import { literalValue, objectLiteral, storyFormatCallee, surroundingCode, trivia } from './helpers/js-arbitraries.js';

/** A format.js whose format object holds `literal` as its `value` property. */
const wrap = (literal: string): string => `window.storyFormat({"version":"1.0.0","source":"s","value":${literal}});`;

/** What twee-ts reads as the `value` property of the format object, or the reason it gives. */
function ours(literal: string): { readonly value: string } | { readonly reason: string } {
  const read = readFormatObject(wrap(literal));
  return read.ok ? { value: canonical(read.fields.get('value')) } : { reason: read.reason };
}

/** What V8 makes of the same `value`, or `undefined` if the file does not run. */
function v8(literal: string): string | undefined {
  const run = runFormatScript(wrap(literal));
  const [format] = run.ok ? run.calls : [];
  return typeof format === 'object' && format !== null && 'value' in format ? canonical(format.value) : undefined;
}

/** Expect twee-ts to read `literal` exactly as V8 evaluates it. */
function expectAsV8(literal: string): void {
  const expected = v8(literal);
  expect(expected, `V8 should run ${JSON.stringify(literal)}`).toBeDefined();
  expect(ours(literal), JSON.stringify(literal)).toEqual({ value: expected });
}

/** Expect twee-ts to reject `literal` with a reason matching `reason`. */
function expectRejected(literal: string, reason: RegExp): void {
  const result = ours(literal);
  expect(result, JSON.stringify(literal)).toEqual({ reason: expect.stringMatching(reason) });
}

describe('format object literals read as JavaScript reads them', () => {
  it.each([
    ['strict JSON', '{"a": [1, -2.5e3, true, false, null], "b": {"c": "d\\u00e9\\n"}}'],
    ['single quotes', `{'a': 'it\\'s "x"'}`],
    ['unquoted and numeric keys', '{a: 1, $b_2: 2, 3: "three"}'],
    ['trailing commas', '{"a": [1, 2,], "b": {"c": 1,},}'],
    ['comments', '{ // line\n "a": /* block */ 1 }'],
    ['JavaScript escapes', `{"a": "\\x41\\u{1F600}\\v\\0\\q\\/", "b": 'line \\\ncontinued'}`],
    ['other number forms', '{"a": 0x1F, "b": 0o17, "c": 0b101, "d": .5, "e": 5., "f": +1}'],
    ['strings that look like structure', `{"a": "b, }", "c": "d: e", 'f': "{g:1,h:2,}"}`],
    ['a line comment ended by a carriage return', '[1, // c\r2]'],
    ['a carriage-return line continuation', '"a\\\r\nb"'],
    ['a lone carriage-return line continuation', '"a\\\rb"'],
    ['a line separator continuation', '"a\\\u{2028}b"'],
    ['raw line and paragraph separators in a string', '"a\u{2028}b\u{2029}c"'],
    ['a braced unicode escape', '"\\u{41}\\u{1f600}"'],
    // JS-5: the numbers and escapes sloppy-mode JavaScript, which runs format.js, gives.
    ['a legacy octal integer (JS-5)', '010'],
    ['a legacy octal key (JS-5)', '{010: 1, 0x10: 2, 1e3: 3, 1.50: 4, .5: 5}'],
    ['a decimal with a leading zero', '[08, 09.5, 019e1]'],
    ['numeric separators (JS-5)', '[1_000, 0x_F === 1 ? 0 : 0b1_0, 1_0.0_1e1_0]'.replace('0x_F === 1 ? 0 : ', '')],
    ['a sign with trivia after it (JS-5)', '[- 1, -/* c */2, +\n3, -0]'],
    ['a template literal without substitutions (JS-5)', '`a\r\nb\\`${"{"}`'.replace('${"{"}', '')],
    ['legacy octal escapes and \\8, \\9 (JS-5)', '"\\101\\0\\8\\9\\377"'],
    ['non-ASCII and escaped identifier keys (JS-5)', '{ä: 1, \\u0061b: 2, \\u{63}: 3, a\\u200cb: 4}'],
    ['a BigInt key', '{1n: 1, 0x10n: 2}'],
    ['duplicate keys, the last value in the first place', '{a: 1, b: 2, a: 3, "b": 4, 1: 5, "1": 6}'],
    ['integer-like keys, which JavaScript puts first', '{b: 1, 2: 2, a: 3, 1: 4}'],
    ['HTML-like comments (JS-2)', "{a: 1, <!-- it's a comment\n b: 2\n--> another one\n}"],
    ['an infinite number', '[1e400, -1e400]'],
  ])('reads %s', (_label, literal) => {
    expectAsV8(literal);
  });

  it('leaves out a function-valued property, as data, whatever its spelling (JS-4)', () => {
    for (const property of [
      'setup: function () {}',
      '"setup": function () { return /"}/; }',
      "'setup': function named() {}",
      'setup() {}',
      'async setup() {}',
      '*setup() {}',
      'setup: () => {}',
      'setup: async () => 1',
    ]) {
      const read = readFormatObject(`window.storyFormat({a: 1, ${property}, b: 2});`);
      expect(read, property).toMatchObject({
        ok: true,
        notes: [expect.stringMatching(/^Skipped the function at property setup/)],
      });
      expect(read.ok && [...read.fields.keys()], property).toEqual(['a', 'b']);
    }
  });

  it('lets a later function replace an earlier value, as JavaScript does', () => {
    const read = readFormatObject('window.storyFormat({setup: "data", setup() {}, other: 1, other: () => 0});');
    expect(read.ok && [...read.fields.keys()]).toEqual([]);
  });

  it('keeps an earlier function replaced by a later value out of the way', () => {
    const read = readFormatObject('window.storyFormat({setup() {}, a: 1, setup: "data"});');
    expect(read.ok && Object.fromEntries(read.fields)).toEqual({ setup: 'data', a: 1 });
  });

  it('rejects a __proto__ key, which sets the prototype in JavaScript (JS-5)', () => {
    for (const literal of [
      '{__proto__: {a: 1}}',
      '{"__proto__": {a: 1}}',
      '{__\\u0070roto__: 1}',
      "{'__proto__': 1}",
    ]) {
      expectRejected(literal, /^Could not decode the story format object: Unsupported __proto__ key/);
    }
    // A computed key adds an ordinary property in JavaScript, but computed keys are not read at all.
    expectRejected('{["__proto__"]: 1}', /Unsupported computed property key/);
    expect(Object.prototype).not.toHaveProperty('a');
  });

  it('reports a rejected value by its property path and its line and column', () => {
    const source = 'window.storyFormat({\n  a: 1,\n  b: [0, {c: nope}],\n  "d-e": {f: x},\n});';
    expect(readFormatObject(source)).toEqual({
      ok: false,
      reason:
        'Could not decode the story format object: Unsupported identifier "nope" at property b[1].c (line 3, column 14); only literal data is read.',
    });
    expect(readFormatObject(source.replace('nope', '0'))).toEqual({
      ok: false,
      reason:
        'Could not decode the story format object: Unsupported identifier "x" at property ["d-e"].f (line 4, column 14); only literal data is read.',
    });
  });

  it('counts every line terminator in positions (JS-6)', () => {
    for (const lt of ['\n', '\r', '\r\n', '\u{2028}', '\u{2029}']) {
      const source = `window.storyFormat({${lt}a:1,${lt}b:?});`;
      const read = readFormatObject(source);
      expect(read, JSON.stringify(lt)).toEqual({
        ok: false,
        reason: 'The story format file is not valid JavaScript: Unexpected token at line 3, column 3.',
      });
    }
    const source = `window.storyFormat({\ra:1,\u{2028}b:x});`;
    expect(readFormatObject(source)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('(line 3, column 3)'),
    });
  });

  it.each([
    ['an identifier', 'b', /Unsupported identifier "b"/],
    ['undefined (JS-5)', 'undefined', /Unsupported identifier "undefined"/],
    ['NaN (JS-5)', 'NaN', /Unsupported identifier "NaN"/],
    ['Infinity (JS-5)', '-Infinity', /Unsupported - expression/],
    ['a BigInt (JS-5)', '1n', /Unsupported BigInt/],
    ['a negative BigInt', '-1n', /Unsupported - expression/],
    ['a regular expression', '/a"}/g', /Unsupported regular expression/],
    ['an array hole (JS-5)', '[1,,2]', /Unsupported array hole at property value\[1\]/],
    ['an array spread', '[...[1]]', /Unsupported spread element at property value\[0\]/],
    ['a function in an array', '[function () {}]', /Unsupported function in an array at property value\[0\]/],
    ['a template literal with a substitution (JS-5)', '`a${1}b`', /Unsupported template literal with substitutions/],
    ['a tagged template', 'String.raw`a`', /Unsupported tagged template expression/],
    ['a concatenation', '"a" + "b"', /Unsupported binary expression/],
    ['a call', 'f()', /Unsupported call expression/],
    ['a sign before a string', '-"1"', /Unsupported - expression/],
    ['a double sign', '- -1', /Unsupported - expression/],
    ['another unary operator', '!0', /Unsupported ! expression/],
    ['void', 'void 0', /Unsupported void expression/],
    ['a sequence', '(1, 2)', /Unsupported sequence expression/],
    ['a conditional', 'true ? 1 : 2', /Unsupported conditional expression/],
    ['this', 'this', /Unsupported this expression/],
    ['a class', 'class {}', /Unsupported class expression/],
    ['a spread property', '{...{a: 1}}', /Unsupported spread property at property value/],
    ['a computed key', '{["a"]: 1}', /Unsupported computed property key at property value/],
    ['a getter', '{get a() { return 1; }}', /Unsupported getter at property value\.a/],
    ['a setter', '{set a(v) {}}', /Unsupported setter at property value\.a/],
    ['a shorthand property', '{a}', /Unsupported shorthand property at property value\.a/],
  ])('rejects %s with a diagnostic', (_label, literal, reason) => {
    expectRejected(literal, reason);
  });

  it.each([
    ['an unterminated string', '"b}', /Unterminated string constant at line 1/],
    ['a raw line break in a string', '"b\nc"', /Unterminated string constant at line 1/],
    ['an unterminated comment', '1 /* }', /Unterminated comment at line 1/],
    ['a missing comma', '{"a": 1 "b": 2}', /Unexpected token at line 1/],
    ['a short hexadecimal escape', '"\\x4"', /Bad character escape sequence at line 1/],
    ['a non-hexadecimal unicode escape', '"\\u12G4"', /Bad character escape sequence at line 1/],
    ['an unclosed braced unicode escape', '"\\u{41"', /Bad character escape sequence at line 1/],
    ['a code point beyond the Unicode range', '"\\u{110000}"', /Code point out of bounds at line 1/],
    ['a missing colon', '{"a" 1}', /Unexpected token at line 1/],
    ['a number glued to an identifier', '[1a]', /Identifier directly after number at line 1/],
    ['a signed property key (JS-5)', '{-1: 1}', /Unexpected token at line 1/],
    ['an unexpected character', '@', /Unexpected character '@' at line 1/],
    ['a separator in a legacy octal number', '01_0', /Numeric separator is not allowed/],
  ])('rejects %s as not valid JavaScript, as V8 does', (_label, literal, reason) => {
    expect(v8(literal)).toBeUndefined();
    expectRejected(literal, reason);
  });

  it('rejects a legacy octal escape in a strict-mode format.js, as V8 does', () => {
    const source = '"use strict"; window.storyFormat({version: "1.0.0", source: "\\101"});';
    expect(runFormatScript(source).ok).toBe(false);
    expect(readFormatObject(source)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Octal literal in strict mode/),
    });
  });
});

describe('format object literals compared with V8 (property-based)', () => {
  it('reads every generated literal value as V8 evaluates it', () => {
    fc.assert(
      fc.property(literalValue, (literal) => {
        expectAsV8(literal);
      }),
      { numRuns: 400 },
    );
  });

  it('reads every generated format object, with any wrapper around the call, as V8 does', () => {
    fc.assert(
      fc.property(
        fc.tuple(surroundingCode, storyFormatCallee, trivia, objectLiteral, trivia, surroundingCode),
        ([prelude, callee, before, object, after, postlude]) => {
          const source = `${prelude}\n${callee}(${before}${object}${after});\n${postlude}`;
          const run = runFormatScript(source);
          expect(run.ok, source).toBe(true);
          const calls = run.ok ? run.calls : [];
          expect(calls).toHaveLength(1);
          const read = readFormatObject(source);
          expect(read.ok && canonical(Object.fromEntries(read.fields)), source).toBe(canonical(calls[0]));
        },
      ),
      { numRuns: 300 },
    );
  });
});

/** An unsupported construct, and where in its text the node reported for it starts. */
interface Unsupported {
  readonly text: string;
  readonly at: number;
}

const unsupportedValue = fc.constantFrom<Unsupported>(
  { text: 'undefined', at: 0 },
  { text: 'NaN', at: 0 },
  { text: 'Infinity', at: 0 },
  { text: 'x', at: 0 },
  { text: '1n', at: 0 },
  { text: '0x1Fn', at: 0 },
  { text: '/a"}/g', at: 0 },
  { text: '1 + 1', at: 0 },
  { text: 'f()', at: 0 },
  { text: '`a${1}b`', at: 0 },
  { text: '-"1"', at: 0 },
  { text: '!0', at: 0 },
  { text: 'void 0', at: 0 },
  { text: '- -1', at: 0 },
  { text: '(1, 2)', at: 1 },
  { text: 'a ? 1 : 2', at: 0 },
  { text: 'new Date()', at: 0 },
  { text: 'this', at: 0 },
  { text: 'class {}', at: 0 },
  { text: 'String.raw`x`', at: 0 },
  { text: '[1,,2]', at: 0 },
  { text: '[...a]', at: 1 },
  { text: '[function () {}]', at: 1 },
  { text: 'a.b', at: 0 },
  { text: 'null ?? 1', at: 0 },
);

const unsupportedProperty = fc.constantFrom<Unsupported>(
  { text: '...{}', at: 0 },
  { text: '[k]: 1', at: 0 },
  { text: 'get a() { return 1; }', at: 0 },
  { text: 'set a(v) {}', at: 0 },
  { text: 'a', at: 0 },
  { text: '__proto__: {}', at: 0 },
  { text: '"__proto__": 1', at: 0 },
);

/** An unsupported construct placed in a property, possibly nested in arrays and objects. */
const placedUnsupported = fc.oneof(
  unsupportedProperty,
  fc.tuple(fc.constantFrom('k', '"k"', '1'), trivia, unsupportedValue).map(([key, gap, value]) => {
    const prefix = `${key}:${gap}`;
    return { text: prefix + value.text, at: prefix.length + value.at };
  }),
  fc.tuple(trivia, unsupportedValue).map(([gap, value]) => {
    const prefix = `k: [0, {n: ${gap}`;
    return { text: `${prefix}${value.text}}]`, at: prefix.length + value.at };
  }),
);

describe('format objects with an unsupported construct (property-based)', () => {
  it('never gives a value, and reports where the construct is', () => {
    fc.assert(
      fc.property(
        fc.tuple(surroundingCode, objectLiteral, placedUnsupported, trivia),
        ([prelude, object, unsupported, gap]) => {
          // Put the construct first in a generated object, so the generated properties follow it
          // (`{x,}` is valid: a trailing comma).
          const head = `${prelude}\nwindow.storyFormat({${gap}`;
          const source = `${head}${unsupported.text},${object.slice(1)});`;
          const read = readFormatObject(source);
          const { line, column } = getLineInfo(source, head.length + unsupported.at);
          expect(read, source).toEqual({
            ok: false,
            reason: expect.stringContaining(`(line ${line}, column ${column + 1})`),
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});

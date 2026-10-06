/**
 * The shared JavaScript reading helpers: one set of line terminators and one way to count
 * positions for every reader (#245 class C, #221), and acorn's syntax errors as results.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getLineInfo } from 'acorn';
import { LINE_TERMINATORS, describePosition, isLineTerminator, lineColumnFinder, lineEnd } from '../src/js-chars.js';
import { AcornParser, JsSyntaxError, SCRIPT_OPTIONS, parseScript, trySyntax } from '../src/js-syntax.js';

describe('line terminators', () => {
  it('are exactly the four ECMAScript ones', () => {
    const terminators = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).filter(
      isLineTerminator,
    );
    expect(terminators).toEqual(['\n', '\r', '\u{2028}', '\u{2029}']);
    expect(Array.from(LINE_TERMINATORS)).toEqual(terminators);
    // JavaScript's own `.` stops at the same four.
    expect(terminators.every((ch) => !/./.test(ch))).toBe(true);
    expect(isLineTerminator(undefined)).toBe(false);
    expect(isLineTerminator('\r\n')).toBe(false);
  });

  it('end a line wherever JavaScript ends one', () => {
    expect(lineEnd('ab\u{2029}c', 0)).toBe(2);
    expect(lineEnd('ab\r\nc', 1)).toBe(2);
    expect(lineEnd('abc', 1)).toBe(3);
  });
});

describe('lineColumnFinder', () => {
  const text = fc
    .array(fc.constantFrom('a', 'é', '\u{1F600}', '\n', '\r', '\r\n', '\u{2028}', '\u{2029}', ' '), { maxLength: 40 })
    .map((parts) => parts.join(''));

  it('counts lines and columns as acorn does, at every offset outside a CR LF pair', () => {
    fc.assert(
      fc.property(text, (source) => {
        const find = lineColumnFinder(source);
        for (let offset = 0; offset <= source.length; offset++) {
          if (source[offset - 1] === '\r' && source[offset] === '\n') continue;
          const acorn = getLineInfo(source, offset);
          expect(find(offset), `${JSON.stringify(source)} @${offset}`).toEqual({
            line: acorn.line,
            column: acorn.column + 1,
          });
        }
      }),
    );
  });

  it('describes a position for a message', () => {
    expect(describePosition(lineColumnFinder('a\r\nbc')(4))).toBe('line 2, column 2');
  });
});

describe('acorn syntax errors', () => {
  it("are results with acorn's message and the offsets it reported", () => {
    const read = parseScript('var a = 1;\nvar = 2;');
    expect(read).toEqual({ ok: false, error: expect.any(JsSyntaxError) });
    expect(!read.ok && [read.error.message, read.error.pos, read.error.raisedAt]).toEqual(['Unexpected token', 15, 16]);
  });

  it('include errors acorn reports as recoverable, such as an invalid regular expression', () => {
    const read = trySyntax(() => AcornParser.parse('x = /(/;', SCRIPT_OPTIONS));
    expect(!read.ok && read.error.message).toBe('Invalid regular expression: /(/: Unterminated group');
  });

  it('let any other error through', () => {
    expect(() =>
      trySyntax(() => {
        throw new TypeError('not a syntax error');
      }),
    ).toThrow(TypeError);
  });
});

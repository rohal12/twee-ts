/**
 * Diagnostics that quote a character of the input quote the whole character: a character outside the Basic
 * Multilingual Plane is one code point, never the first half of its surrogate pair, and a lone surrogate in the
 * input is written as `\uXXXX`. So every message is a well-formed string (#386).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseTwee } from '../src/parser.js';
import { validateIFID } from '../src/ifid.js';
import { parseScript } from '../src/js-syntax.js';
import { escapeLoneSurrogates, quotableCharacterAt } from '../src/source-text.js';

const VALID_UUID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

describe('quotableCharacterAt', () => {
  it.each([
    ['a BMP character', 'xay', 1, 'a'],
    ['a surrogate pair', 'x😀y', 1, '😀'],
    ['the second half of a pair', 'x😀y', 2, '\\uDE00'],
    ['a lone high surrogate', 'x\ud83dy', 1, '\\uD83D'],
    ['a lone low surrogate', 'x\ude00y', 1, '\\uDE00'],
    ['the end of the text', 'xy', 2, ''],
  ])('quotes %s', (_, text, index, expected) => {
    expect(quotableCharacterAt(text, index)).toBe(expected);
  });

  it('always gives a well-formed string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.nat(), (text, n) => {
        expect(quotableCharacterAt(text, n % (text.length + 1)).isWellFormed()).toBe(true);
      }),
    );
  });
});

describe('escapeLoneSurrogates', () => {
  it('keeps well-formed text as it is and makes any text well-formed', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(escapeLoneSurrogates(text)).toBe(text);
      }),
    );
    fc.assert(
      fc.property(fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)) }), (t) => {
        expect(escapeLoneSurrogates(t).isWellFormed()).toBe(true);
      }),
    );
  });
});

describe('the lexer quotes an illegal character whole', () => {
  it.each([
    ['a BMP character', ':: A [t] x\nbody', 'x'],
    ['a character outside the BMP', ':: A [t] 😀\nbody', '😀'],
    ['a lone surrogate', ':: A [t] \ud83d\nbody', '\\uD83D'],
  ])('%s', (_, source, quoted) => {
    expect(parseTwee(source).diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        message: `line 1: Malformed twee source; illegal character '${quoted}' amid the optional blocks.`,
      }),
    ]);
  });

  it('reports well-formed messages for any header', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (rest) => {
        const { diagnostics } = parseTwee(`:: A [t] ${rest}\nbody`);
        expect(diagnostics.every((d) => d.message.isWellFormed())).toBe(true);
      }),
    );
  });
});

describe('validateIFID quotes a character whole', () => {
  it.each([
    ['a separator', 8, '😀'],
    ['the version', 14, '😀'],
    ['the variant', 19, '😀'],
    ['a hex digit', 0, '😀'],
  ])('at %s', (_, index, character) => {
    // A pair takes two code units, so the IFID keeps its length with one character left out after it.
    const ifid = VALID_UUID.slice(0, index) + character + VALID_UUID.slice(index + 2);
    expect(validateIFID(ifid)).toContain(`'${character}' at position ${index + 1}`);
  });

  it('gives well-formed messages for any 36-character value', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', minLength: 36 }), (text) => {
        // Cut at 36 code units, which may split a pair.
        expect(validateIFID(text.slice(0, 36))?.isWellFormed() ?? true).toBe(true);
      }),
    );
  });
});

describe('JavaScript syntax errors quote a character whole', () => {
  it.each([
    ['a lone surrogate', 'a = 1;\n\ud83d b', "Unexpected character '\\uD83D'"],
    // Acorn reads a high surrogate at the end of the input as U+10000.
    ['a lone surrogate at the end', 'a = 1;\n\ud83d', "Unexpected character '\\uD83D'"],
    ['a lone low surrogate', 'a = 1;\n\ude00', "Unexpected character '\\uDE00'"],
    ['a character outside the BMP', 'a = 1;\n\u{1F600}', "Unexpected character '😀'"],
  ])('%s', (_, source, message) => {
    const read = parseScript(source);
    expect(read.ok ? '' : read.error.message).toBe(message);
  });
});

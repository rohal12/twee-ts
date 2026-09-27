import { describe, it, expect } from 'vitest';
import { SUBSTITUTION, evalStringLiteral, javaScriptStrings } from '../src/javascript-strings.js';

/** Small seeded generator, so the random cases are the same on every run. */
function makeRandom(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

describe('evalStringLiteral', () => {
  /** What strict-mode JavaScript, which SugarCube uses to evaluate a quoted argument, makes of it. */
  function strictEval(literal: string): string | undefined {
    try {
      return new Function(`"use strict"; return ${literal};`)() as string;
    } catch {
      return undefined;
    }
  }

  it('decodes quotes, backslashes and other escapes', () => {
    expect(evalStringLiteral(`"It's"`)).toBe("It's");
    expect(evalStringLiteral(`'Say "no"'`)).toBe('Say "no"');
    expect(evalStringLiteral(`"a\\"b"`)).toBe('a"b');
    expect(evalStringLiteral(`'a\\'b'`)).toBe("a'b");
    expect(evalStringLiteral(`"a\\\\b"`)).toBe('a\\b');
    expect(evalStringLiteral(`"\\u{1F600}\\u0041\\x41\\n\\q"`)).toBe('\u{1F600}AA\nq');
    expect(evalStringLiteral(`""`)).toBe('');
  });

  it('rejects what strict-mode JavaScript rejects', () => {
    expect(evalStringLiteral(`"\\1"`)).toBeUndefined();
    expect(evalStringLiteral(`"\\8"`)).toBeUndefined();
    expect(evalStringLiteral(`"\\00"`)).toBeUndefined();
    expect(evalStringLiteral(`"\\x4"`)).toBeUndefined();
    expect(evalStringLiteral(`"\\u{110000}"`)).toBeUndefined();
    expect(evalStringLiteral(`"a\rb"`)).toBeUndefined();
  });

  it('matches strict-mode JavaScript on random escapes', () => {
    const random = makeRandom(1956);
    const chars = [
      'a',
      'F',
      '0',
      '1',
      '7',
      '8',
      '9',
      'x',
      'u',
      '{',
      '}',
      'b',
      'n',
      'v',
      '"',
      "'",
      '\\',
      '\r',
      '\u2028',
      ' ',
    ];
    for (let i = 0; i < 20000; i++) {
      const quote = random(2) === 0 ? '"' : "'";
      // Build a literal SugarCube's lexer accepts: no raw newline, no unescaped closing quote,
      // and a backslash always followed by a character other than a newline.
      const length = random(8);
      let body = '';
      for (let j = 0; j < length; j++) {
        const ch = chars[random(chars.length)]!;
        body += random(2) === 0 || ch === quote || ch === '\\' ? `\\${ch}` : ch;
      }
      const literal = `${quote}${body}${quote}`;
      expect(evalStringLiteral(literal), JSON.stringify(literal)).toBe(strictEval(literal));
    }
  });
});

describe('javaScriptStrings', () => {
  it('decodes string literals', () => {
    expect(javaScriptStrings(`a = 'x'; b = "y\\n" + 'it\\'s';`)).toEqual(['x', 'y\n', "it's"]);
  });

  it('skips comments', () => {
    expect(javaScriptStrings(`// it's\n'a' /* "b" */ + 'c'`)).toEqual(['a', 'c']);
  });

  it('skips regular expressions, and tells them from division', () => {
    expect(javaScriptStrings(`s.replace(/'/g, "q")`)).toEqual(['q']);
    expect(javaScriptStrings(`x = a / b; y = 'c' / 2; z = (d) / 'e'`)).toEqual(['c', 'e']);
    expect(javaScriptStrings(`if (x) return /"[/"]/.test(s) ? 'd' : 'e';`)).toEqual(['d', 'e']);
    // After `x++`, a property named like a keyword, or a name with a non-ASCII letter, `/` divides.
    expect(javaScriptStrings(`n = x++ / 2; f('a'); m = y / 3;`)).toEqual(['a']);
    expect(javaScriptStrings(`n = a.return / 2 + g('b') / 1;`)).toEqual(['b']);
    expect(javaScriptStrings(`n = café / 2 + h('c') + 1 / 3;`)).toEqual(['c']);
  });

  it('keeps a template literal whole, marking each substitution', () => {
    expect(javaScriptStrings("t = `a${b + 'c'}d${ {x: '}'}.x }e`")).toEqual([
      'c',
      '}',
      `a${SUBSTITUTION}d${SUBSTITUTION}e`,
    ]);
    expect(javaScriptStrings('t = `x\\`y\r\nz`')).toEqual(['x`y\nz']);
    expect(javaScriptStrings('t = `outer ${`inner ${x}`} end`')).toEqual([
      `inner ${SUBSTITUTION}`,
      `outer ${SUBSTITUTION} end`,
    ]);
  });

  it('leaves out strings that are not closed on their line', () => {
    expect(javaScriptStrings(`a = 'x\nb = "y"`)).toEqual(['y']);
  });

  it('stays fast on malformed source', () => {
    const n = 40000;
    expect(javaScriptStrings('(/['.repeat(n))).toEqual([]);
    expect(javaScriptStrings("'" + "\\'".repeat(n))).toEqual([]);
    expect(javaScriptStrings('"' + '\\"'.repeat(n) + "\n'ok'")).toEqual(['ok']);
  });

  it('reads deeply nested template literals without running out of stack', () => {
    const depth = 20000;
    const source = '`${'.repeat(depth) + "'deep'" + '}`'.repeat(depth);
    expect(javaScriptStrings(source)).toContain('deep');
  });
});

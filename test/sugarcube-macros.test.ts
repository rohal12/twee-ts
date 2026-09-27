import { describe, it, expect } from 'vitest';
import { findMacroPassageLinks, findMacroTags, parseMacroArgs } from '../src/sugarcube-macros.js';
import type { MacroTag } from '../src/sugarcube-macros.js';

/** Small seeded generator, so the random cases are the same on every run. */
function makeRandom(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

function randomString(random: (n: number) => number, alphabet: readonly string[], maxLength: number): string {
  const length = random(maxLength + 1);
  return Array.from({ length }, () => alphabet[random(alphabet.length)]).join('');
}

/**
 * The pattern SugarCube 2.37.3 uses to find a macro tag (the macro parser's `lookahead`, with
 * `Patterns.macroName` filled in). It backtracks exponentially when no `>>` follows, so it is only
 * used here, on short strings, as the reference for `findMacroTags`.
 */
const SUGARCUBE_TAG_PATTERN =
  '<<(/?[A-Za-z][\\w-]*|[=-])(?:\\s*)((?:(?:/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*/)|(?://.*\\n)|(?:`(?:\\\\.|[^`\\\\])*`)|' +
  '(?:"(?:\\\\.|[^"\\\\])*")|(?:\'(?:\\\\.|[^\'\\\\])*\')|(?:\\[(?:[<>]?[Ii][Mm][Gg])?\\[[^\\r\\n]*?\\]\\]+)|[^>]|' +
  '(?:>(?!>)))*)>>';

/** Finds tags as SugarCube does: try the pattern at each `<<`; on a miss, move past the `<<`. */
function referenceTags(text: string): MacroTag[] {
  const re = new RegExp(SUGARCUBE_TAG_PATTERN, 'gm');
  const tags: MacroTag[] = [];
  let start = text.indexOf('<<');
  while (start !== -1) {
    re.lastIndex = start;
    const m = re.exec(text);
    if (m !== null && m.index === start && m[1]) {
      tags.push({ name: m[1], args: m[2] ?? '', start, end: re.lastIndex });
      start = text.indexOf('<<', re.lastIndex);
    } else {
      start = text.indexOf('<<', start + 2);
    }
  }
  return tags;
}

describe('findMacroTags', () => {
  it('finds tags, their names and their raw arguments', () => {
    expect(findMacroTags('a <<link "Go" "Next">>b<</link>>')).toEqual([
      { name: 'link', args: '"Go" "Next"', start: 2, end: 22 },
      { name: '/link', args: '', start: 23, end: 32 },
    ]);
  });

  it('does not end a tag at >> inside a quoted string, comment or link markup', () => {
    expect(findMacroTags(`<<a "x>>" 'y>>' \`z>>\` /* >> */ [[p>>q]]>>`).map((t) => t.args)).toEqual([
      `"x>>" 'y>>' \`z>>\` /* >> */ [[p>>q]]`,
    ]);
  });

  it('treats a quote as an ordinary character when no >> follows the closing quote', () => {
    // SugarCube's pattern backtracks here: the string "b>>c" would leave no >> to end the tag.
    expect(findMacroTags('<<a "b>>c"').map((t) => t.args)).toEqual(['"b']);
  });

  it('matches SugarCube 2.37.3 on random input', () => {
    const random = makeRandom(20260927);
    const alphabet = [
      '<',
      '<<',
      '>',
      '>>',
      '"',
      "'",
      '`',
      '\\',
      '/',
      '*',
      '[',
      ']',
      'img',
      'l',
      '=',
      ' ',
      '\n',
      '\r',
      '\t',
      '\u2028',
    ];
    for (let i = 0; i < 20000; i++) {
      const text = randomString(random, alphabet, 12);
      expect(findMacroTags(text), JSON.stringify(text)).toEqual(referenceTags(text));
    }
  });

  it('stays fast when no >> closes a tag', () => {
    // SugarCube's own pattern takes minutes on this; a script passage can contain `1<<n`.
    const text = 'var x = 1<<n; ' + 'f("a"); '.repeat(5000);
    expect(findMacroTags(text)).toEqual([]);
  });

  it('stays fast when a string, comment or markup runs past the last >>', () => {
    // Each escaped quote or opener inside such a part could start another scan to its end.
    const n = 50000;
    for (const text of [
      '<<a "' + '\\"'.repeat(n) + '>>"',
      "<<a '" + "\\'".repeat(n) + ">>'",
      '<<a `' + '\\`'.repeat(n) + '>>`',
      '<<a ' + '[['.repeat(n) + '>>]]',
      '<<a ' + '[img['.repeat(n) + '>>]]',
      '<<a ' + '/*'.repeat(n) + '>>*/',
      '<<a ' + '//'.repeat(n) + '>>\n',
    ]) {
      expect(findMacroTags(text)).toHaveLength(1);
    }
  });

  it('stays fast when many tags hold a part that runs past the last >>', () => {
    const n = 40000;
    expect(findMacroTags('<<a ">>' + '<<a \\">>'.repeat(n))).toHaveLength(n + 1);
    expect(findMacroTags('<<a [[>>'.repeat(n))).toHaveLength(n);
    expect(findMacroTags('<<a /*>>'.repeat(n))).toHaveLength(n);
  });
});

describe('parseMacroArgs', () => {
  it('reads quoted strings, with or without spaces between them', () => {
    expect(parseMacroArgs(`"a" 'b'`)).toEqual([
      { type: 'string', value: 'a' },
      { type: 'string', value: 'b' },
    ]);
    expect(parseMacroArgs(`"a""b"`)).toEqual([
      { type: 'string', value: 'a' },
      { type: 'string', value: 'b' },
    ]);
    expect(parseMacroArgs(`"a"\u180e"b"`)).toEqual([
      { type: 'string', value: 'a' },
      { type: 'string', value: 'b' },
    ]);
  });

  it('reads a bare word up to the next space, quotes included', () => {
    expect(parseMacroArgs(`a"b c"`)).toEqual([
      { type: 'string', value: 'a"b' },
      { type: 'string', value: 'c"' },
    ]);
  });

  it('reads numbers as SugarCube converts them', () => {
    expect(parseMacroArgs('42 0x10 -1 NaN')).toEqual([
      { type: 'number', value: 42 },
      { type: 'number', value: 16 },
      { type: 'number', value: -1 },
      { type: 'number', value: NaN },
    ]);
  });

  it('marks values known only in play, null and other values', () => {
    expect(parseMacroArgs('$x _y setup.z settings.w `1 + 1` `` true false undefined null')).toEqual([
      { type: 'other' },
      { type: 'other' },
      { type: 'other' },
      { type: 'other' },
      { type: 'other' },
      { type: 'other' },
      { type: 'other' },
      { type: 'other' },
      { type: 'other' },
      { type: 'null' },
    ]);
  });

  it('keeps words that only look like variables as text', () => {
    expect(parseMacroArgs('$ _1a setupx')).toEqual([
      { type: 'string', value: '$' },
      { type: 'string', value: '_1a' },
      { type: 'string', value: 'setupx' },
    ]);
  });

  it('reads link and image markup as one argument, and what follows it as the next', () => {
    expect(parseMacroArgs('[[a]]]]')).toEqual([{ type: 'markup' }, { type: 'string', value: ']]' }]);
    expect(parseMacroArgs('[[a|b]] [[a|b][$x to 1]] [img[x.png][Room]] "c"')).toEqual([
      { type: 'markup' },
      { type: 'markup' },
      { type: 'markup' },
      { type: 'string', value: 'c' },
    ]);
  });

  it('reads no arguments from an empty string', () => {
    expect(parseMacroArgs('')).toEqual([]);
    expect(parseMacroArgs('  \n ')).toEqual([]);
  });

  it('fails where SugarCube fails', () => {
    expect(parseMacroArgs(`"abc`)).toBeUndefined();
    expect(parseMacroArgs(`"a\nb"`)).toBeUndefined();
    expect(parseMacroArgs(`"a\\\nb"`)).toBeUndefined();
    expect(parseMacroArgs('`abc')).toBeUndefined();
    expect(parseMacroArgs('[x]')).toBeUndefined();
    expect(parseMacroArgs('[[a|b]')).toBeUndefined();
    expect(parseMacroArgs('[[a]x]]')).toBeUndefined();
    expect(parseMacroArgs(`"\\1"`)).toBeUndefined();
  });
});

describe('findMacroPassageLinks', () => {
  it('stays fast when many comments, markup or elements are never closed', () => {
    const n = 40000;
    for (const opener of [
      '/* ',
      '/% ',
      '<!-- ',
      '[[a ',
      '[img[ ',
      '""" ',
      '{{{ ',
      '{{{\n',
      '<nowiki>',
      '<html>',
      '<script>',
      '<style>',
      '<<script>>',
    ]) {
      expect(findMacroPassageLinks(opener.repeat(n) + '<<goto "A">>'), opener).toEqual([
        { macro: 'goto', passage: 'A' },
      ]);
    }
  });

  it('stays fast when stray openers in comments run over many <<script>> openers', () => {
    const n = 40000;
    expect(findMacroPassageLinks('/* <<x " */<<script>>'.repeat(n) + '" >><<goto "A">>')).toEqual([
      { macro: 'goto', passage: 'A' },
    ]);
  });

  it('stays fast when a <<script>> closer search meets unclosed comments and long lines', () => {
    const n = 20000;
    const blocks = [
      '<!-- <<x " -->\n<<script>>\n<<y /*>>\n" >>\n',
      '<!-- <<x " -->\n<<script>>\n<<y //>>" >>',
      '/* <<x " */<<script>><<y //>> " >>',
      '/* <<x " */<<script>>' + '<<1'.repeat(30),
    ];
    for (const block of blocks) {
      expect(findMacroPassageLinks(block.repeat(n) + '" >><<goto "A">>'), block).toContainEqual({
        macro: 'goto',
        passage: 'A',
      });
    }
  });

  it('stays fast when each <<script>> closer search meets a long tag name, spaces or text', () => {
    // Every <<script>> here needs its own closer search, and each would read the long part again,
    // unless the search's limit counts it.
    const size = 3_000_000;
    const openers = Math.floor(Math.sqrt(2 * (4 * size + 100_000)));
    for (const long of [
      '<<a' + ' '.repeat(size) + '>>',
      '<<' + 'a'.repeat(size) + '>>',
      '<<a b' + ' '.repeat(size) + '>>',
      '<'.repeat(size),
      '">>' + ' '.repeat(size),
    ]) {
      const text = '/*<<x */"' + '<<script>>'.repeat(openers) + long + '">><<goto "A">>';
      expect(findMacroPassageLinks(text)).toContainEqual({ macro: 'goto', passage: 'A' });
    }
  });

  it('returns very many calls from one element without failing', () => {
    const n = 200000;
    expect(findMacroPassageLinks('<script>' + `x('<<goto "A">>');`.repeat(n) + '</script>')).toHaveLength(n);
  });
});

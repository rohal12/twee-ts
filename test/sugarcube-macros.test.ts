import { describe, it, expect } from 'vitest';
import {
  findJavaScriptPassageLinks,
  findMacroPassageLinks,
  findMacroTags,
  parseMacroArgs,
  scriptBodyCloser,
  tagMatcher,
} from '../src/sugarcube-macros.js';
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
  }, 20_000);

  it('stays fast when many tags hold a part that runs past the last >>', () => {
    const n = 40000;
    expect(findMacroTags('<<a ">>' + '<<a \\">>'.repeat(n))).toHaveLength(n + 1);
    expect(findMacroTags('<<a [[>>'.repeat(n))).toHaveLength(n);
    expect(findMacroTags('<<a /*>>'.repeat(n))).toHaveLength(n);
  }, 20_000);
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
  }, 20_000);

  it('stays fast when stray openers in comments run over many <<script>> openers', () => {
    const n = 40000;
    expect(findMacroPassageLinks('/* <<x " */<<script>>'.repeat(n) + '" >><<goto "A">>')).toEqual([
      { macro: 'goto', passage: 'A' },
    ]);
  }, 20_000);

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
  }, 20_000);

  it('stays fast when each <<script>> closer search meets a long tag name, spaces or text', () => {
    // Every <<script>> here needs its own closer search, and each would read the long part again,
    // unless the search's limit counts it. (The counting itself is tested below.)
    const size = 300_000;
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
  }, 20_000);

  it('returns very many calls from one element without failing', () => {
    const n = 200000;
    expect(findMacroPassageLinks('<script>' + `x('<<goto "A">>');`.repeat(n) + '</script>')).toHaveLength(n);
  }, 20_000);
});

describe('the <<script>> closer search limit', () => {
  /** How many characters the tag matcher says it read to match a tag at `start`. */
  function work(text: string, start = 0): number {
    let characters = 0;
    tagMatcher(text, undefined, (read) => {
      characters += read;
    })(start);
    return characters;
  }

  it('counts every character a tag match reads', () => {
    const size = 10_000;
    // The name, the spaces after it, each character stepped over, and a part scanned to its end.
    expect(work('<<' + 'a'.repeat(size) + '>>')).toBeGreaterThanOrEqual(size);
    expect(work('<<a' + ' '.repeat(size) + '>>')).toBeGreaterThanOrEqual(size);
    expect(work('<<a b' + ' '.repeat(size) + '>>')).toBeGreaterThanOrEqual(size);
    expect(work('<<a /*' + ' '.repeat(size) + '>>')).toBeGreaterThanOrEqual(size);
    // A << that starts no tag counts too.
    expect(work('<<<')).toBeGreaterThan(0);
  });

  it('counts the text between tags when it scans from a body', () => {
    const gap = 10_000;
    // The tag <<x runs over the <<script>> opener, so its body is scanned on its own.
    const text = '/*<<x */"<<script>>' + ' '.repeat(gap) + '<</script>>';
    const start = text.indexOf('<<script>>');
    const opener = { name: 'script', args: '', start, end: start + 10 };
    expect(findMacroTags(text).some((tag) => tag.start === start)).toBe(false);
    const budget = { left: 4 * gap };
    expect(scriptBodyCloser(text, budget)(opener)?.name).toBe('/script');
    expect(budget.left).toBeLessThanOrEqual(3 * gap);
  });
});

describe('findJavaScriptPassageLinks', () => {
  it('reads a call whose << an escape makes', () => {
    const source = [
      String.raw`f('<<goto "G">>');`,
      String.raw`f('<\<goto "A">>');`,
      String.raw`f('\x3c<goto "B">>');`,
      String.raw`f('\u003C<goto "C">>');`,
      String.raw`f('\u{3c}<goto "D">>');`,
      'f(\'<\\\n<goto "E">>\');',
      String.raw`f('\<<goto "F">>');`,
    ];
    for (const [index, line] of source.entries()) {
      expect(findJavaScriptPassageLinks(line), line).toEqual([{ macro: 'goto', passage: 'GABCDEF'[index] }]);
    }
  });

  it('reads a call in a <script> element that a string holds', () => {
    // The outer string's \x5c is a backslash, so the element's own string reads \x3c<goto S>>.
    const source = String.raw`jQuery(document.body).wiki('<script>$.wiki("\x5cx3c<goto S>>")</script>');`;
    expect(findJavaScriptPassageLinks(source)).toEqual([{ macro: 'goto', passage: 'S' }]);
  });
});

/**
 * `javaScriptStrings` against acorn's full parse as the oracle (#245 JS-7): source that parses is
 * read exactly as ECMAScript reads it, whatever comes before a `/`; source that does not parse is
 * read by acorn's tokenizer, with the recovery rules stated in `src/javascript-strings.ts`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import type { AnyNode, Options } from 'acorn';
import { SUBSTITUTION, evalStringLiteral, javaScriptStrings } from '../src/javascript-strings.js';
import { findJavaScriptPassageLinks, findPassageLinks } from '../src/sugarcube-macros.js';
import { storyInspect } from '../src/inspect.js';
import { parseTwee } from '../src/parser.js';
import { StoryBuilder } from '../src/story.js';
import { evaluateJavaScript } from './helpers/javascript.js';
import { lineTerminator, stringLiteral, templateLiteral } from './helpers/js-arbitraries.js';

const ORACLE_OPTIONS: Options = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
  allowImportExportEverywhere: true,
  checkPrivateFields: false,
};

function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

/** What strict-mode JavaScript makes of a string literal, or undefined if it rejects it. */
function strictValue(raw: string): string | undefined {
  try {
    const value = evaluateJavaScript(`"use strict"; return ${raw};`);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The oracle: the string and template literal values of a full parse, in the order they end, or
 * undefined if the source does not parse.
 */
function astStrings(source: string, mode: 'strict' | 'sloppy' = 'strict'): string[] | undefined {
  let program;
  try {
    program = parse(source, ORACLE_OPTIONS);
  } catch {
    return undefined;
  }
  const found: { end: number; value: string }[] = [];
  const pending: AnyNode[] = [program];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      const value = mode === 'strict' ? strictValue(node.raw ?? '') : node.value;
      if (value !== undefined) found.push({ end: node.end, value });
    } else if (node.type === 'TemplateLiteral') {
      const cooked = node.quasis.map((quasi) => quasi.value.cooked);
      if (cooked.every((piece) => typeof piece === 'string'))
        found.push({ end: node.end, value: cooked.join(SUBSTITUTION) });
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) pending.push(...child.filter(isNode));
      else if (isNode(child)) pending.push(child);
    }
  }
  return found.sort((a, b) => a.end - b.end).map((f) => f.value);
}

/** A stray `@` after the source: the parse fails there, and all of the source is read exactly. */
const brokenAfter = (source: string): string => `${source}\n@`;

/** A stray `@` before the source: the parse fails at once, and all of it is read by the tokenizer. */
const brokenBefore = (source: string): string => `@\n${source}`;

/** Regular expression literals holding the characters a naive scanner misreads. */
const TRICKY_REGEXES = [
  '/"/',
  "/'/",
  '/`/',
  '/[/*]/',
  '/\\/*/',
  '/}"/g',
  '/{/',
  '/"<<goto \'Phantom\'>>"/',
  '/[\\]"]/',
];

/** The confirmed cases of JS-7, with the string after the regular expression or division. */
const JS7_CASES: Readonly<Record<string, string>> = {
  'a regular expression after the ) of an if': 'if (x) /"/.test(s); var a = "<<goto \'A\'>>";',
  'a regular expression after the ) of a while': 'while (a) /"/g.exec(b); var c = "<<goto \'Z\'>>";',
  'a regular expression after a block': '{}\n/"/.test(s); var a = "<<goto \'A\'>>";',
  'a regular expression after a function declaration': 'function f(){}\n/"/.test(x); var c = "<<goto \'Z\'>>";',
  'a regular expression after an arrow function body': 'f = () => {}\n/"/.test(x); s = "<<goto \'Z\'>>";',
  'a regular expression with a single quote after an if': "if (a) /'/.test(b); var c = '<<goto \"Z\">>';",
  'a division after an identifier named of': 'var of = 4, g = 2; x = of / g; y = "a/b";',
  'a division after a number ending in a dot': 'x = 1./2; y = "<<goto \'A/B\'>>";',
};

describe('javaScriptStrings tells regular expressions from division as ECMAScript does (JS-7)', () => {
  for (const [label, source] of Object.entries(JS7_CASES)) {
    it(`reads ${label}`, () => {
      const expected = astStrings(source);
      expect(expected).toBeDefined();
      expect(javaScriptStrings(source)).toEqual(expected);
      // Acorn's tokenizer also gets these right when the source does not parse.
      expect(javaScriptStrings(brokenAfter(source))).toEqual(expected);
      expect(javaScriptStrings(brokenBefore(source))).toEqual(expected);
    });
  }

  it('finds no phantom link in a regular expression, and misses no link after one, end to end', () => {
    const brokenLinks = (script: string): string[] => {
      const twee = `:: StoryTitle\nT\n\n:: Start\nHi\n\n:: Code [script]\n${script}\n`;
      const builder = new StoryBuilder();
      for (const passage of parseTwee(twee).passages) builder.add(passage, []);
      return storyInspect(builder.build()).brokenLinks.map((link) => link.to);
    };
    expect(brokenLinks(`if (ok) /"/.test(s); $.wiki("<<goto 'Missing'>>");`)).toEqual(['Missing']);
    expect(brokenLinks(`if (ok) /"<<goto 'Phantom'>>"/.test(s);`)).toEqual([]);
    expect(brokenLinks(`function f() {}\n/"<<goto 'Phantom'>>"/.test(s);`)).toEqual([]);
    expect(brokenLinks(`var of = 4, g = 2; x = of / g; $.wiki("<<goto 'Mi/ssing'>>")`)).toEqual(['Mi/ssing']);
    expect(brokenLinks(`if (ok) /'/.test(s);\n$.wiki('<<goto "Missing">>');`)).toEqual(['Missing']);
  });
});

/** Code before which, after which, or around which a `/` is ambiguous to a token-level reader. */
const tokenizerStatement = fc.oneof(
  fc
    .tuple(fc.constantFrom(...TRICKY_REGEXES), stringLiteral)
    .chain(([regex, string]) =>
      fc.constantFrom(
        `if (a) ${regex}.test(${string});`,
        `while (a) ${regex}.exec(${string});`,
        `for (;;) ${regex}.test(${string});`,
        `function f() {}\n${regex}.test(${string});`,
        `{}\n${regex}.test(${string});`,
        `x = () => {}\n${regex}.test(${string});`,
        `do ${regex}.test(${string}); while (a);`,
        `return ${regex}.test(${string});`,
        `x = typeof ${regex} + ${string};`,
        `x = a ? ${regex} : ${string};`,
        `x = [${regex}, ${string}];`,
        `x = {a: ${regex}, b: ${string}};`,
        `x = !${regex}.test(${string});`,
        `x = \`\${${regex}.source}\${${string}}\`;`,
        `case1: ${regex}.test(${string});`,
        `if (a) {} else ${regex}.test(${string});`,
      ),
    ),
  stringLiteral.chain((string) =>
    fc.constantFrom(
      `x = a / b / ${string};`,
      `x = (a) / 2 / ${string}.length;`,
      `x = a[0] / 2 / ${string}.length;`,
      `x = a++ / 2 / ${string}.length;`,
      `x = a.return / 2 / ${string}.length;`,
      `x = 1. / 2 / ${string}.length;`,
      `var of = 4, g = 2; x = of / g / ${string}.length;`,
      `x = {}.a / 2 / ${string}.length;`,
      `x = this / 2 / ${string}.length;`,
      `x = \`a\` / 2 / ${string}.length;`,
      `x = 10n / 2n; y = ${string};`,
      `x = 1_000 / 2 / ${string}.length;`,
      `x = a?.b / 2 / ${string}.length;`,
      `x = { m() { return this.x / 2 / ${string}.length; } };`,
    ),
  ),
  templateLiteral.map((template) => `x = ${template};`),
  fc.tuple(stringLiteral, stringLiteral).map(([a, b]) => `x = \`a\${${a} + \`b\${${b}}c\`}d\`;`),
  fc
    .tuple(fc.constantFrom('// ', '/* ', '<!-- '), fc.constantFrom('"', "'", '`', '/*', '{'), lineTerminator)
    .map(([open, text, lt]) => (open === '/* ' ? `${open}${text} */${lt}` : `${open}${text}${lt}`)),
  fc.tuple(lineTerminator, fc.constantFrom('"', "'", '`', '{')).map(([lt, text]) => `${lt}--> ${text}${lt}`),
);

/**
 * Statements acorn's tokenizer reads wrongly on its own, without a parse: a block statement after
 * a class declaration (it takes the block for an object), and `await` before a regular expression
 * (it takes `await` for a name). Only source that does not parse up to them is read that way.
 */
const TOKENIZER_LIMITS: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  'a block after a class declaration': ['class A {}\n{}\n/"/.test(s); x = "a"', ['/.test(s); x = ']],
  'await before a regular expression': ['async function f() { await /"/.test(s); x = "a"; }', ['/.test(s); x = ']],
};

const statement = fc.oneof(
  { weight: 9, arbitrary: tokenizerStatement },
  { weight: 1, arbitrary: fc.constantFrom(...Object.values(TOKENIZER_LIMITS).map(([source]) => source)) },
  stringLiteral.map((string) => `class A { #x = 1; m() { return this.#x / 2 / ${string}.length; } }`),
);

const program = fc.array(statement, { minLength: 1, maxLength: 6 }).map((statements) => statements.join('\n'));
const tokenizerProgram = fc
  .array(tokenizerStatement, { minLength: 1, maxLength: 6 })
  .map((statements) => statements.join('\n'));

describe('javaScriptStrings compared with a full parse (property-based)', () => {
  it('reads every generated program exactly as the parse does', () => {
    fc.assert(
      fc.property(program, (source) => {
        const expected = astStrings(source);
        fc.pre(expected !== undefined);
        expect(javaScriptStrings(source), source).toEqual(expected);
      }),
      { numRuns: 3000 },
    );
  });

  it('reads the code before a syntax error exactly', () => {
    fc.assert(
      fc.property(program, (source) => {
        const expected = astStrings(source);
        fc.pre(expected !== undefined);
        expect(javaScriptStrings(brokenAfter(source)), source).toEqual(expected);
      }),
      { numRuns: 1000 },
    );
  });

  it('reads code after a syntax error with the tokenizer as the parse does, within its stated limits', () => {
    fc.assert(
      fc.property(tokenizerProgram, (source) => {
        const expected = astStrings(source);
        fc.pre(expected !== undefined);
        expect(javaScriptStrings(brokenBefore(source)), source).toEqual(expected);
      }),
      { numRuns: 3000 },
    );
  });

  it.each(Object.entries(TOKENIZER_LIMITS))("states the tokenizer's limit: %s", (_label, [source, misread]) => {
    expect(javaScriptStrings(source)).toEqual(['a']);
    expect(javaScriptStrings(brokenAfter(source))).toEqual(['a']);
    expect(javaScriptStrings(brokenBefore(source))).toEqual(misread);
  });

  it('reads sloppy-mode strings with legacy octal escapes in sloppy mode only', () => {
    fc.assert(
      fc.property(program, (source) => {
        const expected = astStrings(source, 'sloppy');
        fc.pre(expected !== undefined);
        expect(javaScriptStrings(source, 'sloppy'), source).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('reads real JavaScript files as the parse does, through both paths', () => {
    const require = createRequire(import.meta.url);
    for (const name of ['acorn', 'fast-check', 'prettier']) {
      const file = require.resolve(name);
      const source = readFileSync(file, 'utf8');
      const expected = astStrings(source) ?? [];
      expect(expected.length, file).toBeGreaterThan(10);
      expect(javaScriptStrings(source), file).toEqual(expected);
      expect(javaScriptStrings(brokenAfter(source)), file).toEqual(expected);
      expect(javaScriptStrings(brokenBefore(source)), file).toEqual(expected);
    }
  });
});

describe('javaScriptStrings on source that does not parse', () => {
  it.each([
    ['TwineScript, read token by token', '$x to "<<goto \'A\'>>" is $y', ["<<goto 'A'>>"]],
    ['an unexpected character, skipped alone', '@x("a") # "b"', ['a', 'b']],
    ['an unexpected character outside the BMP, skipped whole', '\u{1F600}"a" \u{1F600}"b"', ['a', 'b']],
    ['an unterminated string: the rest of its line is skipped', `'a "b" c\n"d"`, ['d']],
    ['an unterminated string at a CRLF line end', `'a "b" c\r\n"d"`, ['d']],
    ['an unterminated string, which may hold a line separator', `'a "b" c\u{2028}"d"`, []],
    ['an unterminated regular expression', 'x = /abc "q"\ny = "kept"', ['kept']],
    ['a bad escape', 'x = "\\x4" + "q"\n"kept"', ['kept']],
    ['an invalid regular expression', 'x = /(/ + "q"\n"kept"', ['kept']],
    ['an unterminated block comment: nothing after it is read', '"a" /* "b"\n"c"', ['a']],
    ['an unterminated template: nothing after it is read', '"a"; `b ${"c"} d\n"e"', ['a', 'c']],
    ['an unclosed substitution at the end', '`abc${ "x"', ['x']],
    ['a stray closing brace', '} "kept"', ['kept']],
    ['an untagged template with a bad escape', '`a\\1b`; "kept"', ['kept']],
  ])('reads %s', (_label, source, expected) => {
    expect(astStrings(source)).toBeUndefined();
    expect(javaScriptStrings(source)).toEqual(expected);
  });

  it('leaves out a tagged template whose escape no string may hold', () => {
    expect(javaScriptStrings('tag`\\unicode`; "kept"')).toEqual(['kept']);
    expect(javaScriptStrings(brokenBefore('tag`\\unicode`; "kept"'))).toEqual(['kept']);
  });

  it('keeps a template literal open across TwineScript in its substitution', () => {
    expect(javaScriptStrings('x = `${$x is 1} "<<goto \'A\'>>"`;')).toEqual([`${SUBSTITUTION} "<<goto 'A'>>"`]);
  });

  it('starts each line after an error with nothing open', () => {
    expect(javaScriptStrings('x = `a ${ "b" + \'c\n"d" }`')).toEqual(['b', 'd']);
  });

  it('takes linear time on source built to restart the tokenizer often', { timeout: 120_000 }, () => {
    const n = 50_000;
    for (const source of ["'\n".repeat(n), '@'.repeat(n), '@a'.repeat(n), 'x = /[\n'.repeat(n), '"\\x"\n'.repeat(n)]) {
      const start = performance.now();
      javaScriptStrings(source);
      // A fraction of a second each on a laptop; reading quadratically would take a minute or more.
      expect(performance.now() - start, JSON.stringify(source.slice(0, 8))).toBeLessThan(20_000);
    }
  });
});

describe('strict and sloppy mode', () => {
  it('reads exactly one string literal and nothing around it', () => {
    for (const text of ['"a" + "b"', '"a"; x', ' "a"', '"a" ', 'a', '`a`']) {
      expect(evalStringLiteral(text), text).toBeUndefined();
    }
  });

  it('reads legacy octal escapes and \\8 only in sloppy mode', () => {
    expect(javaScriptStrings(`a = '\\101'; b = "\\8"; c = 'ok'`, 'sloppy')).toEqual(['A', '8', 'ok']);
    expect(javaScriptStrings(`a = '\\101'; b = "\\8"; c = 'ok'`, 'strict')).toEqual(['ok']);
    expect(javaScriptStrings(`a = '\\101'; b = "\\8"; c = 'ok'`)).toEqual(['ok']);
    expect(evalStringLiteral(`'\\101'`, 'sloppy')).toBe('A');
    expect(evalStringLiteral(`'\\101'`)).toBeUndefined();
  });

  it('reads a <script> element as sloppy-mode code, and Story JavaScript as strict-mode code', () => {
    const call = `$.wiki('\\74\\74goto "Octal">>');`;
    expect(findPassageLinks(`<script>${call}</script>`)).toEqual([{ via: 'goto', passage: 'Octal' }]);
    expect(findPassageLinks(`<<script>>${call}<</script>>`)).toEqual([]);
    expect(findJavaScriptPassageLinks(call)).toEqual([]);
    expect(findPassageLinks(`<script>$.wiki('\\133\\133Room]]')</script>`)).toEqual([
      { via: 'markup', passage: 'Room' },
    ]);
  });
});

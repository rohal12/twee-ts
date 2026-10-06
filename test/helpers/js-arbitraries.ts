/**
 * fast-check arbitraries for JavaScript source text: trivia of every kind the Script goal allows,
 * string, template and numeric literals in every spelling, identifiers, and the object literals
 * built from them that a story format passes to `storyFormat()`. Every generated text is valid
 * sloppy-mode JavaScript; what it means is left to the oracle (V8 or acorn) to say.
 */
import fc from 'fast-check';

/** The ECMAScript line terminators, CR LF included. */
const LINE_TERMINATORS = ['\n', '\r', '\r\n', '\u{2028}', '\u{2029}'] as const;

/** ECMAScript white space: TAB, VT, FF, SP, NBSP, ZWNBSP and a sample of the Zs category. */
const WHITE_SPACE = [
  '\t',
  '\v',
  '\f',
  ' ',
  '\u{a0}',
  '\u{feff}',
  '\u{1680}',
  '\u{2000}',
  '\u{2005}',
  '\u{200a}',
  '\u{202f}',
  '\u{205f}',
  '\u{3000}',
] as const;

export const lineTerminator = fc.constantFrom(...LINE_TERMINATORS);
const whiteSpace = fc.constantFrom(...WHITE_SPACE);

/** Comment text that may look like code, strings or other comments, but has no line terminator. */
const commentText = fc
  .array(
    fc.constantFrom(
      'a',
      ' ',
      '{',
      '}',
      '(',
      ')',
      '"',
      "'",
      '`',
      '/',
      '*',
      '<!--',
      '-->',
      ',',
      ':',
      'é',
      '\\',
      'storyFormat({',
    ),
    {
      maxLength: 6,
    },
  )
  .map((parts) => parts.join(''))
  .filter((text) => !text.includes('*/'));

/** A block comment's text, which may span lines. */
const blockCommentText = fc
  .array(fc.oneof(commentText, lineTerminator), { maxLength: 4 })
  .map((parts) => parts.join(''))
  .filter((text) => !text.includes('*/') && !text.endsWith('*'));

/** One piece of trivia: white space, a line terminator, or a comment of any kind (Annex B included). */
const triviaPiece = fc.oneof(
  whiteSpace,
  lineTerminator,
  fc.tuple(commentText, lineTerminator).map(([text, lt]) => `//${text}${lt}`),
  blockCommentText.map((text) => `/*${text}*/`),
  fc.tuple(commentText, lineTerminator).map(([text, lt]) => `<!--${text}${lt}`),
  // `-->` starts a comment only at the start of a line.
  fc.tuple(lineTerminator, commentText, lineTerminator).map(([before, text, after]) => `${before}-->${text}${after}`),
);

/** Trivia between two tokens: often nothing, sometimes several pieces. */
export const trivia = fc.oneof(
  { weight: 2, arbitrary: fc.constant('') },
  { weight: 3, arbitrary: fc.array(triviaPiece, { minLength: 1, maxLength: 3 }).map((pieces) => pieces.join('')) },
);

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
const caseOf = (text: string, upper: boolean): string => (upper ? text.toUpperCase() : text);

/** A character spelled as an escape, or a line continuation, valid in a sloppy-mode string literal. */
const stringEscape = fc.oneof(
  fc.constantFrom(
    '\\n',
    '\\t',
    '\\b',
    '\\f',
    '\\v',
    '\\r',
    '\\0',
    '\\\\',
    '\\"',
    "\\'",
    '\\a',
    '\\/',
    '\\8',
    '\\9',
    '\\$',
  ),
  fc.tuple(fc.integer({ min: 0, max: 0xff }), fc.boolean()).map(([n, upper]) => `\\x${caseOf(hex(n, 2), upper)}`),
  fc.tuple(fc.integer({ min: 0, max: 0xffff }), fc.boolean()).map(([n, upper]) => `\\u${caseOf(hex(n, 4), upper)}`),
  fc
    .tuple(fc.integer({ min: 0, max: 0x10ffff }), fc.integer({ min: 0, max: 3 }))
    .map(([n, zeros]) => `\\u{${'0'.repeat(zeros)}${hex(n, 1)}}`),
  // Legacy octal escapes, written with three digits so that no digit after them joins in.
  fc.integer({ min: 0, max: 0o377 }).map((n) => `\\${n.toString(8).padStart(3, '0')}`),
  lineTerminator.map((lt) => `\\${lt}`),
);

/** Any single code point, lone surrogates included. */
const anyCodePoint = fc.oneof(
  fc.integer({ min: 0x20, max: 0x7e }).map((n) => String.fromCharCode(n)),
  fc.integer({ min: 0, max: 0x10ffff }).map((n) => String.fromCodePoint(n)),
  fc.integer({ min: 0xd800, max: 0xdfff }).map((n) => String.fromCharCode(n)),
  fc.constantFrom('{', '}', '"', "'", '`', '/', '*', ',', ':', '\u{2028}', '\u{2029}', '\u{feff}', '<!--', '-->'),
);

/** A string literal, quoted either way, with characters written raw or escaped. */
export const stringLiteral = fc
  .tuple(fc.constantFrom('"', "'"), fc.array(fc.oneof(anyCodePoint, stringEscape), { maxLength: 8 }))
  .map(([quote, parts]) => {
    const body = parts
      .map((part) => {
        if (part === quote || part === '\\') return `\\${part}`;
        // A raw line feed or carriage return would end the literal.
        if (part === '\n' || part === '\r') return part === '\n' ? '\\n' : '\\r';
        return part;
      })
      .join('');
    return `${quote}${body}${quote}`;
  });

/** A template literal without substitutions: raw line breaks, `$` and escapes included. */
export const templateLiteral = fc
  .array(
    fc.oneof(
      anyCodePoint,
      lineTerminator,
      fc.constantFrom('\\n', '\\`', '\\\\', '\\$', '\\${', '$', '\\x41', '\\u{1F600}', '\\u0041', '\\0'),
      lineTerminator.map((lt) => `\\${lt}`),
    ),
    { maxLength: 8 },
  )
  .map((parts) => {
    const body = parts
      // A raw `$` could start a substitution with a `{` after it.
      .map((part) => (part === '`' || part === '\\' || part === '$' ? `\\${part}` : part))
      .join('')
      // `\0` before a digit is not allowed in a template.
      .replace(/\\0(?=[0-9])/g, '\\x00');
    return `\`${body}\``;
  });

const digits = (min: number, alphabet: string): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...Array.from(alphabet)), { minLength: min, maxLength: 6 }).chain((ds) =>
    // Numeric separators go between two digits.
    fc
      .array(fc.boolean(), { minLength: ds.length, maxLength: ds.length })
      .map((separators) => ds.map((d, i) => (i > 0 && separators[i] === true ? `_${d}` : d)).join('')),
  );

const decimalDigits = (min: number): fc.Arbitrary<string> => digits(min, '0123456789');
const decimalInteger = fc.oneof(
  fc.constant('0'),
  fc
    .tuple(fc.constantFrom(...Array.from('123456789')), decimalDigits(0))
    .map(([first, rest]) => first + (rest.startsWith('_') ? rest.slice(1) : rest)),
);
const exponent = fc.option(
  fc
    .tuple(fc.constantFrom('e', 'E'), fc.constantFrom('', '+', '-'), decimalDigits(1))
    .map(([e, sign, ds]) => e + sign + ds),
  { nil: '' },
);

/** A numeric literal (no sign) in any notation the Script goal allows, BigInts aside. */
const numericLiteral = fc.oneof(
  fc.tuple(decimalInteger, exponent).map(([int, exp]) => int + exp),
  fc.tuple(decimalInteger, decimalDigits(0), exponent).map(([int, frac, exp]) => `${int}.${frac}${exp}`),
  fc.tuple(decimalDigits(1), exponent).map(([frac, exp]) => `.${frac}${exp}`),
  fc.tuple(fc.constantFrom('0x', '0X'), digits(1, '0123456789abcdefABCDEF')).map(([p, ds]) => p + ds),
  fc.tuple(fc.constantFrom('0o', '0O'), digits(1, '01234567')).map(([p, ds]) => p + ds),
  fc.tuple(fc.constantFrom('0b', '0B'), digits(1, '01')).map(([p, ds]) => p + ds),
  // Legacy octal integers, and decimal integers with a leading zero (sloppy mode only).
  fc.array(fc.constantFrom(...Array.from('01234567')), { minLength: 1, maxLength: 4 }).map((ds) => `0${ds.join('')}`),
  fc
    .tuple(
      fc.array(fc.constantFrom(...Array.from('0123456789')), { maxLength: 3 }),
      fc.constantFrom('8', '9'),
      exponent,
    )
    .map(([ds, big, exp]) => `0${ds.join('')}${big}${exp}`),
  fc.constantFrom('1e400', '5e-324', '0.1', '9007199254740993', '0x1fffffffffffff1'),
);

/** A number with an optional `-` or `+` sign, which trivia may follow. */
const signedNumber = fc
  .tuple(fc.constantFrom('', '-', '+'), trivia, numericLiteral)
  .map(([sign, gap, number]) => (sign === '' ? number : sign + gap + number));

const identifierStart = fc.constantFrom(...Array.from('abcxyzAZ_$'), 'é', 'ü', 'ʰ', 'ℵ', '㐀', '\u{10400}');
const identifierPart = fc.constantFrom(...Array.from('abc019_$'), 'é', '\u{300}', '\u{200c}', '\u{200d}', '٣');

/** An identifier name, sometimes with a character written as a Unicode escape. */
const identifierName = fc
  .tuple(identifierStart, fc.array(identifierPart, { maxLength: 4 }), fc.nat({ max: 5 }))
  .map(([start, rest, escapeAt]) =>
    [start, ...rest]
      .map((ch, i) => (i === escapeAt && ch.length === 1 ? `\\u${hex(ch.charCodeAt(0), 4)}` : ch))
      .join(''),
  );

/** A property key: an identifier (reserved words included), a string or a number. */
const propertyKey = fc
  .oneof(
    identifierName,
    fc.constantFrom(
      'if',
      'class',
      'null',
      'true',
      'default',
      'a',
      'b',
      '"a"',
      "'b'",
      '"\\x61"',
      '1',
      '0x1',
      '1.0',
      '01',
      '"1"',
      '1n',
    ),
    stringLiteral,
    numericLiteral,
  )
  .filter((key) => !key.includes('__proto__') && !/^__\\u|proto/.test(key));

/** A function-valued property: not data, which twee-ts leaves out. */
const functionProperty = fc
  .tuple(
    propertyKey,
    fc.constantFrom('function () { return /"[}]/.test("{"); }', '() => {}', 'async () => 1', 'function* g() {}'),
  )
  .map(([key, fn]) => `${key}: ${fn}`);
const methodProperty = fc
  .tuple(fc.constantFrom('', 'async ', '*'), identifierName)
  .map(([prefix, key]) => `${prefix}${key}() { return '}'; }`);

/** Join items with commas and trivia, with an optional trailing comma. */
const list = (items: readonly string[], gaps: readonly string[], trailing: boolean): string =>
  items.map((item, i) => `${gaps[i] ?? ''}${item}${gaps[i + items.length] ?? ''}`).join(',') +
  (trailing && items.length > 0 ? ',' : '');

const gapsFor = (count: number): fc.Arbitrary<string[]> =>
  fc.array(trivia, { minLength: 2 * count, maxLength: 2 * count });

/** Literal values in the supported subset: strings, templates, numbers, booleans, null, arrays and objects. */
export const { value: literalValue, object: objectLiteral } = fc.letrec<{
  value: string;
  object: string;
  array: string;
}>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    stringLiteral,
    templateLiteral,
    signedNumber,
    fc.constantFrom('true', 'false', 'null'),
    tie('array'),
    tie('object'),
  ),
  array: fc
    .array(tie('value'), { maxLength: 4 })
    .chain((items) =>
      fc
        .tuple(gapsFor(items.length), fc.boolean(), trivia)
        .map(([gaps, trailing, inner]) => `[${inner}${list(items, gaps, trailing)}]`),
    ),
  object: fc
    .array(
      fc.oneof(
        {
          weight: 6,
          arbitrary: fc
            .tuple(propertyKey, trivia, trivia, tie('value'))
            .map(([key, a, b, value]) => `${key}${a}:${b}${value}`),
        },
        { weight: 1, arbitrary: functionProperty },
        { weight: 1, arbitrary: methodProperty },
      ),
      { maxLength: 5 },
    )
    .chain((props) =>
      fc
        .tuple(gapsFor(props.length), fc.boolean(), trivia)
        .map(([gaps, trailing, inner]) => `{${inner}${list(props, gaps, trailing)}}`),
    ),
}));

/** Code before or after the call that tokenizes differently from what a naive scanner expects. */
export const surroundingCode = fc
  .array(
    fc.oneof(
      trivia,
      fc.constantFrom(
        'var __r = /"/g;',
        "var __s = /'/;",
        'var __t = /`/;',
        'var __u = /[/*]/;',
        'var __v = /\\/*/;',
        'var __w = /storyFormat\\({/;',
        'var __x = 4 / 2 / 1;',
        'if (0) /"/.test("");',
        'while (0) /"/g.exec("");',
        'function __f() {}\n/"/.test("");',
        'var __g = () => {}\n/"/.test("");',
        '{}\n/"/.test("");',
        'var of = 4, g = 2, __y = of / g;',
        'var __z = 1./2;',
        'var éstoryFormat = function () {};',
        'var __o = { storyFormat: "{" };',
        'var __q = "storyFormat({";',
        'var __k = `${"}"}${`{`}`;',
        '/* storyFormat({}) */',
        "<!-- storyFormat({}) it's\n",
        "\n--> storyFormat({}) it's\n",
        'var __a = 010 + 0x1 + 1_0;',
      ),
    ),
    { maxLength: 4 },
  )
  .map((parts) => parts.join('\n'));

/** The ways a format.js may call `storyFormat`. */
export const storyFormatCallee = fc.constantFrom(
  'window.storyFormat',
  'storyFormat',
  'window["storyFormat"]',
  "window['storyFormat']",
  '(window.storyFormat)',
  'window.\\u0073toryFormat',
  'window.storyFormat?.',
  'window?.storyFormat',
);

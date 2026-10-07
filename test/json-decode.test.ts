import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  JsonObject,
  MAX_JSON_DEPTH,
  describeJsonValue,
  field,
  formatJsonPath,
  goFoldKey,
  jsonArrayOf,
  jsonBoolean,
  jsonNumber,
  jsonRecordOf,
  jsonString,
  nullAsZero,
  ownRecord,
  parseJSON,
  readObject,
} from '../src/json-decode.js';
import type { DecodeIssue, JsonValue } from '../src/json-decode.js';

/** A parsed value as `JSON.parse` would give it: members in order, a repeated key keeping its first place. */
function toPlain(value: JsonValue): unknown {
  if (value instanceof JsonObject) {
    return ownRecord(value.members.map(({ key, value: v }) => [key, toPlain(v)] as const));
  }
  if (Array.isArray(value)) return value.map(toPlain);
  return value;
}

/**
 * Same value, keys in the same order. (Not `toStrictEqual`, which compares the `constructor` property of two
 * objects, and that is data here.)
 */
function expectSameValue(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

function jsonParses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Characters that matter to JSON syntax, and some that matter to JavaScript strings but not to JSON. */
const JSON_CHARS = fc.constantFrom(
  ...'{}[]:,"\\/ \t\n\r0123456789-+.eEtrufalsn'.split(''),
  'u',
  'x',
  '\u2028',
  '\u0000',
  '\u001f',
  '\ud800',
  '\ufeff',
  '\u00a0',
);

describe('parseJSON: agrees with JSON.parse (differential)', () => {
  it('gives the same value for every JSON text JSON.parse accepts', () => {
    fc.assert(
      fc.property(fc.json({ maxDepth: 4 }), (text) => {
        const parsed = parseJSON(text);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expectSameValue(toPlain(parsed.value), JSON.parse(text));
      }),
      { numRuns: 500 },
    );
  });

  it('gives the same value for JSON with unusual strings, keys and white space', () => {
    const key = fc.oneof(fc.constantFrom('__proto__', 'constructor', 'toString', 'a', 'A'), fc.string());
    const value = fc.letrec<{ value: unknown }>((tie) => ({
      value: fc.oneof(
        { depthSize: 'small' },
        fc.string({ unit: 'binary' }),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie('value'), { maxLength: 3 }),
        fc.array(fc.tuple(key, tie('value')), { maxLength: 3 }).map((entries) => ownRecord(entries)),
      ),
    })).value;
    const space = fc.constantFrom('', ' ', '\t', '\n', '\r\n  ');
    fc.assert(
      fc.property(value, space, (v, indent) => {
        const text = `${indent}${JSON.stringify(v, null, indent.trim() === '' && indent !== '' ? 1 : undefined)}${indent}`;
        const parsed = parseJSON(text);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expectSameValue(toPlain(parsed.value), JSON.parse(text));
      }),
      { numRuns: 300 },
    );
  });

  it('accepts exactly the texts JSON.parse accepts, among near-JSON strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: JSON_CHARS, maxLength: 12 }), (text) => {
        expect(parseJSON(text).ok).toBe(jsonParses(text));
      }),
      { numRuns: 3000 },
    );
  });

  it('accepts exactly the texts JSON.parse accepts, among JSON texts with one edit', () => {
    const edited = fc
      .tuple(fc.json({ maxDepth: 2 }), fc.nat(), fc.nat({ max: 2 }), fc.string({ unit: JSON_CHARS, maxLength: 2 }))
      .map(([text, at, remove, insert]) => {
        const i = at % (text.length + 1);
        return text.slice(0, i) + insert + text.slice(i + remove);
      });
    fc.assert(
      fc.property(edited, (text) => {
        expect(parseJSON(text).ok).toBe(jsonParses(text));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('parseJSON: what JSON.parse does not show', () => {
  it('keeps every member of an object in order, repeated keys included', () => {
    const parsed = parseJSON('{"a":1,"b":2,"a":3}');
    expect(parsed).toEqual({
      ok: true,
      value: new JsonObject([
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
        { key: 'a', value: 3 },
      ]),
    });
  });

  it('builds no objects from keys, so __proto__ is data', () => {
    const parsed = parseJSON('{"__proto__":{"polluted":true}}');
    expect(parsed.ok && parsed.value instanceof JsonObject && parsed.value.members[0]?.key).toBe('__proto__');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('reports where the text goes wrong', () => {
    expect(parseJSON('{\n  "a": tru\n}')).toEqual({
      ok: false,
      error: {
        message: 'unexpected character "t"; expected a JSON value at line 2, column 8',
        offset: 9,
        line: 2,
        column: 8,
      },
    });
    expect(parseJSON('[1,')).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/^unexpected end of input/) },
    });
    expect(parseJSON('"a')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('a closing quotation mark') },
    });
    expect(parseJSON('"\\x"')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('an escape sequence') },
    });
    expect(parseJSON('"\\u12g4"')).toMatchObject({ ok: false, error: { column: 4 } });
    expect(parseJSON('{"a" 1}')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('":" after an object key') },
    });
    expect(parseJSON('1 2')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('the end of input') },
    });
    expect(parseJSON('"\u0001"')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('control character') },
    });
  });

  it('reads escapes, lone surrogates included, as JSON.parse does', () => {
    const text = '"\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\ud800x"';
    expect(parseJSON(text)).toEqual({ ok: true, value: JSON.parse(text) });
  });

  it('accepts nesting up to the limit and rejects deeper nesting, without growing the call stack', () => {
    const nested = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth);
    expect(parseJSON(nested(MAX_JSON_DEPTH)).ok).toBe(true);
    expect(parseJSON(nested(MAX_JSON_DEPTH + 1))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(`maximum nesting depth of ${MAX_JSON_DEPTH}`) },
    });
    const objects = '{"a":'.repeat(MAX_JSON_DEPTH + 1) + '1' + '}'.repeat(MAX_JSON_DEPTH + 1);
    expect(parseJSON(objects).ok).toBe(false);
  });

  it('parses large input in linear time', () => {
    const big = JSON.stringify(Array.from({ length: 200_000 }, (_, i) => ({ k: `v${i}`, n: i })));
    const started = performance.now();
    expect(parseJSON(big).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('formatJsonPath and describeJsonValue', () => {
  it('writes identifiers after a dot and other keys in brackets', () => {
    expect(formatJsonPath([])).toBe('$');
    expect(formatJsonPath(['ifid', 'tag-colors', 0, '__proto__', ''])).toBe('$.ifid["tag-colors"][0].__proto__[""]');
  });

  it('describes each kind of value', () => {
    expect([null, 'x', 3, true, [], new JsonObject([])].map(describeJsonValue)).toEqual([
      'null',
      'a string ("x")',
      'a number (3)',
      'a boolean (true)',
      'an array',
      'an object',
    ]);
  });
});

describe('decoders', () => {
  const run = <T>(
    decoder: (v: JsonValue, p: readonly (string | number)[], i: DecodeIssue[]) => T,
    value: JsonValue,
  ) => {
    const issues: DecodeIssue[] = [];
    return { result: decoder(value, ['x'], issues), issues };
  };

  it('check each scalar type and record a typed issue for anything else', () => {
    expect(run(jsonString, 'a').result).toEqual({ ok: true, value: 'a' });
    expect(run(jsonNumber, 2.5).result).toEqual({ ok: true, value: 2.5 });
    expect(run(jsonBoolean, false).result).toEqual({ ok: true, value: false });
    expect(run(jsonString, 1)).toEqual({
      result: { ok: false },
      issues: [{ kind: 'type', path: ['x'], message: '$.x must be a string, not a number (1)' }],
    });
    expect(run(jsonBoolean, 'true').issues[0]?.message).toBe('$.x must be a boolean, not a string ("true")');
    expect(run(jsonNumber, null).issues[0]?.message).toBe('$.x must be a finite number, not null');
  });

  it('reject a number too large for a double, as Go does', () => {
    const parsed = parseJSON('1e400');
    expect(parsed.ok && run(jsonNumber, parsed.value).issues[0]?.message).toBe(
      '$.x must be a finite number, not a number (Infinity)',
    );
  });

  it('read null as the zero value only when asked to', () => {
    expect(run(nullAsZero(jsonString, ''), null).result).toEqual({ ok: true, value: '' });
    expect(run(nullAsZero(jsonString, ''), 'v').result).toEqual({ ok: true, value: 'v' });
    expect(run(jsonString, null).result).toEqual({ ok: false });
  });

  it('read arrays and records, leaving out and reporting the elements they reject', () => {
    expect(run(jsonArrayOf(jsonString), ['a', 1, 'b'])).toEqual({
      result: { ok: true, value: ['a', 'b'] },
      issues: [{ kind: 'type', path: ['x', 1], message: '$.x[1] must be a string, not a number (1)' }],
    });
    expect(run(jsonArrayOf(jsonString), 'a').result).toEqual({ ok: false });
    const record = new JsonObject([
      { key: '__proto__', value: 'p' },
      { key: 'b', value: 'first' },
      { key: 'b', value: 2 },
      { key: 'c', value: 'c' },
    ]);
    const { result, issues } = run(jsonRecordOf(jsonString), record);
    expect(result).toEqual({
      ok: true,
      value: new Map([
        ['__proto__', 'p'],
        ['c', 'c'],
      ]),
    });
    expect(issues.map((i) => i.path)).toEqual([['x', 'b']]);
    expect(run(jsonRecordOf(jsonString), []).result).toEqual({ ok: false });
  });
});

describe('readObject', () => {
  function read(json: string, keys: 'exact' | 'go') {
    const parsed = parseJSON(json);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const got: [string, string][] = [];
    const issues: DecodeIssue[] = [];
    const ok = readObject(parsed.value, [], issues, {
      keys,
      fields: {
        start: field(jsonString, (v) => got.push(['start', v])),
        'tag-colors': field(jsonString, (v) => got.push(['tag-colors', v])),
      },
    });
    return { ok, got, issues: issues.map((i) => [i.kind, i.message]) };
  }

  it('reads fields in document order, the last repeated one winning, and reports the repeat', () => {
    expect(read('{"start":"a","start":"b"}', 'exact')).toEqual({
      ok: true,
      got: [
        ['start', 'a'],
        ['start', 'b'],
      ],
      issues: [['duplicate-key', '$.start repeats the field "start"; the last one is used']],
    });
  });

  it('matches keys regardless of case as Go does, preferring an exact match', () => {
    expect(read('{"START":"a","Tag-Colors":"b","ſtart":"c","start":"d"}', 'go')).toEqual({
      ok: true,
      got: [
        ['start', 'a'],
        ['tag-colors', 'b'],
        ['start', 'c'],
        ['start', 'd'],
      ],
      issues: [
        ['case-variant-key', '$.START is read as "start", since keys match regardless of letter case'],
        ['case-variant-key', '$["Tag-Colors"] is read as "tag-colors", since keys match regardless of letter case'],
        ['case-variant-key', '$["ſtart"] is read as "start", since keys match regardless of letter case'],
        ['duplicate-key', '$["ſtart"] repeats the field "start"; the last one is used'],
        ['duplicate-key', '$.start repeats the field "start"; the last one is used'],
      ],
    });
  });

  it('matches only exact keys when asked to, and reports the others as unknown', () => {
    expect(read('{"START":"a","constructor":"b","__proto__":"c"}', 'exact')).toEqual({
      ok: true,
      got: [],
      issues: [
        ['unknown-key', '$.START is not a known field'],
        ['unknown-key', '$.constructor is not a known field'],
        ['unknown-key', '$.__proto__ is not a known field'],
      ],
    });
  });

  it('rejects a value that is not an object', () => {
    expect(read('[]', 'go')).toEqual({ ok: false, got: [], issues: [['type', '$ must be an object, not an array']] });
  });
});

describe('goFoldKey', () => {
  it('folds as Go encoding/json folds: ASCII letters, and the letters whose simple folding is ASCII', () => {
    expect(goFoldKey('format-Version')).toBe('FORMAT-VERSION');
    expect(goFoldKey('ſtart')).toBe(goFoldKey('start'));
    expect(goFoldKey('Key')).toBe(goFoldKey('key'));
    expect(goFoldKey('ıfıd')).not.toBe(goFoldKey('ifid'));
    expect(goFoldKey('İFİD')).not.toBe(goFoldKey('ifid'));
    expect(goFoldKey('é')).not.toBe(goFoldKey('e'));
    expect(goFoldKey('ß')).toBe('ß');
  });

  it('folds exactly the code points to ASCII that Go folds to ASCII (#298)', () => {
    // The oracle: every rune above U+007F whose Go fold (encoding/json foldRune(), the smallest rune of its
    // unicode.SimpleFold orbit) is ASCII, listed by Go 1.24 over U+0080..U+10FFFF.
    const goFoldsToAscii = new Map([
      [0x17f, 'S'],
      [0x212a, 'K'],
    ]);
    const got = new Map<number, string>();
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const folded = goFoldKey(String.fromCodePoint(cp));
      if (folded.charCodeAt(0) < 0x80) got.set(cp, folded);
    }
    expect(got).toEqual(goFoldsToAscii);
  });

  it('folds two ASCII keys alike exactly when they are equal ignoring ASCII case', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary-ascii' }), fc.string({ unit: 'binary-ascii' }), (a, b) => {
        expect(goFoldKey(a) === goFoldKey(b)).toBe(a.toUpperCase() === b.toUpperCase());
      }),
    );
  });
});

describe('ownRecord', () => {
  it('keeps every key as an own enumerable property, __proto__ included', () => {
    const record = ownRecord([
      ['__proto__', 'x'],
      ['constructor', 'y'],
      ['a', 'z'],
    ]);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.keys(record)).toEqual(['__proto__', 'constructor', 'a']);
    expect(JSON.stringify(record)).toBe('{"__proto__":"x","constructor":"y","a":"z"}');
    expect({ ...record }).toEqual(record);
  });
});

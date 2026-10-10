/**
 * Locating the format object in a format.js: the file is parsed as JavaScript, so regular
 * expressions, HTML-like comments, every line terminator and Unicode identifiers around the
 * `storyFormat()` call are read as a browser reads them (#245 JS-1 to JS-4 and JS-6, #221). Each
 * case runs through the parser, local discovery, a direct download and an offline compile from the
 * download cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { compile } from '../src/compiler.js';
import { decodeFormatJSON, parseFormatJSON, readFormatObject, UNNAMED_FORMAT_NAME } from '../src/format-decode.js';
import { discoverAllFormats, discoverFormats, readFormatSource } from '../src/formats.js';
import type { Diagnostic } from '../src/types.js';
import { fetchDirectFormat } from '../src/remote-formats.js';
import { canonical, runFormatScript } from './helpers/story-format-oracle.js';

const OBJECT = '{name:"Review",version:"1.0.0",source:"<b>{{STORY_DATA}}</b>"}';
const CALL = `window.storyFormat(${OBJECT});`;
const SOURCE = '<b>{{STORY_DATA}}</b>';

/** Valid format.js files around one call, which every path must read as Review 1.0.0. */
const WRAPPERS: Readonly<Record<string, string>> = {
  // JS-1: regular expression literals holding quotes or comment openers before the call.
  'JS-1 a regular expression with a double quote': `var re = /"/g;\n${CALL}\nvar x = "a";`,
  'JS-1 a regular expression with a single quote': `var re = /'/g;\n${CALL}\nvar y = 'b';`,
  'JS-1 a regular expression with a backquote': 'var re = /`/;\n' + CALL + '\nvar t = `x`;',
  'JS-1 a regular expression with /* in a class': `var re = /[/*]/;\n${CALL}\n/* c */`,
  'JS-1 a regular expression with an escaped slash and a star': `var re = /\\/*/;\n${CALL}\n// */`,
  'JS-1 a regular expression holding storyFormat({': `var re = /storyFormat\\({/;\n${CALL}`,
  'JS-1 a regular expression after the ) of an if': `if (0) /"/.test("");\n${CALL}`,
  'JS-1 a regular expression after a function declaration': `function f() {}\n/'/.test("");\n${CALL}`,
  'JS-1 a division and then a quote': `var a = 4 / 2; var q = "'";\n${CALL}`,
  // JS-2: HTML-like comments (Annex B), which a classic script allows.
  'JS-2 an HTML open comment with an apostrophe': `<!-- it's a format\n${CALL}\nvar s = 'x';`,
  'JS-2 an HTML open comment holding a call': `<!-- storyFormat({}) \n${CALL}`,
  'JS-2 an HTML close comment at the start of a line': `var a = 1;\n-->{ it's\n${CALL}`,
  // JS-3: an identifier that only ends in storyFormat.
  'JS-3 a non-ASCII identifier ending in storyFormat': `var éstoryFormat = function () {}; éstoryFormat({name:"Wrong",version:"9.9.9",source:"x"});\n${CALL}`,
  'JS-3 an escaped identifier ending in storyFormat': `var \\u00e9storyFormat = function () {}; éstoryFormat({name:"Wrong",version:"9.9.9",source:"x"});\n${CALL}`,
  // #221: a line comment ends at any line terminator.
  '#221 a line comment ended by LF': `// copyright {\n${CALL}`,
  '#221 a line comment ended by CR': `// copyright {\r${CALL}`,
  '#221 a line comment ended by CRLF': `// copyright {\r\n${CALL}`,
  '#221 a line comment ended by LS': `// copyright {\u{2028}${CALL}`,
  '#221 a line comment ended by PS': `// copyright {\u{2029}${CALL}`,
  '#221 brace comments around the call': `/* { */\n// }}}\n${CALL}\n/* } */ // {`,
  // Other spellings of the call.
  'an escaped identifier in the call': `window.\\u0073toryFormat(${OBJECT});`,
  'an optional call': `window.storyFormat?.(${OBJECT});`,
  'a parenthesized callee': `(window.storyFormat)(${OBJECT});`,
  'a bracketed callee': `window["storyFormat"](${OBJECT});`,
  'a parenthesized optional chain': `(window?.storyFormat)(${OBJECT});`,
  'other calls through optional chains': `var a = { b: () => () => 0 }; (a?.b())({}); (a?.b)({});\n${CALL}`,
  'a bare storyFormat call': `storyFormat(${OBJECT});`,
  'a call inside a function': `(function () { 'use strict'; window.storyFormat(${OBJECT}); })();`,
  'a hashbang line': `#!/usr/bin/env node {\n${CALL}`,
  'trivia of every kind between the tokens': `window\u{feff}.\u{a0}storyFormat\u{3000}(/* { */${OBJECT}\u{2028});`,
};

describe('locating the storyFormat() call', () => {
  for (const [label, source] of Object.entries(WRAPPERS)) {
    it(`reads the format behind ${label}, as JavaScript does`, () => {
      const run = runFormatScript(source);
      const [evaluated] = run.ok ? run.calls : [];
      expect(canonical(evaluated)).toBe(canonical({ name: 'Review', version: '1.0.0', source: SOURCE }));
      expect(parseFormatJSON(source)).toEqual({ name: 'Review', version: '1.0.0', source: SOURCE, proofing: false });
    });
  }

  it('rejects a file with more than one call, naming each one', () => {
    expect(decodeFormatJSON(`${CALL}\n  storyFormat(${OBJECT});`)).toEqual({
      ok: false,
      reason:
        'The story format file calls storyFormat() 2 times (line 1, column 1; line 2, column 3); expected exactly one call.',
    });
    // A call a script never makes still counts: which one runs is not known without running it.
    expect(decodeFormatJSON(`function unused() { storyFormat({}); }\n${CALL}`).ok).toBe(false);
  });

  it('rejects a call that is not given an object literal', () => {
    for (const call of ['window.storyFormat(format);', 'storyFormat();', 'storyFormat(...[{}]);']) {
      expect(decodeFormatJSON(call)).toEqual({
        ok: false,
        reason: 'The storyFormat() call at line 1, column 1 is not given an object literal.',
      });
    }
  });

  it('rejects a file with no call, unless all of it is one object literal', () => {
    expect(decodeFormatJSON('format({version: "1.0.0", source: "s"});')).toEqual({
      ok: false,
      reason: 'Could not find a storyFormat({…}) call in the story format file.',
    });
    expect(decodeFormatJSON('// no format\n')).toMatchObject({ ok: false });
    expect(decodeFormatJSON('var o = {version: "1.0.0", source: "s"};')).toMatchObject({ ok: false });
    // Tweego reads a file that is just the object.
    expect(parseFormatJSON('/* c */ {"name": "Bare", "version": "1.0.0", "source": "s"} // end\n')?.name).toBe('Bare');
    expect(parseFormatJSON('({name: "Bare", version: "1.0.0", source: "s"})')?.name).toBe('Bare');
    expect(parseFormatJSON('{version: "1.0.0"}')).toBeNull();
    expect(decodeFormatJSON('{"version": "1.0.0", "source": "s"} x')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^The story format file is not valid JavaScript: Unexpected token at line 1/),
    });
  });

  it("reports a file that is not JavaScript with acorn's message and position", () => {
    expect(decodeFormatJSON('var s = "unterminated\n' + CALL)).toEqual({
      ok: false,
      reason: 'The story format file is not valid JavaScript: Unterminated string constant at line 1, column 9.',
    });
    expect(decodeFormatJSON(`${'['.repeat(100_000)}${CALL}`)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /^The story format file nests too deeply to read \(the JavaScript parser ran out of stack space\) at line 1, column \d+\.$/,
      ),
    });
    // Nesting acorn can parse is read too.
    const deep = `storyFormat({version: "1.0.0", source: "s", deep: ${'['.repeat(500)}${']'.repeat(500)}});`;
    expect(readFormatObject(deep)).toMatchObject({ ok: true });
  });

  it('counts lines in positions with every line terminator, in downloads too (JS-6)', () => {
    for (const lt of ['\r', '\u{2028}', '\u{2029}', '\r\n']) {
      expect(decodeFormatJSON(`window.storyFormat({${lt}a: 1,${lt}b: ?});`), JSON.stringify(lt)).toMatchObject({
        reason: expect.stringContaining('at line 3, column 4'),
      });
    }
  });
});

describe('function-valued properties (JS-4)', () => {
  it('keeps the properties after a setup function, such as proofing', () => {
    const source =
      'window.storyFormat({"name":"R","version":"1.0.0","source":"x","setup": function(){ return /\'}/; }, "proofing": true});';
    expect(decodeFormatJSON(source)).toEqual({
      ok: true,
      data: { name: 'R', version: '1.0.0', source: 'x', proofing: true },
      notes: [],
    });
  });

  it('notes a function where twee-ts expects data, with its position', () => {
    const source = 'window.storyFormat({name: () => 1, version: "1.0.0", source: "x", proofing() {}});';
    expect(decodeFormatJSON(source)).toEqual({
      ok: true,
      data: { name: UNNAMED_FORMAT_NAME, version: '1.0.0', source: 'x', proofing: false },
      notes: [
        'Skipped the function at property name (line 1, column 21)',
        'Skipped the function at property proofing (line 1, column 67)',
      ],
    });
  });

  it.each(['name', 'version', 'source', 'proofing', 'author', 'description', 'image', 'url', 'license'])(
    'notes a function at the property %s that twee-ts reads',
    (field) => {
      const source = `window.storyFormat({version: "1.0.0", source: "x", ${field}() {}, other: {${field}() {}}});`;
      const result = readFormatObject(source);
      expect(result.ok && result.notes).toEqual([
        `Skipped the function at property ${field} (line 1, column ${source.indexOf(`${field}() {}`) + 1})`,
      ]);
    },
  );

  it.each(['setup', 'editorExtensions', 'other'])(
    'says nothing of a function at the property %s, nested or not',
    (key) => {
      const source = `window.storyFormat({name: "R", version: "1.0.0", source: "x", ${key}: () => 1, nested: {name() {}, ${key}: function () {}}});`;
      const result = readFormatObject(source);
      expect(result.ok && result.notes).toEqual([]);
      expect(result.ok && [...result.fields.keys()]).toEqual(['name', 'version', 'source', 'nested']);
    },
  );

  it('reads a source that follows the setup function', () => {
    const source = 'window.storyFormat({name:"R",version:"1.0.0","setup": function(){return 1},source:"x"});';
    expect(parseFormatJSON(source)?.source).toBe('x');
  });

  it.each([['setup: function () {}'], ["'setup': function () {}"], ['setup() {}'], ['setup: () => {}']])(
    'skips %s',
    (property) => {
      const result = decodeFormatJSON(`window.storyFormat({name:"R",version:"1.0.0",source:"x",${property}});`);
      expect(result).toMatchObject({ ok: true, data: { name: 'R' }, notes: [] });
      expect(readFormatObject(`window.storyFormat({name:"R",version:"1.0.0",source:"x",${property}});`)).toMatchObject({
        ok: true,
        fields: new Map([
          ['name', 'R'],
          ['version', '1.0.0'],
          ['source', 'x'],
        ]),
      });
    },
  );
});

describe('format metadata fields', () => {
  it('ignores optional fields of the wrong type, with a note', () => {
    const source =
      'window.storyFormat({name: 5, version: "1.0.0", source: "s", proofing: "yes", author: ["a"], url: "u", image: null});';
    expect(decodeFormatJSON(source)).toEqual({
      ok: true,
      data: { name: UNNAMED_FORMAT_NAME, version: '1.0.0', source: 's', proofing: false, url: 'u' },
      notes: [
        'Ignored "name": it is not a string',
        'Ignored "proofing": it is not a boolean',
        'Ignored "author": it is not a string',
        'Ignored "image": it is not a string',
      ],
    });
  });

  it('requires a string version and source, and a SemVer version', () => {
    expect(decodeFormatJSON('storyFormat({source: "s"});')).toEqual({
      ok: false,
      reason: 'Story format has no "version" string.',
    });
    expect(decodeFormatJSON('storyFormat({version: "1.0.0", source: `a${1}`});')).toMatchObject({ ok: false });
    expect(decodeFormatJSON('storyFormat({version: "x", source: "s"});')).toMatchObject({
      reason: 'Story format version "x" is not a SemVer version.',
    });
  });
});

let cacheRoot = '';
let origCacheHome: string | undefined;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'twee-ts-format-decode-'));
  origCacheHome = process.env['XDG_CACHE_HOME'];
  process.env['XDG_CACHE_HOME'] = cacheRoot;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (origCacheHome !== undefined) process.env['XDG_CACHE_HOME'] = origCacheHome;
  else delete process.env['XDG_CACHE_HOME'];
  rmSync(cacheRoot, { recursive: true, force: true });
});

/** Answer `fetch` for `url` with `body`, and anything else with a network error. */
function serve(url: string, body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return requested === url ? Promise.resolve(new Response(body)) : Promise.reject(new TypeError('offline'));
    }),
  );
}

const STORY = [
  {
    filename: 'story.tw',
    content: `:: StoryData\n{"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC", "format": "Review", "format-version": "1.0.0"}\n\n:: StoryTitle\nT\n\n:: Start\nHello.\n`,
  },
];

describe('every format path reads the same wrappers (#221, JS-1 to JS-3)', () => {
  for (const [label, source] of Object.entries(WRAPPERS)) {
    it(`discovers, downloads and compiles offline the format behind ${label}`, async () => {
      // Local discovery, and the source read back for a compile.
      const formats = join(cacheRoot, 'formats');
      mkdirSync(join(formats, 'review-1'), { recursive: true });
      writeFileSync(join(formats, 'review-1', 'format.js'), source);
      const local = discoverFormats([formats]).get('review-1');
      expect(local?.name).toBe('Review');
      expect(local && readFormatSource(local)).toBe(SOURCE);

      // A direct download, then a compile from the cache with no network.
      const url = 'https://example.test/review/format.js';
      serve(url, source);
      expect((await fetchDirectFormat(url)).version).toBe('1.0.0');
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(new TypeError('offline'))),
      );
      const offline = await compile({
        sources: STORY,
        formatUrls: [url],
        noRemote: true,
        formatPaths: [],
        useTweegoPath: false,
      });
      expect(offline.format?.name).toBe('Review');
      // The template is the format's: its element holds the story data, with the IFID comment before it.
      expect(offline.output).toMatch(/^<!-- UUID:\/\/[^ ]+\/\/ --><b><tw-storydata /);
    });
  }

  it('skips a local format.js that is not valid JavaScript, saying where', () => {
    const formats = join(cacheRoot, 'formats');
    mkdirSync(join(formats, 'broken-1'), { recursive: true });
    writeFileSync(join(formats, 'broken-1', 'format.js'), `/* never closed\n${CALL}`);
    const diagnostics: Diagnostic[] = [];
    expect(discoverAllFormats([formats], diagnostics).size).toBe(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({ message: expect.stringContaining('Unterminated comment at line 1, column 1') }),
    ]);
  });
});

/**
 * Directories of real story formats to check, when present: `TWEE_TS_REAL_FORMATS` (a list joined
 * by the platform's path delimiter), and Tweego's own formats beside the repository. They are not
 * part of the repository; the fixtures that are run always.
 */
function realFormatFiles(): string[] {
  const root = resolve(__dirname, '..');
  const dirs = [
    ...(process.env['TWEE_TS_REAL_FORMATS'] ?? '').split(delimiter).filter((dir) => dir !== ''),
    join(root, 'tweego', 'storyformats'),
    join(root, '..', 'tweego', 'storyformats'),
    join(root, 'test', 'fixtures', 'storyformats'),
    join(root, 'test', 'fixtures', 'storyformats-harlowe'),
    join(root, 'test', 'fixtures', 'storyformats-sugarcube'),
  ];
  return dirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).map((id) => join(dir, id, 'format.js')))
    .filter((file) => existsSync(file));
}

/** Code that a naive scanner would misread, put before or after a real format. */
const REAL_FORMAT_WRAPPERS: Readonly<Record<string, (source: string) => string>> = {
  'as shipped': (s) => s,
  'after a regular expression with a quote (JS-1)': (s) => `var __r = /"/;\n${s}`,
  'after a line comment ended by LS (#221)': (s) => `// license {\u{2028}${s}`,
  'after an HTML-like comment (JS-2)': (s) => `<!-- it's {\n${s}`,
  'before a regular expression with a quote (JS-1)': (s) => `${s}\nvar __r = /'/;`,
};

describe('real story formats, compared with V8', () => {
  const files = realFormatFiles();

  it('finds the formats to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of files) {
    it(`decodes ${file} under every wrapper exactly as V8 evaluates it`, () => {
      const shipped = readFileSync(file, 'utf8');
      for (const [label, wrapper] of Object.entries(REAL_FORMAT_WRAPPERS)) {
        const source = wrapper(shipped);
        const run = runFormatScript(source);
        const calls = run.ok ? run.calls : [];
        expect(calls, label).toHaveLength(1);
        const read = readFormatObject(source);
        expect(read.ok && canonical(Object.fromEntries(read.fields)), `${file} ${label}`).toBe(canonical(calls[0]));
      }
    });
  }
});

describe('decoding speed', () => {
  it('decodes a 5 MB format.js with a large setup function quickly', { timeout: 120_000 }, () => {
    const source = JSON.stringify('<p class="x">{{STORY_DATA}}</p>\n'.repeat(130_000));
    const setup = 'var r = /"[{]/g; if (r) /\'/.test("a"); var t = `${1}`;\n'.repeat(20_000);
    const file = `window.storyFormat({name:"Big",version:"1.0.0",source:${source},setup: function () {${setup}}});`;
    expect(file.length).toBeGreaterThan(5_000_000);
    const start = performance.now();
    const result = decodeFormatJSON(file);
    const elapsed = performance.now() - start;
    expect(result.ok && result.data.source.length).toBe(130_000 * 32);
    // About half a second on a laptop; the bound only catches a slower algorithm.
    expect(elapsed).toBeLessThan(30_000);
  });

  it('leaves out many function properties in linear time', { timeout: 120_000 }, () => {
    const methods = Array.from({ length: 50_000 }, (_, i) => `f${i}() {}`).join(',\n');
    const result = decodeFormatJSON(`window.storyFormat({version: "1.0.0", source: "s",\n${methods}, name() {}});`);
    expect(result.ok && result.notes).toEqual([
      expect.stringMatching(/^Skipped the function at property name \(line 50001, /),
    ]);
  });
});

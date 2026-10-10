/**
 * One test for each intended difference from Tweego listed in docs/tweego-differences.md, named after its
 * number. A difference that is not listed there is a bug.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { constants } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/compiler.js';
import { parseTwee } from '../src/parser.js';
import { StoryBuilder, createStory, decodeStoryData, marshalStoryData } from '../src/story.js';
import { toTwee } from '../src/output-twee.js';
import { decompileHTML } from '../src/html-parser.js';
import { countNormalizationSegments } from '../src/word-count.js';
import type { CompileResult, Diagnostic, OutputMode } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const FIXTURE_FORMATS = fileURLToPath(new URL('./fixtures/storyformats', import.meta.url));
const DOC = fileURLToPath(new URL('../docs/tweego-differences.md', import.meta.url));

async function build(files: Record<string, string>, outputMode: OutputMode = 'json'): Promise<CompileResult> {
  return compile({
    sources: Object.entries(files).map(([filename, content]) => ({ filename, content })),
    outputMode,
    noRemote: true,
  });
}

describe('intended differences from Tweego (docs/tweego-differences.md)', () => {
  it('D-1: removes a byte order mark at the start of a later line before "::"', () => {
    expect(parseTwee(':: A\na\n\ufeff:: B\nb').passages.map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('D-2: drops trailing blank lines without trimming', () => {
    expect(parseTwee(':: A\n x \n\n  \n:: B', { trim: false }).passages[0]?.text).toBe(' x ');
  });

  it('D-3: drops a lone backslash at the end of a name, with a warning', () => {
    const { passages, diagnostics } = parseTwee(':: foo\\\nx');
    expect(passages[0]?.name).toBe('foo');
    expect(diagnostics.map((d) => d.level)).toEqual(['warning']);
  });

  it('D-4: keeps other string metadata keys, and reads case variants of position as position', () => {
    const { passages, diagnostics } = parseTwee(':: A {"Position":"1,2","note":"n","n":1}\nx');
    expect(passages[0]?.metadata).toEqual({ position: '1,2', note: 'n' });
    expect(diagnostics.map((d) => d.level)).toEqual(['warning', 'warning']);
  });

  it('D-5: reports malformed and wrong-typed StoryData as errors and goes on', async () => {
    const result = await build({ 'a.tw': `:: StoryData\n{"ifid":"${IFID}","zoom":"big"}\n:: Start\nx` });
    expect(result.diagnostics.map((d) => d.level)).toEqual(['error']);
    expect(result.story.ifid).toBe(IFID);
    expect(result.output).toContain('"name"');
  });

  it('D-5: reports StoryData that is not JSON, and an invalid IFID, as errors and goes on', async () => {
    const notJson = await build({ 'a.tw': ':: StoryData\n{"ifid": nope}\n:: Start\nx' });
    expect(notJson.diagnostics.every((d) => d.level === 'error')).toBe(true);
    expect(notJson.diagnostics.length).toBeGreaterThan(0);
    expect(notJson.output).toContain('"Start"');
    const badIfid = await build({ 'a.tw': ':: StoryData\n{"ifid":"BAD"}\n:: Start\nx' });
    expect(badIfid.diagnostics.map((d) => d.level)).toEqual(['error']);
    expect(badIfid.story.ifid).toBe('BAD');
    expect(badIfid.output).toContain('"Start"');
  });

  it('D-6: warns about keys Tweego accepts silently', async () => {
    const result = await build({ 'a.tw': `:: StoryData\n{"Ifid":"${IFID}","ifid":"${IFID}","x":1}\n:: Start\nx` });
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      '"StoryData" $.Ifid is read as "ifid", since keys match regardless of letter case.',
      '"StoryData" $.ifid repeats the field "ifid"; the last one is used.',
      '"StoryData" $.x is not a known field; it is left out.',
    ]);
  });

  it('D-7: reads and writes the tags field', () => {
    const decoded = decodeStoryData('{"tags":"draft final"}');
    expect(decoded.ok && decoded.twine2.tags).toBe('draft final');
    const story = createStory();
    story.twine2.tags = 'draft';
    expect(JSON.parse(marshalStoryData(story))).toEqual({ tags: 'draft' });
  });

  it('D-8: stores a wrapped IFID as the bare UUID', () => {
    const decoded = decodeStoryData(`{"ifid":"uuid://${IFID.toLowerCase()}//"}`);
    expect(decoded.ok && decoded.ifid).toBe(IFID);
  });

  describe('loading files', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'twee-ts-differences-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('D-9: gives a file passage whose name is taken the next free name', async () => {
      writeFileSync(join(dir, 'a.tw'), `:: StoryData\n{"ifid":"${IFID}"}\n:: Start\nx\n:: bg\nmine`);
      writeFileSync(join(dir, 'bg.png'), Buffer.from([0x89, 0x50]));
      const result = await compile({ sources: [dir], outputMode: 'json', noRemote: true });
      expect(result.story.passages.map((p) => p.name)).toContain('bg 2');
      expect(result.story.passages.find((p) => p.name === 'bg')?.text).toBe('mine');
    });

    it('D-10: keeps the leading dots of a media file name', async () => {
      writeFileSync(join(dir, 'a.tw'), `:: StoryData\n{"ifid":"${IFID}"}\n:: Start\nx`);
      writeFileSync(join(dir, '.hidden.night.png'), Buffer.from([0x89, 0x50]));
      const result = await compile({
        sources: [join(dir, 'a.tw'), join(dir, '.hidden.night.png')],
        outputMode: 'json',
        noRemote: true,
      });
      expect(result.story.passages.map((p) => p.name)).toContain('.hidden');
    });
  });

  it('D-11: checks the Twee it writes and says what will not read back', () => {
    const builder = new StoryBuilder();
    builder.add({ name: ' Padded', tags: [], text: 'x' }, []);
    const diagnostics: Diagnostic[] = [];
    toTwee(builder.build(), 'twee3', { diagnostics });
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Passage " Padded" cannot be written as Twee that reads back the same: its name has leading or trailing whitespace, which Twee drops.',
    ]);
  });

  it('D-12: writes StoryData from the story, with the compile options it changed', async () => {
    const result = await compile({
      sources: [{ filename: 'a.tw', content: `:: StoryData\n{"ifid":"${IFID}"}\n:: Begin\nx` }],
      outputMode: 'twee3',
      startPassage: 'Begin',
    });
    expect(result.output).toContain('"start": "Begin"');
  });

  it('D-13: puts the file and line on diagnostics about a passage', async () => {
    const result = await build({ 'a.tw': ':: Start\nx', 'b.tw': ':: Start\ny' });
    expect(result.diagnostics.find((d) => d.message.startsWith('Replacing'))).toMatchObject({
      file: 'b.tw',
      line: 1,
      message: expect.stringContaining('a.tw (line 1)'),
    });
  });

  it('D-19: reports an empty story title as an error, and an @import after another rule as a warning', async () => {
    const compileHtml = (content: string) =>
      compile({
        sources: [{ filename: 'a.tw', content: `:: StoryData\n{"ifid":"${IFID}"}\n\n${content}` }],
        formatId: 'test-format-1',
        formatPaths: [FIXTURE_FORMATS],
        useTweegoPath: false,
        noRemote: true,
      });
    const untitled = await compileHtml(':: StoryTitle\n\n:: Start\nx\n');
    expect(untitled.diagnostics.map((d) => d.level)).toContain('error');
    const late = await compileHtml(
      ':: StoryTitle\nT\n\n:: Sheet [stylesheet]\na {}\n@import url(b.css);\n\n:: Start\nx\n',
    );
    expect(late.diagnostics.map((d) => d.message).join('\n')).toContain('@import');
  });

  it('D-18: ends each script but the last with a statement boundary', async () => {
    const result = await build({
      'a.tw': ':: StoryTitle\nT\n\n:: A [script]\nwindow.a = {} // note\n\n:: B [script]\n(function () {})();\n',
    });
    const script = String((JSON.parse(result.output) as { script: unknown }).script);
    expect(script).toBe('window.a = {} // note\n;\n(function () {})();');
  });

  describe('a format template', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'twee-ts-d20-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('D-30: writes the IFID comment before the element of its own that holds the story data', async () => {
      mkdirSync(join(dir, 'store-1'));
      const format = {
        name: 'Store',
        version: '1.0.0',
        source: '<body><div id="store-area" hidden>{{STORY_DATA}}</div>',
      };
      writeFileSync(join(dir, 'store-1', 'format.js'), `window.storyFormat(${JSON.stringify(format)});`);
      const result = await compile({
        sources: [{ filename: 'a.tw', content: `:: StoryTitle\nT\n:: StoryData\n{"ifid":"${IFID}"}\n:: Start\nx` }],
        formatId: 'store-1',
        formatPaths: [dir],
        useTweegoPath: false,
        noRemote: true,
      });
      expect(result.output).toContain(`<!-- UUID://${IFID}// --><div id="store-area" hidden><tw-storydata `);
    });
  });

  it('D-31: counts a mark newer than Unicode 11 as a mark', () => {
    // U+1E130 (Unicode 12, combining class 230): Go's tables do not have it, so Tweego counts two segments here.
    expect(countNormalizationSegments('a\u{1e130}')).toBe(1);
  });

  it('D-17: writes Twee with LF line endings on every OS', async () => {
    const result = await build({ 'a.tw': ':: Start\r\nline one\r\nline two\r\n' }, 'twee3');
    expect(result.output).toContain('line one\nline two');
    expect(result.output).not.toContain('\r');
  });

  it('D-16: escapes a Twee2 position as a JSON string', () => {
    const { passages, diagnostics } = parseTwee(':: A <1","size":"9,9>\nx', { twee2Compat: true });
    expect(diagnostics).toEqual([]);
    expect(passages[0]?.metadata).toEqual({ position: '1","size":"9,9' });
  });

  it('D-14: keeps the tw-storydata attributes and renames a passage named StoryData', () => {
    const { story, diagnostics } = decompileHTML(
      `<tw-storydata name="S" startnode="1" ifid="${IFID}" format="SugarCube">` +
        '<tw-passagedata pid="1" name="Start">x</tw-passagedata>' +
        '<tw-passagedata pid="2" name="StoryData">{"format":"Harlowe"}</tw-passagedata></tw-storydata>',
    );
    expect([story.ifid, story.twine2.format, story.twine2.start]).toEqual([IFID, 'SugarCube', 'Start']);
    expect(story.passages.map((p) => p.name)).toContain('StoryData 2');
    expect(diagnostics.map((d) => d.level)).toEqual(['warning']);
  });

  it('D-15: reads numbers in attributes whole, and warns about a startnode no passage has', () => {
    const { story, diagnostics } = decompileHTML(
      `<tw-storydata name="S" startnode="7" zoom="Inf" ifid="${IFID}">` +
        '<tw-passagedata pid="1x" name="Start">x</tw-passagedata></tw-storydata>',
    );
    expect(story.twine2.zoom).toBe(1);
    expect(story.twine2.start).toBe('');
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Cannot parse "tw-storydata" content attribute "zoom" as a float; value "Inf".',
      'Cannot parse "tw-passagedata" content attribute "pid" as an integer; value "1x".',
      'The "tw-storydata" content attribute "startnode" is 7, but no "tw-passagedata" has that "pid"; the story has no start passage.',
    ]);
  });

  // --- Differences found by comparing with a Tweego 2.1.1 binary ---

  it('D-20: writes the StoryData JSON without the default zoom, with tag colors in source order and raw', async () => {
    const colors = '{"zeta":"red","alpha":"blue","q<r>&s":"green","u\\u2028v":"gray"}';
    const result = await build(
      { 'a.tw': `:: StoryData\n{"ifid":"${IFID}","tag-colors":${colors}}\n:: Start\nx` },
      'twee3',
    );
    const data = result.output.slice(result.output.indexOf(':: StoryData'), result.output.indexOf(':: Start'));
    expect(data).not.toContain('"zoom"');
    expect(data).toContain('<r>&s');
    expect(data).toContain('u\u2028v');
    expect([...data.matchAll(/^\t\t"([^"]+)"/gm)].map((m) => m[1])).toEqual(['zeta', 'alpha', 'q<r>&s', 'u\u2028v']);
    const decoded = decodeStoryData('{"start":"\\ud800"}');
    expect(decoded.ok && decoded.twine2.start).toBe('\ud800');
  });

  describe('Twine 2 output', () => {
    const archive = async (story: string, formatId?: string): Promise<string> =>
      (
        await compile({
          sources: [{ filename: 'a.tw', content: story }],
          outputMode: 'twine2-archive',
          noRemote: true,
          ...(formatId === undefined ? {} : { formatId }),
        })
      ).output;

    it('D-21: writes names and tags as characters, and escapes < and > in names, and & in tag colors', async () => {
      const output = await archive(
        `:: StoryData\n{"ifid":"${IFID}","tag-colors":{"q<r>&s":"green"}}\n\n:: A\\\\b\tc\u00a0d<e>f\u200bg [t<u>v w\\\\x]\nx\n`,
      );
      expect(output).toContain('name="A\\b\tc\u00a0d&lt;e&gt;f\u200bg"');
      expect(output).toContain('tags="t<u>v w\\x"');
      expect(output).toContain('<tw-tag name="q<r>&amp;s" color="green">');
    });

    it('D-22: writes creator, an empty tags attribute and the tag colors in source order', async () => {
      const colors = '{"zeta":"red","alpha":"blue","mid":"green"}';
      const output = await archive(`:: StoryData\n{"ifid":"${IFID}","tag-colors":${colors}}\n\n:: Start\nx\n`);
      expect(output).toMatch(/<tw-storydata [^>]*creator="Twee-ts" creator-version="[^"]+"/);
      expect(output).toContain(' tags="" hidden>');
      expect([...output.matchAll(/<tw-tag name="([^"]+)"/g)].map((m) => m[1])).toEqual(['zeta', 'alpha', 'mid']);
    });

    it('D-23: writes the format of StoryData into an archive, empty when it has none, and ignores --format', async () => {
      const without = await archive(`:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start\nx\n`, 'harlowe-3');
      expect(without).toContain(' format="" format-version=""');
      const older = `:: StoryData\n{"ifid":"${IFID}","format":"SugarCube","format-version":"2.30.0"}\n\n:: Start\nx\n`;
      expect(await archive(older)).toContain(' format="SugarCube" format-version="2.30.0"');
    });
  });

  describe('Twine 1 output', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'twee-ts-differences-'));
      mkdirSync(join(dir, 'custom-1'));
      writeFileSync(
        join(dir, 'custom-1', 'header.html'),
        '<html><body><p><a href="http://twinery.org/">Twine</a> "TIME"</p><div id="storeArea">"STORY"</div></body></html>',
      );
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const story = `:: StoryTitle\nT\n\n:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start\nx\n`;

    it('D-24: stamps tiddlers, leaves the store area visible, keeps the byline and writes the time in UTC', async () => {
      const archive = await build({ 'a.tw': story }, 'twine1-archive');
      expect(archive.output).toMatch(/<div tiddler="Start" tags="" created="\d{12}" modifier="twee" twine-position=/);
      expect(archive.output).not.toContain('hidden');

      const html = await compile({
        sources: [{ filename: 'a.tw', content: story }],
        formatId: 'custom-1',
        formatPaths: [dir],
        useTweegoPath: false,
        noRemote: true,
      });
      expect(html.output).toContain('<a href="http://twinery.org/">Twine</a> Built on ');
      expect(html.output).toMatch(/Built on \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT/);
    });
  });

  it('D-25: writes </script> and </style> in code as <\\/script> and <\\/style>', async () => {
    const code = ':: Code [script]\nvar s = "</script>";\n\n:: Sheet [stylesheet]\na::after { content: "</style>"; }\n';
    const result = await compile({
      sources: [
        { filename: 'a.tw', content: `:: StoryTitle\nT\n\n:: StoryData\n{"ifid":"${IFID}"}\n\n${code}\n:: Start\nx\n` },
      ],
      formatId: 'test-format-1',
      formatPaths: [FIXTURE_FORMATS],
      useTweegoPath: false,
      noRemote: true,
    });
    expect(result.output).toContain('var s = "<\\/script>";</script>');
    expect(result.output).toContain('content: "<\\/style>"; }</style>');
  });

  it('D-26: counts the words of the story that is built, not of a replaced duplicate passage', async () => {
    const twice = await build({
      'a.tw': `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Dup\nfirst one two three\n\n:: Dup\nsecond\n`,
    });
    const once = await build({ 'a.tw': `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Dup\nsecond\n` });
    expect(twice.stats.words).toBe(once.stats.words);
  });

  describe('loading files found by comparison with Tweego', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'twee-ts-differences-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('D-27: reads a symbolic link to a file, found or named, and warns about a named unsupported type', async () => {
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'other'));
      writeFileSync(join(dir, 'other', 'l.tw'), `:: StoryData\n{"ifid":"${IFID}"}\n:: Linked\nx`);
      symlinkSync(join(dir, 'other', 'l.tw'), join(dir, 'src', 'l.tw'));
      writeFileSync(join(dir, 'thing.xyz'), 'x');
      const found = await compile({ sources: [join(dir, 'src')], outputMode: 'json', noRemote: true });
      expect(found.story.passages.map((p) => p.name)).toContain('Linked');
      const named = await compile({
        sources: [join(dir, 'src', 'l.tw'), join(dir, 'thing.xyz')],
        outputMode: 'json',
        noRemote: true,
      });
      expect(named.story.passages.map((p) => p.name)).toContain('Linked');
      expect(named.diagnostics.map((d) => d.level)).toEqual(['warning']);
      expect(named.diagnostics[0]?.message).toContain('Not a supported source file type');
    });

    it('D-28: reads the bytes Windows-1252 leaves undefined as control characters', async () => {
      const head = Buffer.from(`:: StoryData\n{"ifid":"${IFID}"}\n:: Start\n`);
      writeFileSync(join(dir, 'a.tw'), Buffer.concat([head, Buffer.from([0x41, 0x81, 0x9d, 0xe9])]));
      const result = await compile({ sources: [join(dir, 'a.tw')], outputMode: 'json', noRemote: true });
      expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('A\u0081\u009dé');
    });
  });

  it('D-29: reads all the text of a passage, and not a story inside a template', () => {
    const story = (name: string, text: string): string =>
      `<tw-storydata name="${name}" startnode="1" ifid="${IFID}" format="SugarCube" format-version="2.37.3">` +
      `<tw-passagedata pid="1" name="Start">${text}</tw-passagedata></tw-storydata>`;
    const passageText = (html: string): string | undefined =>
      decompileHTML(html).story.passages.find((p) => p.name === 'Start')?.text;
    expect(passageText(story('S', 'a<!-- c -->b<![CDATA[x]]>z'))).toBe('abz');
    const decoy = decompileHTML(`<html><body><template>${story('Decoy', 'decoy')}</template>${story('Real', 'real')}`);
    expect(decoy.story.name).toBe('Real');
    expect(passageText(`<template>${story('Decoy', 'decoy')}</template>${story('Real', 'real')}`)).toBe('real');
  });

  it('D-30: rejects a text file too large for a string before reading it, and HTML nested more than 512 deep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-ts-d30-'));
    try {
      const path = join(dir, 'huge.twee');
      writeFileSync(path, '');
      // Sparse: no data is written.
      truncateSync(path, constants.MAX_STRING_LENGTH + 1);
      const result = await compile({ sources: [path], outputMode: 'json', noRemote: true });
      expect(result.diagnostics.map((d) => d.message)).toContainEqual(expect.stringMatching(/File size .* is greater/));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(() => decompileHTML('<div>'.repeat(511))).toThrow('HTML nests more than 512 elements deep.');
    expect(() => decompileHTML('<div>'.repeat(510))).not.toThrow();
  });

  it('lists every difference of docs/tweego-differences.md with a test named after it', () => {
    const listed = [...readFileSync(DOC, 'utf8').matchAll(/^\*\*(D-\d+)\./gm)].map((m) => m[1] ?? '');
    const tested = new Set(
      [...readFileSync(fileURLToPath(import.meta.url), 'utf8').matchAll(/\bit\('(D-\d+):/g)].map((m) => m[1] ?? ''),
    );
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((id) => !tested.has(id))).toEqual([]);
  });
});

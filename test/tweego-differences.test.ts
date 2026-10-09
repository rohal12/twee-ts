/**
 * One test for each intended difference from Tweego listed in docs/tweego-differences.md, named after its
 * number. A difference that is not listed there is a bug.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { parseTwee } from '../src/parser.js';
import { StoryBuilder, createStory, decodeStoryData, marshalStoryData } from '../src/story.js';
import { toTwee } from '../src/output-twee.js';
import { decompileHTML } from '../src/html-parser.js';
import type { CompileResult, Diagnostic, OutputMode } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

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

  it('D-18: ends each script but the last with a statement boundary', async () => {
    const result = await build({
      'a.tw': ':: StoryTitle\nT\n\n:: A [script]\nwindow.a = {} // note\n\n:: B [script]\n(function () {})();\n',
    });
    const script = String((JSON.parse(result.output) as { script: unknown }).script);
    expect(script).toBe('window.a = {} // note\n;\n(function () {})();');
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
});

/**
 * Regression tests for the Twee language and story model audit (#246), and for #171, #236, #241 and JS-9
 * (#245): one test per reported case, named after it, plus the sibling cases of each defect class.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, compileIncremental } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';
import { toTwee } from '../src/output-twee.js';
import { parseTwee } from '../src/parser.js';
import { storyInspect } from '../src/inspect.js';
import {
  StoryBuilder,
  createStory,
  decodeStoryData,
  deriveStoryMetadata,
  storyAdd,
  storyHas,
  unmarshalStorySettings,
} from '../src/story.js';
import type { CompileResult, Diagnostic, FileCacheEntry, InlineSource, OutputMode } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const IFID2 = '11111111-2222-4333-8444-555555555555';

function inline(files: Record<string, string>): InlineSource[] {
  return Object.entries(files).map(([filename, content]) => ({ filename, content }));
}

async function build(files: Record<string, string>, outputMode: OutputMode = 'json'): Promise<CompileResult> {
  return compile({ sources: inline(files), outputMode, noRemote: true });
}

const messages = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => `${d.level}: ${d.message}`);

/** The metadata the story's own passages decide; a compile without overrides must equal it. */
function expectDerivedMetadata(result: CompileResult): void {
  const derived = deriveStoryMetadata(result.story.passages);
  expect(result.story.name).toBe(derived.name);
  expect(result.story.legacyIFID).toBe(derived.legacyIFID);
  expect(result.story.twine1).toEqual(derived.twine1);
  expect(result.story.twine2).toEqual(derived.twine2);
}

describe('T-01: Twee output and a text line that reads as a header after a BOM', () => {
  const html =
    `<tw-storydata name="S" startnode="1" ifid="${IFID}" format="F" format-version="1.0.0">` +
    '<tw-passagedata pid="1" name="Start" tags="" position="0,0">Hello\n&#xFEFF;:: Injected [x]\nSecret</tw-passagedata>' +
    '<tw-passagedata pid="2" name="Code" tags="script" position="0,0">a()\n&#xFEFF;:: b\nc()</tw-passagedata>' +
    '</tw-storydata>';

  it('warns about the line in a story passage', () => {
    const diagnostics: Diagnostic[] = [];
    toTwee(decompileHTML(html).story, 'twee3', { diagnostics });
    expect(messages(diagnostics)).toContain(
      'warning: Passage "Start" cannot be written as Twee that reads back the same: line 2 of its text starts with "::", which Twee reads as a passage header.',
    );
  });

  it('indents the line in a script passage, so that the script reads back as one passage', () => {
    const diagnostics: Diagnostic[] = [];
    const twee = toTwee(decompileHTML(html).story, 'twee3', { diagnostics });
    expect(messages(diagnostics)).toContain(
      'warning: Passage "Code": line 2 of its text starts with "::", which Twee reads as a passage header; it was written indented by one space.',
    );
    const code = parseTwee(twee).passages.find((p) => p.name === 'Code');
    expect(code?.text).toBe('a()\n \ufeff:: b\nc()');
  });
});

describe('T-02: one StoryData passage decides both the passage and the metadata', () => {
  it('lets a malformed later StoryData win: no metadata from the earlier one, and an error at its location', async () => {
    const result = await build({
      'a.tw': `:: StoryData\n{"ifid":"${IFID}","format":"Harlowe","format-version":"3.3.0","start":"Begin"}\n:: Begin\nhi`,
      'b.tw': `:: StoryData\n{"ifid":"${IFID2}", oops}\n`,
    });
    expect(result.story.twine2.format).toBe('');
    expect(result.story.twine2.start).toBe('');
    expect(result.story.passages.find((p) => p.name === 'StoryData')?.text).toBe(`{"ifid":"${IFID2}", oops}`);
    expect(result.diagnostics.find((d) => d.message.startsWith('Cannot unmarshal'))).toMatchObject({
      level: 'error',
      file: 'b.tw',
      line: 1,
    });
    expectDerivedMetadata(result);
  });

  it('gives the same model when the Twee output is compiled again', async () => {
    const files = {
      'a.tw': `:: StoryData\n{"ifid":"${IFID}","format":"Harlowe"}\n:: Start\nhi`,
      'b.tw': ':: StoryData\n{oops}\n',
    };
    const first = await build(files, 'twee3');
    const again = await build({ 'out.tw': first.output });
    expect(again.story.twine2).toEqual((await build(files)).story.twine2);
  });
});

describe('T-03 and #236: a later StorySettings replaces everything an earlier one set', () => {
  it('drops the legacy IFID of the replaced StorySettings', async () => {
    const result = await build({
      'a.tw': `:: StorySettings\nifid:${IFID}\njquery:on\n:: Start\nhi`,
      'b.tw': ':: StorySettings\nundo:off\n',
    });
    expect(result.story.legacyIFID).toBe('');
    expect([...result.story.twine1.settings]).toEqual([['undo', 'off']]);
    expect(result.diagnostics.some((d) => d.message.includes('reusing "ifid" entry'))).toBe(false);
    expect(result.diagnostics.some((d) => d.message.startsWith('Story IFID not found'))).toBe(true);
    expectDerivedMetadata(result);
  });

  const twine1Story = (replacement: string): Record<string, string> => ({
    'a.tw': `:: StoryData\n{"ifid":"${IFID}"}\n:: StoryTitle\nReview\n:: StorySettings\nobfuscate:rot13\n:: Start\nHello world`,
    'b.tw': `:: StorySettings\n${replacement}`,
  });

  it.each([
    ['removes ROT13 when the replacement leaves it out', 'jquery:on', [['jquery', 'on']], 'Hello world'],
    [
      'keeps ROT13 when the replacement has it',
      'obfuscate:rot13\nmodernizr:on',
      [
        ['obfuscate', 'rot13'],
        ['modernizr', 'on'],
      ],
      'Hello world',
    ],
  ])('%s', async (_label, replacement, settings, decodedText) => {
    const result = await build(twine1Story(replacement), 'twine1-archive');
    expect([...result.story.twine1.settings]).toEqual(settings);
    const start = decompileHTML(result.output).story.passages.find((p) => p.name === 'Start');
    expect(start?.text).toBe(decodedText);
  });

  describe('in incremental builds', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'twee-ts-settings-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('gives the replacement settings in cold and warm builds', async () => {
      for (const [name, content] of Object.entries(twine1Story('jquery:on'))) writeFileSync(join(dir, name), content);
      const cache = new Map<string, FileCacheEntry>();
      const options = { sources: [dir], outputMode: 'json' as const, noRemote: true };
      const cold = await compileIncremental(options, cache);
      const warm = await compileIncremental(options, cache);
      for (const result of [cold, warm]) expect([...result.story.twine1.settings]).toEqual([['jquery', 'on']]);
    });
  });
});

describe('T-04 and JS-9: wrong-typed StoryData fields are reported, not dropped silently', () => {
  const storyData =
    `{"ifid":"${IFID}","format":"Harlowe","format-version":3,"options":"debug","start":["Begin"],` +
    '"zoom":"0.5","tag-colors":["red"]}';

  it('reports an error for each wrong-typed field, at the StoryData passage', async () => {
    const result = await build({ 'a.tw': `:: Begin\nhi\n:: StoryData\n${storyData}` });
    const errors = result.diagnostics.filter((d) => d.level === 'error');
    expect(errors.map((d) => [d.message, d.file, d.line])).toEqual([
      ['"StoryData" $["format-version"] must be a string, not a number (3); the field is left out.', 'a.tw', 3],
      ['"StoryData" $.options must be an array, not a string ("debug"); the field is left out.', 'a.tw', 3],
      ['"StoryData" $.start must be a string, not an array; the field is left out.', 'a.tw', 3],
      ['"StoryData" $.zoom must be a finite number, not a string ("0.5"); the field is left out.', 'a.tw', 3],
      ['"StoryData" $["tag-colors"] must be an object, not an array; the field is left out.', 'a.tw', 3],
    ]);
    expect(result.story.twine2.format).toBe('Harlowe');
    expect(result.story.twine2.formatVersion).toBe('');
  });

  it('reports an unknown field, which the normalized StoryData passage leaves out', async () => {
    const result = await build({ 'a.tw': `:: StoryData\n{"ifid":"${IFID}","creator":"Twine"}\n:: Start\nhi` }, 'twee3');
    expect(messages(result.diagnostics)).toEqual([
      'warning: "StoryData" $.creator is not a known field; it is left out.',
    ]);
    expect(result.output).not.toContain('creator');
  });

  it('reads a number format-version as no version only with the error that says so', async () => {
    const result = await build({
      'a.tw': `:: StoryData\n{"ifid":"${IFID}","format":"F","format-version":2}\n:: Start\nhi`,
    });
    expect(result.diagnostics.map((d) => d.level)).toEqual(['error']);
  });
});

describe('T-05: StoryData keys match regardless of letter case, as in Tweego', () => {
  it('reads IFID, Format and Format-Version, and warns about the spelling', async () => {
    const result = await build(
      { 'a.tw': `:: StoryData\n{"IFID":"${IFID}","Format":"Harlowe","Format-Version":"3.3.0"}\n:: Start\nhi` },
      'twee3',
    );
    expect(result.story.ifid).toBe(IFID);
    expect(result.story.twine2.format).toBe('Harlowe');
    expect(result.story.twine2.formatVersion).toBe('3.3.0');
    expect(messages(result.diagnostics)).toEqual([
      'warning: "StoryData" $.IFID is read as "ifid", since keys match regardless of letter case.',
      'warning: "StoryData" $.Format is read as "format", since keys match regardless of letter case.',
      'warning: "StoryData" $["Format-Version"] is read as "format-version", since keys match regardless of letter case.',
    ]);
    expect(result.output).toContain('"format-version": "3.3.0"');
  });

  it.each(['İfid', 'ıfıd'])('does not read %s as the IFID: Go folds İ and ı to no ASCII letter (#298)', async (key) => {
    const result = await build({ 'a.tw': `:: StoryData\n{"${key}":"${IFID}"}\n:: Start\nhi` });
    expect(result.story.ifid).not.toBe(IFID);
    expect(messages(result.diagnostics)).toContain(
      `warning: "StoryData" $["${key}"] is not a known field; it is left out.`,
    );
  });

  it('lets the last of two spellings win, as Go does', async () => {
    const result = await build({ 'a.tw': `:: StoryData\n{"ifid":"${IFID}","format":"A","FORMAT":"B"}\n:: Start\nhi` });
    expect(result.story.twine2.format).toBe('B');
  });
});

describe('T-09: media passage and font family names end at the first dot, as in Tweego', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-media-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('names bg.night.gif "bg" and gives My.Font.woff2 the family "My"', async () => {
    writeFileSync(join(dir, 'bg.night.gif'), Buffer.from('GIF89a'));
    writeFileSync(join(dir, 'My.Font.woff2'), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, 'story.tw'), `:: StoryData\n{"ifid":"${IFID}"}\n:: Start\n[img[bg]]`);
    const result = await compile({ sources: [dir], outputMode: 'json', noRemote: true });
    expect(result.story.passages.map((p) => p.name).sort()).toEqual(['My.Font.woff2', 'Start', 'StoryData', 'bg']);
    expect(result.story.passages.find((p) => p.name === 'My.Font.woff2')?.text).toContain('font-family: "My";');
  });
});

describe('T-12: orphans are the passages no chain of links reaches', () => {
  const inspect = (source: string): readonly string[] => {
    const builder = new StoryBuilder();
    for (const p of parseTwee(source).passages) builder.add(p, []);
    return storyInspect(builder.build()).orphans;
  };

  it('lists a passage that links only to itself', () => {
    expect(inspect(':: Start\nHi\n:: Loop\n[[Again->Loop]]')).toEqual(['Loop']);
  });

  it('lists a group that links only among itself, and what only it links to', () => {
    expect(inspect(':: Start\n[[A]]\n:: A\nEnd\n:: B\n[[C]]\n:: C\n[[B]] [[D]]\n:: D\nx')).toEqual(['B', 'C', 'D']);
  });

  it('counts links from info passages, which the story format shows without a link', () => {
    expect(inspect(':: Start\nHi\n:: StoryMenu\n[[Menu]]\n:: Menu\n[[Deep]]\n:: Deep\nx')).toEqual([]);
  });

  it('takes linear time on a long chain of passages and on long passage text', () => {
    const chain = Array.from({ length: 20_000 }, (_, i) => `:: P${i}\n[[P${i + 1}]]`).join('\n');
    const longText = ':: Start\n' + 'line [[Start]] <<goto "Start">>\n'.repeat(100_000);
    for (const source of [`:: Start\n[[P0]]\n${chain}`, longText]) {
      const started = performance.now();
      inspect(source);
      expect(performance.now() - started).toBeLessThan(5000);
    }
    expect(inspect(`:: Start\n[[P0]]\n${chain}`)).toEqual([]);
  });

  it('starts from the StoryData start passage', () => {
    expect(inspect(`:: StoryData\n{"ifid":"${IFID}","start":"Begin"}\n:: Begin\n[[A]]\n:: A\nx\n:: Start\ny`)).toEqual([
      'Start',
    ]);
  });
});

describe('T-13: duplicate and special passage diagnostics say where', () => {
  it('locates a duplicate at the new passage and names the old one', async () => {
    const result = await build({ 'a.tw': ':: Start\none\n\n:: X\nx', 'b.tw': '\n:: Start\ntwo' });
    expect(result.diagnostics).toContainEqual({
      level: 'warning',
      message: 'Replacing existing passage "Start" with duplicate. It replaces the one from a.tw (line 1).',
      file: 'b.tw',
      line: 2,
    });
  });

  it('locates StorySettings, StoryIncludes and IFID diagnostics', async () => {
    const result = await build({
      'a.tw': ':: Start\nx\n:: StorySettings\nno colon\nzoom:2\n:: StoryIncludes\nb.tw\n:: StoryData\n{"ifid":"bad"}',
    });
    expect(result.diagnostics.filter((d) => d.file === 'a.tw').map((d) => [d.level, d.line])).toEqual([
      ['warning', 3],
      ['warning', 3],
      ['warning', 6],
      ['error', 8],
    ]);
  });
});

describe('#241: object property names are kept as passage metadata keys', () => {
  const source = ':: Start {"__proto__":"kept","constructor":"control","position":"1,1"}\nHello';

  it('keeps __proto__ as an own key when parsing', () => {
    const [start] = parseTwee(source).passages;
    expect(start?.metadata && Object.keys(start.metadata)).toEqual(['__proto__', 'constructor', 'position']);
    expect(start?.metadata && Object.getPrototypeOf(start.metadata)).toBe(Object.prototype);
  });

  it('keeps it in JSON and Twee 3 output', async () => {
    const files = { 'a.tw': `:: StoryData\n{"ifid":"${IFID}"}\n${source}` };
    const json = JSON.parse((await build(files)).output) as { passages: { name: string; metadata?: unknown }[] };
    expect(JSON.stringify(json.passages.find((p) => p.name === 'Start')?.metadata)).toBe(
      '{"__proto__":"kept","constructor":"control","position":"1,1"}',
    );
    expect((await build(files, 'twee3')).output).toContain(
      ':: Start {"__proto__":"kept","constructor":"control","position":"1,1"}',
    );
  });

  it('keeps it through StoryBuilder', () => {
    const builder = new StoryBuilder();
    for (const p of parseTwee(source).passages) builder.add(p, []);
    expect(JSON.stringify(builder.get('Start')?.metadata)).toBe(
      '{"__proto__":"kept","constructor":"control","position":"1,1"}',
    );
  });
});

describe('the compile model is derived from its passages', () => {
  it('holds after special passages arrive in any order and in duplicate', async () => {
    const result = await build({
      'a.tw': `:: StoryTitle\n  Old  \n:: StorySettings\njquery:on\n:: StoryData\n{"ifid":"${IFID}","format":"A"}\n:: Start\nx`,
      'b.tw': `:: StoryData\n{"ifid":"${IFID}","tag-colors":{"__proto__":"red"}}\n:: StoryTitle\nNew`,
    });
    expectDerivedMetadata(result);
    expect(result.story.name).toBe('New');
    expect([...result.story.twine2.tagColors]).toEqual([['__proto__', 'red']]);
  });

  it('trims the story title at Go white space only', async () => {
    const result = await build({ 'a.tw': ':: StoryTitle\n\u0085\ufeffTitle\u00a0\n:: Start\nx' });
    expect(result.story.name).toBe('\ufeffTitle');
  });
});

describe('edge rules of the model and the Twee writer', () => {
  it('finds passages after code outside story.ts replaced one in place', () => {
    const story = createStory();
    storyAdd(story, { name: 'A', tags: [], text: 'a' }, []);
    storyAdd(story, { name: 'B', tags: [], text: 'b' }, []);
    story.passages[0] = { name: 'Z', tags: [], text: 'z' };
    expect(storyHas(story, 'A')).toBe(false);
    expect(storyHas(story, 'Z')).toBe(true);
    storyAdd(story, { name: 'A', tags: [], text: 'again' }, []);
    expect(story.passages.map((p) => p.name)).toEqual(['Z', 'B', 'A']);
  });

  it('reads a StoryData zoom of 0 as the default zoom, as Tweego does', () => {
    const decoded = decodeStoryData('{"zoom":0}');
    expect(decoded.ok && decoded.twine2.zoom).toBe(1);
  });

  it('lower-cases StorySettings keys and values as Go does, per code point', () => {
    const story = createStory();
    unmarshalStorySettings(story, `\u0130F\u0130D:${IFID}\nJQUERY:ON\n\u03a3\u0391\u03a3:\u0391\u03a3`, []);
    expect(story.legacyIFID).toBe(IFID);
    expect([...story.twine1.settings]).toEqual([
      ['jquery', 'on'],
      ['\u03c3\u03b1\u03c3', '\u03b1\u03c3'],
    ]);
  });

  it('warns once, with the count, about the metadata Twee 1 leaves out', () => {
    const builder = new StoryBuilder();
    builder.add({ name: 'A', tags: [], text: 'a', metadata: { position: '1,1' } }, []);
    builder.add({ name: 'B', tags: [], text: 'b', metadata: { size: '2,2' } }, []);
    const diagnostics: Diagnostic[] = [];
    toTwee(builder.build(), 'twee1', { diagnostics });
    expect(messages(diagnostics)).toEqual([
      'warning: Twee 1 has no passage metadata, so the metadata (such as "position") of 2 passages are left out.',
    ]);
  });

  it('says what reads back differently: a tag that holds a header, metadata keys read as others, a CR', () => {
    const builder = new StoryBuilder();
    builder.add({ name: 'A', tags: ['a\n::b'], text: 'x' }, []);
    builder.add({ name: 'B', tags: [], text: 'y', metadata: { Position: '1,1', position: '2,2' } }, []);
    builder.add({ name: 'C', tags: [], text: 'one\rtwo' }, []);
    const diagnostics: Diagnostic[] = [];
    toTwee(builder.build(), 'twee3', { diagnostics });
    expect(messages(diagnostics)).toEqual([
      'warning: Passage "A" cannot be written as Twee that reads back the same: its tag "a\\n::b" is empty or has whitespace, which splits tags in Twee.',
      'warning: Passage "B" cannot be written as Twee that reads back the same: its metadata reads back as {"position":"2,2"}.',
      'warning: Passage "C" cannot be written as Twee that reads back the same: its text reads back differently (Twee reads a carriage return as a line break).',
    ]);
  });

  it('reports a repeated metadata key and keeps the last value', () => {
    const { passages, diagnostics } = parseTwee(':: A {"x":"1","x":"2"}\nbody');
    expect(passages[0]?.metadata).toEqual({ x: '2' });
    expect(diagnostics.map((d) => d.message)).toEqual([
      'load <inline>: line 1: Passage metadata: $.x repeats a key; the last one is used.',
    ]);
  });
});

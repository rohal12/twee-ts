/**
 * Twine 1 `obfuscate:rot13` output and decompiling, checked against what Twine 1.4 writes (`tiddlywiki.py`,
 * `Tiddler.toHtml()`) and how its `engine.js` (Sugarcane, Jonah, Responsive) reads the tiddlers back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'htmlparser2';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';

type HtmlDocument = ReturnType<typeof parseDocument>;
type HtmlNode = HtmlDocument['children'][number];
type EnginePassage = readonly [name: string, tags: readonly string[], text: string];

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Twine 1.4 engine.js `rot13()`. */
function rot13(s: string): string {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const code = c.charCodeAt(0) + 13;
    return String.fromCharCode((c <= 'Z' ? 90 : 122) >= code ? code : code - 26);
  });
}

/** Twine 1.4 engine.js `Passage.unescapeLineBreaks()`. */
function unescapeLineBreaks(s: string): string {
  return s.replace(/\\n/gm, '\n').replace(/\\t/gm, '\t').replace(/\\s/gm, '\\').replace(/\r/gm, '');
}

function tiddlerElements(html: string): HtmlNode[] {
  const found: HtmlNode[] = [];
  const visit = (node: HtmlNode): void => {
    if ('attribs' in node && node.name === 'div' && 'tiddler' in node.attribs) found.push(node);
    if ('children' in node) node.children.forEach(visit);
  };
  parseDocument(html).children.forEach(visit);
  return found;
}

/**
 * Read the tiddlers of `html` the way Twine 1.4's engine.js does (`Tale()` and `Passage()`): with `obfuscate:rot13`,
 * every tiddler but `StorySettings` and the ones whose raw `tags` hold `Twine.image` gets its name decoded, and
 * every non-image tiddler its tags and text; the text is the `nodeValue` of the tiddler's first child node.
 */
function readLikeEngine(html: string): EnginePassage[] {
  const tiddlers = tiddlerElements(html);
  const attribute = (node: HtmlNode, name: string): string | undefined =>
    'attribs' in node ? node.attribs[name] : undefined;
  const settings = tiddlers.find((node) => attribute(node, 'tiddler') === 'StorySettings');
  const settingsText = settings && 'children' in settings ? firstChildValue(settings) : '';
  const obfuscate = unescapeLineBreaks(settingsText)
    .split('\n')
    .some((line) => line.toLowerCase().replace(/\s/g, '') === 'obfuscate:rot13');

  return tiddlers.map((node) => {
    const raw = attribute(node, 'tiddler') ?? '';
    const rawTags = attribute(node, 'tags') ?? '';
    const isImage = rawTags.includes('Twine.image');
    const decode = obfuscate && !isImage;
    const name = obfuscate && raw !== 'StorySettings' && !isImage ? rot13(raw) : raw;
    const tags = (decode ? rot13(rawTags) : rawTags).split(' ').filter((tag) => tag !== '');
    const text = unescapeLineBreaks(firstChildValue(node));
    return [name, tags, decode && !tags.includes('Twine.image') ? rot13(text) : text] as const;
  });
}

/** engine.js: `b.firstChild ? b.firstChild.nodeValue : ""` (a comment's `nodeValue` is its text). */
function firstChildValue(node: HtmlNode): string {
  if (!('children' in node)) return '';
  const first = node.children[0];
  return first !== undefined && 'data' in first ? first.data : '';
}

function passages(story: { readonly passages: readonly { name: string; tags: string[]; text: string }[] }) {
  return story.passages.map((p) => [p.name, p.tags, p.text] as const);
}

async function archive(content: string) {
  return compile({ sources: [{ filename: 'story.tw', content }], outputMode: 'twine1-archive' });
}

const OBFUSCATED = [
  ':: StoryTitle',
  'My Story',
  '',
  ':: StoryData',
  `{"ifid":"${IFID}"}`,
  '',
  ':: StorySettings',
  'obfuscate:rot13',
  '',
  ':: Start [intro Twine.private-not]',
  'Hello [[Next]]',
  '',
  ':: Next',
  'The end.\nSecond line',
  '',
  ':: a --> b --!> c',
  'Secret text',
  '',
  ':: pic [Twine.image]',
  PNG,
  '',
].join('\n');

describe('Twine 1 rot13 obfuscation output', () => {
  it('encodes the name, tags and text of each tiddler, as Twine 1.4 does', async () => {
    const result = await archive(OBFUSCATED);
    const start = tiddlerElements(result.output).find(
      (node) => 'attribs' in node && node.attribs['tiddler'] === 'Fgneg',
    );

    expect(result.output).toMatch(
      /<div tiddler="Fgneg" tags="vageb Gjvar.cevingr-abg" [^>]*>Uryyb \[\[Arkg\]\]<\/div>/,
    );
    expect(start && 'children' in start ? start.children.map((child) => child.type) : []).toEqual(['text']);
    expect(result.output).toMatch(/<div tiddler="FgbelGvgyr" tags="" [^>]*>Zl Fgbel<\/div>/);
  });

  it('writes no comment into the tiddlers', async () => {
    expect((await archive(OBFUSCATED)).output).not.toContain('<!--');
  });

  it('leaves StorySettings and Twine.image tiddlers unencoded', async () => {
    const result = await archive(OBFUSCATED);

    expect(result.output).toMatch(/<div tiddler="StorySettings" tags="" [^>]*>obfuscate:rot13<\/div>/);
    expect(result.output).toMatch(
      /<div tiddler="pic" tags="Twine.image" [^>]*>data:image\/png;base64,iVBORw0KGgo=<\/div>/,
    );
  });

  it('gives Twine 1.4 engine.js back the original passages', async () => {
    const result = await archive(OBFUSCATED);
    const read = readLikeEngine(result.output).filter(([name]) => name !== 'StorySettings');

    expect(read).toEqual(passages(result.story).filter(([name]) => name !== 'StorySettings'));
    expect(read.map(([name]) => name)).toEqual(['StoryTitle', 'StoryData', 'Start', 'Next', 'a --> b --!> c', 'pic']);
  });

  it('gives Twine 1.4 engine.js back the original passages when not obfuscating', async () => {
    const result = await archive(OBFUSCATED.replace('obfuscate:rot13', 'obfuscate:off'));

    expect(readLikeEngine(result.output)).toEqual(passages(result.story));
  });
});

describe('Twine 1 rot13 obfuscation decompiling', () => {
  it('decodes what Twine 1.4 writes for an obfuscated story', () => {
    const twine14 =
      '<div id="storeArea"><div tiddler="FgbelGvgyr">Zl Fgbel</div><div tiddler="StorySettings">obfuscate:rot13</div>' +
      '<div tiddler="Fgneg" tags="vageb gjb">Uryyb [[Arkg]]\\nYvar</div>' +
      `<div tiddler="pic" tags="Twine.image">${PNG}</div></div>`;
    const { story, diagnostics } = decompileHTML(twine14);

    expect(passages(story)).toEqual([
      ['StoryTitle', [], 'My Story'],
      ['StorySettings', [], 'obfuscate:rot13'],
      ['Start', ['intro', 'two'], 'Hello [[Next]]\nLine'],
      ['pic', ['Twine.image'], PNG],
    ]);
    expect(story.name).toBe('My Story');
    expect(diagnostics).toEqual([]);
  });

  it('round-trips names holding HTML comment delimiters, with and without obfuscation', async () => {
    for (const settings of ['obfuscate:rot13', 'obfuscate:off']) {
      const result = await archive(OBFUSCATED.replace('obfuscate:rot13', settings));
      expect(passages(decompileHTML(result.output).story)).toEqual(passages(result.story));
    }
  });
});

// --- Property-style round trip: names, tags and text from a nasty alphabet ---

const NAME_PIECES = [
  'a',
  'Z',
  'm',
  'N',
  'Start',
  ' ',
  '[',
  ']',
  '{',
  '}',
  '\\',
  '"',
  "'",
  '<',
  '>',
  '&',
  '&amp;',
  '-->',
  '--!>',
  '<!--',
  '</div>',
  '</script>',
  '\\n',
  '\\s',
  '\\t',
  'é',
  '😀',
  '|',
  '::',
  '/*',
  '*/',
  '%',
  '=',
  '\t',
] as const;
const TEXT_PIECES = [...NAME_PIECES, '\n', '\n\n', '[[Start]]', '<<if>>'] as const;
const TAG_PIECES = NAME_PIECES.filter((piece) => !/\s/.test(piece));

/** A seeded pseudo-random number generator (mulberry32), so a failure can be replayed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  const item = items[Math.floor(next() * items.length)];
  if (item === undefined) throw new Error('pick() from an empty list');
  return item;
}

function phrase(next: () => number, pieces: readonly string[], max: number): string {
  return Array.from({ length: 1 + Math.floor(next() * max) }, () => pick(next, pieces)).join('');
}

const RESERVED = new Set(['StoryTitle', 'StoryData', 'StorySettings', 'StoryIncludes']);

/** Twee source for a random story that Twee can represent: trimmed names, and no text line starting with `::`. */
function randomTwee(seed: number, settings: string): string {
  const next = random(seed);
  const names = new Set<string>();
  while (names.size < 8) {
    const name = phrase(next, NAME_PIECES, 6).trim();
    if (name !== '' && !RESERVED.has(name)) names.add(name);
  }
  const escape = (s: string): string => s.replace(/[\\[\]{}]/g, '\\$&');
  const text = (): string =>
    phrase(next, TEXT_PIECES, 12)
      .split('\n')
      .map((line) => (line.startsWith('::') ? `x${line}` : line))
      .join('\n')
      .trim() || 'x';
  const header = (name: string, tags: readonly string[]): string =>
    `:: ${escape(name)}${tags.length > 0 ? ` [${escape(tags.join(' '))}]` : ''}`;
  return [
    `:: StoryTitle\n${text()}\n`,
    `:: StoryData\n{"ifid":"${IFID}"}\n`,
    `:: StorySettings\n${settings}\n`,
    ...[...names].map((name) => {
      const tags = Array.from({ length: Math.floor(next() * 3) }, () => phrase(next, TAG_PIECES, 3));
      return `${header(name, tags)}\n${text()}\n`;
    }),
    `:: picture [Twine.image]\n${PNG}\n`,
  ].join('\n');
}

describe('Twine 1 round trip from a nasty alphabet', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-twine1-roundtrip-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withoutCreated = (html: string): string => html.replace(/ created="\d+"/g, '');

  for (const settings of ['obfuscate:rot13', 'obfuscate:off']) {
    it(`compiles, decompiles and compiles again to the same story (${settings})`, async () => {
      for (let seed = 1; seed <= 25; seed++) {
        const first = await archive(randomTwee(seed, settings));
        expect(first.diagnostics, `seed ${seed}`).toEqual([]);
        expect(first.story.passages, `seed ${seed}`).toHaveLength(12);

        expect(passages(decompileHTML(first.output).story), `seed ${seed}`).toEqual(passages(first.story));
        expect(
          readLikeEngine(first.output).filter(([name]) => name !== 'StorySettings'),
          `seed ${seed}`,
        ).toEqual(passages(first.story).filter(([name]) => name !== 'StorySettings'));

        const file = join(dir, `story-${seed}.html`);
        writeFileSync(file, first.output);
        const second = await compile({ sources: [file], outputMode: 'twine1-archive' });
        expect(second.diagnostics, `seed ${seed}`).toEqual([]);
        expect(withoutCreated(second.output), `seed ${seed}`).toBe(withoutCreated(first.output));
      }
    });
  }
});

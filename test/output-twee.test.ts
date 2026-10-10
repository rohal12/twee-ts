/**
 * Twee output that cannot read back the same: warnings, and the indented `::` lines of stylesheets and scripts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { parseTwee } from '../src/parser.js';
import { fullAttrEscape, htmlEscape } from '../src/escape.js';
import type { Diagnostic, OutputMode } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

interface HtmlPassage {
  readonly name: string;
  readonly tags?: readonly string[];
  readonly text: string;
}

/** Twine 2 archive HTML holding `passages`, with an optional story stylesheet and script. */
function twine2Html(passages: readonly HtmlPassage[], code: { css?: string; js?: string } = {}): string {
  const data = passages
    .map(
      (p, i) =>
        `<tw-passagedata pid="${i + 1}" name="${fullAttrEscape(p.name)}" tags="${fullAttrEscape((p.tags ?? []).join(' '))}">${htmlEscape(p.text)}</tw-passagedata>`,
    )
    .join('');
  return (
    `<tw-storydata name="S" startnode="1" ifid="${IFID}" format="SugarCube" format-version="2.37.3">` +
    `<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">${code.css ?? ''}</style>` +
    `<script role="script" id="twine-user-script" type="text/twine-javascript">${code.js ?? ''}</script>` +
    `${data}</tw-storydata>`
  );
}

function warnings(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter((d) => d.level === 'warning').map((d) => d.message);
}

function texts(passages: readonly { name: string; tags: readonly string[]; text: string }[]) {
  return passages.map((p) => [p.name, p.tags, p.text] as const);
}

describe('Twee output round trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-twee-output-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function toTwee(html: string, outputMode: OutputMode = 'twee3') {
    const file = join(dir, 'story.html');
    writeFileSync(file, html);
    return compile({ sources: [file], outputMode });
  }

  async function recompile(twee: string) {
    const file = join(dir, 'story.tw');
    writeFileSync(file, twee);
    return compile({ sources: [file], outputMode: 'twee3' });
  }

  it('indents a stylesheet line starting with :: so the stylesheet reads back whole, and says so', async () => {
    const css = 'body { color: red; }\n::selection { background: gold; }\n::-webkit-scrollbar { width: 0; }';
    const twee = await toTwee(twine2Html([{ name: 'Start', text: 'Hello' }], { css }));

    expect(twee.diagnostics).toEqual([
      {
        level: 'warning',
        message:
          'Passage "Story Stylesheet": lines 2, 3 of its text start with "::", which Twee reads as a passage header; they were written indented by one space.',
      },
    ]);
    expect(twee.output).toContain(
      ':: Story Stylesheet [stylesheet]\nbody { color: red; }\n ::selection { background: gold; }\n ::-webkit-scrollbar { width: 0; }\n',
    );

    const back = await recompile(twee.output);
    expect(back.diagnostics).toEqual([]);
    expect(texts(back.story.passages).filter(([name]) => name !== 'StoryData')).toEqual([
      ['StoryTitle', [], 'S'],
      [
        'Story Stylesheet',
        ['stylesheet'],
        'body { color: red; }\n ::selection { background: gold; }\n ::-webkit-scrollbar { width: 0; }',
      ],
      ['Start', [], 'Hello'],
    ]);
  });

  it('indents a script line starting with ::', async () => {
    const js = 'const css = `\n::selection {}\n::placeholder {}`;';
    const twee = await toTwee(twine2Html([{ name: 'Start', text: 'Hello' }], { js }));

    expect(warnings(twee.diagnostics)).toEqual([
      'Passage "Story JavaScript": lines 2, 3 of its text start with "::", which Twee reads as a passage header; they were written indented by one space.',
    ]);
    expect(twee.output).toContain('const css = `\n ::selection {}\n ::placeholder {}`;');
  });

  it('warns about a story passage line starting with ::, which it writes as it is', async () => {
    const twee = await toTwee(twine2Html([{ name: 'Start', text: 'Hello\n:: Not a passage\nBye' }]));

    expect(warnings(twee.diagnostics)).toEqual([
      'Passage "Start" cannot be written as Twee that reads back the same: line 2 of its text starts with "::", which Twee reads as a passage header.',
    ]);
    expect(twee.output).toContain(':: Start\nHello\n:: Not a passage\nBye\n');
  });

  it('warns about names that the Twee parser would change', async () => {
    const twee = await toTwee(
      twine2Html([
        { name: 'Start', text: 'Hello' },
        { name: ' Padded ', text: 'a' },
        { name: 'Two\nlines', text: 'b' },
      ]),
    );

    expect(warnings(twee.diagnostics)).toEqual([
      'Passage " Padded " cannot be written as Twee that reads back the same: its name has leading or trailing whitespace, which Twee drops.',
      'Passage "Two\\nlines" cannot be written as Twee that reads back the same: its name has a line break, which ends a Twee passage header.',
    ]);
  });

  it('warns about names and tags that Twee 1 cannot escape, but not in Twee 3', async () => {
    const html = twine2Html([
      { name: 'Start', text: 'Hello' },
      { name: 'a[b]', tags: ['x{y}'], text: 'a' },
    ]);
    const twee1 = await toTwee(html, 'twee1');
    const twee3 = await toTwee(html, 'twee3');

    expect(warnings(twee1.diagnostics)).toEqual([
      'Passage "a[b]" cannot be written as Twee that reads back the same: its name has "[", "]", "{", "}" or "\\", which Twee 1 cannot escape.',
      'Passage "a[b]" cannot be written as Twee that reads back the same: its tag "x{y}" has "[", "]", "{", "}" or "\\", which Twee 1 cannot escape.',
    ]);
    expect(twee3.diagnostics).toEqual([]);
  });

  it('warns about a tag with whitespace, which only the API can make', async () => {
    const result = await compile({
      sources: [{ filename: 'story.tw', content: `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start [a]\nHi\n` }],
      outputMode: 'twee3',
      tagAliases: { a: 'two words' },
    });

    expect(warnings(result.diagnostics)).toEqual([
      'Passage "Start" cannot be written as Twee that reads back the same: its tag "two words" is empty or has whitespace, which splits tags in Twee.',
    ]);
  });

  it('writes the tags after aliasing: the alias and its target (docs/tag-aliases.md)', async () => {
    const result = await compile({
      sources: [{ filename: 'story.tw', content: `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Utils [library]\nx\n` }],
      outputMode: 'twee3',
      tagAliases: { library: 'script' },
    });

    expect(result.output).toContain(':: Utils [library script]\n');
  });

  it('reports nothing for a story that reads back the same', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'story.tw',
          content: `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start [a\\[b]\nText with :: inside\n  ::indented\n\n:: Code [script]\n// :: not at the start\n`,
        },
      ],
      outputMode: 'twee3',
    });

    expect(result.diagnostics).toEqual([]);
  });

  // --- Property-style: any passage that would not read back the same gets a warning ---

  const NAME_PIECES = ['a', 'Z', ' ', '\t', '\n', '[', ']', '{', '}', '\\', '"', '<', '&', '::', ':', 'é', '😀', '/*'];
  const TEXT_PIECES = [...NAME_PIECES, '\n::', '\n', 'body {}', '::selection'];
  const TAG_PIECES = NAME_PIECES.filter((piece) => !/\s/.test(piece));

  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function phrase(next: () => number, pieces: readonly string[], max: number): string {
    return Array.from({ length: 1 + Math.floor(next() * max) }, () => pieces[Math.floor(next() * pieces.length)]).join(
      '',
    );
  }

  // One random passage and stylesheet per story: a passage Twee misreads can take the passages after it along,
  // which their own warnings (or lack of them) cannot be about.
  for (const outputMode of ['twee3', 'twee1'] as const) {
    it(`warns whenever ${outputMode} output does not read a passage back the same`, async () => {
      let checked = 0;
      let warned = 0;
      for (let seed = 1; seed <= 150; seed++) {
        const next = random(seed);
        const name = phrase(next, NAME_PIECES, 4);
        if (name.trim() === '' || name.trim() === 'Start') continue;
        const tags = Array.from({ length: Math.floor(next() * 3) }, () => phrase(next, TAG_PIECES, 2));
        const text = phrase(next, TEXT_PIECES, 8).trim() || 'x';
        const css = phrase(next, TEXT_PIECES, 8).trim();
        const html = twine2Html(
          [
            { name: 'Start', text: 'Hi' },
            { name, tags, text },
          ],
          { css },
        );
        const twee = await toTwee(html, outputMode);
        const read = new Map(parseTwee(twee.output).passages.map((p) => [p.name, p]));

        for (const p of twee.story.passages.filter((q) => q.name === name || q.tags.includes('stylesheet'))) {
          const label = `Passage ${JSON.stringify(p.name)}`;
          if (warnings(twee.diagnostics).some((message) => message.startsWith(label))) {
            warned++;
            continue;
          }
          const back = read.get(p.name);
          expect([back?.name, back?.tags, back?.text], `seed ${seed}: ${label}`).toEqual([p.name, p.tags, p.text]);
          checked++;
        }
      }
      // Both kinds of passages must have come up.
      expect(checked).toBeGreaterThan(30);
      expect(warned).toBeGreaterThan(30);
    });
  }
});

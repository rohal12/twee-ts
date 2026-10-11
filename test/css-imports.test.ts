/**
 * Which `@import` rules the joined story stylesheet makes ineffective (#352): every kind of rule and token that can
 * come before an import, within one stylesheet source and across sources, through the scanner itself and through
 * every entry point that reports it (HTML, archive and JSON output, lint; passages and `.css` inputs), each with the
 * join its output makes. The table (test/helpers/css-imports.ts) is checked against real browsers in
 * css-imports-browser.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import { ineffectiveImportDiagnostics, joinWithLineFeeds } from '../src/css-imports.js';
import type { JoinedStylesheet } from '../src/css-imports.js';
import { lint } from '../src/lint.js';
import type { CompileOptions, Diagnostic } from '../src/types.js';
import { IMPORT, PREDECESSORS, sourcesOf } from './helpers/css-imports.js';
import type { Predecessor } from './helpers/css-imports.js';

const IFID = '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}';
const base = (): Pick<CompileOptions, 'formatPaths' | 'useTweegoPath' | 'noRemote'> => ({
  formatPaths: ['test/fixtures/storyformats-sugarcube'],
  useTweegoPath: false,
  noRemote: true,
});
const STORY = `:: StoryTitle\nT\n\n:: StoryData\n${IFID}\n\n:: Start\nHello\n`;

const importWarnings = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics.filter((d) => d.message.includes('@import')).map((d) => d.message);
const labelled = (texts: readonly string[]) => texts.map((text, i) => ({ label: `sheet ${String(i + 1)}`, text }));

/** The sources joined as HTML and archive output join them: a comment names each source, and ends a line. */
function joinedLikeHtml(texts: readonly string[]): JoinedStylesheet {
  const parts: { start: number }[] = [];
  let text = '';
  texts.forEach((source, i) => {
    text += `${i > 0 && !text.endsWith('\n') ? '\n' : ''}${texts.length > 1 ? `/* twine-user-stylesheet #${String(i + 1)}: "s" */\n` : ''}`;
    parts.push({ start: text.length });
    text += source;
  });
  return { text, parts };
}
const joinedLikeJson = (texts: readonly string[]): JoinedStylesheet => joinWithLineFeeds(labelled(texts));

const diagnose = (texts: readonly string[], joined = joinedLikeHtml): Diagnostic[] =>
  ineffectiveImportDiagnostics(labelled(texts), joined(texts));
const names = (found: readonly Diagnostic[]): string[] => found.map((d) => d.message.slice(0, 7));

/** The cases that read the same in one source and in a source each. */
const SINGLE = PREDECESSORS.filter((p) => p.where !== 'sources');

describe('what may come before an @import (#352)', () => {
  it('lists each kind of predecessor once', () => {
    const all = PREDECESSORS.map((p) => p.name);

    expect(new Set(all).size).toBe(all.length);
  });

  it.each(SINGLE.map((p) => [p.name, p] as const))('%s, in one source', (_name, p) => {
    expect(diagnose(sourcesOf(p.css, false)).map((d) => d.level)).toEqual(p.blocks ? ['warning'] : []);
  });

  it.each(PREDECESSORS.map((p) => [p.name, p] as const))('%s, before a source of its own', (_name, p) => {
    expect(names(diagnose(sourcesOf(p.css, true)))).toEqual(p.blocks ? ['sheet 2'] : []);
    expect(names(diagnose(sourcesOf(p.css, true), joinedLikeJson))).toEqual(
      (p.jsonBlocks ?? p.blocks) ? ['sheet 2'] : [],
    );
  });

  it('counts the imports of a source', () => {
    const found = diagnose(['a {}', `${IMPORT}\n${IMPORT}`, IMPORT]);

    expect(found.map((d) => d.message.slice(0, 21))).toEqual(['sheet 2 has 2 @import', 'sheet 3 has an @impor']);
  });

  it('names a namespace rule as the rule an import cannot follow (the reported case of #352)', () => {
    const found = diagnose([
      '@namespace svg url("http://www.w3.org/2000/svg");',
      '@import url("data:text/css,body%7B%7D");',
    ]);

    expect(found.map((d) => d.message)).toEqual([expect.stringContaining('sheet 2 has an @import rule')]);
  });

  it('keeps an import inside a block of its own source out of the report', () => {
    expect(diagnose(['@media print { @import "x.css"; }'])).toEqual([]);
  });

  it('keeps an import that is no import by itself out of the report', () => {
    expect(diagnose(['@import;', '@import foo;', '@import "a.css" {}', '@import url(a"b);'])).toEqual([]);
  });

  it('never takes @charset for a rule (CSS Syntax: an unknown at-rule), also after an import and from a later source', () => {
    const found = diagnose(['@import "m0.css";', '@charset "UTF-8";\n@import "m1.css";']);

    expect(found).toEqual([]);
  });

  it.each([
    ['an import without its semicolon, then a rule of the next source', ['@import "a.css"', 'a { b: c }']],
    ['an import without its semicolon, then a block of the next source', ['@import "a.css"', '@media print { }']],
  ])('reports the import itself for %s', (_name, texts) => {
    expect(names(diagnose(texts))).toEqual(['sheet 1']);
  });

  it('reads a url as the tokenizer does: it runs on to the next parenthesis, across sources', () => {
    const threeSources = diagnose(['url(', 'a[b="}"] {}', '@import "m2.css";']);
    const closed = diagnose(['url(', 'a.b) {}', '@import "m2.css";']);

    expect([names(threeSources), names(closed)]).toEqual([['sheet 3'], []]);
  });

  it('reads a url token by its decoded name, not by the characters before the parenthesis', () => {
    const escaped = diagnose(['@import \\75 rl(a{b.css);', '@import "m1.css";']);
    const hash = diagnose(['#url({) {}', '@import "m1.css";']);

    expect([escaped, names(hash)]).toEqual([[], ['sheet 2']]);
  });

  it('takes a comment end that is no comment for the delimiters it is, across sources', () => {
    // `*/` then `a {}` read as `* / a`, a selector no browser accepts: the rule is dropped and the import is kept.
    expect(diagnose(['*/', 'a {}', IMPORT])).toEqual([]);
    expect(diagnose(['*/', 'a {}', IMPORT], joinedLikeJson)).toEqual([]);
  });

  it('ends a comment that a source leaves open where the output does', () => {
    const texts = ['/* note', '@import "m1.css";'];

    expect([names(diagnose(texts)), names(diagnose(texts, joinedLikeJson))]).toEqual([[], ['sheet 2']]);
  });

  it.each([
    'a {} /* x',
    '"x',
    'a { b: "x\\',
    'a { b: "x\\\ny" }',
    'a { b: "x\\\r\ny" }',
    '\\',
    '\\\r\n',
    '@',
    '@1 {}',
    '-',
    '--x',
    '1e',
    '1e+',
    '1e+2',
    '1.',
    '1.e',
    '.',
    '+',
    '#',
    '<',
    '<!-',
    '--',
    'a:not(',
    'url(',
    'url( x',
    'url(x\\',
    "url('x",
    'url(x y',
    'url(x y)',
    'url(x ',
    'url(a"b\\) c)',
    'url(a\\\nb)',
    'url(x\u0001)',
    'url(\\',
    'u\\',
    'a\\75',
    'a\\000075 x',
    '\\10ffff ',
    '\\1F600 x',
    '\\😀',
    '('.repeat(200),
    `a{${'('.repeat(100)}${')'.repeat(100)}}`,
    'a'.repeat(100),
    `.${'\\61 '.repeat(100)}b {}`,
    `@${'a'.repeat(100)} {}`,
  ])('reads %j to its end without a warning', (text) => {
    expect(diagnose([text])).toEqual([]);
  });
});

describe('every entry point reports what the scanner does (#352)', () => {
  const sheetPassages = (texts: readonly string[]): string =>
    texts.map((text, i) => `\n:: Sheet${String(i + 1)} [stylesheet]\n${text}\n`).join('');

  const viaPassages = (p: Predecessor) => ({
    sources: [{ filename: 'story.tw', content: STORY + sheetPassages(sourcesOf(p.css, true)) }],
  });
  const viaFiles = (p: Predecessor) => ({
    sources: [
      { filename: 'story.tw', content: STORY },
      ...sourcesOf(p.css, true).map((content, i) => ({ filename: `${String(i + 1).padStart(2, '0')}.css`, content })),
    ],
  });
  type Sources = Pick<CompileOptions, 'sources'>;
  /**
   * How many warnings each entry gives for a case: HTML and archive output join the stylesheets with a comment, JSON
   * output with a line feed, and lint reports for the Twine 2 HTML output, so it gives the warnings of HTML's join.
   */
  const ENTRIES = [
    [
      'HTML output',
      async (o: Sources) => (await compile({ ...base(), ...o })).diagnostics,
      (p: Predecessor) => p.blocks,
    ],
    [
      'archive output',
      async (o: Sources) => (await compile({ ...base(), ...o, outputMode: 'twine2-archive' })).diagnostics,
      (p: Predecessor) => p.blocks,
    ],
    [
      'JSON output',
      async (o: Sources) => (await compile({ ...base(), ...o, outputMode: 'json' })).diagnostics,
      (p: Predecessor) => p.jsonBlocks ?? p.blocks,
    ],
    ['lint', async (o: Sources) => (await lint({ ...base(), ...o })).diagnostics, (p: Predecessor) => p.blocks],
  ] as const;
  const KINDS = [
    ['stylesheet passages', viaPassages],
    ['.css inputs', viaFiles],
  ] as const;

  describe.each(ENTRIES)('%s', (_entry, run, expected) => {
    describe.each(KINDS)('from %s', (_kind, sourcesFor) => {
      it.each(PREDECESSORS.map((p) => [p.name, p] as const))('%s', async (_name, p) => {
        const diagnostics = await run(sourcesFor(p));

        expect(importWarnings(diagnostics)).toHaveLength(expected(p) ? 1 : 0);
      });
    });
  });

  it('names the stylesheet passage that holds the ignored import', async () => {
    const content = STORY + sheetPassages(['@namespace x url(y);', IMPORT]);
    const diagnostics = (await compile({ ...base(), sources: [{ filename: 'story.tw', content }] })).diagnostics;

    expect(importWarnings(diagnostics)).toEqual([expect.stringContaining('Stylesheet passage "Sheet2"')]);
  });
});

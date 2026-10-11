/**
 * Which `@import` rules the joined story stylesheet makes ineffective (#352): every kind of rule and token that can
 * come before an import, within one stylesheet source and across sources, through the scanner itself and through
 * every entry point that reports it (HTML, archive and JSON output, lint; passages and `.css` inputs). The table
 * (test/helpers/css-imports.ts) is checked against Chromium in css-imports-browser.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import { ineffectiveImportDiagnostics } from '../src/css-imports.js';
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
const labelled = (texts: readonly string[]) => texts.map((text, i) => ({ label: `sheet ${i + 1}`, text }));
/** The cases that read the same in one source and in a source each. */
const SINGLE = PREDECESSORS.filter((p) => p.where !== 'sources');

describe('what may come before an @import (#352)', () => {
  it('lists each kind of predecessor once', () => {
    const names = PREDECESSORS.map((p) => p.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it.each(SINGLE.map((p) => [p.name, p] as const))('%s, in one source', (_name, p) => {
    const found = ineffectiveImportDiagnostics(labelled(sourcesOf(p.css, false)));

    expect(found.map((d) => d.level)).toEqual(p.blocks ? ['warning'] : []);
  });

  it.each(PREDECESSORS.map((p) => [p.name, p] as const))('%s, before a source of its own', (_name, p) => {
    const found = ineffectiveImportDiagnostics(labelled(sourcesOf(p.css, true)));

    expect(found.map((d) => d.message.slice(0, 7))).toEqual(p.blocks ? ['sheet 2'] : []);
  });

  it('counts the imports of a source', () => {
    const found = ineffectiveImportDiagnostics(labelled(['a {}', `${IMPORT}\n${IMPORT}`, IMPORT]));

    expect(found.map((d) => d.message.slice(0, 21))).toEqual(['sheet 2 has 2 @import', 'sheet 3 has an @impor']);
  });

  it('names a namespace rule as the rule an import cannot follow (the reported case of #352)', () => {
    const found = ineffectiveImportDiagnostics(
      labelled(['@namespace svg url("http://www.w3.org/2000/svg");', '@import url("data:text/css,body%7B%7D");']),
    );

    expect(found.map((d) => d.message)).toEqual([expect.stringContaining('sheet 2 has an @import rule')]);
  });

  it.each([
    ['an import with a block', ['@import "a.css" {}']],
    ['an import without its semicolon, then a rule of the next source', ['@import "a.css"', 'a { b: c }']],
  ])('reports the import itself for %s', (_name, texts) => {
    const found = ineffectiveImportDiagnostics(labelled(texts));

    expect(found.map((d) => d.message.slice(0, 7))).toEqual(['sheet 1']);
  });

  it('keeps an import inside a block of its own source out of the report', () => {
    const found = ineffectiveImportDiagnostics(labelled(['@media print { @import "x.css"; }']));

    expect(found).toEqual([]);
  });

  it('treats an @charset away from the start of the first source as the at-rule it is', () => {
    const counts = [
      ['@import "a.css";', '@charset "utf-8";', IMPORT],
      ['@charset "utf-8";', IMPORT],
      [' @charset "utf-8";', IMPORT],
      ['@charset "utf-8";\n@charset "utf-8";', IMPORT],
    ].map((texts) => ineffectiveImportDiagnostics(labelled(texts)).length);

    expect(counts).toEqual([1, 0, 1, 1]);
  });
});

describe('every entry point reports what the scanner does (#352)', () => {
  const sheetPassages = (texts: readonly string[]): string =>
    texts.map((text, i) => `\n:: Sheet${String(i + 1)} [stylesheet]\n${text}\n`).join('');

  const viaPassages = (p: Predecessor, split: boolean) => ({
    sources: [{ filename: 'story.tw', content: STORY + sheetPassages(sourcesOf(p.css, split)) }],
  });
  const viaFiles = (p: Predecessor, split: boolean) => ({
    sources: [
      { filename: 'story.tw', content: STORY },
      ...sourcesOf(p.css, split).map((content, i) => ({ filename: `${String(i + 1).padStart(2, '0')}.css`, content })),
    ],
  });
  // A table of every entry and every kind of source: the same cases through each.
  const ENTRIES = [
    ['HTML output', async (o: Pick<CompileOptions, 'sources'>) => (await compile({ ...base(), ...o })).diagnostics],
    [
      'archive output',
      async (o: Pick<CompileOptions, 'sources'>) =>
        (await compile({ ...base(), ...o, outputMode: 'twine2-archive' })).diagnostics,
    ],
    [
      'JSON output',
      async (o: Pick<CompileOptions, 'sources'>) =>
        (await compile({ ...base(), ...o, outputMode: 'json' })).diagnostics,
    ],
    ['lint', async (o: Pick<CompileOptions, 'sources'>) => (await lint({ ...base(), ...o })).diagnostics],
  ] as const;
  const KINDS = [
    ['stylesheet passages', viaPassages],
    ['.css inputs', viaFiles],
  ] as const;

  describe.each(ENTRIES)('%s', (_entry, run) => {
    describe.each(KINDS)('from %s', (_kind, sourcesFor) => {
      it.each(PREDECESSORS.map((p) => [p.name, p] as const))('%s', async (_name, p) => {
        const diagnostics = await run(sourcesFor(p, true));

        expect(importWarnings(diagnostics)).toHaveLength(p.blocks ? 1 : 0);
      });
    });
  });

  it('names the stylesheet passage that holds the ignored import', async () => {
    const content = STORY + sheetPassages(['@namespace x url(y);', IMPORT]);
    const diagnostics = (await compile({ ...base(), sources: [{ filename: 'story.tw', content }] })).diagnostics;

    expect(importWarnings(diagnostics)).toEqual([expect.stringContaining('Stylesheet passage "Sheet2"')]);
  });
});

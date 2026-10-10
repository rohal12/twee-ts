import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import { ineffectiveImportDiagnostics } from '../src/css-imports.js';
import type { CompileOptions } from '../src/types.js';

const IFID = '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}';
const base = (): Pick<CompileOptions, 'formatPaths' | 'useTweegoPath' | 'noRemote'> => ({
  formatPaths: ['test/fixtures/storyformats-sugarcube'],
  useTweegoPath: false,
  noRemote: true,
});
const tw = (title: string): string => `${title}:: StoryData\n${IFID}\n\n:: Start\nHello\n`;

describe('story title validation of HTML output (#351)', () => {
  it.each([
    ['missing', tw(''), 'Special passage "StoryTitle" not found.'],
    ['empty', tw(':: StoryTitle\n\n\n'), 'Special passage "StoryTitle" is empty, so the story has no name.'],
  ])('reports a %s title as an error for a Twine 2 format', async (_name, content, message) => {
    const result = await compile({ ...base(), sources: [{ filename: 'story.tw', content }] });

    expect(result.diagnostics).toContainEqual({ level: 'error', message });
  });

  it('accepts a titled story', async () => {
    const result = await compile({
      ...base(),
      sources: [{ filename: 'story.tw', content: tw(':: StoryTitle\nMy Story\n\n') }],
    });

    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('does not require a title of Twee, archive or JSON output', async () => {
    const results = await Promise.all(
      (['twee3', 'twine2-archive', 'json'] as const).map((outputMode) =>
        compile({ ...base(), outputMode, sources: [{ filename: 'story.tw', content: tw('') }] }),
      ),
    );

    expect(results.flatMap((r) => r.diagnostics.filter((d) => d.message.includes('StoryTitle')))).toEqual([]);
  });
});

describe('ineffective @import rules (#352)', () => {
  const sheets = (...texts: string[]) => texts.map((text, i) => ({ label: `sheet ${i + 1}`, text }));
  const IMPORT = '@import url("https://fonts.example/a.css?x=1;2");\n';

  it.each([
    ['an import after a rule of an earlier source', ['body { margin: 0; }', IMPORT], 1],
    ['an import after a rule of its own source', [`a { b: c }\n${IMPORT}`], 1],
    ['two imports after a rule', [`a {}\n${IMPORT}${IMPORT}`], 1],
    ['an import first', [`${IMPORT}body { margin: 0; }`], 0],
    ['an import alone', [IMPORT], 0],
    ['import then rules, then nothing', [IMPORT, 'body {}'], 0],
    [
      'charset, layer statement and namespace before the import',
      ['@charset "utf-8";\n@layer a, b;\n@namespace x url(y);\n' + IMPORT + 'a{}'],
      0,
    ],
    [
      'a rule hidden in a comment or string',
      ['/* a { } */ @media x { } '.replace('@media x { }', '') + IMPORT, '/* b {} */' + IMPORT],
      0,
    ],
    ['an import inside a block', ['@media print { @import "x.css"; }'], 0],
    ['an escaped brace in a selector before an import', ['.a\\{ b {}\n' + IMPORT], 1],
    ['an escaped character in a leading import', ['@import url(x\\;y);\na {}'], 0],
    ['a layered block before an import', ['@layer a { p {} }\n' + IMPORT], 1],
  ] as const)('%s', (_name, texts, count) => {
    const found = ineffectiveImportDiagnostics(sheets(...texts));

    expect(found.map((d) => d.level)).toEqual(Array<string>(count).fill('warning'));
  });

  it('names the source and warns in HTML, archive and JSON output', async () => {
    const content = `${tw(':: StoryTitle\nT\n\n')}\n:: A [stylesheet]\nbody { margin: 0 }\n\n:: B [stylesheet]\n${IMPORT}\n`;
    const results = await Promise.all(
      (['html', 'twine2-archive', 'json'] as const).map((outputMode) =>
        compile({ ...base(), outputMode, sources: [{ filename: 'story.tw', content }] }),
      ),
    );

    expect(results.map((r) => r.diagnostics.filter((d) => d.message.includes('@import')).length)).toEqual([1, 1, 1]);
    expect(results[0]?.diagnostics.find((d) => d.message.includes('@import'))?.message).toContain('"B"');
  });

  it('is silent for import-first order', async () => {
    const content = `${tw(':: StoryTitle\nT\n\n')}\n:: A [stylesheet]\n${IMPORT}\n:: B [stylesheet]\nbody { margin: 0 }\n`;
    const result = await compile({ ...base(), sources: [{ filename: 'story.tw', content }] });

    expect(result.diagnostics.filter((d) => d.message.includes('@import'))).toEqual([]);
  });
});

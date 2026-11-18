import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { compile } from '../src/compiler.js';
import { scriptTexts } from './helpers/html.js';
import { parseJsonObject } from './helpers/json.js';

const STORY = ':: StoryTitle\nHashbang\n:: StoryData\n{"ifid":"12345678-1234-4123-8123-123456789ABC"}\n:: Start\nHello';
const LOOKALIKE = 'globalThis.lookalike = `#!keep\\n#!/also-keep`;';

for (const outputMode of ['html', 'twine2-archive', 'json'] as const) {
  for (const representation of ['files', 'passages'] as const) {
    describe(`${outputMode} hashbang composition from ${representation} (#348)`, () => {
      for (const newline of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
        it.each([0, 1, 2, 'all', 'single'] as const)(
          `executes hashbang position %s with ${JSON.stringify(newline)}`,
          async (position) => {
            const texts = Array.from(
              { length: position === 'single' ? 1 : 3 },
              (_, i) =>
                (position === i || position === 'all' || position === 'single' ? `#!/usr/bin/env node${newline}` : '') +
                `globalThis.v${String(i)} = ${String(i)};${newline}${LOOKALIKE}`,
            );
            const sources =
              representation === 'files'
                ? [
                    { filename: 'story.tw', content: STORY },
                    ...texts.map((content, i) => ({ filename: `s${String(i)}.js`, content })),
                  ]
                : [
                    {
                      filename: 'story.tw',
                      content: STORY + texts.map((text, i) => `\n:: S${String(i)} [script]\n${text}\n`).join(''),
                    },
                  ];
            const result = await compile({
              sources,
              outputMode,
              formatId: 'test-format-1',
              formatPaths: ['test/fixtures/storyformats'],
              useTweegoPath: false,
              noRemote: true,
            });
            expect(result.diagnostics).toEqual([]);
            const script =
              outputMode === 'json'
                ? String(parseJsonObject(result.output)['script'])
                : (scriptTexts(result.output)[0] ?? '');
            const context: Record<string, unknown> = {};
            runInNewContext(script, context);
            expect(Object.fromEntries(Object.entries(context).filter(([key]) => key.startsWith('v')))).toEqual(
              Object.fromEntries(texts.map((_text, i) => [`v${String(i)}`, i])),
            );
            expect(context['lookalike']).toBe('#!keep\n#!/also-keep');
            expect(script.startsWith('#!')).toBe(position === 'single');
          },
        );
      }
    });
  }
}

it('keeps passage labels and local line numbers after hashbang rewriting', async () => {
  const result = await compile({
    sources: [
      { filename: 'story.tw', content: STORY },
      { filename: 'first.js', content: '#!/node\n// comment\n</script>' },
      { filename: 'last.js', content: '#!/node\n// comment\n</script>' },
    ],
    outputMode: 'twine2-archive',
  });
  expect(result.diagnostics.map((d) => d.message)).toEqual([
    expect.stringContaining('script passage "first.js" has "</script" at line 3'),
    expect.stringContaining('script passage "last.js" has "</script" at line 3'),
  ]);
});

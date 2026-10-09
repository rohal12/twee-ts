import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import { scriptTexts } from './helpers/html.js';
import { evaluateJavaScript } from './helpers/javascript.js';
import { parseJsonObject } from './helpers/json.js';

const STORY =
  ':: StoryTitle\nScript composition\n\n:: StoryData\n{"ifid":"12345678-1234-4123-8123-123456789ABC"}\n\n:: Start\nHello\n';

/** Pairs that are valid alone and fail when joined without a statement boundary (issue: semicolon-free source). */
const PAIRS: readonly (readonly [first: string, second: string, check: string])[] = [
  ['globalThis.settings = {}', '(function () { globalThis.didRun = true; })();', 'settings'],
  ['globalThis.total = 5', '[1, 2, 3].forEach(n => globalThis.total += n);', 'total'],
  ['globalThis.greeting = "hello"', '/hello/.test(globalThis.greeting) && (globalThis.didRun = true);', 'greeting'],
  ['globalThis.settings = {} // trailing comment', '(function () { globalThis.didRun = true; })();', 'settings'],
];

const run = (script: string): Record<string, unknown> => {
  const g = {} as Record<string, unknown>;
  evaluateJavaScript(script.replaceAll('globalThis', 'g'), { g });
  return g;
};

describe('script sources are joined with a statement boundary', () => {
  for (const [first, second, key] of PAIRS) {
    const sources = [
      { filename: 'story.tw', content: STORY },
      { filename: '01.js', content: first },
      { filename: '02.js', content: second },
    ];
    const passages = [
      { filename: 'story.tw', content: `${STORY}\n:: A [script]\n${first}\n\n:: B [script]\n${second}\n` },
    ];

    it.each([
      ['archive', 'twine2-archive', sources],
      ['archive from script passages', 'twine2-archive', passages],
      ['json', 'json', sources],
    ] as const)(`runs %s output of ${JSON.stringify(first)}`, async (_label, outputMode, input) => {
      const result = await compile({ sources: input, outputMode });
      const script =
        outputMode === 'json'
          ? String(parseJsonObject(result.output)['script'])
          : (scriptTexts(result.output)[0] ?? '');
      expect(Object.keys(run(script))).toContain(key);
    });
  }

  it('leaves a single source and a terminated source as they are', async () => {
    const one = await compile({
      sources: [{ filename: 'story.tw', content: `${STORY}\n:: A [script]\nwindow.a = 1;\n` }],
      outputMode: 'twine2-archive',
    });
    expect(one.output).toContain('>window.a = 1;</script>');
    const two = await compile({
      sources: [
        { filename: 'story.tw', content: `${STORY}\n:: A [script]\nwindow.a = 1;\n\n:: B [script]\nwindow.b = 2;\n` },
      ],
      outputMode: 'twine2-archive',
    });
    expect(two.output).toContain('/* twine-user-script #2: "B" */\nwindow.b = 2;');
  });
});

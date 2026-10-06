/**
 * Matrix group INTERACT (see cases.ts): a generated corpus that crosses the features one build
 * combines. For each output mode, every run compiles two sources (a file or an inline source, in
 * one of three line endings, trimmed or not) where the second replaces StorySettings and Start,
 * with a tag alias, and checks that a cold build, an incremental build and a warm incremental build
 * agree and keep the authored data. Failures print fast-check's seed and the counterexample.
 */
import { join } from 'node:path';
import fc from 'fast-check';
import { expect } from 'vitest';
import { compile, compileIncremental, decompileHTML } from '@rohal12/twee-ts';
import type { CompileOptions, CompileResult, FileCacheEntry, OutputMode } from '@rohal12/twee-ts';
import { defineContracts, IFID, localFormat, write } from './harness.js';

/** Fixed, so a run is repeatable; a failure reports it with the counterexample. */
const SEED = 236238;
const RUNS = 24;

const PASSAGE_CHARACTERS = [
  'a',
  'b',
  ' ',
  'z',
  '&',
  '<',
  '>',
  '"',
  "'",
  'Ω',
  '{',
  '}',
  '[',
  ']',
  '$',
  '/',
  '\\',
  '|',
  '-',
];

/** Passage text: markup and entity characters, quotes and non-ASCII, never blank at either end. */
const passageText = fc
  .string({ unit: fc.constantFrom(...PASSAGE_CHARACTERS), minLength: 1, maxLength: 40 })
  .map((text) => `case ${text} end`);

const scenario = fc.record({
  text: passageText,
  newline: fc.constantFrom('\n', '\r\n', '\r'),
  fromFile: fc.boolean(),
  trim: fc.boolean(),
});

/** Twine 1 output records the minute it was made; two builds may straddle a minute. */
function withoutTimestamps(output: string): string {
  return output.replace(/created="\d{12}"/g, 'created="<time>"');
}

function startOf(result: CompileResult): { readonly text: string | undefined; readonly tags: readonly string[] } {
  const start = result.story.passages.find((p) => p.name === 'Start');
  return { text: start?.text, tags: start?.tags ?? [] };
}

const HTML_MODES: readonly OutputMode[] = ['html', 'twine2-archive', 'twine1-archive'];

async function expectBuildsAgree(root: string, mode: OutputMode): Promise<void> {
  const local = localFormat(root);
  await fc.assert(
    fc.asyncProperty(scenario, async ({ text, newline, fromFile, trim }) => {
      const first =
        `:: StoryData\n{"ifid":"${IFID}"}\n:: StoryTitle\nGenerated\n:: StorySettings\nobfuscate:rot13\n` +
        ':: Start [old]\nold text\n:: Secret [Twine.private]\nsecret text\n';
      const content = first.replaceAll('\n', newline);
      const last = `:: StorySettings\njquery:on\n:: Start [alias]\n${text}\n:: Next\n[[Start]]\n`;
      const options: CompileOptions = {
        ...local.options,
        formatId: local.formatId,
        sources: [
          fromFile ? write(join(root, 'first.tw'), content) : { filename: 'first.tw', content },
          { filename: 'last.tw', content: last },
        ],
        outputMode: mode,
        tagAliases: { alias: 'location' },
        trim,
      };
      const cache = new Map<string, FileCacheEntry>();
      const cold = await compile(options);
      const incremental = await compileIncremental(options, cache);
      const warm = await compileIncremental(options, cache);
      expect(withoutTimestamps(incremental.output)).toBe(withoutTimestamps(cold.output));
      expect(withoutTimestamps(warm.output)).toBe(withoutTimestamps(cold.output));
      expect(warm.diagnostics).toEqual(cold.diagnostics);
      expect(cold.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
      // The later StorySettings replaces the earlier one whole.
      expect([...warm.story.twine1.settings]).toEqual([['jquery', 'on']]);
      expect(startOf(warm)).toEqual({ text, tags: ['alias', 'location'] });
      if (HTML_MODES.includes(mode)) {
        const decoded = decompileHTML(cold.output).story.passages;
        expect(decoded.find((p) => p.name === 'Start')?.text).toBe(text);
        expect(decoded.map((p) => p.name)).not.toContain('Secret');
      }
    }),
    { seed: SEED, numRuns: RUNS, endOnFailure: true },
  );
}

defineContracts('INTERACT', {
  html: (root) => expectBuildsAgree(root, 'html'),
  twee3: (root) => expectBuildsAgree(root, 'twee3'),
  twee1: (root) => expectBuildsAgree(root, 'twee1'),
  'twine2-archive': (root) => expectBuildsAgree(root, 'twine2-archive'),
  'twine1-archive': (root) => expectBuildsAgree(root, 'twine1-archive'),
  json: (root) => expectBuildsAgree(root, 'json'),
});

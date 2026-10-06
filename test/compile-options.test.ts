/**
 * Options compile() does not read are reported, as unknown config keys are, so that a misspelt option is not
 * silently left at its default (#248 F16: `compile({ format })`, which the old packaging guide showed, was
 * ignored without a word).
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import type { CompileOptions } from '../src/types.js';

const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHi\n';

/** Options as JavaScript, or a spread object, may pass them: with keys the type does not have. */
function withExtra(extra: Readonly<Record<string, unknown>>): CompileOptions {
  const options: CompileOptions = { sources: [{ filename: 'a.tw', content: STORY }], outputMode: 'twee3' };
  return Object.assign(options, extra);
}

describe('compile options it does not read', () => {
  it.each([
    ['format', ' (did you mean "formatId"?)'],
    ['formatID', ' (did you mean "formatId"?)'],
    ['output_mode', ' (did you mean "outputMode"?)'],
    ['output', ' (did you mean "outFile"?)'],
    ['frobnicate', ''],
    ['__proto__', ''],
  ])('warns about %j%s', async (key, hint) => {
    const options = withExtra({});
    Object.defineProperty(options, key, { value: 'x', enumerable: true });
    const result = await compile(options);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      `Unknown compile option "${key}"${hint}; it is ignored.`,
    ]);
  });

  it('reads every option the types declare without a warning', async () => {
    const result = await compile(
      withExtra({
        exclude: [],
        formatId: undefined,
        startPassage: 'Start',
        formatPaths: [],
        useTweegoPath: false,
        modules: [],
        headFile: undefined,
        trim: true,
        twee2Compat: false,
        testMode: false,
        formatIndices: [],
        formatUrls: [],
        noRemote: true,
        signal: undefined,
        formatFetchTimeout: 1000,
        formatResolutionTimeout: 1000,
        useDefaultFormatIndices: false,
        tagAliases: {},
        sourceInfo: false,
        wordCountMethod: 'tweego',
      }),
    );
    expect(result.diagnostics).toEqual([]);
  });
});

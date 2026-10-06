/**
 * The public option types accept an explicit `undefined` for every optional property, so a
 * consumer with `exactOptionalPropertyTypes` on can pass `formatId: process.env.FORMAT` and the
 * like. tsconfig.json turns that flag on, and `pnpm run typecheck` checks this file: a property
 * that loses its `| undefined` fails the build. The runtime tests check that an explicit
 * `undefined` means the same as leaving the property out.
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler.js';
import { parseTwee } from '../src/parser.js';
import { decompileHTML } from '../src/html-parser.js';
import { storyInspect } from '../src/inspect.js';
import type {
  CompileOptions,
  CompileToFileOptions,
  DecompileOptions,
  InspectOptions,
  Passage,
  RemoteFetchOptions,
  TweeTsConfig,
  WatchOptions,
} from '../src/types.js';
import type { ParseOptions } from '../src/parser.js';
import type { TweeTsVitePluginOptions } from '../src/plugins/vite.js';
import type { TweeTsRollupPluginOptions } from '../src/plugins/rollup.js';

const SOURCE =
  ':: StoryTitle\nT\n\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello [[Next]]\n\n:: Next\nBye\n';

/** Every optional property of `T` set to `undefined`. */
type AllUndefined<T> = { [K in keyof T as undefined extends T[K] ? K : never]-?: undefined };

// Compile-time probes: each object sets every optional property to undefined explicitly.
const compileOptions = {
  sources: [],
  exclude: undefined,
  outputMode: undefined,
  formatId: undefined,
  startPassage: undefined,
  formatPaths: undefined,
  useTweegoPath: undefined,
  modules: undefined,
  headFile: undefined,
  trim: undefined,
  twee2Compat: undefined,
  testMode: undefined,
  formatIndices: undefined,
  formatUrls: undefined,
  noRemote: undefined,
  signal: undefined,
  formatFetchTimeout: undefined,
  tagAliases: undefined,
  sourceInfo: undefined,
  wordCountMethod: undefined,
} satisfies AllUndefined<CompileOptions> & CompileOptions;
const watchOptions = {
  ...compileOptions,
  outFile: 'out.html',
  onBuild: undefined,
  onError: undefined,
} satisfies AllUndefined<WatchOptions> & WatchOptions & CompileToFileOptions;
const passage = { name: 'P', tags: [], text: '', metadata: undefined, source: undefined } satisfies Passage;
const config = {
  sources: undefined,
  exclude: undefined,
  output: undefined,
  outputMode: undefined,
  formatId: undefined,
  startPassage: undefined,
  formatPaths: undefined,
  formatIndices: undefined,
  formatUrls: undefined,
  useTweegoPath: undefined,
  modules: undefined,
  headFile: undefined,
  trim: undefined,
  twee2Compat: undefined,
  testMode: undefined,
  noRemote: undefined,
  formatFetchTimeout: undefined,
  tagAliases: undefined,
  sourceInfo: undefined,
  wordCountMethod: undefined,
} satisfies AllUndefined<TweeTsConfig> & TweeTsConfig;
const remote = { signal: undefined, timeout: undefined } satisfies AllUndefined<RemoteFetchOptions> &
  RemoteFetchOptions;
const decompile = { trim: undefined } satisfies AllUndefined<DecompileOptions> & DecompileOptions;
const inspect = { target: undefined } satisfies AllUndefined<InspectOptions> & InspectOptions;
const parse = { filename: undefined, trim: undefined, twee2Compat: undefined } satisfies AllUndefined<ParseOptions> &
  ParseOptions;
const vitePlugin = {
  sources: [],
  format: undefined,
  outputFilename: undefined,
  compileOptions: undefined,
  entry: undefined,
} satisfies AllUndefined<TweeTsVitePluginOptions> & TweeTsVitePluginOptions;
const rollupPlugin = {
  sources: [],
  format: undefined,
  outputFilename: undefined,
  compileOptions: undefined,
} satisfies AllUndefined<TweeTsRollupPluginOptions> & TweeTsRollupPluginOptions;

describe('optional properties set to undefined', () => {
  it('cover every optional property of the public option types', () => {
    // A probe object that missed a property would fail `satisfies AllUndefined<…>` at compile time;
    // at runtime, check each probe holds only undefined optional values.
    const probes = [watchOptions, passage, config, remote, decompile, inspect, parse, vitePlugin, rollupPlugin];
    for (const probe of probes) {
      const defined = Object.entries(probe).filter(
        ([key, value]) => value !== undefined && !['sources', 'outFile', 'name', 'tags', 'text'].includes(key),
      );
      expect(defined).toEqual([]);
    }
  });

  it('compile treats an explicit undefined like an absent option', async () => {
    const sources = [{ filename: 'story.tw', content: SOURCE }];
    for (const outputMode of ['twee3', 'json'] as const) {
      const absent = await compile({ sources, outputMode, noRemote: true });
      const explicit = await compile({ ...compileOptions, sources, outputMode, noRemote: true });
      expect(explicit.output).toBe(absent.output);
      expect(explicit.diagnostics).toEqual(absent.diagnostics);
    }
  });

  it('parseTwee, decompileHTML and storyInspect treat an explicit undefined like an absent option', async () => {
    expect(parseTwee(SOURCE, parse)).toEqual(parseTwee(SOURCE));
    const html = (await compile({ sources: [{ filename: 's.tw', content: SOURCE }], outputMode: 'twine2-archive' }))
      .output;
    expect(decompileHTML(html, decompile)).toEqual(decompileHTML(html));
    const { story } = await compile({ sources: [{ filename: 's.tw', content: SOURCE }], outputMode: 'twee3' });
    expect(storyInspect(story, inspect)).toEqual(storyInspect(story));
  });
});

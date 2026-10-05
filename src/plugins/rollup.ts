/**
 * Ready-made Rollup plugin for twee-ts.
 * Compiles .tw files and emits HTML as an asset. Compile errors fail the build
 * and emit nothing; warnings go through Rollup's warnings.
 */
import { resolve } from 'node:path';
import type { CompileOptions, CompileResult, Diagnostic } from '../types.js';
import { compile } from '../compiler.js';
import { fatalError, formatDiagnostic, splitDiagnostics } from './diagnostics.js';
import type { LocatedError } from './diagnostics.js';

export interface TweeTsRollupPluginOptions {
  /** Source directories/files to compile. */
  sources: string[];
  /** Story format ID. */
  format?: string;
  /** Output filename. Default: 'index.html'. */
  outputFilename?: string;
  /** Additional compile options. */
  compileOptions?: Partial<CompileOptions>;
}

export function tweeTsPlugin(options: TweeTsRollupPluginOptions) {
  const outputFilename = options.outputFilename ?? 'index.html';

  return {
    name: 'twee-ts',

    // `rollup --watch` rebuilds for the files the build registers. The story's
    // inputs are read in generateBundle, outside the module graph, so they are
    // registered here. Rollup's watcher watches a folder recursively, files added
    // to it included.
    buildStart(this: { addWatchFile: (id: string) => void; meta: { watchMode: boolean } }) {
      if (!this.meta.watchMode) return;
      const extra = options.compileOptions;
      const inputs = [...options.sources, ...(extra?.headFile ? [extra.headFile] : []), ...(extra?.modules ?? [])];
      for (const input of inputs) this.addWatchFile(resolve(input));
    },

    async generateBundle(this: {
      emitFile: (opts: { type: 'asset'; fileName: string; source: string }) => void;
      error: (error: LocatedError) => never;
      warn: (message: string) => void;
    }): Promise<void> {
      let result: CompileResult;
      try {
        result = await compile({
          sources: options.sources,
          formatId: options.format,
          ...options.compileOptions,
        });
      } catch (e) {
        return this.error(fatalError(e));
      }
      let warnings: Diagnostic[];
      try {
        warnings = splitDiagnostics(result);
      } catch (e) {
        return this.error(e as LocatedError);
      }
      for (const w of warnings) this.warn(formatDiagnostic(w));
      this.emitFile({ type: 'asset', fileName: outputFilename, source: result.output });
    },
  };
}

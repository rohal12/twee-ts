/**
 * Ready-made Rollup plugin for twee-ts.
 * Compiles .tw files and emits HTML as an asset.
 */
import type { CompileOptions } from '../types.js';
import { compile } from '../compiler.js';

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

    async generateBundle(
      _outputOptions: unknown,
      _bundle: Record<string, unknown>,
    ) {
      const result = await compile({
        sources: options.sources,
        formatId: options.format,
        ...options.compileOptions,
      });

      (this as unknown as { emitFile: (opts: Record<string, unknown>) => void }).emitFile({
        type: 'asset',
        fileName: outputFilename,
        source: result.output,
      });

      for (const d of result.diagnostics) {
        if (d.level === 'warning') {
          console.warn(`[twee-ts] ${d.message}`);
        } else {
          console.error(`[twee-ts] ${d.message}`);
        }
      }
    },
  };
}

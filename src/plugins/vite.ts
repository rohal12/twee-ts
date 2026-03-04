/**
 * Ready-made Vite plugin for twee-ts.
 * Watches .tw files and emits compiled HTML.
 */
import type { CompileOptions } from '../types.js';
import { compile } from '../compiler.js';

export interface TweeTsVitePluginOptions {
  /** Source directories/files to compile. */
  sources: string[];
  /** Story format ID. */
  format?: string;
  /** Output filename in build output. Default: 'index.html'. */
  outputFilename?: string;
  /** Additional compile options. */
  compileOptions?: Partial<CompileOptions>;
}

export function tweeTsPlugin(options: TweeTsVitePluginOptions) {
  const outputFilename = options.outputFilename ?? 'index.html';

  return {
    name: 'twee-ts',

    async buildStart() {
      // No-op: compilation happens in generateBundle
    },

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

    configureServer(server: {
      watcher: { add: (path: string) => void };
      ws: { send: (data: { type: string }) => void };
    }) {
      for (const source of options.sources) {
        server.watcher.add(source);
      }
    },

    handleHotUpdate(ctx: { file: string; server: { ws: { send: (data: { type: string }) => void } } }) {
      if (ctx.file.endsWith('.tw') || ctx.file.endsWith('.twee')) {
        ctx.server.ws.send({ type: 'full-reload' });
      }
    },
  };
}

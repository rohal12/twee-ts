/**
 * Ready-made Vite plugin for twee-ts.
 * Watches .tw files and emits compiled HTML via incremental compilation.
 */
import type { CompileOptions, FileCacheEntry } from '../types.js';
import { compileIncremental } from '../compiler.js';

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

function isTweeFile(file: string): boolean {
  return file.endsWith('.tw') || file.endsWith('.twee');
}

function getCompileOptions(options: TweeTsVitePluginOptions): CompileOptions {
  return {
    sources: options.sources,
    formatId: options.format,
    ...options.compileOptions,
  };
}

function logDiagnostics(diagnostics: ReadonlyArray<{ level: string; message: string }>) {
  for (const d of diagnostics) {
    if (d.level === 'warning') {
      console.warn(`[twee-ts] ${d.message}`);
    } else {
      console.error(`[twee-ts] ${d.message}`);
    }
  }
}

export function tweeTsPlugin(options: TweeTsVitePluginOptions) {
  const outputFilename = options.outputFilename ?? 'index.html';
  const cache = new Map<string, FileCacheEntry>();
  let compiledHtml = '';

  return {
    name: 'twee-ts',

    async buildStart() {
      // No-op: compilation happens in generateBundle (build) or configureServer (dev)
    },

    async generateBundle(this: { emitFile: (opts: { type: string; fileName: string; source: string }) => void }) {
      const result = await compileIncremental(getCompileOptions(options), cache);

      this.emitFile({
        type: 'asset',
        fileName: outputFilename,
        source: result.output,
      });

      logDiagnostics(result.diagnostics);
    },

    async configureServer(server: {
      watcher: { add: (path: string) => void };
      ws: { send: (data: { type: string }) => void };
      middlewares: {
        use: (fn: (req: { url?: string }, res: { end: (data: string) => void }, next: () => void) => void) => void;
      };
    }) {
      for (const source of options.sources) {
        server.watcher.add(source);
      }

      // Initial compile
      const result = await compileIncremental(getCompileOptions(options), cache);
      compiledHtml = result.output;
      logDiagnostics(result.diagnostics);

      // Serve compiled HTML for requests to / or the output filename
      const servePath = outputFilename === 'index.html' ? '/' : `/${outputFilename}`;
      server.middlewares.use((req, res, next) => {
        if (req.url === servePath || (servePath === '/' && req.url === '/index.html')) {
          res.end(compiledHtml);
          return;
        }
        next();
      });
    },

    async handleHotUpdate(ctx: { file: string; server: { ws: { send: (data: { type: string }) => void } } }) {
      if (!isTweeFile(ctx.file)) return;

      const result = await compileIncremental(getCompileOptions(options), cache, new Set([ctx.file]));
      compiledHtml = result.output;
      logDiagnostics(result.diagnostics);

      ctx.server.ws.send({ type: 'full-reload' });
    },
  };
}

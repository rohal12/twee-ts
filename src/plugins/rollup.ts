/**
 * Ready-made Rollup plugin for twee-ts.
 * Compiles .tw files and emits HTML as an asset. Compile errors fail the build
 * and emit nothing; warnings go through Rollup's warnings.
 */
import { readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { CompileOptions, CompileResult, Diagnostic } from '../types.js';
import { compileForOutputFile } from '../compiler.js';
import { fatalError, formatDiagnostic, splitDiagnostics } from './diagnostics.js';
import type { LocatedError } from './diagnostics.js';
import { emittedFilePath } from './paths.js';
import type { OutputLocation } from './paths.js';

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

/**
 * What `rollup --watch` watches for the input at the absolute `path`: the path
 * itself, which Rollup watches recursively when it is a folder, unless it holds
 * one of the files the build wrote (`written`). Such a folder is replaced by what
 * it contains, and the written files are left out, so writing them starts no
 * build. A file added straight to that folder later is found at the next build.
 */
function watchTargets(path: string, written: readonly string[]): string[] {
  if (written.includes(path)) return [];
  if (!written.some((file) => file.startsWith(path + sep))) return [path];
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return [path]; // Unreadable: Rollup's watcher reports it.
  }
  return entries.flatMap((entry) => watchTargets(join(path, entry), written));
}

export function tweeTsPlugin(options: TweeTsRollupPluginOptions) {
  const outputFilename = options.outputFilename ?? 'index.html';
  // In watch mode, the files the last build wrote and those the current one writes
  // (absolute paths). They may sit inside a source folder, which must not rebuild for them.
  let written: readonly string[] = [];
  let writing: string[] = [];

  return {
    name: 'twee-ts',

    // `rollup --watch` rebuilds for the files the build registers. The story's
    // inputs are read in generateBundle, outside the module graph, so they are
    // registered here. Rollup's watcher watches a folder recursively, files added
    // to it included.
    buildStart(this: { addWatchFile: (id: string) => void; meta: { watchMode: boolean } }) {
      if (!this.meta.watchMode) return;
      // A build that failed before writing leaves the last build's files as they were.
      if (writing.length > 0) {
        written = writing;
        writing = [];
      }
      const extra = options.compileOptions;
      const inputs = [...options.sources, ...(extra?.headFile ? [extra.headFile] : []), ...(extra?.modules ?? [])];
      for (const input of inputs) {
        for (const target of watchTargets(resolve(input), written)) this.addWatchFile(target);
      }
    },

    async generateBundle(
      this: {
        emitFile: (opts: { type: 'asset'; fileName: string; source: string }) => void;
        error: (error: LocatedError) => never;
        warn: (message: string) => void;
        meta: { watchMode: boolean };
      },
      outputOptions: OutputLocation,
      bundle: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      // Where the story is written: a source folder may hold it, and its last
      // build must not be loaded back as a source.
      const outFile = emittedFilePath(outputOptions, outputFilename);
      let result: CompileResult;
      try {
        result = await compileForOutputFile(
          { sources: options.sources, formatId: options.format, ...options.compileOptions },
          outFile,
        );
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
      if (this.meta.watchMode) {
        for (const fileName of new Set([...Object.keys(bundle), outputFilename])) {
          const path = emittedFilePath(outputOptions, fileName);
          if (path !== undefined) writing.push(path);
        }
      }
    },
  };
}

/**
 * Ready-made Rollup plugin for twee-ts.
 * Compiles .tw files and emits HTML as an asset. Compile errors fail the build
 * and emit nothing; warnings go through Rollup's warnings.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CompileOptions, CompileResult, Diagnostic } from '../types.js';
import { compileForOutputFile } from '../compiler.js';
import { outputPaths, realPathOf, walkedEntry } from '../filesystem.js';
import type { OutputPaths } from '../filesystem.js';
import { fatalError, formatDiagnostic, splitDiagnostics } from './diagnostics.js';
import type { LocatedError } from './diagnostics.js';
import { createOutputRecord, outputLocations } from './paths.js';
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
 * What `rollup --watch` watches for the input at `path`, whose real path is
 * `real`. `isRoot`: the input itself, which is followed wherever it leads.
 *
 * Rollup watches a folder recursively and follows the links in it. So a folder
 * is registered whole only when nothing under it is left out of the story: no
 * file or folder the build writes (`outputs`), and no link to a folder, which
 * source discovery doesn't follow and which may lead to the output. Any other
 * folder is replaced by what it contains, minus those, so writing the outputs
 * starts no build. A file added straight to such a folder is found at the next
 * build. A path the build writes to is never registered itself: Rollup fails a
 * watch build whose watched files include its `output.dir` or `output.file`.
 */
function watchTargets(path: string, real: string, outputs: OutputPaths, isRoot: boolean): string[] {
  if (outputs.isFile(real) || (!isRoot && outputs.isDir(real))) return [];
  let entry;
  try {
    entry = isRoot ? { stat: statSync(path), real } : walkedEntry(path, real);
  } catch {
    // An input Rollup's watcher reports, unless it is an output location. Below an
    // input, what source discovery can't read (a link to nothing, say) is skipped.
    return isRoot && !outputs.isDir(real) ? [path] : [];
  }
  if (entry === undefined) return []; // A link to a folder, not followed.
  if (outputs.isFile(entry.real)) return [];
  if (!entry.stat.isDirectory()) return [path];
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return isRoot && !outputs.isDir(real) ? [path] : [];
  }
  const children = names.map((name) => {
    const child = join(path, name);
    return { path: child, targets: watchTargets(child, join(entry.real, name), outputs, false) };
  });
  const whole =
    !outputs.holds(entry.real) &&
    children.every(({ path: child, targets }) => targets.length === 1 && targets[0] === child);
  return whole ? [path] : children.flatMap(({ targets }) => targets);
}

export function tweeTsPlugin(options: TweeTsRollupPluginOptions) {
  const outputFilename = options.outputFilename ?? 'index.html';
  // Every path this plugin's builds write: each output's folder or file, its story,
  // and the files of each bundle. A source folder may hold any of them, and none
  // may be read back as a source or rebuild under watch.
  const record = createOutputRecord(outputFilename);

  return {
    name: 'twee-ts',

    // Rollup's watch mode and CLI pass the whole config here, outputs included, so
    // they are known before the first build starts and before any is written.
    // Typed `object`: a type with only optional properties would share none with
    // Rollup's InputOptions, and the plugin would no longer be assignable to Plugin.
    options(inputOptions: object): undefined {
      const { output } = inputOptions as { readonly output?: unknown };
      for (const location of outputLocations(output)) record.addLocation(location);
      return undefined;
    },

    // `rollup --watch` rebuilds for the files the build registers. The story's
    // inputs are read in generateBundle, outside the module graph, so they are
    // registered here. Rollup's watcher watches a folder recursively, files added
    // to it included.
    buildStart(this: { addWatchFile: (id: string) => void; meta: { watchMode: boolean } }) {
      if (!this.meta.watchMode) return;
      const outputs = outputPaths(record.outputs());
      const extra = options.compileOptions;
      const inputs = [...options.sources, ...(extra?.headFile ? [extra.headFile] : []), ...(extra?.modules ?? [])];
      for (const input of inputs) {
        for (const target of watchTargets(resolve(input), realPathOf(input), outputs, true)) this.addWatchFile(target);
      }
    },

    // Runs for every output before any of them generates its bundle, when the
    // outputs are written together (as the CLI and watch mode write them).
    renderStart(outputOptions: OutputLocation): void {
      record.addLocation(outputOptions);
    },

    async generateBundle(
      this: {
        emitFile: (opts: { type: 'asset'; fileName: string; source: string }) => void;
        error: (error: LocatedError) => never;
        warn: (message: string) => void;
      },
      outputOptions: OutputLocation,
      bundle: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      // Where this output writes the story and the bundle. A source folder may hold
      // them, or another output's, and no last build of them may be read back.
      record.addLocation(outputOptions);
      record.addFiles(outputOptions, Object.keys(bundle));
      let result: CompileResult;
      try {
        result = await compileForOutputFile(
          { sources: options.sources, formatId: options.format, ...options.compileOptions },
          record.outputs(),
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
    },
  };
}

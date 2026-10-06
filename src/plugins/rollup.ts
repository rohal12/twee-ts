/**
 * Ready-made Rollup plugin for twee-ts.
 * Compiles .tw files and emits HTML as an asset. Compile errors fail the build
 * and emit nothing; warnings go through Rollup's warnings.
 */
import { resolve } from 'node:path';
import { outputPaths } from '../filesystem.js';
import { compileStory, fatalError } from './diagnostics.js';
import type { CompiledStory, LocatedError } from './diagnostics.js';
import { resolvePluginOptions } from './options.js';
import type { SharedPluginOptions } from './options.js';
import { createOutputRecord, outputLocations } from './paths.js';
import type { OutputLocation } from './paths.js';
import { watchTargets } from './watch-targets.js';

export type { PluginCompileOptions } from './options.js';

export type TweeTsRollupPluginOptions = SharedPluginOptions;

export function tweeTsPlugin(options: TweeTsRollupPluginOptions) {
  const resolved = resolvePluginOptions('rollup', options);
  const { outputFilename } = resolved;
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
      const output: unknown = Reflect.get(inputOptions, 'output');
      for (const location of outputLocations(output)) record.addLocation(location);
      return undefined;
    },

    // `rollup --watch` rebuilds for the files the build registers. The story's
    // inputs are read in generateBundle, outside the module graph, so they are
    // registered here: the sources, the head file and the modules, without the
    // files `exclude` leaves out (see watchTargets).
    buildStart(this: { addWatchFile: (id: string) => void; meta: { watchMode: boolean } }) {
      if (!this.meta.watchMode) return;
      const outputs = outputPaths(record.outputs());
      // In the platform's own form, as Rollup reports its module ids.
      for (const target of watchTargets(resolved.inputs, resolved.excluded, outputs, 'given'))
        this.addWatchFile(resolve(target));
    },

    // Runs for every output before any of them generates its bundle, when the
    // outputs are written together (as the CLI and watch mode write them).
    renderStart(outputOptions: OutputLocation): void {
      record.addLocation(outputOptions);
    },

    async generateBundle(
      this: {
        emitFile: (opts: { type: 'asset'; fileName: string; source: string }) => void;
        error: (error: LocatedError | string) => never;
        warn: (message: string) => void;
      },
      outputOptions: OutputLocation,
      bundle: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      if (Object.hasOwn(bundle, outputFilename)) {
        return this.error(
          `twee-ts: the bundle already holds a file named ${outputFilename}; set the plugin's outputFilename to another name.`,
        );
      }
      // Where this output writes the story and the bundle. A source folder may hold
      // them, or another output's, and no last build of them may be read back.
      record.addLocation(outputOptions);
      record.addFiles(outputOptions, Object.keys(bundle));
      let story: CompiledStory;
      try {
        story = await compileStory(resolved.compile(), record.outputs());
      } catch (e) {
        return this.error(fatalError(e));
      }
      for (const warning of story.warnings) this.warn(warning);
      this.emitFile({ type: 'asset', fileName: outputFilename, source: story.output });
    },
  };
}

/**
 * Ready-made Rollup plugin for twee-ts.
 * Compiles .tw files and emits HTML as an asset. Compile errors fail the build
 * and emit nothing; warnings go through Rollup's warnings.
 */
import { resolve, sep } from 'node:path';
import * as fs from 'node:fs/promises';
import { outputPaths } from '../filesystem.js';
import { recordOwnOutput } from '../atomic-write.js';
import { checkStoryInputs, compileStory, fatalError } from './diagnostics.js';
import type { CompiledStory, LocatedError } from './diagnostics.js';
import { resolvePluginOptions } from './options.js';
import type { SharedPluginOptions } from './options.js';
import { bundlerInputs, createOutputRecord, emittedFilePath, outputLocations } from './paths.js';
import type { OutputLocation } from './paths.js';
import { createLinkWatch } from './link-watch.js';
import type { LinkWatch } from './link-watch.js';
import { watchPlan } from './watch-targets.js';
import { identify } from '../path-identity.js';
import { isRecord } from '../util.js';

export type { PluginCompileOptions } from './options.js';

export type TweeTsRollupPluginOptions = SharedPluginOptions;

type InputContext = Parameters<typeof bundlerInputs>[0] & {
  readonly environment?: { getTopLevelConfig(): object };
};

export function tweeTsPlugin(options: TweeTsRollupPluginOptions) {
  const resolved = resolvePluginOptions('rollup', options);
  const { outputFilename } = resolved;
  // Every path this plugin's builds write: each output's folder or file, its story,
  // and the files of each bundle. A source folder may hold any of them, and none
  // may be read back as a source or rebuild under watch.
  const record = createOutputRecord(outputFilename);
  // Tells the watch that a link the inputs are reached through was pointed elsewhere (see link-watch.ts).
  let linkWatch: LinkWatch | undefined;
  // The link watch could not be set up (no temporary folder); said once, and not tried again.
  let linkWatchUnavailable = false;
  // Where each registered path led when Rollup's watcher first followed it.
  const followed = new Map<string, string>();
  const viteInputs = new WeakMap<object, () => ReadonlySet<string>>();
  let checkWrite: ((writtenFile?: string) => void) | undefined;
  const inputsOf = (context: InputContext): string[] => [
    ...bundlerInputs(context),
    ...(context.environment === undefined ? [] : (viteInputs.get(context.environment.getTopLevelConfig())?.() ?? [])),
  ];
  const finalGuard = {
    name: 'twee-ts:protect-inputs',
    generateBundle: {
      order: 'post' as const,
      handler(this: InputContext, outputOptions: OutputLocation, bundle: Readonly<Record<string, unknown>>): void {
        const files = new Set(
          Object.keys(bundle).flatMap((name) => {
            const path = emittedFilePath(outputOptions, name);
            return path === undefined ? [] : [path];
          }),
        );
        checkWrite = (writtenFile) => {
          checkStoryInputs(record.outputs(), inputsOf(this));
          // Later concurrent IO may see this build's own story before writeBundle records ownership.
          // A plugin's cache IO before it registers more inputs must not consume the preflight.
          if (writtenFile !== undefined && files.has(resolve(writtenFile))) checkWrite = undefined;
        };
        checkStoryInputs(record.outputs(), inputsOf(this));
      },
    },
  };

  return {
    name: 'twee-ts',

    // Vite also accepts this plugin, but Rolldown has no getWatchFiles(). Use its recorder only when
    // Vite hosts the build, so standalone Rollup never loads the optional Vite runtime.
    async configResolved(config: {
      readonly command: string;
      readonly root: string;
      readonly plugins: readonly unknown[];
    }) {
      if (config.command !== 'build') return;
      const { recordWatchFiles } = await import('./vite-entry.js');
      const recorder = recordWatchFiles(undefined, config.root, {}, () => {
        checkStoryInputs(record.outputs(), recorder.inputs());
      });
      viteInputs.set(config, recorder.inputs);
      // Rolldown does not install new plugins returned by options(), so install its final guard here.
      Reflect.set(config, 'plugins', [...config.plugins, recorder.plugin, finalGuard]);
    },

    // Rollup's watch mode and CLI pass the whole config here, outputs included, so
    // they are known before the first build starts and before any is written.
    // Typed `object`: a type with only optional properties would share none with
    // Rollup's InputOptions, and the plugin would no longer be assignable to Plugin.
    options(this: object, inputOptions: object): object {
      checkWrite = undefined;
      const output: unknown = Reflect.get(inputOptions, 'output');
      for (const location of outputLocations(output)) record.addLocation(location);
      // Run after user generateBundle hooks too: they can register more inputs before the write.
      const guarded = { ...inputOptions, plugins: [Reflect.get(inputOptions, 'plugins'), finalGuard] };
      if ('environment' in this) return guarded;
      const configuredFs: unknown = Reflect.get(inputOptions, 'fs');
      const io = isRecord(configuredFs) ? configuredFs : fs;
      // Output plugins run after input plugins. Validate before output IO starts, including mkdir:
      // Rollup writes files concurrently, so rejecting one write must not leave sibling writes in flight.
      const guardedIO =
        (method: 'mkdir' | 'writeFile') =>
        (...args: unknown[]): unknown => {
          checkWrite?.(method === 'writeFile' && typeof args[0] === 'string' ? args[0] : undefined);
          const operation: unknown = Reflect.get(io, method);
          if (typeof operation !== 'function') throw new Error(`The Rollup filesystem has no ${method} method.`);
          const result: unknown = Reflect.apply(operation, undefined, args);
          return result;
        };
      const protectedFs = { mkdir: guardedIO('mkdir'), writeFile: guardedIO('writeFile') };
      Object.setPrototypeOf(protectedFs, io);
      return { ...guarded, fs: protectedFs };
    },

    // `rollup --watch` rebuilds for the files the build registers. The story's
    // inputs are read in generateBundle, outside the module graph, so they are
    // registered here: the sources, the head file and the modules, without the
    // files `exclude` leaves out (see watchTargets). Rollup's watcher follows a link and watches what it leads to, so
    // it doesn't see a link, or a hop of a chain of links, pointed elsewhere; the plugin watches the links itself.
    buildStart(this: {
      addWatchFile: (id: string) => void;
      warn: (message: string) => void;
      meta: { watchMode: boolean };
    }) {
      if (!this.meta.watchMode) return;
      const outputs = outputPaths(record.outputs(), 'snapshot');
      // In the platform's own form, as Rollup reports its module ids.
      const plan = watchPlan(resolved.inputs, resolved.excluded, outputs, 'given');
      const targets = plan.targets.map((target) => identify(target).absolute);
      for (const target of targets) this.addWatchFile(target);
      // Rollup's watcher keeps watching what a path led to when it was registered, so a path that leads elsewhere now
      // (a link was pointed at another file or folder) is watched from its new location as well.
      for (const [path, real] of plan.reals) {
        const first = followed.get(path) ?? real;
        followed.set(path, first);
        if (first !== real) this.addWatchFile(resolve(real));
      }
      if (plan.links.length > 0 && !linkWatchUnavailable) {
        linkWatch ??= createLinkWatch();
        if (linkWatch === undefined) {
          // The links are a refinement: the build goes on, and says once what the watch cannot do.
          linkWatchUnavailable = true;
          this.warn(
            '[twee-ts] The link watch is unavailable because no temporary folder can be written (check TMPDIR); ' +
              'a link pointed at another target is read with the next build something else starts.',
          );
        } else {
          linkWatch.watch(plan.links);
          this.addWatchFile(linkWatch.signal);
        }
      }
      // Rollup's file watcher (chokidar) reads every backslash as a separator, also on POSIX, where it is a
      // filename character: such a file is read by each build, but an edit to it starts none.
      const unwatchable = sep === '/' ? targets.filter((target) => target.includes('\\')) : [];
      if (unwatchable.length > 0) {
        this.warn(
          `[twee-ts] Rollup's watch mode cannot watch ${unwatchable.map((target) => JSON.stringify(target)).join(', ')} ` +
            'because the name contains a backslash; edits to it will not rebuild the story.',
        );
      }
    },

    // The watcher is closed: the links are no longer watched.
    closeWatcher(): void {
      linkWatch?.close();
      linkWatch = undefined;
    },

    // Runs for every output before any of them generates its bundle, when the
    // outputs are written together (as the CLI and watch mode write them).
    renderStart(outputOptions: OutputLocation): void {
      record.addLocation(outputOptions);
    },

    async generateBundle(
      this: InputContext & {
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
        story = await compileStory(resolved.compile(), record.outputs(), undefined, true, inputsOf(this));
      } catch (e) {
        return this.error(fatalError(e));
      }
      for (const warning of story.warnings) this.warn(warning);
      this.emitFile({ type: 'asset', fileName: outputFilename, source: story.output });
    },

    writeBundle(
      outputOptions: OutputLocation,
      bundle: Readonly<
        Record<string, { readonly type: 'asset'; readonly source: string | Uint8Array } | { readonly type: 'chunk' }>
      >,
    ): void {
      const asset = bundle[outputFilename];
      const destination = emittedFilePath(outputOptions, outputFilename);
      // Rollup writes the asset itself. Only a completed write establishes ownership, including for output
      // modes without creator markers; generate() must leave the ownership of existing disk bytes unchanged.
      if (asset?.type === 'asset' && destination !== undefined) recordOwnOutput(destination, asset.source);
    },
  };
}

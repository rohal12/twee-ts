/**
 * Main compiler orchestrator.
 * compile(), compileToFile(), watch().
 * Ported from tweego.go + config.go.
 */
import { dirname, join, sep } from 'node:path';
import type {
  CompileOptions,
  CompileToFileOptions,
  WatchOptions,
  CompileResult,
  CompileStats,
  Diagnostic,
  Story,
  StoryFormatInfo,
  OutputMode,
  InlineSource,
  FileCacheEntry,
} from './types.js';
import { ineffectiveImportDiagnostics } from './css-imports.js';
import type { StylesheetSource } from './css-imports.js';
import { createStory, getStoryStats, snapshot } from './story.js';
import {
  getFilenames,
  isExcluded,
  isLoadableType,
  isPreviousBuild,
  outputPaths,
  toBuildOutputs,
  watchFilesystem,
} from './filesystem.js';
import type {
  BuildOutputs,
  DiscoveredFile,
  FilenamesResult,
  OutputPaths,
  SkippedOutput,
  WatchTiming,
} from './filesystem.js';
import { formatRequestFor, resolveStoryFormat } from './format-resolution.js';
import { loadSources, loadInlineSources, loadSourcesCached } from './loader.js';
import { applyTagAliases, hasTag, metadataForOutput } from './passage.js';
import { generateIFID } from './ifid.js';
import { toTwine2HTML, toTwine2Archive, terminateScript, twine2TagColors } from './output-twine2.js';
import { toTwine1HTML, toTwine1Archive } from './output-twine1.js';
import { toTwee } from './output-twee.js';
import { loadHeadContent, moduleIds } from './modules.js';
import { startPassageDiagnostics, storyTitleDiagnostics } from './start-passage.js';
import { clearIndexCache } from './remote-formats.js';
import { checkWritable, isOwnOutput, writeFileAtomic } from './atomic-write.js';
import { identify, isKeyInside } from './path-identity.js';
import { duplicateInput, failureOfRead, inputProblem, problemDiagnostic } from './input-policy.js';
import type { InputProblem } from './input-policy.js';
import { readUTF8 } from './util.js';
import { unknownOptionWarnings, validateCompileOptions } from './compile-options.js';
import { VERSION } from './version.js';
import { TweeTsError } from './errors.js';

export { TweeTsError };

const CREATOR_NAME = 'Twee-ts';

const DEFAULT_FORMAT_ID = 'sugarcube-2';
const DEFAULT_START_NAME = 'Start';

/** Whether `error` is one no change to the sources can fix: a watch stops on it. */
function isConfigurationError(error: unknown): error is TweeTsError {
  return error instanceof TweeTsError && (error.code === 'OUTPUT_IS_INPUT' || error.code === 'INVALID_OPTIONS');
}

/**
 * Compile Twee sources to HTML, Twee, or JSON.
 */
export async function compile(options: CompileOptions): Promise<CompileResult> {
  return buildOutput(options, {});
}

/**
 * Compile and write to a file. How the file is written depends on what is there (see atomic-write.ts): a
 * regular file is replaced atomically, so a reader sees the previous build or the new one, never part of it,
 * and a failed write leaves the previous build; a FIFO or a device is written through; a read-only file is
 * refused. An output that can't be written (a read-only file, a missing folder) fails before the build.
 */
export async function compileToFile(options: CompileToFileOptions): Promise<CompileResult> {
  validateCompileOptions(options, ['sources', 'outFile']);
  const result = await compileForOutputFile(options, options.outFile, undefined, [], true);
  // The build may have been aborted after it finished: the previous output stays.
  options.signal?.throwIfAborted();
  writeFileAtomic(options.outFile, result.output);
  return result;
}

/** An input named outside the compile options, which the output must not overwrite either. */
export interface ExtraInput {
  readonly role: 'config';
  readonly path: string;
}

/**
 * Builds as compileToFile() does for `outputs`, without writing them: an output may sit
 * inside a source folder, so its last build is left out of the sources and modules and
 * never read back. `outputs` is the one file the CLI writes, or every path a bundler's
 * build writes (see BuildOutputs). The caller decides whether the result is written.
 * With no outputs (output to stdout, or none), this is compile(). With `cache`, files
 * are cached as compileIncremental() caches them. `extraInputs` (the CLI's config file)
 * are checked against the outputs as the sources are. With `writesOutput`, the output file
 * the caller writes afterwards is checked to be writable before any input is read.
 *
 * Throws a TweeTsError (`OUTPUT_IS_INPUT`) when an input would be overwritten (see checkNamedInputs).
 *
 * Internal, for the CLI and the bundler plugins; not part of the public API.
 */
export async function compileForOutputFile(
  options: CompileOptions,
  outputs: BuildOutputs | string | undefined,
  cache?: Map<string, FileCacheEntry>,
  extraInputs: readonly ExtraInput[] = [],
  writesOutput = false,
): Promise<CompileResult> {
  return buildOutput(options, { cache, outputs, extraInputs, writesOutput });
}

/**
 * The JSON build lint inspects, for a project whose builds are written to `outputs` (see `compileForOutputFile()`).
 * It also reads the modules and head file as HTML output does, so it reports what HTML output would about them:
 * a module that can't be used, text HTML cannot carry, code the escapers change, and a head file that can't be
 * read (fatal, as in a build).
 *
 * Internal, for lint; not part of the public API.
 */
export async function compileForLint(
  options: Omit<CompileOptions, 'outputMode'>,
  outputs: string | undefined,
): Promise<CompileResult> {
  return buildOutput({ ...options, outputMode: 'json' }, { outputs, checkHead: true });
}

/**
 * Compile with incremental caching support.
 * Plugins and advanced users can manage their own cache and changed-file tracking.
 *
 * Without `changedFiles`, a cached file is reused while its modification time, size, inode and
 * status-change time are unchanged. With it, a file it names is always reparsed, and every
 * other cached file is reused as it is. A file may be named by an absolute path or by a path
 * relative to the working directory, with or without a leading `./`, or through a link: entries are
 * matched to the source files by identity (see path-identity.ts). A file that fails to load is
 * dropped from the cache, so the next build tries it again.
 */
export async function compileIncremental(
  options: CompileOptions,
  cache: Map<string, FileCacheEntry>,
  changedFiles?: ReadonlySet<string>,
): Promise<CompileResult> {
  return buildOutput(options, { cache, changedFiles });
}

/**
 * Watch for file changes and recompile. Every build is written to `outFile` (as compileToFile()
 * writes it), including one whose diagnostics report errors. Builds run one at a time, and each
 * one is written and reported as it finishes, in order: changes made during a build go into one
 * follow-up build after it. A watched path that can't be watched is passed to `onError`.
 *
 * Options that can't work (an output that is also a named input or an authored file in a source or module
 * folder, an out-of-range option) reject the returned promise before anything is watched. A build that fails for such a reason later (a link
 * changed to make the output an input) is passed to `onError`, and watching stops.
 *
 * Aborting the returned controller, or the `signal` in the options, stops watching and
 * aborts the story format requests of the build in progress.
 */
export function watch(options: WatchOptions): Promise<AbortController> {
  // Watching starts synchronously; an error while starting rejects rather than throws.
  return new Promise((resolveWatch) => {
    resolveWatch(watchWithWriteFilter(options, () => true));
  });
}

/**
 * watch(), writing to `outFile` only the builds `shouldWrite` accepts. A rejected build
 * leaves the output file as it was; `onBuild` receives every build either way.
 *
 * Throws (a TweeTsError) when the options can't work, before anything is watched.
 *
 * Internal, for the CLI, which keeps the last good output when a rebuild reports errors;
 * not part of the public API.
 */
export function watchWithWriteFilter(
  options: WatchOptions,
  shouldWrite: (result: CompileResult) => boolean,
  hooks: WatchHooks = {},
): AbortController {
  validateCompileOptions(options, ['sources', 'outFile']);
  const written = toBuildOutputs(options.outFile);
  checkNamedInputs(namedInputs(options, hooks.extraInputs ?? []), outputPaths(written), []);
  checkFolderOutputs(options, written);

  const controller = new AbortController();
  const cache = new Map<string, FileCacheEntry>();
  // Every build runs with the controller's signal, which the caller's own signal also aborts (below).
  const buildOptions: WatchOptions = { ...options, signal: controller.signal };

  // Separate file paths from inline sources
  const filePaths = options.sources.filter((s): s is string => typeof s === 'string');
  const modulePaths = options.modules ?? [];
  const headPaths = options.headFile ? [options.headFile] : [];
  const allPaths = [...filePaths, ...modulePaths, ...headPaths];

  // A change to an excluded source builds nothing. `exclude` leaves modules and the
  // head file alone, so a module (or a file in a module folder) or the head file
  // still rebuilds when a glob matches it.
  const exclude = options.exclude ?? [];
  const notExcludable = [...modulePaths, ...headPaths].map((p) => identify(p).key);
  const ignore = (filename: string): boolean => {
    if (!isExcluded(filename, exclude)) return false;
    const { key } = identify(filename);
    return !notExcludable.some((root) => isKeyInside(key, root, sep));
  };

  // One build at a time. Changes reported while a build is in flight wait in `queued` and go
  // into a single follow-up build once it finishes. Every finished build is delivered first:
  // it can't be older than what was delivered before it, and delivering each one means a
  // steady stream of changes still produces regular output and reports.
  let building = false;
  let queued: WatchBuildRequest | undefined;

  // onError is the last place an error can go; an exception from it is reported to the
  // console instead, so that it never ends the watch as an unhandled rejection.
  const reportError = (error: Error): void => {
    try {
      options.onError?.(error);
    } catch (e) {
      console.error(`twee-ts watch: onError threw while handling "${error.message}": ${toError(e).message}`);
    }
  };

  const deliver = (outcome: WatchBuildOutcome): void => {
    try {
      if (!outcome.ok) throw outcome.error;
      if (shouldWrite(outcome.result)) writeFileAtomic(options.outFile, outcome.result.output);
      options.onBuild?.(outcome.result);
    } catch (e) {
      reportError(toError(e));
      // An error no edit to the sources can fix (FS-13): stop, as Tweego does.
      if (isConfigurationError(e)) controller.abort(e);
    }
  };

  // Runs `first`, then the follow-up for whatever was queued meanwhile, until nothing is.
  // `building` is cleared in the same step as the last delivery, so a change reported
  // right after it starts a new build rather than waiting in `queued`.
  const drain = async (first: WatchBuildRequest): Promise<void> => {
    building = true;
    try {
      let request: WatchBuildRequest | undefined = first;
      while (request !== undefined) {
        let found: readonly DiscoveredFile[] = [];
        const outcome = await buildOutput(buildOptions, {
          cache,
          changedFiles: request.changedFiles,
          outputs: options.outFile,
          extraInputs: hooks.extraInputs ?? [],
          onDiscovered: (files) => {
            found = files;
          },
        }).then(
          (result): WatchBuildOutcome => ({ ok: true, result }),
          (e: unknown): WatchBuildOutcome => ({ ok: false, error: toError(e) }),
        );
        if (controller.signal.aborted) return;
        handle.track(found);
        deliver(outcome);
        request = queued;
        queued = undefined;
      }
    } finally {
      building = false;
      hooks.onIdle?.();
    }
  };

  const handle = watchFilesystem(
    allPaths,
    options.outFile,
    (changedFiles) => {
      if (controller.signal.aborted) return;
      const request: WatchBuildRequest = { changedFiles };
      if (building) {
        queued = queued === undefined ? request : mergeBuildRequests(queued, request);
        return;
      }
      drain(request).catch((e: unknown) => {
        reportError(toError(e));
      });
    },
    ignore,
    reportError,
    hooks.timing,
  );

  const outer = options.signal;
  const onOuterAbort = (): void => {
    controller.abort(outer?.reason);
  };
  controller.signal.addEventListener('abort', () => {
    queued = undefined;
    handle.close();
    outer?.removeEventListener('abort', onOuterAbort);
  });
  if (outer?.aborted) onOuterAbort();
  else outer?.addEventListener('abort', onOuterAbort, { once: true });
  return controller;
}

/** Internal hooks into watchWithWriteFilter(); not part of the public API. */
export interface WatchHooks {
  /**
   * Called each time the watch's builds have run out: the last one was delivered or, after
   * an abort, dropped, and none is in flight. Lets a test wait for a build to finish when
   * nothing it does shows.
   */
  readonly onIdle?: () => void;
  /** How long to wait for changes to settle (see watchFilesystem); tests shorten it. */
  readonly timing?: WatchTiming;
  /** Inputs besides the compile options' own (the CLI's config file), which the output must not overwrite. */
  readonly extraInputs?: readonly ExtraInput[];
}

/** A watch-mode build: the files that changed, or `undefined` for a full build. */
interface WatchBuildRequest {
  readonly changedFiles: ReadonlySet<string> | undefined;
}

type WatchBuildOutcome =
  { readonly ok: true; readonly result: CompileResult } | { readonly ok: false; readonly error: Error };

/** One build covering both requests: a full build if either is one, else every changed file. */
function mergeBuildRequests(a: WatchBuildRequest, b: WatchBuildRequest): WatchBuildRequest {
  if (a.changedFiles === undefined || b.changedFiles === undefined) return { changedFiles: undefined };
  return { changedFiles: new Set([...a.changedFiles, ...b.changedFiles]) };
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** An input the output must not overwrite, named by the user. */
interface NamedInput {
  readonly role: 'source' | 'module' | 'head' | 'config' | 'story format';
  readonly path: string;
}

/** Every input named in `options` (and `extra`), whatever the output mode. */
function namedInputs(options: CompileOptions, extra: readonly ExtraInput[]): NamedInput[] {
  return [
    ...options.sources
      .filter((s): s is string => typeof s === 'string')
      .map((path) => ({ role: 'source' as const, path })),
    ...(options.modules ?? []).map((path) => ({ role: 'module' as const, path })),
    ...(options.headFile ? [{ role: 'head' as const, path: options.headFile }] : []),
    ...extra,
  ];
}

/** The TweeTsError for an output that would overwrite `input`. */
function outputIsInput(input: NamedInput, diagnostics: readonly Diagnostic[], detail = ''): TweeTsError {
  const role = input.role === 'source' ? '' : ` (the ${input.role === 'head' ? 'head file' : input.role})`;
  return new TweeTsError(
    `path ${input.path}: Output file cannot be an input source${role}.${detail}`,
    [...diagnostics],
    {
      code: 'OUTPUT_IS_INPUT',
    },
  );
}

/**
 * The one output-safety check for inputs named directly, run before the output mode is looked at, so it
 * holds for every mode and every role: a source, module, head file or config file (or, once it is known,
 * a story format file) that is an output file (the same file by identity, or a hard link to it) is a
 * TweeTsError, as in Tweego. Writing the build would overwrite it. A folder that holds an output is
 * walked instead, and the output inside it left out (see checkSkippedOutputs).
 */
function checkNamedInputs(
  inputs: readonly NamedInput[],
  output: OutputPaths,
  diagnostics: readonly Diagnostic[],
): void {
  const overlap = inputs.find((input) => output.isFile(input.path));
  if (overlap !== undefined) throw outputIsInput(overlap, diagnostics);
}

/**
 * The output-safety check for output files found while walking a source or module folder, which are
 * left out of the inputs. Writing over one is fine when it is a previous build, or a file the walk
 * would not load anyway; but an existing file of a type the folder's role loads, which twee-ts did not
 * build, is the author's own file (FS-07): a TweeTsError, unless an exclude glob leaves it out.
 */
function checkSkippedOutputs(
  skipped: readonly SkippedOutput[],
  role: 'source' | 'module',
  diagnostics: readonly Diagnostic[],
  only?: OutputPaths,
): void {
  for (const output of skipped) {
    if (only !== undefined && !only.isFile(output.path)) continue;
    if (!isLoadableType(output.path, role) || isOwnOutput(output.path) || isPreviousBuild(output.path)) continue;
    throw outputIsInput(
      { role, path: output.path },
      diagnostics,
      ` It is a ${role} file inside the ${role} folder ${output.folder}, and not an earlier build. Move the output out of the folder, or exclude the file.`,
    );
  }
}

/**
 * The output-safety check for an output inside a source or module folder (see checkSkippedOutputs), which a
 * watch makes before it watches anything, as its first build would: the error is then the rejection of watch(),
 * not one that stops the watch silently when there is no `onError` (#363).
 */
function checkFolderOutputs(options: CompileOptions, written: BuildOutputs): void {
  const sources = options.sources.filter((s): s is string => typeof s === 'string');
  checkSkippedOutputs(getFilenames(sources, written, options.exclude).skippedOutputs, 'source', []);
  checkSkippedOutputs(getFilenames(options.modules ?? [], written, [], 'module').skippedOutputs, 'module', []);
}

/** The files a story format reads, which the output must not overwrite. */
function formatInputs(format: StoryFormatInfo): NamedInput[] {
  if (format.isTwine2) return [{ role: 'story format', path: format.filename }];
  // A Twine 1 format reads its components from its own folder and the one above it (see output-twine1.ts).
  const formatDir = dirname(format.filename);
  const parentDir = dirname(formatDir);
  return [
    format.filename,
    join(formatDir, 'userlib.js'),
    join(formatDir, 'code.js'),
    join(formatDir, 'footer.html'),
    join(parentDir, 'engine.js'),
    join(parentDir, 'jquery.js'),
    join(parentDir, 'modernizr.js'),
  ].map((path) => ({ role: 'story format', path }));
}

/** Throws the TweeTsError a fatal input problem calls for. */
function fatalInput(problem: InputProblem, diagnostics: readonly Diagnostic[]): TweeTsError {
  return new TweeTsError(problem.message, [...diagnostics], { code: 'INPUT_UNAVAILABLE', cause: problem.cause });
}

/**
 * The head file's text, trimmed. Any failure to read it is fatal, as in Tweego (`modifyHead`): the output
 * would silently lack what the author put in the head.
 */
function readHeadFile(path: string, diagnostics: Diagnostic[]): string {
  try {
    return readUTF8(path, diagnostics).trim();
  } catch (e) {
    throw fatalInput(inputProblem('head', 'named', failureOfRead(path, e), path, e), diagnostics);
  }
}

/**
 * The module tags for the head, each module read on its own so a failure names its file, and the modules loaded
 * (Tweego's "External files"). A module that can't be read is reported as the input policy says (an error) and
 * left out, and so is one of a type modules don't load; a module given again, under this or another spelling, is
 * skipped with a warning, as a source is.
 */
function moduleTags(
  files: readonly DiscoveredFile[],
  diagnostics: Diagnostic[],
): { readonly tags: string; readonly loaded: readonly string[] } {
  const seen = new Map<string, string>();
  const tags: string[] = [];
  const loaded: string[] = [];
  // One id namespace for the page, kept across the single-module loads below.
  const idFor = moduleIds(diagnostics);
  for (const file of files) {
    const earlier = seen.get(file.key);
    if (earlier !== undefined) {
      diagnostics.push(duplicateInput('module', file.path, earlier));
      continue;
    }
    if (!isLoadableType(file.path, 'module')) {
      const diagnostic = problemDiagnostic(
        inputProblem('module', file.discovery, 'unsupported-type', file.path, undefined),
      );
      if (diagnostic) diagnostics.push(diagnostic);
      continue;
    }
    try {
      const tag = loadHeadContent([file.path], undefined, diagnostics, idFor);
      if (tag.length > 0) tags.push(tag);
    } catch (e) {
      const diagnostic = problemDiagnostic(
        inputProblem('module', file.discovery, failureOfRead(file.path, e), file.path, e),
      );
      if (diagnostic) diagnostics.push(diagnostic);
      continue;
    }
    // Only a module that loaded counts as given: one that failed is tried, and reported, again (as a source is).
    seen.set(file.key, file.path);
    loaded.push(file.path);
  }
  return { tags: tags.join('\n'), loaded };
}

/**
 * The content HTML output injects into the head (the module tags, then the head file) and what went into it, the
 * modules that loaded and the head file, as Tweego lists them. Adds what reading them reports to `diagnostics`;
 * a head file that can't be read is fatal (see `readHeadFile()`).
 */
function headContent(
  modules: FilenamesResult,
  headFile: string | undefined,
  diagnostics: Diagnostic[],
): { readonly head: string; readonly injected: string[] } {
  diagnostics.push(...modules.diagnostics);
  const tags = moduleTags(modules.files, diagnostics);
  const head = [tags.tags, headFile ? readHeadFile(headFile, diagnostics) : '']
    .filter((part) => part.length > 0)
    .join('\n');
  return { head, injected: [...tags.loaded, ...(headFile ? [identify(headFile).display] : [])] };
}

/**
 * `outputs`: what the build writes (an output file's path, or a bundler's outputs),
 * which source and module discovery skip, so an output inside a source folder is
 * never loaded back. The output-safety checks run before any input is read and before
 * the output mode matters: see checkNamedInputs and checkSkippedOutputs.
 */
async function buildOutput(options: CompileOptions, context: BuildContext): Promise<CompileResult> {
  validateCompileOptions(options, ['sources']);
  const { cache, changedFiles, outputs, extraInputs = [] } = context;
  const written = toBuildOutputs(outputs);
  const outputGuard = outputPaths(written);
  // The story file a user named (CLI, compileToFile, watch). A bundler's outputs are its own: it writes
  // over its chunks and assets in a source folder on every build, so for it only named inputs and its story
  // (`BuildOutputs.stories`) are checked.
  const namedOutput = typeof outputs === 'string';
  // What is checked in a source or module folder: every output file of a named output; of a bundler's, only its
  // story (when the caller says it writes one).
  const stories = outputPaths({ files: written.stories ?? [], dirs: [] });
  const guardsFolders = namedOutput || (written.stories?.length ?? 0) > 0;
  const guarded = namedOutput ? undefined : stories;
  const diagnostics: Diagnostic[] = [];
  const outputMode: OutputMode = options.outputMode ?? 'html';
  const trim = options.trim ?? true;
  const twee2Compat = options.twee2Compat ?? false;
  const testMode = options.testMode ?? false;
  const noRemote = options.noRemote ?? false;
  const sourceInfo = options.sourceInfo ?? false;

  options.signal?.throwIfAborted();
  diagnostics.push(...unknownOptionWarnings(options));
  checkNamedInputs(namedInputs(options, extraInputs), outputGuard, diagnostics);

  // Clear per-compile index cache
  clearIndexCache();

  // Group the sources in the order supplied: each run of file paths is walked (directories
  // expanded in place) and each run of inline sources is kept together, so a later source
  // overrides an earlier one whatever kind each is.
  const groups: SourceGroup[] = [];
  for (const source of options.sources) {
    const last = groups[groups.length - 1];
    if (typeof source === 'string') {
      if (last?.kind === 'paths') last.paths.push(source);
      else groups.push({ kind: 'paths', paths: [source] });
    } else if (last?.kind === 'inline') {
      last.sources.push(source);
    } else {
      groups.push({ kind: 'inline', sources: [source] });
    }
  }

  const walked = groups.map((group) => {
    if (group.kind === 'inline') return group;
    const found = getFilenames(group.paths, written, options.exclude);
    diagnostics.push(...found.diagnostics);
    if (guardsFolders) checkSkippedOutputs(found.skippedOutputs, 'source', diagnostics, guarded);
    return { kind: 'files' as const, files: found.files };
  });
  // Modules are read for HTML output only, but checked in every mode.
  const modules = getFilenames(options.modules ?? [], written, [], 'module');
  if (guardsFolders) checkSkippedOutputs(modules.skippedOutputs, 'module', diagnostics, guarded);
  // Once the output is known to be no input, and before the work: a target that can't be written fails now.
  if (context.writesOutput === true && typeof outputs === 'string') checkWritable(outputs);
  context.onDiscovered?.([...walked.flatMap((group) => (group.kind === 'files' ? group.files : [])), ...modules.files]);
  // Every file of the build, so that a cache purge while loading one group keeps the others' entries.
  const buildFiles = new Set(walked.flatMap((group) => (group.kind === 'files' ? group.files.map((f) => f.path) : [])));

  // Create story and load sources
  const story = createStory();
  const processedFiles = new Set<string>();

  for (const group of walked) {
    if (group.kind === 'inline') {
      loadInlineSources(story, group.sources, { trim, twee2Compat }, diagnostics);
    } else if (cache) {
      loadSourcesCached(
        story,
        group.files,
        { trim, twee2Compat },
        diagnostics,
        processedFiles,
        cache,
        changedFiles,
        buildFiles,
      );
    } else {
      loadSources(story, group.files, { trim, twee2Compat }, diagnostics, processedFiles);
    }
  }
  if (cache && buildFiles.size === 0) {
    loadSourcesCached(story, [], { trim, twee2Compat }, diagnostics, processedFiles, cache, changedFiles);
  }

  // Apply tag aliases (e.g. library → script)
  if (options.tagAliases) {
    story.passages = applyTagAliases(story.passages, options.tagAliases);
  }

  // Resolve format: explicit formatId > StoryData format > default, looked up locally,
  // in the download cache, then remotely. An unavailable request is an error, never another format.
  let format: StoryFormatInfo | undefined;

  if (outputMode === 'html') {
    const request = formatRequestFor(
      options.formatId,
      story.twine2.format,
      story.twine2.formatVersion,
      DEFAULT_FORMAT_ID,
    );
    format = await resolveStoryFormat(request, { ...options, noRemote }, diagnostics);
    // The caller may have aborted while the format was being found.
    options.signal?.throwIfAborted();
    if (format) checkNamedInputs(formatInputs(format), outputGuard, diagnostics);
  }

  // Merge config from StoryData: command-line > StoryData > default.
  // An explicit override is recorded on the story so JSON output and inspection see it too.
  if (options.startPassage) story.twine2.start = options.startPassage;
  const startName = story.twine2.start || DEFAULT_START_NAME;

  // Apply test mode
  if (testMode) {
    story.twine2.options.set('debug', true);
  }

  // The Twine 2 story data carries the IFID; the other outputs write it when the story has one (as Tweego does).
  if (requiresIFID(outputMode, format)) ensureIFID(story, diagnostics);

  // Generate output
  let output: string;
  let externalFiles: string[] | undefined;

  switch (outputMode) {
    case 'twee3':
    case 'twee1':
      // Without a StoryData passage, add one only to record what the options changed.
      output = toTwee(story, outputMode, { addStoryData: Boolean(options.startPassage) || testMode, diagnostics });
      break;

    case 'twine2-archive':
      output = toTwine2Archive(story, startName, { sourceInfo, diagnostics });
      break;

    case 'twine1-archive':
      output = toTwine1Archive(story, startName, { diagnostics });
      break;

    case 'json':
      output = storyToJSON(story, startName, diagnostics);
      break;

    case 'html': {
      // Sanity checks for HTML mode
      diagnostics.push(...startPassageDiagnostics(story, startName, format?.isTwine2 === false ? 'twine1' : 'twine2'));

      if (!format) {
        throw new TweeTsError('No story format available for HTML output.', diagnostics);
      }

      // A story without a name cannot start in SugarCube, and Twine 1 reads its name from the StoryTitle passage.
      diagnostics.push(...storyTitleDiagnostics(story, format.isTwine2 ? 'twine2' : 'twine1'));

      // Modules and head file, injected before the template's closing head tag while the template is filled
      const { head, injected } = headContent(modules, options.headFile, diagnostics);
      externalFiles = injected;

      output = format.isTwine2
        ? toTwine2HTML(story, format, startName, { sourceInfo, head, diagnostics })
        : toTwine1HTML(story, format, startName, { head, diagnostics });
      break;
    }

    default: {
      const _exhaustive: never = outputMode;
      throw new TweeTsError(`Unhandled output mode: ${_exhaustive}`, diagnostics);
    }
  }
  // Lint reads the modules and head file as HTML output does, for what HTML output would report about them.
  if (context.checkHead === true && outputMode !== 'html') headContent(modules, options.headFile, diagnostics);

  // Compute stats
  const stats: CompileStats = {
    ...getStoryStats(story, options.wordCountMethod),
    files: [...processedFiles],
    ...(externalFiles === undefined ? {} : { externalFiles }),
  };

  // Nothing is delivered, or written by the caller, for a build that was aborted meanwhile.
  options.signal?.throwIfAborted();
  // The output may have been moved (a link retargeted) while the build awaited a format: the file it will be
  // written to is checked again, against every input, as the last step before the caller writes it.
  if (namedOutput) {
    checkNamedInputs(
      [
        ...namedInputs(options, extraInputs),
        ...(format ? formatInputs(format) : []),
        ...walked
          .flatMap((group) => (group.kind === 'files' ? group.files : []))
          .map((file) => ({ role: 'source' as const, path: file.path })),
        ...modules.files.map((file) => ({ role: 'module' as const, path: file.path })),
      ],
      outputPaths(written),
      diagnostics,
    );
  }
  // The same holds for an output that became an authored file of a source or module folder while the build awaited
  // a format (edited, or created at a path nothing was at): the folders are walked again for what they now skip.
  if (guardsFolders && outputMode === 'html') {
    for (const group of groups) {
      if (group.kind === 'paths') {
        checkSkippedOutputs(
          getFilenames(group.paths, written, options.exclude).skippedOutputs,
          'source',
          diagnostics,
          guarded,
        );
      }
    }
    checkSkippedOutputs(
      getFilenames(options.modules ?? [], written, [], 'module').skippedOutputs,
      'module',
      diagnostics,
      guarded,
    );
  }
  // The story handed out is a frozen copy: it shares no object with the incremental cache (#246 S-4).
  return { output: output, story: snapshot(story), format, diagnostics, stats };
}

/** How a build runs, beyond its options: what buildOutput() is called with by each entry point. */
interface BuildContext {
  /** Cache files as compileIncremental() caches them. */
  readonly cache?: Map<string, FileCacheEntry> | undefined;
  /** The files known to have changed since the last build with `cache`. */
  readonly changedFiles?: ReadonlySet<string> | undefined;
  /** What the build writes, which no input may be (see checkNamedInputs). */
  readonly outputs?: BuildOutputs | string | undefined;
  /** Inputs besides the options' own (the CLI's config file). */
  readonly extraInputs?: readonly ExtraInput[];
  /** Receives every source and module file the build found, before any is read (for the watcher). */
  readonly onDiscovered?: (files: readonly DiscoveredFile[]) => void;
  /** Read the modules and head file as HTML output does, whatever the output mode (for lint). */
  readonly checkHead?: boolean;
  /**
   * Whether the output file named in `outputs` is written after the build: it is then checked to be writable
   * (see checkWritable) once the inputs are checked and before any is read, so a missing folder or a read-only
   * file fails before the work.
   */
  readonly writesOutput?: boolean;
}

/** A run of sources of one kind, in the order supplied. */
type SourceGroup =
  { readonly kind: 'paths'; readonly paths: string[] } | { readonly kind: 'inline'; readonly sources: InlineSource[] };

/**
 * Whether the output needs an IFID: Twine 2 HTML and the Twine 2 archive, whose `tw-storydata` element has an `ifid`
 * attribute that Twine 2 requires, as Tweego requires it. Twine 1 HTML and archives, Twee and JSON (where `ifid` is
 * optional) are written without one when the story has none. HTML output with no format fails anyway.
 */
function requiresIFID(outputMode: OutputMode, format: StoryFormatInfo | undefined): boolean {
  switch (outputMode) {
    case 'html':
      return format?.isTwine2 !== false;
    case 'twine2-archive':
      return true;
    case 'twine1-archive':
    case 'twee3':
    case 'twee1':
    case 'json':
      return false;
    default: {
      const _exhaustive: never = outputMode;
      throw new TweeTsError(`Unhandled output mode: ${String(_exhaustive)}`, []);
    }
  }
}

/** Give the story an IFID for output that requires one: the legacy IFID, else a generated one, reported. */
function ensureIFID(story: Story, diagnostics: Diagnostic[]): void {
  if (story.ifid !== '') return;

  if (story.legacyIFID !== '') {
    story.ifid = story.legacyIFID;
    diagnostics.push({
      level: 'warning',
      message: 'Story IFID not found; reusing "ifid" entry from the "StorySettings" special passage.',
    });
  } else {
    const ifid = generateIFID();
    story.ifid = ifid;
    diagnostics.push({
      level: 'error',
      message: `Story IFID not found. Add an IFID to your story: {"ifid":"${ifid}"}`,
    });
  }
}

/**
 * Serialize a Story to JSON per the Twine 2 JSON Output Specification (v1.0):
 * https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-jsonoutput-doc.md
 * `start` is the start passage the other output modes use (`startName`): the one StoryData or the options name,
 * else the default `Start` when the JSON lists a passage of that name. `tag-colors` holds the tag colors Twine 2
 * output writes; `diagnostics` receives a warning for each color left out (see `twine2TagColors()`).
 */
function storyToJSON(story: Story, startName: string, diagnostics: Diagnostic[]): string {
  // Gather script and stylesheet content, excluding them from passages.
  const scripts: string[] = [];
  const stylesheets: StylesheetSource[] = [];
  const storyPassages: { name: string; tags: string[]; text: string; metadata?: Record<string, string> }[] = [];

  for (const p of story.passages) {
    if (p.name === 'StoryTitle' || p.name === 'StoryData') continue;
    if (hasTag(p, 'Twine.private')) continue;

    if (hasTag(p, 'script')) {
      scripts.push(p.text);
    } else if (hasTag(p, 'stylesheet')) {
      stylesheets.push({ label: `Stylesheet passage "${p.name}"`, text: p.text });
    } else {
      const entry: { name: string; tags: string[]; text: string; metadata?: Record<string, string> } = {
        name: p.name,
        tags: p.tags,
        text: p.text,
      };
      // Own properties, so a key such as `__proto__` is kept.
      const metadata = metadataForOutput(p.metadata);
      if (metadata !== undefined) entry.metadata = metadata;
      storyPassages.push(entry);
    }
  }

  const tagColors = twine2TagColors(story);
  diagnostics.push(...tagColors.diagnostics);
  diagnostics.push(...ineffectiveImportDiagnostics(stylesheets));
  const start = story.twine2.start !== '' || storyPassages.some((p) => p.name === startName) ? startName : '';
  // Keys in the order the JSON output lists them; optional ones only when set.
  const obj = {
    name: story.name,
    ...(story.ifid ? { ifid: story.ifid } : {}),
    ...(story.twine2.format ? { format: story.twine2.format } : {}),
    ...(story.twine2.formatVersion ? { 'format-version': story.twine2.formatVersion } : {}),
    ...(start ? { start } : {}),
    ...(tagColors.colors.length > 0 ? { 'tag-colors': Object.fromEntries(tagColors.colors) } : {}),
    ...(story.twine2.zoom !== 1 ? { zoom: story.twine2.zoom } : {}),
    creator: CREATOR_NAME,
    'creator-version': VERSION,
    style: stylesheets.map((sheet) => sheet.text).join('\n'),
    script: scripts.map((text, i) => (i < scripts.length - 1 ? terminateScript(text) : text)).join(''),
    passages: storyPassages,
  };

  return JSON.stringify(obj, null, 2);
}

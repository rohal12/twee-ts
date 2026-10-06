/**
 * Main compiler orchestrator.
 * compile(), compileToFile(), watch().
 * Ported from tweego.go + config.go.
 */
import { resolve, sep } from 'node:path';
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
import { createStory, storyHas, getStoryStats } from './story.js';
import { getFilenames, isExcluded, outputPaths, realPathOf, toBuildOutputs, watchFilesystem } from './filesystem.js';
import type { BuildOutputs } from './filesystem.js';
import { formatRequestFor, resolveStoryFormat } from './format-resolution.js';
import { loadSources, loadInlineSources, loadSourcesCached } from './loader.js';
import { applyTagAliases, hasTag } from './passage.js';
import { generateIFID } from './ifid.js';
import { toTwine2HTML, toTwine2Archive } from './output-twine2.js';
import { toTwine1HTML, toTwine1Archive } from './output-twine1.js';
import { toTwee } from './output-twee.js';
import { loadHeadContent } from './modules.js';
import { startPassageDiagnostics } from './start-passage.js';
import { clearIndexCache } from './remote-formats.js';
import { writeFileAtomic } from './atomic-write.js';
import { VERSION } from './version.js';

const CREATOR_NAME = 'Twee-ts';

const DEFAULT_FORMAT_ID = 'sugarcube-2';
const DEFAULT_START_NAME = 'Start';

export class TweeTsError extends Error {
  constructor(
    message: string,
    public diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = 'TweeTsError';
  }
}

/**
 * Compile Twee sources to HTML, Twee, or JSON.
 */
export async function compile(options: CompileOptions): Promise<CompileResult> {
  return buildOutput(options);
}

/**
 * Compile and write to a file. The file is replaced atomically: a reader sees the previous
 * build or the new one, never part of it, and a failed write leaves the previous build.
 */
export async function compileToFile(options: CompileToFileOptions): Promise<CompileResult> {
  const result = await compileForOutputFile(options, options.outFile);
  // The build may have been aborted after it finished: the previous output stays.
  options.signal?.throwIfAborted();
  writeFileAtomic(options.outFile, result.output);
  return result;
}

/**
 * Builds as compileToFile() does for `outputs`, without writing them: an output may sit
 * inside a source folder, so its last build is left out of the sources and modules and
 * never read back. `outputs` is the one file the CLI writes, or every path a bundler's
 * build writes (see BuildOutputs). The caller decides whether the result is written.
 * With no outputs (output to stdout, or none), this is compile(). With `cache`, files
 * are cached as compileIncremental() caches them.
 *
 * Throws a TweeTsError when a source, module or head file named directly is an output.
 *
 * Internal, for the CLI and the bundler plugins; not part of the public API.
 */
export async function compileForOutputFile(
  options: CompileOptions,
  outputs: BuildOutputs | string | undefined,
  cache?: Map<string, FileCacheEntry>,
): Promise<CompileResult> {
  return buildOutput(options, cache, undefined, outputs);
}

/**
 * Compile with incremental caching support.
 * Plugins and advanced users can manage their own cache and changed-file tracking.
 *
 * Without `changedFiles`, a cached file is reused while its modification time is unchanged.
 * With it, a file it names is always reparsed, whatever its modification time, and every
 * other cached file is reused as it is. A file may be named by an absolute path or by a path
 * relative to the working directory, with or without a leading `./`: entries are matched to
 * the source files by resolved path. A file that fails to load is dropped from the cache, so
 * the next build tries it again.
 */
export async function compileIncremental(
  options: CompileOptions,
  cache: Map<string, FileCacheEntry>,
  changedFiles?: ReadonlySet<string>,
): Promise<CompileResult> {
  return buildOutput(options, cache, changedFiles);
}

/**
 * Watch for file changes and recompile. Every build is written to `outFile` (replacing it
 * atomically, as compileToFile() does), including one whose diagnostics report errors.
 * Builds run one at a time, and each one is written and reported as it finishes, in order:
 * changes made during a build go into one follow-up build after it. A watched path that
 * can't be watched is passed to `onError`.
 *
 * Aborting the returned controller, or the `signal` in the options, stops watching and
 * aborts the story format requests of the build in progress.
 */
export async function watch(options: WatchOptions): Promise<AbortController> {
  return watchWithWriteFilter(options, () => true);
}

/**
 * watch(), writing to `outFile` only the builds `shouldWrite` accepts. A rejected build
 * leaves the output file as it was; `onBuild` receives every build either way.
 *
 * Internal, for the CLI, which keeps the last good output when a rebuild reports errors;
 * not part of the public API.
 */
export async function watchWithWriteFilter(
  options: WatchOptions,
  shouldWrite: (result: CompileResult) => boolean,
  hooks: WatchHooks = {},
): Promise<AbortController> {
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
  const notExcludable = [...modulePaths, ...headPaths].map((p) => resolve(p));
  const ignore = (filename: string): boolean => {
    if (!isExcluded(filename, exclude)) return false;
    const abs = resolve(filename);
    return !notExcludable.some((root) => abs === root || abs.startsWith(root + sep));
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
        // Unknown/root identity changes may replace contents while preserving mtimes.
        // A full watch rebuild must read them again; ordinary incremental calls retain caching.
        if (request.changedFiles === undefined) cache.clear();
        const outcome = await buildOutput(buildOptions, cache, request.changedFiles, options.outFile).then(
          (result): WatchBuildOutcome => ({ ok: true, result }),
          (e: unknown): WatchBuildOutcome => ({ ok: false, error: toError(e) }),
        );
        if (controller.signal.aborted) return;
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
      drain(request).catch((e: unknown) => reportError(toError(e)));
    },
    ignore,
    reportError,
  );

  const outer = options.signal;
  const onOuterAbort = (): void => controller.abort(outer?.reason);
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

/**
 * `outputs`: what the build writes (an output file's path, or a bundler's outputs),
 * which source and module discovery skip, so an output inside a source folder is
 * never loaded back. A source, module or head file named directly that is an output
 * is a TweeTsError, as in Tweego: writing the build would overwrite it.
 */
async function buildOutput(
  options: CompileOptions,
  cache?: Map<string, FileCacheEntry>,
  changedFiles?: ReadonlySet<string>,
  outputs?: BuildOutputs | string,
): Promise<CompileResult> {
  const written = toBuildOutputs(outputs);
  const diagnostics: Diagnostic[] = [];
  const outputLocations = outputPaths(written);
  rejectOutputSources(
    [...(options.modules ?? []), ...(options.headFile === undefined ? [] : [options.headFile])].filter((path) =>
      outputLocations.isFile(realPathOf(path)),
    ),
    diagnostics,
  );
  const outputMode: OutputMode = options.outputMode ?? 'html';
  const trim = options.trim ?? true;
  const twee2Compat = options.twee2Compat ?? false;
  const testMode = options.testMode ?? false;
  const noRemote = options.noRemote ?? false;
  const sourceInfo = options.sourceInfo ?? false;

  options.signal?.throwIfAborted();
  const timeout = options.formatFetchTimeout;
  if (timeout !== undefined && !(timeout >= 0)) {
    throw new TweeTsError(`formatFetchTimeout must be 0 or more milliseconds, not ${timeout}.`);
  }

  // Clear per-compile index cache
  clearIndexCache();

  // Group the sources in the order supplied: each run of file paths is walked (directories
  // expanded in place) and each run of inline sources is kept together, so a later source
  // overrides an earlier one whatever kind each is.
  const groups: SourceGroup[] = [];
  const outputSources: string[] = [];
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
    outputSources.push(...found.outputSources);
    return { kind: 'files' as const, filenames: found.filenames };
  });
  rejectOutputSources(outputSources, diagnostics);
  // Every file of the build, so that a cache purge while loading one group keeps the others' entries.
  const buildFiles = new Set(walked.flatMap((group) => (group.kind === 'files' ? group.filenames : [])));

  // Create story and load sources
  const story = createStory();
  const processedFiles = new Set<string>();

  for (const group of walked) {
    if (group.kind === 'inline') {
      loadInlineSources(story, group.sources, { trim, twee2Compat }, diagnostics);
    } else if (cache) {
      loadSourcesCached(
        story,
        group.filenames,
        { trim, twee2Compat },
        diagnostics,
        processedFiles,
        cache,
        changedFiles,
        buildFiles,
      );
    } else {
      loadSources(story, group.filenames, { trim, twee2Compat }, diagnostics, processedFiles);
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
  }

  // Merge config from StoryData: command-line > StoryData > default.
  // An explicit override is recorded on the story so JSON output and inspection see it too.
  if (options.startPassage) story.twine2.start = options.startPassage;
  const startName = story.twine2.start || DEFAULT_START_NAME;

  // Apply test mode
  if (testMode) {
    story.twine2.options.set('debug', true);
  }

  // Ensure IFID is set before output generation
  ensureIFID(story, diagnostics);

  // Generate output
  let output: string;

  switch (outputMode) {
    case 'twee3':
    case 'twee1':
      // Without a StoryData passage, add one only to record what the options changed.
      output = toTwee(story, outputMode, { addStoryData: Boolean(options.startPassage) || testMode, diagnostics });
      break;

    case 'twine2-archive':
      output = toTwine2Archive(story, startName, { sourceInfo });
      break;

    case 'twine1-archive':
      output = toTwine1Archive(story, startName);
      break;

    case 'json':
      output = storyToJSON(story);
      break;

    case 'html': {
      // Sanity checks for HTML mode
      diagnostics.push(...startPassageDiagnostics(story, startName, format?.isTwine2 === false ? 'twine1' : 'twine2'));

      if (!format) {
        throw new TweeTsError('No story format available for HTML output.', diagnostics);
      }

      if (!format.isTwine2 && story.name === '' && !storyHas(story, 'StoryTitle')) {
        diagnostics.push({
          level: 'error',
          message: 'Special passage "StoryTitle" not found.',
        });
      }

      // Modules and head file, injected before the template's closing head tag while the template is filled
      const modules = getFilenames(options.modules ?? [], written);
      diagnostics.push(...modules.diagnostics);
      const { headFile } = options;
      const headIsOutput = headFile !== undefined && outputPaths(written).isFile(realPathOf(headFile));
      rejectOutputSources([...modules.outputSources, ...(headIsOutput ? [headFile] : [])], diagnostics);
      const head = loadHeadContent(modules.filenames, options.headFile, diagnostics);

      output = format.isTwine2
        ? toTwine2HTML(story, format, startName, { sourceInfo, head, diagnostics })
        : toTwine1HTML(story, format, startName, { head, diagnostics });
      break;
    }

    default: {
      const _exhaustive: never = outputMode;
      throw new TweeTsError(`Unhandled output mode: ${_exhaustive as string}`, diagnostics);
    }
  }

  // Compute stats
  const stats: CompileStats = {
    ...getStoryStats(story, options.wordCountMethod),
    files: [...processedFiles],
  };

  // Nothing is delivered, or written by the caller, for a build that was aborted meanwhile.
  options.signal?.throwIfAborted();
  return { output, story, format, diagnostics, stats };
}

/** A run of sources of one kind, in the order supplied. */
type SourceGroup =
  { readonly kind: 'paths'; readonly paths: string[] } | { readonly kind: 'inline'; readonly sources: InlineSource[] };

/**
 * Throws for the first of `paths`, inputs named directly that are also an output:
 * writing the build would overwrite them. An output found while walking a source
 * folder is skipped instead (see getFilenames).
 */
function rejectOutputSources(paths: readonly string[], diagnostics: readonly Diagnostic[]): void {
  const [first] = paths;
  if (first === undefined) return;
  throw new TweeTsError(`path ${first}: Output file cannot be an input source.`, [...diagnostics]);
}

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
 */
function storyToJSON(story: Story): string {
  // Gather script and stylesheet content, excluding them from passages.
  const scripts: string[] = [];
  const stylesheets: string[] = [];
  const storyPassages: { name: string; tags: string[]; text: string; metadata?: Record<string, string> }[] = [];

  for (const p of story.passages) {
    if (p.name === 'StoryTitle' || p.name === 'StoryData') continue;
    if (hasTag(p, 'Twine.private')) continue;

    if (hasTag(p, 'script')) {
      scripts.push(p.text);
    } else if (hasTag(p, 'stylesheet')) {
      stylesheets.push(p.text);
    } else {
      const entry: { name: string; tags: string[]; text: string; metadata?: Record<string, string> } = {
        name: p.name,
        tags: p.tags,
        text: p.text,
      };
      if (p.metadata) {
        const meta: Record<string, string> = {};
        for (const [key, value] of Object.entries(p.metadata)) {
          if (typeof value === 'string') meta[key] = value;
        }
        if (Object.keys(meta).length > 0) {
          entry.metadata = meta;
        }
      }
      storyPassages.push(entry);
    }
  }

  const obj: Record<string, unknown> = {
    name: story.name,
  };

  if (story.ifid) obj.ifid = story.ifid;
  if (story.twine2.format) obj.format = story.twine2.format;
  if (story.twine2.formatVersion) obj['format-version'] = story.twine2.formatVersion;
  if (story.twine2.start) obj.start = story.twine2.start;
  if (story.twine2.tagColors.size > 0) obj['tag-colors'] = Object.fromEntries(story.twine2.tagColors);
  if (story.twine2.zoom !== 1) obj.zoom = story.twine2.zoom;
  obj.creator = CREATOR_NAME;
  obj['creator-version'] = VERSION;
  obj.style = stylesheets.join('\n');
  obj.script = scripts.join('\n');
  obj.passages = storyPassages;

  return JSON.stringify(obj, null, 2);
}

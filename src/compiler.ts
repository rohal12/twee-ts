/**
 * Main compiler orchestrator.
 * compile(), compileToFile(), watch().
 * Ported from tweego.go + config.go.
 */
import { writeFileSync } from 'node:fs';
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
import { getFilenames, isExcluded, watchFilesystem } from './filesystem.js';
import { formatRequestFor, resolveStoryFormat } from './format-resolution.js';
import { loadSources, loadInlineSources, loadSourcesCached } from './loader.js';
import { applyTagAliases, hasTag } from './passage.js';
import { generateIFID } from './ifid.js';
import { toTwine2HTML, toTwine2Archive } from './output-twine2.js';
import { toTwine1HTML, toTwine1Archive } from './output-twine1.js';
import { toTwee } from './output-twee.js';
import { modifyHead } from './modules.js';
import { startPassageDiagnostics } from './start-passage.js';
import { clearIndexCache } from './remote-formats.js';
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
 * Compile and write to a file.
 */
export async function compileToFile(options: CompileToFileOptions): Promise<CompileResult> {
  const result = await compileForOutputFile(options, options.outFile);
  writeFileSync(options.outFile, result.output, 'utf-8');
  return result;
}

/**
 * Builds as compileToFile() does for `outFile`, without writing it: the output may sit
 * inside a source folder, so its last build is left out of the sources and modules and
 * never read back. The caller decides whether the result is written. With no `outFile`
 * (output to stdout, or none), this is compile().
 *
 * Internal, for the CLI; not part of the public API.
 */
export async function compileForOutputFile(
  options: CompileOptions,
  outFile: string | undefined,
): Promise<CompileResult> {
  return buildOutput(options, undefined, undefined, outFile);
}

/**
 * Compile with incremental caching support.
 * Plugins and advanced users can manage their own cache and changed-file tracking.
 *
 * Without `changedFiles`, a cached file is reused while its modification time is unchanged.
 * With it, a file it names (by the path source discovery gives it, relative to the working
 * directory) is always reparsed, whatever its modification time, and every other cached
 * file is reused as it is.
 */
export async function compileIncremental(
  options: CompileOptions,
  cache: Map<string, FileCacheEntry>,
  changedFiles?: ReadonlySet<string>,
): Promise<CompileResult> {
  return buildOutput(options, cache, changedFiles);
}

/**
 * Watch for file changes and recompile. Every build is written to `outFile`, including
 * one whose diagnostics report errors. Builds run one at a time: changes made during a
 * build go into one follow-up build after it, and the superseded build is neither
 * written nor reported.
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
): Promise<AbortController> {
  const controller = new AbortController();
  const cache = new Map<string, FileCacheEntry>();

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

  // One build at a time. Changes reported while a build is in flight wait in `queued` and
  // go into a single follow-up build once it finishes; the build they arrived during is
  // superseded, and its result is neither written nor reported.
  let building = false;
  let queued: WatchBuildRequest | undefined;

  const deliver = (outcome: WatchBuildOutcome): void => {
    try {
      if (!outcome.ok) throw outcome.error;
      if (shouldWrite(outcome.result)) writeFileSync(options.outFile, outcome.result.output, 'utf-8');
      options.onBuild?.(outcome.result);
    } catch (e) {
      options.onError?.(toError(e));
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
        const current: WatchBuildRequest = request;
        const outcome = await buildOutput(options, cache, current.changedFiles, options.outFile).then(
          (result): WatchBuildOutcome => ({ ok: true, result }),
          (e: unknown): WatchBuildOutcome => ({ ok: false, error: toError(e) }),
        );
        if (controller.signal.aborted) return;
        // The follow-up also covers this build's changes, so it doesn't depend on what this one cached.
        request = queued === undefined ? undefined : mergeBuildRequests(current, queued);
        queued = undefined;
        if (request === undefined) deliver(outcome);
      }
    } finally {
      building = false;
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
      void drain(request);
    },
    ignore,
  );

  controller.signal.addEventListener('abort', () => {
    queued = undefined;
    handle.close();
  });
  return controller;
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
 * `outFile`: the file the build is written to, which source and module discovery
 * skip (as Tweego does), so an output inside a source folder is never loaded back.
 */
async function buildOutput(
  options: CompileOptions,
  cache?: Map<string, FileCacheEntry>,
  changedFiles?: ReadonlySet<string>,
  outFile?: string,
): Promise<CompileResult> {
  const diagnostics: Diagnostic[] = [];
  const outputMode: OutputMode = options.outputMode ?? 'html';
  const trim = options.trim ?? true;
  const twee2Compat = options.twee2Compat ?? false;
  const testMode = options.testMode ?? false;
  const noRemote = options.noRemote ?? false;
  const sourceInfo = options.sourceInfo ?? false;

  // Clear per-compile index cache
  clearIndexCache();

  // Separate file paths from inline sources
  const filePaths: string[] = [];
  const inlineSources: InlineSource[] = [];
  for (const source of options.sources) {
    if (typeof source === 'string') {
      filePaths.push(source);
    } else {
      inlineSources.push(source);
    }
  }

  // Walk file paths to get all source filenames
  const { filenames: sourceFilenames, diagnostics: sourcePathDiagnostics } = getFilenames(
    filePaths,
    outFile,
    options.exclude,
  );
  diagnostics.push(...sourcePathDiagnostics);

  // Create story and load sources
  const story = createStory();
  const processedFiles = new Set<string>();

  if (cache) {
    loadSourcesCached(story, sourceFilenames, { trim, twee2Compat }, diagnostics, processedFiles, cache, changedFiles);
  } else {
    loadSources(story, sourceFilenames, { trim, twee2Compat }, diagnostics, processedFiles);
  }
  loadInlineSources(story, inlineSources, { trim, twee2Compat }, diagnostics);

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
      output = toTwee(story, outputMode, { addStoryData: Boolean(options.startPassage) || testMode });
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

      if (format.isTwine2) {
        output = toTwine2HTML(story, format, startName, { sourceInfo });
      } else {
        if (story.name === '' && !storyHas(story, 'StoryTitle')) {
          diagnostics.push({
            level: 'error',
            message: 'Special passage "StoryTitle" not found.',
          });
        }
        output = toTwine1HTML(story, format, startName);
      }

      // Inject modules and head file
      const modules = getFilenames(options.modules ?? [], outFile);
      diagnostics.push(...modules.diagnostics);
      output = modifyHead(output, modules.filenames, options.headFile, diagnostics);
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

  return { output, story, format, diagnostics, stats };
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

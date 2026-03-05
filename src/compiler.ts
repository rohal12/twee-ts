/**
 * Main compiler orchestrator.
 * compile(), compileToFile(), watch().
 * Ported from tweego.go + config.go.
 */
import { writeFileSync } from 'node:fs';
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
} from './types.js';
import { createStory, storyHas, getStoryStats } from './story.js';
import { getFilenames, watchFilesystem } from './filesystem.js';
import { discoverFormats, getFormatSearchDirs, getFormatIdByNameAndVersion } from './formats.js';
import { loadSources, loadInlineSources } from './loader.js';
import { applyTagAliases, hasTag } from './passage.js';
import { toTwine2HTML, toTwine2Archive } from './output-twine2.js';
import { toTwine1HTML, toTwine1Archive } from './output-twine1.js';
import { toTwee } from './output-twee.js';
import { modifyHead } from './modules.js';
import { resolveRemoteFormat, clearIndexCache } from './remote-formats.js';
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
  const result = await compile(options);
  writeFileSync(options.outFile, result.output, 'utf-8');
  return result;
}

/**
 * Watch for file changes and recompile.
 */
export async function watch(options: WatchOptions): Promise<AbortController> {
  const controller = new AbortController();

  // Separate file paths from inline sources
  const filePaths = options.sources.filter((s): s is string => typeof s === 'string');
  const modulePaths = options.modules ?? [];
  const allPaths = [...filePaths, ...modulePaths];

  const handle = watchFilesystem(allPaths, options.outFile, () => {
    buildOutput(options)
      .then((result) => {
        writeFileSync(options.outFile, result.output, 'utf-8');
        options.onBuild?.(result);
      })
      .catch((e) => {
        options.onError?.(e instanceof Error ? e : new Error(String(e)));
      });
  });

  controller.signal.addEventListener('abort', () => handle.close());
  return controller;
}

async function buildOutput(options: CompileOptions): Promise<CompileResult> {
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
  const sourceFilenames = getFilenames(filePaths);

  // Create story and load sources
  const story = createStory();
  const processedFiles = new Set<string>();

  loadSources(story, sourceFilenames, { trim, twee2Compat }, diagnostics, processedFiles);
  loadInlineSources(story, inlineSources, { trim, twee2Compat }, diagnostics);

  // Apply tag aliases (e.g. library → script)
  if (options.tagAliases) {
    story.passages = applyTagAliases(story.passages, options.tagAliases);
  }

  // Resolve format
  let format: StoryFormatInfo | undefined;
  let formatId = options.formatId ?? '';

  if (outputMode === 'html') {
    const formatSearchDirs = getFormatSearchDirs(options.formatPaths, options.useTweegoPath ?? true);
    const formats = discoverFormats(formatSearchDirs);

    if (!formatId && story.twine2.format) {
      formatId = getFormatIdByNameAndVersion(formats, story.twine2.format, story.twine2.formatVersion) ?? '';
    }
    if (!formatId) {
      formatId = DEFAULT_FORMAT_ID;
    }

    format = formats.get(formatId);

    // Remote format fallback
    if (!format && !noRemote) {
      // Determine the format name and version for remote lookup
      const remoteName = story.twine2.format || formatId;
      const remoteVersion = story.twine2.formatVersion || '';

      try {
        format = await resolveRemoteFormat(remoteName, remoteVersion, options.formatIndices, options.formatUrls);
      } catch (e) {
        diagnostics.push({
          level: 'warning',
          message: `Remote format fetch failed for "${remoteName}": ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    if (!format) {
      const reason = noRemote ? ' (remote fetching disabled)' : '';
      diagnostics.push({
        level: 'error',
        message: `Story format "${formatId}" is not available${reason}. Found: ${[...formats.keys()].join(', ') || 'none'}`,
      });
    }
  }

  // Merge config from StoryData: command-line > StoryData > default
  const startName = options.startPassage || story.twine2.start || DEFAULT_START_NAME;

  // Apply test mode
  if (testMode) {
    story.twine2.options.set('debug', true);
  }

  // Generate output
  let output: string;

  switch (outputMode) {
    case 'twee3':
    case 'twee1':
      output = toTwee(story, outputMode);
      break;

    case 'twine2-archive':
      output = toTwine2Archive(story, startName, diagnostics, { sourceInfo });
      break;

    case 'twine1-archive':
      output = toTwine1Archive(story, startName);
      break;

    case 'json':
      output = storyToJSON(story);
      break;

    case 'html': {
      // Sanity checks for HTML mode
      if (!storyHas(story, startName)) {
        diagnostics.push({
          level: 'error',
          message: `Starting passage "${startName}" not found.`,
        });
      }

      if (!format) {
        throw new TweeTsError('No story format available for HTML output.', diagnostics);
      }

      if (format.isTwine2) {
        output = toTwine2HTML(story, format, startName, diagnostics, { sourceInfo });
      } else {
        if (story.name === '' && !storyHas(story, 'StoryTitle')) {
          diagnostics.push({
            level: 'error',
            message: 'Special passage "StoryTitle" not found.',
          });
        }
        output = toTwine1HTML(story, format, startName, diagnostics);
      }

      // Inject modules and head file
      const modulePaths = options.modules ? getFilenames(options.modules) : [];
      output = modifyHead(output, modulePaths, options.headFile, diagnostics);
      break;
    }

    default: {
      const _exhaustive: never = outputMode;
      throw new TweeTsError(`Unhandled output mode: ${_exhaustive as string}`, diagnostics);
    }
  }

  // Compute stats
  const stats: CompileStats = {
    ...getStoryStats(story),
    files: [...processedFiles],
  };

  return { output, story, format, diagnostics, stats };
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

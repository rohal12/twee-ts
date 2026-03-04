/**
 * Main compiler orchestrator.
 * compile(), compileToFile(), watch().
 * Ported from tweego.go + config.go.
 */
import { writeFileSync } from 'node:fs';
import type {
  CompileOptions, CompileToFileOptions, WatchOptions,
  CompileResult, CompileStats, Diagnostic, Story,
  StoryFormatInfo, OutputMode, InlineSource,
} from './types.js';
import { createStory, storyHas, getStoryStats } from './story.js';
import { getFilenames, watchFilesystem } from './filesystem.js';
import { discoverFormats, getFormatSearchDirs, getFormatIdByNameAndVersion } from './formats.js';
import { loadSources, loadInlineSources } from './loader.js';
import { applyTagAliases } from './passage.js';
import { toTwine2HTML, toTwine2Archive } from './output-twine2.js';
import { toTwine1HTML, toTwine1Archive } from './output-twine1.js';
import { toTwee } from './output-twee.js';
import { modifyHead } from './modules.js';
import { resolveRemoteFormat, clearIndexCache } from './remote-formats.js';

const DEFAULT_FORMAT_ID = 'sugarcube-2';
const DEFAULT_START_NAME = 'Start';

export class TweeTsError extends Error {
  constructor(message: string, public diagnostics: Diagnostic[] = []) {
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
    buildOutput(options).then((result) => {
      writeFileSync(options.outFile, result.output, 'utf-8');
      options.onBuild?.(result);
    }).catch((e) => {
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
    applyTagAliases(story.passages, options.tagAliases);
  }

  // Check for fatal parse errors
  const fatalErrors = diagnostics.filter((d) => d.level === 'error');
  if (fatalErrors.length > 0 && outputMode === 'html') {
    // Continue if possible, but won't produce valid output
  }

  // Resolve format
  let format: StoryFormatInfo | undefined;
  let formatId = options.formatId ?? '';

  if (outputMode === 'html') {
    const formatSearchDirs = getFormatSearchDirs(
      options.formatPaths,
      options.useTweegoPath ?? true,
    );
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
        format = await resolveRemoteFormat(
          remoteName,
          remoteVersion,
          options.formatIndices,
          options.formatUrls,
        );
      } catch {
        // Remote fetch failed; fall through to error below
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
  let startName: string;
  if (options.startPassage) {
    startName = options.startPassage;
  } else if (story.twine2.start) {
    startName = story.twine2.start;
  } else {
    startName = DEFAULT_START_NAME;
  }

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
      output = toTwine2Archive(story, startName, diagnostics);
      break;

    case 'twine1-archive':
      output = toTwine1Archive(story, startName);
      break;

    case 'json':
      output = storyToJSON(story);
      break;

    case 'html':
    default: {
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
        output = toTwine2HTML(story, format, startName, diagnostics);
      } else {
        if ((story.name === '') && !storyHas(story, 'StoryTitle')) {
          diagnostics.push({
            level: 'error',
            message: 'Special passage "StoryTitle" not found.',
          });
        }
        output = toTwine1HTML(story, format, startName, diagnostics);
      }

      // Inject modules and head file
      const modulePaths = options.modules ? getFilenames(options.modules) : [];
      output = modifyHead(output, modulePaths, options.headFile);
      break;
    }
  }

  // Compute stats
  const stats: CompileStats = {
    ...getStoryStats(story),
    files: [...processedFiles],
  };

  return { output, story, format, diagnostics, stats };
}

function storyToJSON(story: Story): string {
  return JSON.stringify({
    name: story.name,
    ifid: story.ifid,
    passages: story.passages.map((p) => ({
      name: p.name,
      tags: p.tags,
      text: p.text,
      metadata: p.metadata ?? null,
    })),
    twine2: {
      format: story.twine2.format,
      formatVersion: story.twine2.formatVersion,
      start: story.twine2.start,
      tagColors: Object.fromEntries(story.twine2.tagColors),
      options: Object.fromEntries(story.twine2.options),
      zoom: story.twine2.zoom,
    },
  }, null, 2);
}

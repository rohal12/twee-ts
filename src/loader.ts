/**
 * File loading: dispatch by file extension.
 * Ported from storyload.go.
 */
import { basename } from 'node:path';
import { statSync } from 'node:fs';
import type { Story, Diagnostic, InlineSource, Passage, FileCacheEntry } from './types.js';
import { normalizedFileExt, mediaTypeFromFilename, mediaTypeFromExt, fontFormatHint } from './media-types.js';
import { storyAdd, storyPrepend } from './story.js';
import { parseTwee } from './parser.js';
import { readUTF8, readBase64, baseNameWithoutExt } from './util.js';

interface LoadOptions {
  trim?: boolean;
  twee2Compat?: boolean;
}

/**
 * Load all source files into a story.
 */
export function loadSources(
  story: Story,
  filenames: string[],
  opts: LoadOptions,
  diagnostics: Diagnostic[],
  processedFiles: Set<string>,
): void {
  for (const filename of filenames) {
    if (processedFiles.has(filename)) {
      diagnostics.push({ level: 'warning', message: `load ${filename}: Skipping duplicate.` });
      continue;
    }

    const ext = normalizedFileExt(filename);
    try {
      switch (ext) {
        case 'tw':
        case 'twee':
          loadTwee(story, filename, opts, diagnostics);
          break;
        case 'tw2':
        case 'twee2':
          loadTwee(story, filename, { ...opts, twee2Compat: true }, diagnostics);
          break;
        case 'css':
          loadTagged(story, 'stylesheet', filename, diagnostics);
          break;
        case 'js':
          loadTagged(story, 'script', filename, diagnostics);
          break;
        case 'otf':
        case 'ttf':
        case 'woff':
        case 'woff2':
          loadFont(story, filename, diagnostics);
          break;
        case 'gif':
        case 'jpeg':
        case 'jpg':
        case 'png':
        case 'svg':
        case 'tif':
        case 'tiff':
        case 'webp':
          loadMedia(story, 'Twine.image', filename, diagnostics);
          break;
        case 'aac':
        case 'flac':
        case 'm4a':
        case 'mp3':
        case 'oga':
        case 'ogg':
        case 'opus':
        case 'wav':
        case 'wave':
        case 'weba':
          loadMedia(story, 'Twine.audio', filename, diagnostics);
          break;
        case 'mp4':
        case 'ogv':
        case 'webm':
          loadMedia(story, 'Twine.video', filename, diagnostics);
          break;
        case 'vtt':
          loadMedia(story, 'Twine.vtt', filename, diagnostics);
          break;
        default:
          continue;
      }
    } catch (e) {
      diagnostics.push({
        level: 'error',
        message: `load ${filename}: ${e instanceof Error ? e.message : String(e)}`,
        file: filename,
      });
      continue;
    }
    processedFiles.add(filename);
  }

  // Prepend StoryTitle if we have a name but no StoryTitle passage.
  if (story.name !== '' && !story.passages.some((p) => p.name === 'StoryTitle')) {
    storyPrepend(story, { name: 'StoryTitle', tags: [], text: story.name }, diagnostics);
  }
}

/**
 * Load inline sources (string content or InlineSource objects).
 */
export function loadInlineSources(
  story: Story,
  sources: (string | InlineSource)[],
  opts: LoadOptions,
  diagnostics: Diagnostic[],
): void {
  for (const source of sources) {
    if (typeof source === 'string') {
      // Treat as a file path — handled externally
      continue;
    }
    const content = typeof source.content === 'string' ? source.content : source.content.toString('utf-8');

    const ext = normalizedFileExt(source.filename);
    if (ext === 'tw' || ext === 'twee' || ext === 'tw2' || ext === 'twee2' || !ext) {
      const twee2 = ext === 'tw2' || ext === 'twee2' || opts.twee2Compat;
      const result = parseTwee(content, {
        filename: source.filename,
        trim: opts.trim ?? true,
        twee2Compat: twee2,
      });
      diagnostics.push(...result.diagnostics);
      for (const p of result.passages) {
        storyAdd(story, p, diagnostics);
      }
    }
  }
}

interface ParseResult {
  passages: Passage[];
  diagnostics: Diagnostic[];
}

function parseTweeFile(filename: string, opts: LoadOptions): ParseResult {
  const source = readUTF8(filename);
  const result = parseTwee(source, {
    filename,
    trim: opts.trim ?? true,
    twee2Compat: opts.twee2Compat ?? false,
  });
  return { passages: result.passages, diagnostics: [...result.diagnostics] };
}

function parseTaggedFile(tag: string, filename: string): ParseResult {
  const source = readUTF8(filename);
  return { passages: [{ name: basename(filename), tags: [tag], text: source }], diagnostics: [] };
}

function parseMediaFile(tag: string, filename: string): ParseResult {
  const source = readBase64(filename);
  const name = baseNameWithoutExt(filename);
  return {
    passages: [{ name, tags: [tag], text: `data:${mediaTypeFromFilename(filename)};base64,${source}` }],
    diagnostics: [],
  };
}

function parseFontFile(filename: string): ParseResult {
  const source = readBase64(filename);
  const name = basename(filename);
  const family = baseNameWithoutExt(filename);
  const ext = normalizedFileExt(filename);
  const mediaType = mediaTypeFromExt(ext);
  const hint = fontFormatHint(ext);
  return {
    passages: [
      {
        name,
        tags: ['stylesheet'],
        text: `@font-face {\n\tfont-family: "${family}";\n\tsrc: url("data:${mediaType};base64,${source}") format("${hint}");\n}`,
      },
    ],
    diagnostics: [],
  };
}

function parseFile(filename: string, opts: LoadOptions): ParseResult | undefined {
  const ext = normalizedFileExt(filename);
  switch (ext) {
    case 'tw':
    case 'twee':
      return parseTweeFile(filename, opts);
    case 'tw2':
    case 'twee2':
      return parseTweeFile(filename, { ...opts, twee2Compat: true });
    case 'css':
      return parseTaggedFile('stylesheet', filename);
    case 'js':
      return parseTaggedFile('script', filename);
    case 'otf':
    case 'ttf':
    case 'woff':
    case 'woff2':
      return parseFontFile(filename);
    case 'gif':
    case 'jpeg':
    case 'jpg':
    case 'png':
    case 'svg':
    case 'tif':
    case 'tiff':
    case 'webp':
      return parseMediaFile('Twine.image', filename);
    case 'aac':
    case 'flac':
    case 'm4a':
    case 'mp3':
    case 'oga':
    case 'ogg':
    case 'opus':
    case 'wav':
    case 'wave':
    case 'weba':
      return parseMediaFile('Twine.audio', filename);
    case 'mp4':
    case 'ogv':
    case 'webm':
      return parseMediaFile('Twine.video', filename);
    case 'vtt':
      return parseMediaFile('Twine.vtt', filename);
    default:
      return undefined;
  }
}

function loadTwee(story: Story, filename: string, opts: LoadOptions, diagnostics: Diagnostic[]): void {
  const result = parseTweeFile(filename, opts);
  diagnostics.push(...result.diagnostics);
  for (const p of result.passages) {
    storyAdd(story, p, diagnostics);
  }
}

function loadTagged(story: Story, tag: string, filename: string, diagnostics: Diagnostic[]): void {
  const result = parseTaggedFile(tag, filename);
  for (const p of result.passages) {
    storyAdd(story, p, diagnostics);
  }
}

function loadMedia(story: Story, tag: string, filename: string, diagnostics: Diagnostic[]): void {
  const result = parseMediaFile(tag, filename);
  for (const p of result.passages) {
    storyAdd(story, p, diagnostics);
  }
}

function loadFont(story: Story, filename: string, diagnostics: Diagnostic[]): void {
  const result = parseFontFile(filename);
  for (const p of result.passages) {
    storyAdd(story, p, diagnostics);
  }
}

/**
 * Load sources with mtime-based caching for incremental rebuilds.
 * Always creates a fresh Story; cached passages are replayed via storyAdd().
 */
export function loadSourcesCached(
  story: Story,
  filenames: string[],
  opts: LoadOptions,
  diagnostics: Diagnostic[],
  processedFiles: Set<string>,
  cache: Map<string, FileCacheEntry>,
  changedFiles?: ReadonlySet<string>,
): void {
  const currentFiles = new Set<string>();

  for (const filename of filenames) {
    if (processedFiles.has(filename)) {
      diagnostics.push({ level: 'warning', message: `load ${filename}: Skipping duplicate.` });
      continue;
    }

    currentFiles.add(filename);
    const cached = cache.get(filename);

    // If changedFiles is provided and this file isn't changed and we have a cache hit, skip stat
    if (changedFiles && cached && !changedFiles.has(filename)) {
      diagnostics.push(...cached.diagnostics);
      for (const p of cached.passages) {
        storyAdd(story, p, diagnostics);
      }
      processedFiles.add(filename);
      continue;
    }

    // stat the file to check mtime
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filename).mtimeMs;
    } catch {
      // File may have been deleted between getFilenames and here
      continue;
    }

    // Cache hit with matching mtime: replay
    if (cached && cached.mtimeMs === mtimeMs) {
      diagnostics.push(...cached.diagnostics);
      for (const p of cached.passages) {
        storyAdd(story, p, diagnostics);
      }
      processedFiles.add(filename);
      continue;
    }

    // Cache miss: parse and store
    try {
      const result = parseFile(filename, opts);
      if (!result) continue;

      cache.set(filename, {
        mtimeMs,
        passages: result.passages,
        diagnostics: result.diagnostics,
      });

      diagnostics.push(...result.diagnostics);
      for (const p of result.passages) {
        storyAdd(story, p, diagnostics);
      }
    } catch (e) {
      diagnostics.push({
        level: 'error',
        message: `load ${filename}: ${e instanceof Error ? e.message : String(e)}`,
        file: filename,
      });
      continue;
    }
    processedFiles.add(filename);
  }

  // Purge cache entries for deleted files
  for (const key of cache.keys()) {
    if (!currentFiles.has(key)) {
      cache.delete(key);
    }
  }

  // Prepend StoryTitle if we have a name but no StoryTitle passage.
  if (story.name !== '' && !story.passages.some((p) => p.name === 'StoryTitle')) {
    storyPrepend(story, { name: 'StoryTitle', tags: [], text: story.name }, diagnostics);
  }
}

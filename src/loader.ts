/**
 * File loading: dispatch by file extension.
 * Ported from storyload.go.
 */
import { basename } from 'node:path';
import type { Story, Diagnostic, InlineSource } from './types.js';
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

function loadTwee(story: Story, filename: string, opts: LoadOptions, diagnostics: Diagnostic[]): void {
  const source = readUTF8(filename);
  const result = parseTwee(source, {
    filename,
    trim: opts.trim ?? true,
    twee2Compat: opts.twee2Compat ?? false,
  });
  diagnostics.push(...result.diagnostics);
  for (const p of result.passages) {
    storyAdd(story, p, diagnostics);
  }
}

function loadTagged(story: Story, tag: string, filename: string, diagnostics: Diagnostic[]): void {
  const source = readUTF8(filename);
  storyAdd(story, { name: basename(filename), tags: [tag], text: source }, diagnostics);
}

function loadMedia(story: Story, tag: string, filename: string, diagnostics: Diagnostic[]): void {
  const source = readBase64(filename);
  const name = baseNameWithoutExt(filename);
  storyAdd(
    story,
    {
      name,
      tags: [tag],
      text: `data:${mediaTypeFromFilename(filename)};base64,${source}`,
    },
    diagnostics,
  );
}

function loadFont(story: Story, filename: string, diagnostics: Diagnostic[]): void {
  const source = readBase64(filename);
  const name = basename(filename);
  const family = baseNameWithoutExt(filename);
  const ext = normalizedFileExt(filename);
  const mediaType = mediaTypeFromExt(ext);
  const hint = fontFormatHint(ext);

  storyAdd(
    story,
    {
      name,
      tags: ['stylesheet'],
      text: `@font-face {\n\tfont-family: "${family}";\n\tsrc: url("data:${mediaType};base64,${source}") format("${hint}");\n}`,
    },
    diagnostics,
  );
}

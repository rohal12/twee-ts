/**
 * File loading: dispatch by file extension.
 * Ported from storyload.go.
 */
import { basename, resolve } from 'node:path';
import { statSync } from 'node:fs';
import type { Story, Diagnostic, InlineSource, Passage, FileCacheEntry } from './types.js';
import { normalizedFileExt, mediaTypeFromFilename, mediaTypeFromExt, fontFormatHint } from './media-types.js';
import { storyAdd, storyHas, storyPrepend } from './story.js';
import { parseTwee } from './parser.js';
import { decompileHTML } from './html-parser.js';
import { readUTF8, readBase64, baseNameWithoutExt, decodeText } from './util.js';
import type { DecodedText } from './util.js';
import { normalizeSourceText } from './source-text.js';
import { cssStringEscape } from './escape.js';

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
        case 'htm':
        case 'html':
          loadHTML(story, filename, opts, diagnostics);
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
    // Decode and normalize like readUTF8() does for files, so in-memory and on-disk sources load the same.
    const decoded: DecodedText =
      typeof source.content === 'string'
        ? { text: source.content, diagnostics: [] }
        : decodeText(source.content, source.filename);
    diagnostics.push(...decoded.diagnostics);
    const content = normalizeSourceText(decoded.text);

    const ext = normalizedFileExt(source.filename);
    switch (ext) {
      case '':
      case 'tw':
      case 'twee':
      case 'tw2':
      case 'twee2': {
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
        break;
      }
      case 'css':
        storyAdd(story, { name: basename(source.filename), tags: ['stylesheet'], text: content }, diagnostics);
        break;
      case 'js':
        storyAdd(story, { name: basename(source.filename), tags: ['script'], text: content }, diagnostics);
        break;
      default:
        diagnostics.push({
          level: 'warning',
          message: `load ${source.filename}: in-memory sources of type .${ext} are not supported; skipped.`,
        });
    }
  }
}

interface ParseResult {
  passages: Passage[];
  diagnostics: Diagnostic[];
}

function parseTweeFile(filename: string, opts: LoadOptions): ParseResult {
  const readDiagnostics: Diagnostic[] = [];
  const source = readUTF8(filename, readDiagnostics);
  const result = parseTwee(source, {
    filename,
    trim: opts.trim ?? true,
    twee2Compat: opts.twee2Compat ?? false,
  });
  return { passages: result.passages, diagnostics: [...readDiagnostics, ...result.diagnostics] };
}

function parseTaggedFile(tag: string, filename: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const source = readUTF8(filename, diagnostics);
  return { passages: [{ name: basename(filename), tags: [tag], text: source }], diagnostics };
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
        text: `@font-face {\n\tfont-family: "${cssStringEscape(family)}";\n\tsrc: url("data:${mediaType};base64,${source}") format("${hint}");\n}`,
      },
    ],
    diagnostics: [],
  };
}

function parseHTMLFile(filename: string, opts: LoadOptions): ParseResult {
  const readDiagnostics: Diagnostic[] = [];
  const { story, diagnostics } = decompileHTML(readUTF8(filename, readDiagnostics), { trim: opts.trim ?? true });
  // Twine 2 HTML keeps the story name in an attribute, not a passage. Only passages reach the
  // outer story (and the cache), so carry the name as a StoryTitle passage, as Twine 1 HTML does.
  const passages =
    story.name !== '' && !storyHas(story, 'StoryTitle')
      ? [{ name: 'StoryTitle', tags: [], text: story.name }, ...story.passages]
      : story.passages;
  return { passages, diagnostics: [...readDiagnostics, ...diagnostics] };
}

/**
 * Identity of the options that affect how a file parses, stored on its cache entry.
 * Twee files depend on `trim` and `twee2Compat`, HTML files on `trim`; every other file type
 * yields the same key for all options.
 */
function parseOptionsKey(filename: string, opts: LoadOptions): string {
  const ext = normalizedFileExt(filename);
  const trim = opts.trim ?? true;
  if (ext === 'htm' || ext === 'html') return JSON.stringify({ trim });
  const twee2File = ext === 'tw2' || ext === 'twee2';
  if (!twee2File && ext !== 'tw' && ext !== 'twee') return '';
  return JSON.stringify({ trim, twee2Compat: twee2File || (opts.twee2Compat ?? false) });
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
    case 'htm':
    case 'html':
      return parseHTMLFile(filename, opts);
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

function loadHTML(story: Story, filename: string, opts: LoadOptions, diagnostics: Diagnostic[]): void {
  const result = parseHTMLFile(filename, opts);
  diagnostics.push(...result.diagnostics);
  for (const p of result.passages) {
    storyAdd(story, p, diagnostics);
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
  diagnostics.push(...result.diagnostics);
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
  // changedFiles may name a file in any form (absolute, `./`-prefixed or relative to the working
  // directory); it is matched to `filenames`, whatever their form, by resolved path.
  const changedPaths = changedFiles === undefined ? undefined : new Set([...changedFiles].map((f) => resolve(f)));

  for (const filename of filenames) {
    if (processedFiles.has(filename)) {
      diagnostics.push({ level: 'warning', message: `load ${filename}: Skipping duplicate.` });
      continue;
    }

    currentFiles.add(filename);
    const optionsKey = parseOptionsKey(filename, opts);
    // An entry parsed under other options (or without a recorded key) is stale.
    const entry = cache.get(filename);
    const cached = entry?.parseOptionsKey === optionsKey ? entry : undefined;
    // A file changedFiles names is always reparsed: a save can keep the modification time
    // (a timestamp-preserving write, or a filesystem with coarse timestamps).
    const changed = changedPaths?.has(resolve(filename)) ?? false;

    // If changedFiles is provided and this file isn't changed and we have a cache hit, skip stat
    if (changedPaths && cached && !changed) {
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
      // File may have been deleted between getFilenames and here. Its entry goes too, so a
      // later build that doesn't name it in changedFiles can't replay its old passages.
      cache.delete(filename);
      continue;
    }

    // Cache hit with matching mtime, for a file not known to have changed: replay
    if (cached && !changed && cached.mtimeMs === mtimeMs) {
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
        parseOptionsKey: optionsKey,
        passages: result.passages,
        diagnostics: result.diagnostics,
      });

      diagnostics.push(...result.diagnostics);
      for (const p of result.passages) {
        storyAdd(story, p, diagnostics);
      }
    } catch (e) {
      // A file that fails to load keeps no entry: the next build tries it again, and reports
      // the error again while it persists, rather than replaying its old passages.
      cache.delete(filename);
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

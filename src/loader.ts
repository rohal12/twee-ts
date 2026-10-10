/**
 * File loading: dispatch by file extension.
 * Ported from storyload.go.
 */
import { basename } from 'node:path';
import { statSync } from 'node:fs';
import type { Story, Diagnostic, InlineSource, Passage, FileCacheEntry } from './types.js';
import type { DiscoveredFile } from './filesystem.js';
import { identify } from './path-identity.js';
import { duplicateInput, failureOfRead, inputProblem, problemDiagnostic } from './input-policy.js';
import { normalizedFileExt, mediaTypeFromFilename, mediaTypeFromExt, fontFormatHint } from './media-types.js';
import { storyAdd, storyHas, storyPrepend } from './story.js';
import { freezePassage, withGeneratedName } from './passage.js';
import { parseTwee } from './parser.js';
import { decompileHTMLForImport } from './html-parser.js';
import { readUTF8, readBase64, fileStem, decodeText } from './util.js';
import type { DecodedText } from './util.js';
import { normalizeSourceText } from './source-text.js';
import { cssStringEscape } from './escape.js';

interface LoadOptions {
  trim?: boolean;
  twee2Compat?: boolean;
}

/**
 * A source file to load: a DiscoveredFile from getFilenames, or a bare path (treated as found in a folder,
 * so a file of an unknown type is skipped without a word).
 */
export type SourceFile = string | DiscoveredFile;

function toDiscovered(file: SourceFile): DiscoveredFile {
  return typeof file === 'string' ? { path: file, key: identify(file).key, discovery: 'found' } : file;
}

/**
 * The identity keys of the files a build has loaded, next to the paths in its `processedFiles` set (which
 * the caller owns and reports as `stats.files`), so the same file reached by two spellings is loaded once.
 */
const processedKeys = new WeakMap<Set<string>, Map<string, string>>();

/** The earlier spelling of `file` the build already loaded, if any; records `file` as loaded otherwise. */
function alreadyLoaded(processedFiles: Set<string>, file: DiscoveredFile): string | undefined {
  let keys = processedKeys.get(processedFiles);
  if (keys === undefined) {
    keys = new Map([...processedFiles].map((path) => [identify(path).key, path]));
    processedKeys.set(processedFiles, keys);
  }
  return keys.get(file.key);
}

function markLoaded(processedFiles: Set<string>, file: DiscoveredFile): void {
  processedFiles.add(file.path);
  processedKeys.get(processedFiles)?.set(file.key, file.path);
}

/** The diagnostic the input policy gives a source file that failed to load (see input-policy.ts). */
function loadFailure(file: DiscoveredFile, e: unknown): Diagnostic | undefined {
  return problemDiagnostic(inputProblem('source', file.discovery, failureOfRead(file.path, e), file.path, e));
}

/** The diagnostic for a file of a type sources don't load: a warning for a file named directly (FS-17). */
function unsupportedType(file: DiscoveredFile): Diagnostic | undefined {
  return problemDiagnostic(inputProblem('source', file.discovery, 'unsupported-type', file.path, undefined));
}

/**
 * Load all source files into a story. A file that fails to load is reported as the input policy says
 * (an error, or a warning for a file found in a folder that went away since the walk), and the others are
 * still loaded, so one build reports every problem.
 */
export function loadSources(
  story: Story,
  filenames: readonly SourceFile[],
  opts: LoadOptions,
  diagnostics: Diagnostic[],
  processedFiles: Set<string>,
): void {
  for (const file of filenames.map(toDiscovered)) {
    const filename = file.path;
    const earlier = alreadyLoaded(processedFiles, file);
    if (earlier !== undefined) {
      diagnostics.push(duplicateInput('source', file.path, earlier));
      continue;
    }

    let result: ParseResult | undefined;
    try {
      result = parseFile(filename, opts);
    } catch (e) {
      const failure = loadFailure(file, e);
      if (failure) diagnostics.push(failure);
      continue;
    }
    if (result === undefined) {
      const unsupported = unsupportedType(file);
      if (unsupported) diagnostics.push(unsupported);
      continue;
    }
    addParsed(story, result, diagnostics);
    markLoaded(processedFiles, file);
  }

  prependStoryTitle(story, diagnostics);
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
    // The type first: the content of a type in-memory sources don't load is never decoded, nor warned about.
    const ext = normalizedFileExt(source.filename);
    const kind = inlineSourceKind(ext);
    if (kind === undefined) {
      diagnostics.push({
        level: 'warning',
        message: `load ${source.filename}: in-memory sources of type .${ext} are not supported; skipped.`,
      });
      continue;
    }
    // Decode and normalize like readUTF8() does for files, so in-memory and on-disk sources load the same.
    let decoded: DecodedText;
    try {
      decoded =
        typeof source.content === 'string'
          ? { text: source.content, diagnostics: [] }
          : decodeText(source.content, source.filename);
    } catch (e) {
      const failure = loadFailure({ path: source.filename, key: '', discovery: 'named' }, e);
      if (failure) diagnostics.push(failure);
      continue;
    }
    diagnostics.push(...decoded.diagnostics);
    const content = normalizeSourceText(decoded.text);

    switch (kind) {
      case 'twee':
      case 'twee2': {
        const result = parseTwee(content, {
          filename: source.filename,
          trim: opts.trim ?? true,
          twee2Compat: kind === 'twee2' || (opts.twee2Compat ?? false),
        });
        diagnostics.push(...result.diagnostics);
        for (const p of result.passages) {
          storyAdd(story, p, diagnostics);
        }
        break;
      }
      case 'stylesheet':
      case 'script':
        storyAdd(story, codePassage(basename(source.filename), kind, content), diagnostics);
        break;
      default: {
        const _exhaustive: never = kind;
        throw new Error(`unhandled in-memory source kind: ${String(_exhaustive)}`);
      }
    }
  }
}

/** What an in-memory source loads as by its extension `ext` (Twee, CSS or JavaScript), or undefined for another type. */
function inlineSourceKind(ext: string): 'twee' | 'twee2' | 'stylesheet' | 'script' | undefined {
  switch (ext) {
    case '':
    case 'tw':
    case 'twee':
      return 'twee';
    case 'tw2':
    case 'twee2':
      return 'twee2';
    case 'css':
      return 'stylesheet';
    case 'js':
      return 'script';
    default:
      return undefined;
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

/**
 * A stylesheet or script passage named after its file, as Tweego names it. The name only labels
 * the code, so when another passage has it, the passage takes a free one (see `storyAdd()`).
 */
function codePassage(name: string, tag: string, text: string): Passage {
  return withGeneratedName({ name, tags: [tag], text }, { kind: 'code', base: name });
}

/** Mark every passage of a parse result as a code passage named after its file. */
function codeNames(result: ParseResult): ParseResult {
  for (const p of result.passages) withGeneratedName(p, { kind: 'code', base: p.name });
  return result;
}

function parseTaggedFile(tag: string, filename: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const source = readUTF8(filename, diagnostics);
  return { passages: [codePassage(basename(filename), tag, source)], diagnostics };
}

function parseMediaFile(tag: string, filename: string): ParseResult {
  const source = readBase64(filename);
  const name = fileStem(filename);
  const passage = { name, tags: [tag], text: `data:${mediaTypeFromFilename(filename)};base64,${source}` };
  return {
    passages: [withGeneratedName(passage, { kind: 'media', base: name, file: filename })],
    diagnostics: [],
  };
}

function parseFontFile(filename: string): ParseResult {
  const source = readBase64(filename);
  const name = basename(filename);
  const family = fileStem(filename);
  const ext = normalizedFileExt(filename);
  const mediaType = mediaTypeFromExt(ext);
  const hint = fontFormatHint(ext);
  return codeNames({
    passages: [
      {
        name,
        tags: ['stylesheet'],
        text: `@font-face {\n\tfont-family: "${cssStringEscape(family)}";\n\tsrc: url("data:${mediaType};base64,${source}") format("${hint}");\n}`,
      },
    ],
    diagnostics: [],
  });
}

function parseHTMLFile(filename: string, opts: LoadOptions): ParseResult {
  const readDiagnostics: Diagnostic[] = [];
  const { story, diagnostics } = decompileHTMLForImport(readUTF8(filename, readDiagnostics), {
    trim: opts.trim ?? true,
  });
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

/** Adds a parsed file's passages to the story, after its diagnostics. */
function addParsed(
  story: Story,
  result: { readonly passages: readonly Passage[]; readonly diagnostics: readonly Diagnostic[] },
  diagnostics: Diagnostic[],
): void {
  // Copies: the caller gets diagnostics it may change, and the cache keeps its own (#246 S-4).
  diagnostics.push(...result.diagnostics.map((d): Diagnostic => ({ ...d })));
  for (const p of result.passages) {
    storyAdd(story, p, diagnostics);
  }
}

/** Prepends a StoryTitle passage when the story has a name but no such passage. */
function prependStoryTitle(story: Story, diagnostics: Diagnostic[]): void {
  if (story.name !== '' && !story.passages.some((p) => p.name === 'StoryTitle')) {
    storyPrepend(story, { name: 'StoryTitle', tags: [], text: story.name }, diagnostics);
  }
}

/**
 * What a change to a file alters besides its modification time: its size, its inode (a file replaced by
 * another), and its status-change time, which a write updates even when it puts the modification time
 * back (`cp -p`, `rsync -t`, `tar x`, `touch -r`).
 */
function fileSignature(stats: { size: number; ino: number; dev: number; ctimeMs: number }): string {
  return `${stats.size}:${stats.dev}:${stats.ino}:${stats.ctimeMs}`;
}

/**
 * Load sources with caching for incremental rebuilds: a cached file is reused while its modification
 * time and its signature (size, inode, status-change time) are unchanged. Cache entries are keyed by the
 * path the file is loaded under; `changedFiles` may name a file in any spelling (absolute, `./`-prefixed,
 * relative to the working directory, or through a link) and is matched to the files by identity (see
 * path-identity.ts). Always creates a fresh Story; cached passages are replayed via storyAdd().
 */
export function loadSourcesCached(
  story: Story,
  filenames: readonly SourceFile[],
  opts: LoadOptions,
  diagnostics: Diagnostic[],
  processedFiles: Set<string>,
  cache: Map<string, FileCacheEntry>,
  changedFiles?: ReadonlySet<string>,
  buildFiles?: ReadonlySet<string>,
): void {
  const currentFiles = new Set<string>(buildFiles);
  const changedKeys = changedFiles === undefined ? undefined : new Set([...changedFiles].map((f) => identify(f).key));

  for (const file of filenames.map(toDiscovered)) {
    const filename = file.path;
    const earlier = alreadyLoaded(processedFiles, file);
    if (earlier !== undefined) {
      diagnostics.push(duplicateInput('source', file.path, earlier));
      // Not loaded under this path, so its entry is not kept up to date: a change to the file reaches only the
      // entry of the spelling that loaded it. Dropped, so it can't be replayed stale once this path loads (#400).
      cache.delete(filename);
      continue;
    }

    currentFiles.add(filename);
    const optionsKey = parseOptionsKey(filename, opts);
    // An entry parsed under other options (or without a recorded key) is stale.
    const entry = cache.get(filename);
    const cached = entry?.parseOptionsKey === optionsKey ? entry : undefined;
    // A file changedFiles names is always reparsed: a save can keep the modification time
    // (a timestamp-preserving write, or a filesystem with coarse timestamps).
    const changed = changedKeys?.has(file.key) ?? false;

    // If changedFiles is provided and this file isn't changed and we have a cache hit, skip stat
    if (changedKeys && cached && !changed) {
      addParsed(story, cached, diagnostics);
      markLoaded(processedFiles, file);
      continue;
    }

    let mtimeMs: number;
    let signature: string;
    try {
      const stats = statSync(filename);
      mtimeMs = stats.mtimeMs;
      signature = fileSignature(stats);
    } catch (e) {
      // Deleted (or made unreadable) between getFilenames and here. Its entry goes too, so a later
      // build that doesn't name it in changedFiles can't replay its old passages.
      cache.delete(filename);
      const failure = loadFailure(file, e);
      if (failure) diagnostics.push(failure);
      continue;
    }

    // Cache hit with matching mtime and signature, for a file not known to have changed: replay
    if (cached && !changed && cached.mtimeMs === mtimeMs && cached.signature === signature) {
      addParsed(story, cached, diagnostics);
      markLoaded(processedFiles, file);
      continue;
    }

    // Cache miss: parse and store
    try {
      const result = parseFile(filename, opts);
      if (!result) {
        const unsupported = unsupportedType(file);
        if (unsupported) diagnostics.push(unsupported);
        continue;
      }

      // Frozen, so that nothing a build hands out, nor a later step of this build, can change what the
      // next build replays (#246 S-4). The passages keep their identity, and with it a generated name.
      cache.set(filename, {
        mtimeMs,
        signature,
        parseOptionsKey: optionsKey,
        passages: Object.freeze(result.passages.map(freezePassage)),
        diagnostics: Object.freeze(result.diagnostics.map((d) => Object.freeze(d))),
      });

      addParsed(story, result, diagnostics);
    } catch (e) {
      // A file that fails to load keeps no entry: the next build tries it again, and reports
      // the error again while it persists, rather than replaying its old passages.
      cache.delete(filename);
      const failure = loadFailure(file, e);
      if (failure) diagnostics.push(failure);
      continue;
    }
    markLoaded(processedFiles, file);
  }

  // Purge cache entries for deleted files
  for (const key of cache.keys()) {
    if (!currentFiles.has(key)) {
      cache.delete(key);
    }
  }

  prependStoryTitle(story, diagnostics);
}

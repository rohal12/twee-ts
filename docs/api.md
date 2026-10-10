# Programmatic API

twee-ts exports a full API for use from TypeScript or JavaScript code. Every example on this page is type-checked against the published types (with `strict` and `exactOptionalPropertyTypes`) and run by the test suite.

## Core Functions

### `compile(options)`

Compile Twee sources to a string. `compile(options: CompileOptions): Promise<CompileResult>`.

```typescript
import { compile } from '@rohal12/twee-ts';

const result = await compile({
  sources: ['src/'],
  formatId: 'sugarcube-2',
  tagAliases: { library: 'script' },
});

console.log(result.output); // compiled HTML string
console.log(result.story); // the story model (read-only)
console.log(result.format); // format info (undefined for non-HTML modes)
console.log(result.diagnostics); // warnings and errors
console.log(result.stats); // { passages, storyPassages, words, files, externalFiles }
```

`compile()` writes nothing. Problems in the sources are reported in `diagnostics` (see [Error Handling](#error-handling)); the output is built even when some of them are errors, so check them.

### `compileToFile(options)`

Compile and write the output to `outFile`. `compileToFile(options: CompileToFileOptions): Promise<CompileResult>`.

```typescript
import { compileToFile } from '@rohal12/twee-ts';

const result = await compileToFile({
  sources: ['src/'],
  outFile: 'story.html',
});
console.log(`${result.stats.passages} passages written to story.html`);
```

The output is written even when `diagnostics` report errors (the CLI instead writes nothing then; see [Exit Status](./cli#exit-status)). How it is written depends on what is at `outFile`, as [Output safety](./cli#output-safety) describes: a regular file is replaced atomically (a temporary file in the same folder, renamed over it), so a reader such as a live-reload server sees the previous build or the new one, never part of one, and a failed write leaves the previous file. A hard-linked file is written in place, a FIFO or device is written through, and a read-only file is refused with an `EACCES` error.

`outFile` is never read as a source, even inside a source folder or reached through a symbolic link. A build that would write over one of its inputs rejects with a `TweeTsError` whose `code` is `OUTPUT_IS_INPUT`, and writes nothing: `outFile` named as a source, a module or the head file (by any spelling, or as a hard link), `outFile` that is the story format's file, or an existing file of a source type inside a source folder that is not an earlier twee-ts build.

### `watch(options)`

Watch for file changes and recompile automatically. `watch(options: WatchOptions): Promise<AbortController>`: call `abort()` on the controller to stop.

```typescript
import { watch } from '@rohal12/twee-ts';

const controller = await watch({
  sources: ['src/'],
  outFile: 'story.html',
  onBuild(result) {
    console.log(`Built: ${result.stats.passages} passages, ${result.stats.words} words`);
  },
  onError(err) {
    console.error('Build failed:', err.message);
  },
});

// Stop watching
controller.abort();
```

- **Options that can't work** reject the returned promise with a `TweeTsError` before anything is watched: `OUTPUT_IS_INPUT` when `outFile` is an input (see `compileToFile()`), `INVALID_OPTIONS` for an option out of range (a negative `formatFetchTimeout`). They are not passed to `onError`. When a later build fails for such a reason (a link changed to make the output an input, say), the error goes to `onError` and watching stops.
- **What is watched**: the sources, the modules and the head file, wherever the head file is and whatever its extension. Like `compileToFile()`, every build leaves `outFile` out of the sources and modules.
- **Every build is written** to `outFile`, including one whose `diagnostics` report errors, and then passed to `onBuild`; a build that fails with a fatal error writes nothing and is passed to `onError`. (The CLI's watch mode instead keeps the last build without errors; see [Exit Status](./cli#exit-status).) Each build replaces `outFile` as `compileToFile()` does.
- **Order**: builds run one at a time, and each is written and reported as it finishes, in order, so the output never goes back to an older state. Changes saved while a build runs are built together in one follow-up build. While saves keep coming, the output trails the latest save by at most about one build.
- **Stopping**: after `controller.abort()` (or aborting the `signal` passed in the options), no build starts, and one still running writes and reports nothing; story format downloads it waits on are cancelled, so the process can exit.
- **Paths that come and go**: a watched folder or file that doesn't exist yet is waited for and built once it appears, and one that is deleted, or renamed away and replaced (as `git checkout` or a generator may do), is followed to the new one at its path; the build after that reads every file again. A path that can't be watched (one the process may not read, say) is passed to `onError` as a `WatchPathError` (exported; its `path` names the path, and its message starts with `Cannot watch`), and is tried again on the next change in the folder above it; the other paths are still watched.
- `onError` also receives an exception thrown by `onBuild`. An exception thrown by `onError` itself is printed to the console and doesn't stop the watch.

### `compileIncremental(options, cache, changedFiles?)`

`compileIncremental(options: CompileOptions, cache: Map<string, FileCacheEntry>, changedFiles?: ReadonlySet<string>): Promise<CompileResult>` compiles like `compile()`, reusing the passages parsed from each source file by an earlier call with the same `cache`. Tools that track changes themselves (the plugins, editors) use it.

```typescript
import { compileIncremental } from '@rohal12/twee-ts';
import type { FileCacheEntry } from '@rohal12/twee-ts';

const cache = new Map<string, FileCacheEntry>();
await compileIncremental({ sources: ['src/'] }, cache); // parses every file
const again = await compileIncremental({ sources: ['src/'] }, cache, new Set(['src/Start.tw'])); // reparses one
console.log(again.stats.files);
```

Without `changedFiles`, a cached file is reused while its modification time, size, inode and status-change time are unchanged. With it, a file it names is always reparsed and every other cached file is reused as it is. A file may be named by an absolute path or a path relative to the working directory, or through a link: entries are matched to source files by identity. A file that fails to load is dropped from the cache, so the next call tries it again. Treat the entries as opaque.

## Compile Options

All options for `compile()`. Only `sources` is required. Each optional property also accepts an explicit `undefined`, which means the same as leaving it out.

<!-- docs-test: mirror -->

```typescript
interface CompileOptions {
  sources: readonly SourceInput[];
  exclude?: readonly (string | ExcludeGlob)[]; // globs for source files to leave out
  outputMode?: OutputMode; // default: 'html'
  formatId?: string; // default: StoryData's format, else 'sugarcube-2'
  startPassage?: string; // default: StoryData's start, else 'Start'
  formatPaths?: readonly string[];
  useTweegoPath?: boolean; // default: true
  modules?: readonly string[];
  headFile?: string;
  trim?: boolean; // default: true
  twee2Compat?: boolean; // default: false
  testMode?: boolean; // default: false
  formatIndices?: readonly string[];
  formatUrls?: readonly string[];
  noRemote?: boolean; // default: false
  signal?: AbortSignal; // cancels the compile
  formatFetchTimeout?: number; // ms per format request; default: 30000, 0 = no limit
  formatResolutionTimeout?: number; // ms for the whole format search; default: 120000, 0 = no limit
  useDefaultFormatIndices?: boolean; // ask the Story Formats Archive; default: true
  tagAliases?: Record<string, string>;
  sourceInfo?: boolean; // default: false
  wordCountMethod?: WordCountMethod; // 'tweego' (default) or 'whitespace'
}
```

`signal` cancels a compile: story format requests still in progress are aborted, and the promise rejects with the signal's reason (an `AbortError` for `controller.abort()`). Nothing from a cancelled download is written to the format cache.

`formatFetchTimeout` limits each story format request (an index or a `format.js`), in milliseconds. A request that takes longer fails with a warning in `diagnostics`, and the next source is tried. The default is 30000; `0` turns the limit off; a negative value is a `TweeTsError` (`INVALID_OPTIONS`). `formatResolutionTimeout` limits the whole search for the format, over every request (default 120000; `0` turns it off): when it passes, the request in progress stops with a warning, and the format URLs and indices not yet asked answer from the download cache only. `useDefaultFormatIndices: false` leaves the Story Formats Archive out, so only the configured `formatUrls` and `formatIndices` are asked.

```typescript
import { compile } from '@rohal12/twee-ts';

const controller = new AbortController();
const pending = compile({ sources: ['src/'], signal: controller.signal });
controller.abort(); // pending rejects with an AbortError
await pending.catch((err: unknown) => console.log(err instanceof Error ? err.name : err)); // AbortError
```

`SourceInput` is either a file or directory path (`string`) or an inline source (`{ filename: string; content: string | Buffer }`).

`exclude` takes glob patterns for files to leave out of `sources`, matched against each file's path relative to the working directory, as `stats.files` lists it. It applies to `compile()`, `compileToFile()`, `compileIncremental()` and `watch()`, whose watcher also ignores changes to excluded files. Modules and the head file are never left out. See [Excluding files](./configuration#excluding-files) for the pattern rules.

```typescript
import { compileToFile } from '@rohal12/twee-ts';

const result = await compileToFile({
  sources: ['src/story'],
  exclude: ['src/story/**/*.png'],
  outFile: 'story.html',
});
console.log(result.stats.files);
```

## Inline Sources

Pass Twee content directly without files on disk:

```typescript
import { compile } from '@rohal12/twee-ts';

const result = await compile({
  sources: [
    {
      filename: 'story.tw',
      content: `:: StoryData
{"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC"}

:: StoryTitle
My Story

:: Start
Hello, world!`,
    },
  ],
  formatId: 'sugarcube-2',
});
console.log(result.story.name); // My Story
```

You can mix inline sources with file paths:

```typescript
import { compile } from '@rohal12/twee-ts';

const result = await compile({
  sources: ['src/', { filename: 'extra.tw', content: ':: Bonus\nSecret passage!' }],
});
console.log(result.stats.passages);
```

## Compile Result

<!-- docs-test: mirror -->

```typescript
interface CompileResult {
  output: string; // compiled HTML, Twee or JSON
  story: ReadonlyStory; // the story model, read-only
  format?: StoryFormatInfo | undefined; // format used (undefined for non-HTML modes)
  diagnostics: Diagnostic[];
  stats: CompileStats;
}

interface CompileStats {
  passages: number; // all passages
  storyPassages: number; // passages that are not info passages
  words: number; // word count of the story passages
  files: string[]; // source files loaded, in order, relative to the working directory when inside it
  externalFiles?: string[]; // modules and head file injected (HTML output only)
}

type Diagnostic =
  | { level: 'warning'; message: string; file?: string; line?: number }
  | { level: 'error'; message: string; file?: string; line?: number; fatal?: boolean };
```

## Error Handling

Problems in the sources (a missing start passage, duplicate passages, malformed Twee, an invalid StoryData field) are collected as `diagnostics` rather than thrown. A `TweeTsError` is thrown when a build cannot run at all; nothing is built or written then. Its `code` says why, and `diagnostics` holds what the build reported before it stopped:

| `code`              | When                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILD_FAILED`      | No story format is available for HTML output; an unknown `outputMode`                                                                                                             |
| `INVALID_OPTIONS`   | An option out of range (a negative `formatFetchTimeout`); a config file that is not valid JSON or fails validation; bad plugin options; the Vite plugin under a Vite older than 8 |
| `INPUT_UNAVAILABLE` | The head file (HTML output) or the config file is missing or can't be read                                                                                                        |
| `OUTPUT_IS_INPUT`   | The output would overwrite an input (`compileToFile()`, `watch()`, the CLI and the plugins)                                                                                       |

Other failures are ordinary errors: an aborted `signal` rejects with its reason, a failed write of `outFile` with the file system error (its `code`, such as `EACCES`), and a story format file that can't be read at build time, or a Twine 1 format whose required file is missing, with an `Error` naming the file.

```typescript
import { compile, TweeTsError } from '@rohal12/twee-ts';

try {
  const result = await compile({ sources: ['src/'] });
  for (const d of result.diagnostics) {
    if (d.level === 'error') console.error(d.message);
    else console.warn(d.message);
  }
} catch (err) {
  if (err instanceof TweeTsError) {
    console.error(`Fatal (${err.code}):`, err.message);
    console.error('Diagnostics:', err.diagnostics);
  } else {
    throw err;
  }
}
```

## Utility Exports

### `applyTagAliases(passages, aliases)`

`applyTagAliases(passages: readonly Passage[], aliases: Record<string, string>): Passage[]` returns the passages with each alias's target tag added after their own tags (see [Tag Aliases](./tag-aliases)). A passage's own tags are kept as written, a repeated tag included, and no tag is added twice. It returns a new array and leaves the passages passed in unchanged; a passage it changes is a new object. `compile()` applies the `tagAliases` option this way.

```typescript
import { applyTagAliases } from '@rohal12/twee-ts';
import type { Passage } from '@rohal12/twee-ts';

const passages: Passage[] = [{ name: 'Utils', tags: ['library'], text: 'window.x = 1;' }];
const aliased = applyTagAliases(passages, { library: 'script', theme: 'stylesheet' });
console.log(aliased[0]?.tags); // ['library', 'script']
console.log(passages[0]?.tags); // ['library'], unchanged
```

### Lexer & Parser

`tweeLexer(input: string)` is a generator of lexer items; `TweeLexer` is the same lexer as a class (`new TweeLexer(input)`, iterable, or `nextItem()`). Each item's `type` is an `ItemType` value. `parseTwee(source: string, options?)` parses Twee into passages; its options are `filename` (for diagnostics), `trim` (default `true`) and `twee2Compat` (default `false`).

```typescript
import { ItemType, TweeLexer, tweeLexer, parseTwee } from '@rohal12/twee-ts';

// Low-level lexer (generator)
for (const item of tweeLexer(':: Start\nHello!')) {
  if (item.type === ItemType.Name) console.log('passage name:', item.val.trim()); // Start
}

// The same lexer as a class
const items = [...new TweeLexer(':: Start\nHello!')];
console.log(items.length); // 4: Header, Name, Content, EOF

// Parse Twee source into passages
const { passages, diagnostics } = parseTwee(':: Start\nHello!', { filename: 'story.tw' });
console.log(passages[0]?.name, diagnostics.length); // Start 0
```

`parseTwee` normalizes its input the way files are normalized when read: it strips a leading UTF-8 BOM and turns CRLF and bare CR line endings into LF. It also removes a BOM at the start of a later line directly before `::`, which joining files leaves there, so that line stays a passage header. In-memory sources passed to `compile()` get the same normalization. A `Buffer` source that is not valid UTF-8 is decoded as Windows-1252, like a file, with a warning in `diagnostics` (see [Text encoding](./getting-started#text-encoding)).

Names, tags and text are read as Tweego reads them: white space is Go's (`U+0085` is white space, `U+FEFF` is not), a backslash escapes the next character, and passage metadata is decoded as described in [Differences from Tweego](./tweego-differences#reading-twee). With `trim: false`, passage text is kept as written except for its trailing blank lines.

### StoryBuilder

`StoryBuilder` builds a story from passages the way `compile()` does: a passage replaces an earlier one with the same name (with a warning), and the special passages `StoryTitle`, `StoryData` and `StorySettings` decide the story metadata, each from its own text alone.

```typescript
import { StoryBuilder, parseTwee } from '@rohal12/twee-ts';
import type { Diagnostic } from '@rohal12/twee-ts';

const source = ':: StoryTitle\nMy Story\n\n:: Draft\nOnce upon a time.\n\n:: Notes\nTo do.\n';
const builder = new StoryBuilder();
const diagnostics: Diagnostic[] = [];
for (const passage of parseTwee(source).passages) builder.add(passage, diagnostics);
builder.rename('Draft', 'Start', diagnostics); // keeps its place; replaces a passage named Start
builder.remove('Notes'); // removes it, and any metadata it decided
console.log(builder.has('Start')); // true
const story = builder.build(); // a frozen snapshot
console.log(story.name, story.passages.length); // My Story 2
```

| Member                               | Does                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `new StoryBuilder()`                 | An empty story                                                                               |
| `add(passage, diagnostics)`          | Adds a copy of the passage, replacing one with the same name (with a warning)                |
| `rename(from, to, diagnostics)`      | Renames a passage in place; `false` when no passage is named `from`                          |
| `remove(name)`                       | Removes a passage and the metadata it decided; `false` when no passage has the name          |
| `has(name)`, `get(name)`, `passages` | Lookups; `get()` and `passages` return frozen copies                                         |
| `build()`                            | The story as a frozen `ReadonlyStory` snapshot that later changes to the builder don't reach |

The builder's story changes only through `add()`, `rename()` and `remove()`, so its lookups, its passage list and its metadata always agree. Passages are copied in and out, and changing a passage object after adding it changes nothing in the builder. A `StoryIncludes` passage is kept as a passage, with a warning that twee-ts ignores it.

Before 2.0, `builder.story` gave the builder's mutable story; see [Migrating to 2.0](./migrating-to-2#storybuilder).

### HTML Decompiler

`decompileHTML(html: string, options?: DecompileOptions): DecompileResult` reads compiled Twine 2 or Twine 1 HTML (or an archive) back into a story model: `{ story: Story; diagnostics: Diagnostic[] }`.

```typescript
import { compile, decompileHTML } from '@rohal12/twee-ts';

const { output: html } = await compile({ sources: ['src/'] });

// Parse compiled Twine 2 or Twine 1 HTML back into a story model
const { story, diagnostics } = decompileHTML(html);
console.log(story.name, story.passages.length, diagnostics.length);

// Keep passage text exactly as stored, with its leading and trailing whitespace
const untrimmed = decompileHTML(html, { trim: false });
console.log(untrimmed.story.passages.length);
```

`trim` (default `true`) trims whitespace at both ends of passage text, as the Twee lexer does, and applies to the Twine 2 story stylesheet and script too. `compile()` passes its own `trim` option through when it loads `.html` files.

The HTML is read as a browser reads it (with scripting enabled, as story formats run): the story is the first `<tw-storydata>` element, or Twine 1 store area, that a story format finds, not one in template content, a comment or raw text; line breaks are normalized and NUL characters handled as the HTML parser does; and a passage's text is its `textContent`, so text inside elements is kept.

Decompiling gives back the story that was compiled, except for what the output does not carry:

- Passages the output leaves out are gone: `Twine.private` passages, and the StoryTitle passage (the story's `name` is set from the output instead; Twee output writes a StoryTitle passage again).
- All script passages come back as one `Story JavaScript` passage tagged `script`, and all stylesheet passages as one `Story Stylesheet` passage tagged `stylesheet`, with a comment naming each passage between them. Their names and other tags, alias tags included, are not recoverable.
- In them, a `</script`, `</style` and (in script text that would otherwise end the element late) `<!--` come back with a backslash after the `<`, which compiling writes so that the element ends where it should. Where that backslash changes the code (outside a string, comment or regular expression literal), compiling warns.
- Every passage has `position` and `size` metadata, and the StoryData values are those of the build (its story format and version).

Text HTML cannot carry (NUL and lone surrogates) is an error when compiling.

A `<tw-storydata>` `ifid` that is not a valid IFID gives a warning in `diagnostics`, and `story.ifid` keeps the value as written, uppercased. A missing or empty `ifid` gives a warning too, and `story.ifid` stays empty. When `compile()` loads the same file, these are reported once, as errors, by the `StoryData` check, as for a Twee `StoryData` passage.

### Story Formats

- `getFormatSearchDirs(extraPaths?: readonly string[], useTweegoPath = true): string[]`: the local format directories, lowest rank first (see [Search Order](./story-formats#search-order)).
- `discoverFormats(searchDirs: readonly string[]): Map<string, StoryFormatInfo>`: the formats in those directories, keyed by format ID (folder name), keeping the greatest version of each name and major version.
- `parseFormatJSON(source: string): Twine2FormatJSON | null`: the metadata a `format.js` passes to `storyFormat()`, read without running it (see [Format Metadata](./story-formats#format-metadata)), or `null` when it can't be used.
- `parseVersion(text: string): SemVer | null` and `compareVersions(a: SemVer, b: SemVer): number`: a version read as format selection reads it (SemVer 2.0.0, plus Tweego's leading `v` and `1`/`1.2` forms) as `{ major, minor, patch, prerelease }`, or `null`, and the order of two versions by SemVer precedence (a prerelease ranks below its release). They replace `parseSemver()` and `semverCompare()`, which dropped prereleases.

```typescript
import { compareVersions, discoverFormats, getFormatSearchDirs, parseFormatJSON, parseVersion } from '@rohal12/twee-ts';

const dirs = getFormatSearchDirs(['storyformats']);
const formats = discoverFormats(dirs);

for (const [id, format] of formats) {
  console.log(`${id}: ${format.name} ${format.version}`);
}

const meta = parseFormatJSON(
  'window.storyFormat({"name": "My Format", "version": "1.0.0", "source": "<html></html>"});',
);
console.log(meta?.name); // My Format

const a = parseVersion('2.37.3');
const b = parseVersion('2.37.3-rc.1');
if (a && b) console.log(compareVersions(a, b) > 0); // true
```

### Remote Formats

<!-- docs-test: no-run — downloads story formats from the network -->

```typescript
import {
  resolveRemoteFormat,
  fetchDirectFormat,
  discoverCachedFormats,
  listCachedFormats,
  clearCachedFormats,
  getCacheSize,
  getCacheDir,
} from '@rohal12/twee-ts';

// Resolve from format URLs and indices (then the Story Formats Archive) by the same rules as a
// compile, without local formats; see "How a Format Is Chosen" in Story Formats
const format = await resolveRemoteFormat('SugarCube', '2.37.3');
console.log(format?.filename);

// With direct format URLs, a signal, a per-request timeout and a limit for the whole lookup
// (RemoteResolveOptions); failures reject with a TweeTsError (INVALID_OPTIONS or FORMAT_UNAVAILABLE)
const fork = await resolveRemoteFormat('SugarCube', '2.37.3', {
  urls: ['https://example.com/sugarcube/format.js'],
  indices: [],
  signal: AbortSignal.timeout(60_000),
  timeout: 10_000,
  resolutionTimeout: 30_000,
  useDefaultIndices: false,
});
console.log(fork?.version);

// Download a format.js URL into the cache (checked again with a conditional request when cached)
const direct = await fetchDirectFormat('https://example.com/my-format/format.js');
console.log(direct.name);

// Every intact cached format (Map<cache entry key, StoryFormatInfo>)
const cached = discoverCachedFormats();
console.log(cached.size);

// List cached formats with where each came from, its size and when it was downloaded
for (const e of listCachedFormats()) {
  console.log(
    `${e.name} ${e.version} from ${e.source} ${e.origin}: ${e.sizeBytes} bytes, ${e.modifiedAt.toISOString()}`,
  );
}

// Clear all cached formats (returns the number removed)
clearCachedFormats();

// Clear cached formats by name, without regard to letter case
clearCachedFormats('SugarCube');

// Get total cache size
const { totalBytes, count } = getCacheSize();
console.log(totalBytes, count);

// Get cache directory path
console.log(getCacheDir());
```

- `resolveRemoteFormat(name, version, options?: RemoteResolveOptions): Promise<StoryFormatInfo | undefined>` rejects with a `TweeTsError`: `FORMAT_UNAVAILABLE`, whose `diagnostics` list every source's failure, when a source fails and none answers, and `INVALID_OPTIONS` when a URL is not an absolute `http:` or `https:` URL or a time limit is out of range.
- `fetchDirectFormat(url, options?): Promise<StoryFormatInfo>`.
- `listCachedFormats(): readonly CachedFormatEntry[]`; each entry has `name`, `version`, `source` (`'index'` or `'url'`), `origin` (the index or format URL), `sizeBytes` and `modifiedAt`.
- `clearCachedFormats(name?): number`, `getCacheSize(): { totalBytes; count }`, `getCacheDir(): string`.

`fetchAndCacheFormat()` was removed in 2.0; see [Migrating to 2.0](./migrating-to-2#fetchandcacheformat-is-removed).

### IFID

- `generateIFID(): IFID`: a new random IFID (an uppercase UUID v4).
- `validateIFID(ifid: string): string | null`: `null` when the IFID is valid, otherwise what is wrong with it.
- `createIFID(value: string): IFID`: the IFID in its stored form (uppercased, a `UUID://…//` wrapper removed); throws an `Error` when it is not valid.

```typescript
import { createIFID, generateIFID, validateIFID } from '@rohal12/twee-ts';

const ifid = generateIFID(); // "A1B2C3D4-..."
console.log(validateIFID(ifid)); // null: valid
console.log(validateIFID('nope')); // 'invalid IFID length: 4'
console.log(createIFID('uuid://d674c58c-defa-4f70-b7a2-27742230c0fc//')); // 'D674C58C-DEFA-4F70-B7A2-27742230C0FC'
```

### Config

```typescript
import type { Diagnostic } from '@rohal12/twee-ts';
import {
  CONFIG_FILENAME,
  loadConfig,
  loadConfigFile,
  validateConfig,
  unknownConfigKeyWarnings,
  scaffoldConfig,
} from '@rohal12/twee-ts';

console.log(CONFIG_FILENAME); // 'twee-ts.config.json'
const config = loadConfig(); // twee-ts.config.json in the working directory, or null
const warnings: Diagnostic[] = [];
const config2 = loadConfigFile('configs/production.json', warnings); // from a path, collecting warnings
console.log(config?.sources, config2.sources); // config2's paths are rebased: ['src/']
const errors = validateConfig({ sources: 42 }); // [ '"sources" must be an array.' ]
const unknown = unknownConfigKeyWarnings({ formatID: 'harlowe-3' });
// ['Unknown config key "formatID" (did you mean "formatId"?); it is ignored.']
const json = scaffoldConfig(); // default config JSON, as --init writes it
console.log(errors, unknown, json);
```

- `loadConfig(dir?: string, diagnostics?: Diagnostic[]): TweeTsConfig | null` reads `twee-ts.config.json` (`CONFIG_FILENAME`) in `dir` (default: the working directory); `null` when there is none. `loadConfigFile(filePath: string, diagnostics?: Diagnostic[]): TweeTsConfig` reads the file named.
- Paths in the file (`sources`, `exclude`, `output`, `modules`, `headFile`, `formatPaths`) are relative to the config file's folder; both functions return them rebased onto the working directory, as the CLI uses them. An `exclude` glob of a config whose folder name holds glob syntax (`chapter[one]`, `chapter{one,two}`) comes back as `{ base, glob }` (`ExcludeGlob`): the folder is read literally and only `glob` is matched, against the file's path below it.
- They throw a `TweeTsError`: `INPUT_UNAVAILABLE` when the file can't be read, `INVALID_OPTIONS` when it is not valid JSON or fails `validateConfig()`. The optional `diagnostics` array collects warnings that leave the config usable: keys the config does not define (other than `$schema`), a key given twice, and a file that is not valid UTF-8. A config file may start with a byte order mark and may be UTF-16.
- `validateConfig(data: unknown): string[]` returns the errors (empty when valid); `unknownConfigKeyWarnings(data: unknown): string[]` the unknown keys; `scaffoldConfig(): string` the config `--init` writes.

### Lint

`lint(options: Omit<CompileOptions, 'outputMode'>): Promise<LintResult>` compiles the story and checks its links against what Twine 2 output emits. `formatLintReport(result: LintResult): string` is the report `--lint` prints.

```typescript
import { lint, formatLintReport } from '@rohal12/twee-ts';

const result = await lint({ sources: ['src/'] });

console.log(result.brokenLinks);
// [
//   { from: 'Kitchen', to: 'Pantry' },
//   { from: 'Kitchen', to: 'Notes', omission: { kind: 'tag', tag: 'Twine.private' } },
// ]
console.log(result.deadEnds); // ['Ending1', 'Ending2']
console.log(result.orphans); // ['UnusedRoom']

// Human-readable report
console.log(formatLintReport(result));
```

`LintResult` also holds the compile's `diagnostics` and `stats`, the `formatName` and `formatVersion` from StoryData, the `start` passage, and the `passages`, `storyPassages` and `infoPassages` counts.

A link is broken when no passage has its name, or when its passage is one that Twine 2 output leaves out: a passage tagged `script`, `stylesheet` or `Twine.private`, StoryData, StoryTitle, or an empty StorySettings. Such a link has an `omission` field that says why. Links to special passages that the output keeps, such as StoryInit, PassageHeader or a `widget` passage, are valid.

Links are read from passage markup and, in script passages, only from JavaScript strings. JavaScript is read with a JavaScript parser, so a regular expression or a comment is never taken for a string; code that does not parse, such as TwineScript, is read exactly up to the error and token by token after it. Story JavaScript and `<<script>>` bodies are read as strict-mode code and `<script>` elements as sloppy-mode code, so an octal escape such as `\74` counts only in a `<script>` element. Stylesheets (passages tagged `stylesheet`, and loaded `.css` files) are CSS, so they link to nothing. Passages that Twine 2 output leaves out never reach the player, so lint reads no links from `Twine.private` passages, StoryData or StoryTitle: a link in a private notes passage is not reported as broken, and it does not keep a passage from being listed as an orphan. Script passages are still read, because Twine 2 output runs them.

An orphan is a story passage the player cannot reach: no chain of links leads to it from the start passage or from an info passage (StoryInit, PassageHeader, a `script` or `widget` passage, and the other passages a story format runs or shows without a link). A passage that links only to itself, or a group of passages that link only to each other, is an orphan, even though a link leads to it. Only the links listed above count, so a passage shown only through a macro such as `<<include>>` is listed as well.

### Story Inspection

`storyInspect(story: ReadonlyStory, options?: InspectOptions): StoryMap` describes a story's structure: `passages`, `storyPassages`, `infoPassages`, `tags`, `passagesByTag`, `tagsByPassage`, `links` (a `Map` of passage name to the names it links to), `brokenLinks`, `deadEnds`, `orphans` and `start`.

```typescript
import { compile, storyInspect } from '@rohal12/twee-ts';

const result = await compile({ sources: ['src/'], outputMode: 'json' });
const info = storyInspect(result.story);

console.log(info.links); // Map of passage name → passage names it links to
console.log(info.brokenLinks); // links to passages that don't exist

// Also report links to passages that Twine 2 output leaves out (as lint does)
const checked = storyInspect(result.story, { target: 'twine2' });
console.log(checked.brokenLinks); // e.g. [{ from: 'Start', to: 'Logic', omission: { kind: 'tag', tag: 'script' } }]
```

Without a `target`, `storyInspect` describes the source passages and treats a link as broken only when no passage has its name. With `target: 'twine2'` or `target: 'twine1'`, it also reports links to passages that output leaves out (Twine 1 output leaves out only `Twine.private` passages), and reads no links from those passages, except script passages, which Twine 2 output runs. Left-out passages are never story passages, so they are never listed as dead ends or orphans, with or without a target.

#### How links are read

`links`, and with it lint, reads a passage's links as SugarCube 2 (2.37.3) reads them when the story plays. The table lists what counts as a link in passage markup, and what does not:

| Markup                                   | Links to | Notes                                                                                                           |
| ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `[[Hall]]`                               | `Hall`   | Link markup                                                                                                     |
| `[[Go to the hall\|Hall]]`               | `Hall`   | The first `\|`, `->` or `<-` divides the text from the passage                                                  |
| `[[Go->Hall]]`                           | `Hall`   |                                                                                                                 |
| `[[Hall<-Go]]`                           | `Hall`   |                                                                                                                 |
| `[[Go\|Hall][$visited to true]]`         | `Hall`   | With a setter                                                                                                   |
| `[[Go\|"Hall"]]`                         | `Hall`   | A quoted string is taken by its value                                                                           |
| `[img[map.png][Hall]]`                   | `Hall`   | Image markup links to the passage of its link part                                                              |
| `<<goto "Hall">>`                        | `Hall`   | Arguments may be double- or single-quoted, or bare words                                                        |
| `<<link "Go" "Hall">><</link>>`          | `Hall`   |                                                                                                                 |
| `<<button "Go" "Hall">><</button>>`      | `Hall`   | `<<button>>` is `<<link>>` as a button                                                                          |
| `<<link [[Go\|Hall]]>><</link>>`         | `Hall`   | Link markup as the first argument names the passage                                                             |
| `<a data-passage="Hall">Go</a>`          | `Hall`   | Any element with a `data-passage` attribute, `<button>` and `<span>` too                                        |
| `<area data-passage="Hall">`             | `Hall`   | A void element needs no end tag                                                                                 |
| `<<set _go to '<<goto "Hall">>'>>`       | `Hall`   | Links and calls inside the strings of macro arguments, `<<script>>` bodies and `<script>` elements are read too |
| `/* [[Hall]] */`                         | nothing  | Comments (`/* … */`, `/% … %/`, `<!-- … -->`) are skipped                                                       |
| `<<link "Go" $next>><</link>>`           | nothing  | A passage named by a variable or an expression is known only in play                                            |
| `<a data-passage="Hall">Go`              | nothing  | An element other than a void one needs its end tag, or SugarCube reports an error                               |
| `<a data-passage="Hall" href="#">Go</a>` | nothing  | `data-passage` with `href` is an error in SugarCube                                                             |
| `<a @data-passage="$next">Go</a>`        | nothing  | An attribute directive sets the passage in play                                                                 |
| `<img data-passage="Hall">`              | nothing  | On `img`, `audio`, `video`, `source` and `track`, `data-passage` names a media passage                          |
| `<span title="[[Hall]]">x</span>`        | nothing  | The text of a start tag is not markup                                                                           |
| `<<include "Hall">>`                     | nothing  | Shows the passage without a link, so Hall is still an orphan unless something else links to it                  |

A passage tagged `nobr` has its line breaks joined first, as SugarCube does. A script passage is JavaScript: only its strings are read, as markup (`$('#out').wiki('<<goto "Hall">>')` links to Hall), and code that builds a link while the story plays (`'<<goto "' + next + '">>'`, `Engine.play('Hall')`) names nothing. A stylesheet is CSS and links to nothing.

Known differences from SugarCube: a link whose passage SugarCube evaluates because no passage has its name (`[[Go|$next]]`) is taken by its name, and so is a link SugarCube takes for a URL; macros that show or go to a passage other than `<<goto>>`, `<<link>>` and `<<button>>` (`<<include>>`, `<<actions>>`, `<<choice>>`, `<<back>>`, `<<return>>`) are not read; and a `[[`, comment or start tag inside verbatim text, a `<style>` element or an `<svg>` element is read as if it were outside it. The source (`src/sugarcube-macros.ts`) lists the rest.

## Types

All public types are exported from the main entry point (`ItemType` is also a runtime value):

```typescript
import type {
  BrokenLink,
  CachedFormatEntry,
  CompileOptions,
  CompileResult,
  CompileStats,
  CompileToFileOptions,
  DecompileOptions,
  DecompileResult,
  Diagnostic,
  ExcludeGlob,
  FileCacheEntry,
  IFID,
  InlineSource,
  InspectOptions,
  ItemType,
  LexerItem,
  LintResult,
  OmittingTag,
  OutputMode,
  ParseOptions,
  ParseResult,
  Passage,
  PassageMetadata,
  PassageOmission,
  PassageOutputTarget,
  ReadonlyPassage,
  ReadonlyStory,
  RemoteFetchOptions,
  RemoteResolveOptions,
  SFAIndex,
  SemVer,
  SFAIndexEntry,
  SourceInput,
  SourceLocation,
  Story,
  StoryFormatInfo,
  StoryMap,
  TweeTsConfig,
  TweeTsErrorCode,
  Twine1Metadata,
  Twine2FormatJSON,
  Twine2Metadata,
  WatchOptions,
  WordCountMethod,
} from '@rohal12/twee-ts';
```

The plugin option types are exported by their entry points: `TweeTsVitePluginOptions` and `PluginCompileOptions` from `@rohal12/twee-ts/vite`, `TweeTsRollupPluginOptions` and `PluginCompileOptions` from `@rohal12/twee-ts/rollup`.

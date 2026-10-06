# Programmatic API

twee-ts exports a full API for use from TypeScript or JavaScript code.

## Core Functions

### `compile(options)`

Compile Twee sources to a string.

```typescript
import { compile } from '@rohal12/twee-ts';

const result = await compile({
  sources: ['src/'],
  formatId: 'sugarcube-2',
  tagAliases: { library: 'script' },
});

console.log(result.output); // compiled HTML string
console.log(result.story); // parsed Story model
console.log(result.format); // format info (undefined for non-HTML modes)
console.log(result.diagnostics); // warnings and errors
console.log(result.stats); // { passages, storyPassages, words, files }
```

### `compileToFile(options)`

Compile and write the output to a file. The file is replaced atomically (written to a temporary file in the same folder, then renamed over it), so a program that reads it meanwhile, such as a live-reload server, sees the previous build or the new one, never part of one. If the write fails, the previous file is left as it was. `outFile` is left out of the sources and modules, so the output can sit inside a source folder; it is compared by real path, so a symbolic link to it or to its folder doesn't let it back in. A source, module or head file named directly that is `outFile` is an error: the call rejects with a `TweeTsError` (`path a.tw: Output file cannot be an input source.`) and writes nothing, rather than overwrite the source.

```typescript
import { compileToFile } from '@rohal12/twee-ts';

const result = await compileToFile({
  sources: ['src/'],
  outFile: 'story.html',
});
```

### `watch(options)`

Watch for file changes and recompile automatically. Returns an `AbortController` to stop watching. The sources, the modules and the head file are watched, wherever the head file is and whatever its extension. Like `compileToFile()`, every build leaves `outFile` out of the sources and modules, so the output can sit inside a source folder. Every build is written to `outFile`, including one whose `diagnostics` report errors, and then passed to `onBuild`; a build that fails with a fatal error, such as a `TweeTsError`, writes nothing and is passed to `onError`. (The CLI's watch mode instead keeps the last build without errors; see [Exit Status](./cli#exit-status).) Builds run one at a time, and each one is written and reported as it finishes, in order, so the output never goes back to an older state: changes saved while a build is running are built together in one follow-up build once it finishes. While saves keep coming, the output and the reports trail the latest save by at most about one build. After `controller.abort()`, no build starts, and one still running writes and reports nothing; story format downloads it waits on are cancelled, so the process can exit. Aborting the `signal` passed in the options does the same. Each build replaces `outFile` atomically, as `compileToFile()` does.

A watched folder or file that doesn't exist yet is waited for and built once it appears, and one that is deleted, or renamed away and replaced (as `git checkout` or a generator may do), is followed to the new one at its path; the build after that reads every file again. A path that can't be watched (one the process may not read, say) is passed to `onError` as an error whose message starts with `Cannot watch`, and is tried again on the next change in the folder above it; the other paths are still watched. `onError` also receives an exception thrown by `onBuild`. An exception thrown by `onError` itself is printed to the console and doesn't stop the watch.

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

## Compile Options

All options for `compile()`. Only `sources` is required.

```typescript
interface CompileOptions {
  sources: readonly SourceInput[];
  exclude?: readonly string[]; // globs for source files to leave out
  outputMode?: OutputMode; // default: 'html'
  formatId?: string; // default: 'sugarcube-2'
  startPassage?: string; // default: 'Start'
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
  tagAliases?: Record<string, string>;
  sourceInfo?: boolean; // default: false
  wordCountMethod?: 'tweego' | 'whitespace'; // default: 'tweego'
}
```

`signal` cancels a compile: story format requests still in progress are aborted, and the promise rejects with the signal's reason (an `AbortError` for `controller.abort()`). Nothing from a cancelled download is written to the format cache.

`formatFetchTimeout` limits each story format request (an index or a `format.js`), in milliseconds. A request that takes longer fails with a warning in `diagnostics`, and the next source is tried. The default is 30000; `0` turns the limit off.

```typescript
const controller = new AbortController();
const pending = compile({ sources: ['src/'], signal: controller.signal });
controller.abort(); // pending rejects with an AbortError
```

`SourceInput` is either a file/directory path (`string`) or an inline source (`{ filename: string; content: string | Buffer }`).

`exclude` takes glob patterns for files to leave out of `sources`, matched against each file's path relative to the working directory, as `stats.files` lists it. It applies to `compile()`, `compileToFile()`, `compileIncremental()` and `watch()`, whose watcher also ignores changes to excluded files. Modules and the head file are never left out. See [Excluding files](./configuration#excluding-files) for the pattern rules.

```typescript
const result = await compileToFile({
  sources: ['src/story'],
  exclude: ['src/story/**/*.png'],
  outFile: 'story.html',
});
```

## Inline Sources

Pass Twee content directly without files on disk:

```typescript
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
```

You can mix inline sources with file paths:

```typescript
const result = await compile({
  sources: ['src/', { filename: 'extra.tw', content: ':: Bonus\nSecret passage!' }],
});
```

## Compile Result

```typescript
interface CompileResult {
  output: string; // compiled HTML, Twee, or JSON string
  story: ReadonlyStory; // parsed story model, read-only in TypeScript
  format?: StoryFormatInfo; // format used (undefined for non-HTML modes)
  diagnostics: Diagnostic[];
  stats: CompileStats;
}

interface CompileStats {
  passages: number; // total passages
  storyPassages: number; // non-info passages
  words: number; // estimated word count
  files: string[]; // processed file paths
}

interface Diagnostic {
  level: 'warning' | 'error';
  message: string;
  file?: string;
  line?: number;
}
```

## Error Handling

Non-fatal issues (missing start passage, duplicate passages, etc.) are collected as diagnostics rather than thrown. Only truly fatal conditions (no story format available for HTML mode) throw a `TweeTsError`:

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
    console.error('Fatal:', err.message);
    console.error('Diagnostics:', err.diagnostics);
  }
}
```

## Utility Exports

### `applyTagAliases(passages, aliases)`

Return a passage array with tag aliases applied. The original passages and their tags are unchanged. A passage whose tags change is copied with a new tag array; unchanged passages may be shared with the input. Used internally by `compile()`, but available for direct use:

```typescript
import { applyTagAliases, type Passage } from '@rohal12/twee-ts';

const passages: Passage[] = [{ name: 'Utils', tags: ['library'], text: 'window.x = 1;' }];
const resolved = applyTagAliases(passages, { library: 'script', theme: 'stylesheet' });
console.log(resolved[0]?.tags); // ['library', 'script']
console.log(passages[0]?.tags); // ['library']
```

### Lexer & Parser

```typescript
import { TweeLexer, tweeLexer, parseTwee } from '@rohal12/twee-ts';

// Low-level lexer (generator)
const lexer = tweeLexer(':: Start\nHello!');
for (const item of lexer) {
  console.log(item.type, item.val);
}

// Parse Twee source into passages
const { passages, diagnostics } = parseTwee(':: Start\nHello!', { filename: 'story.tw' });
```

`parseTwee` normalizes its input the way files are normalized when read: it strips a leading UTF-8 BOM and turns CRLF and bare CR line endings into LF. It also removes a BOM at the start of a later line directly before `::`, which joining files leaves there, so that line stays a passage header. In-memory sources passed to `compile()` get the same normalization. A `Buffer` source that is not valid UTF-8 is decoded as Windows-1252, like a file, with a warning in `diagnostics` (see [Text encoding](./getting-started#text-encoding)).

### HTML Decompiler

```typescript
import { decompileHTML } from '@rohal12/twee-ts';

// Parse compiled Twine 2 or Twine 1 HTML back into a story model
const { story, diagnostics } = decompileHTML(html);

// Keep passage text exactly as stored, with its leading and trailing whitespace
const untrimmed = decompileHTML(html, { trim: false });
```

`trim` (default `true`) trims whitespace at both ends of passage text, as the Twee lexer does, and applies to the Twine 2 story stylesheet and script too. `compile()` passes its own `trim` option through when it loads `.html` files.

A `<tw-storydata>` `ifid` that is not a valid IFID gives a warning in `diagnostics`, and `story.ifid` keeps the value as written, uppercased. A missing or empty `ifid` gives a warning too, and `story.ifid` stays empty. When `compile()` loads the same file, these are reported once, as errors, by the `StoryData` check, as for a Twee `StoryData` passage.

### Story Formats

```typescript
import { discoverFormats, getFormatSearchDirs, parseFormatJSON } from '@rohal12/twee-ts';

const dirs = getFormatSearchDirs(['/my/formats']);
const formats = discoverFormats(dirs);

for (const [id, format] of formats) {
  console.log(`${id}: ${format.name} ${format.version}`);
}
```

### Remote Formats

```typescript
import {
  resolveRemoteFormat,
  fetchAndCacheFormat,
  discoverCachedFormats,
  listCachedFormats,
  clearCachedFormats,
  getCacheSize,
  getCacheDir,
} from '@rohal12/twee-ts';

// Auto-resolve from SFA indices
const format = await resolveRemoteFormat('SugarCube', '2.37.3');

// With direct format URLs, a signal and a per-request timeout (RemoteFetchOptions)
const fork = await resolveRemoteFormat('SugarCube', '2.37.3', [], ['https://example.com/sugarcube/format.js'], {
  signal: AbortSignal.timeout(60_000),
  timeout: 10_000,
});

// List cached formats (Map<id, StoryFormatInfo>)
const cached = discoverCachedFormats();

// List cached formats with size and modification date
const entries = listCachedFormats();
for (const e of entries) {
  console.log(`${e.name} ${e.version} — ${e.sizeBytes} bytes, modified ${e.modifiedAt.toISOString()}`);
}

// Clear all cached formats, including downloads from direct URLs (returns count removed)
clearCachedFormats();

// Clear cached formats by name
clearCachedFormats('SugarCube');

// Get total cache size
const { totalBytes, count } = getCacheSize();

// Get cache directory path
const cacheDir = getCacheDir();
```

### IFID

```typescript
import { generateIFID, validateIFID } from '@rohal12/twee-ts';

const ifid = generateIFID(); // "A1B2C3D4-..."
validateIFID(ifid); // null: valid
validateIFID('not-an-ifid'); // error message string: invalid
```

`validateIFID()` returns `null` for a valid IFID and a string explaining the error for an invalid one.

### Config

```typescript
import type { Diagnostic } from '@rohal12/twee-ts';
import { loadConfig, loadConfigFile, validateConfig, unknownConfigKeyWarnings, scaffoldConfig } from '@rohal12/twee-ts';

const config = loadConfig(); // from cwd
const warnings: Diagnostic[] = [];
const config2 = loadConfigFile('my-config.json', warnings); // from path, collecting warnings
const errors = validateConfig({ sources: 42 }); // validation
const unknown = unknownConfigKeyWarnings({ formatID: 'harlowe-3' });
// ['Unknown config key "formatID" (did you mean "formatId"?); it is ignored.']
const json = scaffoldConfig(); // default config JSON
```

`loadConfig()` and `loadConfigFile()` throw when the file cannot be read, on invalid JSON or a config that fails `validateConfig()`. Their optional second argument collects warnings that leave the config usable: keys the config does not define (other than `$schema`) and a file that is not valid UTF-8. A config file may start with a byte order mark.

### Lint

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

Lint checks link destinations against what Twine 2 output emits. A link is broken when no passage has its name, or when its passage is one that Twine 2 output leaves out: a passage tagged `script`, `stylesheet` or `Twine.private`, StoryData, StoryTitle, or an empty StorySettings. Such a link has an `omission` field that says why. Links to special passages that the output keeps, such as StoryInit, PassageHeader or a `widget` passage, are valid.

Links are read from passage markup and, in script passages, only from JavaScript strings. Stylesheets (passages tagged `stylesheet`, and loaded `.css` files) are CSS, so they link to nothing. Passages that Twine 2 output leaves out never reach the player, so lint reads no links from `Twine.private` passages, StoryData or StoryTitle: a link in a private notes passage is not reported as broken, and it does not keep a passage from being listed as an orphan. Script passages are still read, because Twine 2 output runs them.

### Story Inspection

```typescript
import { compile, storyInspect } from '@rohal12/twee-ts';

const result = await compile({ sources: ['src/'], outputMode: 'json' });
const info = storyInspect(result.story);

console.log(info.links); // Map of passage name → passage names it links to
console.log(info.brokenLinks); // links to passages that don't exist

// Also report links to passages that Twine 2 output leaves out (as lint does)
const checked = storyInspect(result.story, { target: 'twine2' });
console.log(checked.brokenLinks); // [{ from: 'Start', to: 'Logic', omission: { kind: 'tag', tag: 'script' } }]
```

Without a `target`, `storyInspect` describes the source passages and treats a link as broken only when no passage has its name. With `target: 'twine2'` or `target: 'twine1'`, it also reports links to passages that output leaves out (Twine 1 output leaves out only `Twine.private` passages), and reads no links from those passages, except script passages, which Twine 2 output runs. Left-out passages are never story passages, so they are never listed as dead ends or orphans, with or without a target.

## Types

All public types are re-exported from the main entry point:

```typescript
import type {
  CompileOptions,
  CompileToFileOptions,
  DecompileOptions,
  WatchOptions,
  CompileResult,
  CompileStats,
  Diagnostic,
  Story,
  ReadonlyStory,
  Passage,
  PassageMetadata,
  StoryFormatInfo,
  OutputMode,
  SourceInput,
  InlineSource,
  LexerItem,
  ItemType,
  SFAIndex,
  SFAIndexEntry,
  RemoteFetchOptions,
  SourceLocation,
  TweeTsConfig,
  LintResult,
  StoryMap,
  BrokenLink,
  InspectOptions,
  PassageOutputTarget,
  PassageOmission,
  CachedFormatEntry,
} from '@rohal12/twee-ts';
```

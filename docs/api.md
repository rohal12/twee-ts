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

Compile and write the output to a file.

```typescript
import { compileToFile } from '@rohal12/twee-ts';

const result = await compileToFile({
  sources: ['src/'],
  outFile: 'story.html',
});
```

### `watch(options)`

Watch for file changes and recompile automatically. Returns an `AbortController` to stop watching. The sources, the modules and the head file are watched, wherever the head file is and whatever its extension. Like `compileToFile()`, every build leaves `outFile` out of the sources and modules, so the output can sit inside a source folder. Every build is written to `outFile`, including one whose `diagnostics` report errors, and then passed to `onBuild`; `onError` receives only a fatal error, such as a `TweeTsError`, and that build writes nothing. (The CLI's watch mode instead keeps the last build without errors; see [Exit Status](./cli#exit-status).)

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
  sources: SourceInput[];
  exclude?: string[]; // globs for source files to leave out
  outputMode?: OutputMode; // default: 'html'
  formatId?: string; // default: 'sugarcube-2'
  startPassage?: string; // default: 'Start'
  formatPaths?: string[];
  useTweegoPath?: boolean; // default: true
  modules?: string[];
  headFile?: string;
  trim?: boolean; // default: true
  twee2Compat?: boolean; // default: false
  testMode?: boolean; // default: false
  formatIndices?: string[];
  formatUrls?: string[];
  noRemote?: boolean; // default: false
  tagAliases?: Record<string, string>;
  sourceInfo?: boolean; // default: false
}
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
  story: Story; // parsed story model
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

Apply tag aliases to a passage array. Used internally by `compile()`, but available for direct use:

```typescript
import { applyTagAliases } from '@rohal12/twee-ts';

applyTagAliases(passages, { library: 'script', theme: 'stylesheet' });
```

### Lexer & Parser

```typescript
import { TweeLexer, tweeLexer, parseTwee } from '@rohal12/twee-ts';

// Low-level lexer (generator)
const lexer = tweeLexer(':: Start\nHello!', 'story.tw');
for (const item of lexer) {
  console.log(item.type, item.val);
}

// Parse Twee source into passages
const { passages, diagnostics } = parseTwee(':: Start\nHello!', { filename: 'story.tw' });
```

`parseTwee` normalizes its input the way files are normalized when read: it strips a leading UTF-8 BOM and turns CRLF and bare CR line endings into LF. In-memory sources passed to `compile()` get the same normalization.

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

// List cached formats (Map<id, StoryFormatInfo>)
const cached = discoverCachedFormats();

// List cached formats with size and modification date
const entries = listCachedFormats();
for (const e of entries) {
  console.log(`${e.name} ${e.version} — ${e.sizeBytes} bytes, modified ${e.modifiedAt.toISOString()}`);
}

// Clear all cached formats (returns count removed)
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
validateIFID(ifid); // true
```

### Config

```typescript
import { loadConfig, loadConfigFile, validateConfig, scaffoldConfig } from '@rohal12/twee-ts';

const config = loadConfig(); // from cwd
const config2 = loadConfigFile('my-config.json'); // from path
const errors = validateConfig({ sources: 42 }); // validation
const json = scaffoldConfig(); // default config JSON
```

### Lint

```typescript
import { lint, formatLintReport } from '@rohal12/twee-ts';

const result = await lint({ sources: ['src/'] });

console.log(result.brokenLinks); // [{ from: 'Kitchen', to: 'Pantry' }]
console.log(result.deadEnds); // ['Ending1', 'Ending2']
console.log(result.orphans); // ['UnusedRoom']

// Human-readable report
console.log(formatLintReport(result));
```

### Story Inspection

```typescript
import { compile, storyInspect } from '@rohal12/twee-ts';

const result = await compile({ sources: ['src/'], outputMode: 'json' });
const info = storyInspect(result.story);

console.log(info.passageMap); // Map of passage name → passage
console.log(info.brokenLinks); // passages with links to nonexistent passages
```

## Types

All public types are re-exported from the main entry point:

```typescript
import type {
  CompileOptions,
  CompileToFileOptions,
  WatchOptions,
  CompileResult,
  CompileStats,
  Diagnostic,
  Story,
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
  SourceLocation,
  TweeTsConfig,
  LintResult,
  CachedFormatEntry,
} from '@rohal12/twee-ts';
```

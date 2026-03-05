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

Watch for file changes and recompile automatically. Returns an `AbortController` to stop watching.

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
const passages = parseTwee(':: Start\nHello!', 'story.tw');
```

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
import { resolveRemoteFormat, fetchAndCacheFormat, discoverCachedFormats } from '@rohal12/twee-ts';

// Auto-resolve from SFA indices
const format = await resolveRemoteFormat('SugarCube', '2.37.3');

// List cached formats
const cached = discoverCachedFormats();
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
} from '@rohal12/twee-ts';
```

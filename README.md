# twee-ts

TypeScript Twee-to-HTML compiler — a complete reimplementation of [Tweego](https://www.motoslave.net/tweego/).

Zero runtime dependencies. Node.js 22+.

## Install

```sh
npm install @rohal12/twee-ts
```

## CLI

```sh
# Compile a story
npx twee-ts -o story.html src/

# Initialize a new project
npx twee-ts --init

# Use a config file (twee-ts.config.json)
npx twee-ts

# Decompile HTML back to Twee
npx twee-ts -d -o story.twee story.html

# Watch mode
npx twee-ts -w -o story.html src/

# List available story formats
npx twee-ts --list-formats
```

Story formats are automatically downloaded from the [Story Formats Archive](https://videlais.github.io/story-formats-archive/) when not found locally.

## Config File

Create `twee-ts.config.json` in your project root:

```json
{
  "sources": ["src/"],
  "output": "story.html"
}
```

Then just run `npx twee-ts` with no arguments.

All options:

| Field | Type | Description |
|-------|------|-------------|
| `sources` | `string[]` | Files and directories to compile |
| `output` | `string` | Output file path |
| `outputMode` | `string` | `html`, `twee3`, `twee1`, `twine2-archive`, `twine1-archive`, `json` |
| `formatId` | `string` | Story format directory ID (e.g. `sugarcube-2`) |
| `startPassage` | `string` | Starting passage name (default: `Start`) |
| `formatPaths` | `string[]` | Extra directories to search for story formats |
| `modules` | `string[]` | Files to inject into `<head>` |
| `headFile` | `string` | Raw HTML file to append to `<head>` |
| `trim` | `boolean` | Trim passage whitespace (default: `true`) |
| `twee2Compat` | `boolean` | Twee2 compatibility mode |
| `testMode` | `boolean` | Enable debug/test mode |
| `noRemote` | `boolean` | Disable remote format fetching |
| `formatIndices` | `string[]` | Custom SFA-compatible index URLs |
| `formatUrls` | `string[]` | Direct format.js URLs |

## API

```typescript
import { compile, compileToFile, watch } from '@rohal12/twee-ts';

// Compile to string
const result = await compile({
  sources: ['src/'],
});
console.log(result.output);

// Compile to file
await compileToFile({
  sources: ['src/'],
  outFile: 'story.html',
});

// Watch mode
const controller = await watch({
  sources: ['src/'],
  outFile: 'story.html',
  onBuild(result) {
    console.log(`${result.stats.passages} passages`);
  },
});
// controller.abort() to stop
```

### Inline sources

```typescript
const result = await compile({
  sources: [
    { filename: 'story.tw', content: ':: Start\nHello, world!' },
  ],
});
```

## Vite Plugin

```typescript
// vite.config.ts
import { tweeTsPlugin } from '@rohal12/twee-ts/vite';

export default {
  plugins: [
    tweeTsPlugin({
      sources: ['src/story'],
      outputFilename: 'index.html',
    }),
  ],
};
```

## Rollup Plugin

```typescript
// rollup.config.js
import { tweeTsPlugin } from '@rohal12/twee-ts/rollup';

export default {
  plugins: [
    tweeTsPlugin({
      sources: ['src/story'],
    }),
  ],
};
```

## Output Modes

| Mode | Flag | Description |
|------|------|-------------|
| HTML | (default) | Playable story compiled with a story format |
| Twee 3 | `-d` | Decompile to Twee 3 source |
| Twee 1 | `--decompile-twee1` | Decompile to Twee 1 source |
| Twine 2 Archive | `-a` | Twine 2 archive XML |
| Twine 1 Archive | `--archive-twine1` | Twine 1 archive HTML |
| JSON | `--json` | Story data as JSON |

## Remote Format Fetching

When a story specifies a format that isn't installed locally, twee-ts automatically downloads it from the [Story Formats Archive](https://videlais.github.io/story-formats-archive/). Downloaded formats are cached at `~/.cache/twee-ts/storyformats/`.

Disable with `--no-remote` or `"noRemote": true` in the config file.

## Compatibility

twee-ts is a drop-in replacement for Tweego. It reads the same `.twee`, `.tw`, `.css`, `.js`, font, and media files. It respects `TWEEGO_PATH` and searches the same default directories for story formats. The `--twee2-compat` flag enables Twee2 syntax compatibility.

## License

This is free and unencumbered software released into the public domain. See [UNLICENSE](UNLICENSE).

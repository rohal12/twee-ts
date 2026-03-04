# Getting Started

## Installation

```sh
npm install @rohal12/twee-ts      # npm
pnpm add @rohal12/twee-ts         # pnpm
yarn add @rohal12/twee-ts         # yarn
```

## Create a New Project

The `--init` command scaffolds a minimal Twine project:

```sh
npx @rohal12/twee-ts --init
```

This creates:

```
your-project/
├── twee-ts.config.json
├── src/
│   ├── StoryData.tw
│   └── Start.tw
```

## Compile

With the config file in place, compile with no arguments:

```sh
npx @rohal12/twee-ts
```

Or specify sources and output directly:

```sh
npx @rohal12/twee-ts -o story.html src/
```

## Watch Mode

Automatically rebuild when files change:

```sh
npx @rohal12/twee-ts -w -o story.html src/
```

## Project Structure

A typical twee-ts project looks like this:

```
my-story/
├── twee-ts.config.json        # Configuration
├── src/
│   ├── StoryData.tw           # Story metadata (IFID, format, etc.)
│   ├── Start.tw               # Starting passage
│   ├── chapter-1/
│   │   ├── intro.tw
│   │   └── choices.tw
│   ├── scripts/
│   │   └── macros.tw          # Script passages (tagged [script])
│   └── styles/
│       └── theme.tw           # Stylesheet passages (tagged [stylesheet])
└── story.html                 # Compiled output
```

twee-ts recursively walks directories, so you can organize your `.tw` files however you like.

## Supported File Types

| Extension | Treatment |
|-----------|-----------|
| `.tw`, `.twee` | Parsed as Twee source |
| `.css` | Injected as stylesheet |
| `.js` | Injected as script |
| `.otf`, `.ttf`, `.woff`, `.woff2` | Embedded as base64 font |
| `.gif`, `.jpeg`, `.jpg`, `.png`, `.svg`, `.tif`, `.tiff`, `.webp` | Embedded as base64 media |
| `.aac`, `.flac`, `.mp3`, `.m4a`, `.ogg`, `.opus`, `.wav`, `.wave`, `.weba` | Embedded as base64 audio |
| `.mp4`, `.ogv`, `.webm` | Embedded as base64 video |

## Compatibility with Tweego

twee-ts is a drop-in replacement for Tweego. It:

- Reads the same file types and Twee notation
- Respects the `TWEEGO_PATH` environment variable
- Searches the same default directories for story formats
- Produces equivalent HTML output

The `--twee2-compat` flag enables Twee2 syntax compatibility for projects written in that dialect.

## What's Next?

- [CLI Reference](./cli) — all command-line flags
- [Configuration](./configuration) — `twee-ts.config.json` reference
- [Tag Aliases](./tag-aliases) — map custom tags to special tags
- [Programmatic API](./api) — use twee-ts from code
- [Vite & Rollup Plugins](./plugins) — build tool integration

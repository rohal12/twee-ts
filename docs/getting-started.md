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

Files that already exist are left alone, so `--init` is safe to run in an existing project.

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

If a save leaves an error in the story, twee-ts reports it and keeps the previous `story.html`; the next save that fixes it rebuilds as usual.

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

twee-ts recursively walks directories, so you can organize your `.tw` files however you like. As in Tweego, a symbolic link to a directory inside a source directory is not followed; name the linked directory as a source of its own to include it.

## Supported File Types

| Extension                                                                  | Treatment                |
| -------------------------------------------------------------------------- | ------------------------ |
| `.tw`, `.twee`                                                             | Parsed as Twee source    |
| `.css`                                                                     | Injected as stylesheet   |
| `.js`                                                                      | Injected as script       |
| `.otf`, `.ttf`, `.woff`, `.woff2`                                          | Embedded as base64 font  |
| `.gif`, `.jpeg`, `.jpg`, `.png`, `.svg`, `.tif`, `.tiff`, `.webp`          | Embedded as base64 media |
| `.aac`, `.flac`, `.mp3`, `.m4a`, `.ogg`, `.opus`, `.wav`, `.wave`, `.weba` | Embedded as base64 audio |
| `.mp4`, `.ogv`, `.webm`                                                    | Embedded as base64 video |

### Text encoding

Text files (Twee, CSS, JavaScript, HTML, modules, the head file, story formats and the config file) are read as UTF-8. A leading byte order mark is removed and CRLF and CR line endings become LF. As in Tweego, a file that is not valid UTF-8 is read as Windows-1252 instead, the encoding of many older Windows files and Twine 1 exports, so its accented letters and curly quotes survive. twee-ts also prints a warning naming the file:

```
warning: read src/old.tw: Invalid UTF-8; assuming charset is windows-1252.
```

To silence it, save the file as UTF-8. Unlike Tweego, twee-ts has no `--charset` option for other encodings.

In a Twee file, a byte order mark at the start of a line directly before `::` is removed too. A file made by joining Twee files (`cat a.tw b.tw > story.tw`) then keeps the passage headers of files that were saved with a byte order mark.

### Passage names for loaded files

Each stylesheet, script, font and media file becomes a passage named after the file, as in Tweego: `.css`, `.js` and font files by their file name (`style.css`), media files by their file name without the extension (`images/forest.png` becomes `forest`). A Twine 2 HTML file brings its story stylesheet and script as `Story Stylesheet` and `Story JavaScript`.

These generated names never replace a passage, and no passage replaces them. When the name is already taken by another passage, or is a compiler special name (`StoryTitle`, `StoryData`, `StorySettings`, `StoryIncludes`), the file's passage gets the first free name of `name 2`, `name 3`, and so on. A passage from your Twee sources always keeps its name: if it comes after a file's passage with the same name, the file's passage moves to a free name. So `a/style.css` and `b/style.css` both reach the story, as `style.css` and `style.css 2`, and so do the scripts of several imported HTML files. Tweego instead lets the later of the two replace the earlier one.

Stories refer to media passages by name, so twee-ts warns when a media file gets a new name. Stylesheets and scripts are found by their tag, so their new names are not reported; Twine 2 output shows them only in the comments that separate several stylesheets or scripts. When nothing collides, the names are the file names.

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

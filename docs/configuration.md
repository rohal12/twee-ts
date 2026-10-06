# Configuration

twee-ts automatically loads `twee-ts.config.json` from the current working directory. Use `-c <file>` to specify a different path, or `--no-config` to skip loading entirely.

Paths in a config file (`sources`, `exclude`, `output`, `modules`, `headFile`, `formatPaths`) are relative to the folder that holds the config file, so `twee-ts -c proj/twee-ts.config.json` from the folder above `proj` builds `proj/src/`, not `src/`. Absolute paths, `"-"` (stdout) and an empty `headFile` are kept as they are. (Before 2.0 they were relative to the working directory; see [Migrating to 2.0](./migrating-to-2#config-paths-are-relative-to-the-config-file).) Paths given on the command line stay relative to the working directory.

## JSON Schema

The config file has a [JSON Schema](https://json-schema.org/) that provides autocompletion, validation, and inline documentation in editors like VS Code. Add a `$schema` key to enable it:

```json
{
  "$schema": "https://unpkg.com/@rohal12/twee-ts/schemas/twee-ts.config.schema.json",
  "sources": ["src/"],
  "output": "story.html"
}
```

The schema is also submitted to [SchemaStore](https://www.schemastore.org/), so editors that use SchemaStore will automatically associate `twee-ts.config.json` files with the schema — no `$schema` key needed.

## Minimal Config

```json
{
  "sources": ["src/"],
  "output": "story.html"
}
```

With this in place, run `npx @rohal12/twee-ts` with no arguments.

## Complete Reference

Every key, with its default. `sources` has none: name the sources here or on the command line. `formatId` and `startPassage` apply only where StoryData names no format or start passage, so leave them out to let StoryData decide.

```json
{
  "sources": ["src/"],
  "exclude": [],
  "output": "-",
  "outputMode": "html",
  "formatId": "sugarcube-2",
  "startPassage": "Start",
  "formatPaths": [],
  "formatIndices": [],
  "formatUrls": [],
  "useTweegoPath": true,
  "modules": [],
  "headFile": "",
  "trim": true,
  "twee2Compat": false,
  "testMode": false,
  "noRemote": false,
  "formatFetchTimeout": 30000,
  "tagAliases": {},
  "sourceInfo": false,
  "wordCountMethod": "tweego"
}
```

## Field Reference

### Sources & Output

| Key          | Type       | Default  | Description                                                                                                |
| ------------ | ---------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `sources`    | `string[]` | —        | Files or directories to compile. Directories are walked recursively. Required here or on the command line. |
| `exclude`    | `string[]` | `[]`     | Glob patterns for source files to leave out. See [Excluding files](#excluding-files).                      |
| `output`     | `string`   | `"-"`    | Output file path; `"-"` for stdout. Must not be empty.                                                     |
| `outputMode` | `string`   | `"html"` | One of `html`, `twee3`, `twee1`, `twine2-archive`, `twine1-archive`, `json`.                               |

Source directories are walked as on the command line: a symbolic link to a directory inside one is not followed, and the output file is never read as a source. See the [CLI Reference](./cli).

### Excluding files

Like Tweego, twee-ts loads every file it supports from `sources`: Twee, CSS, JavaScript, fonts, and images, audio and video, which become base64 media passages. To keep files out, such as artwork stored next to the passages that use it but served separately, list glob patterns in `exclude`:

```json
{
  "sources": ["src/story"],
  "exclude": ["src/story/**/*.png"]
}
```

- Each pattern is matched against a file's path relative to the working directory, the path `--log-files` prints, with Node's [`path.matchesGlob`](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern): `*` matches within one folder, `**` across folders, `{png,webp}` either name. A leading `./` is ignored. `*` and `**` don't match names that start with a dot. In a config file, a relative pattern is relative to the config file's folder; on the command line, to the working directory.
- The path is also matched as the real path relative to the working directory, so a pattern works whether the working directory or the sources are reached through a symbolic link (macOS's `/var` and `/private/var`, a linked project folder). A pattern that starts with `/` (or a drive letter) is matched against absolute paths.
- The file extension is matched without regard to letter case, as twee-ts reads `Photo.PNG` as a PNG image: `**/*.png` leaves it out. On a volume that ignores letter case (macOS and Windows by default), the whole path is.
- To leave out a folder, match the files in it: `src/story/art/**`.
- `**` doesn't reach outside the working directory. For sources outside it, start the pattern with the same `../` path: `../shared/**/*.png`.
- A file listed in `sources` directly is left out too if a pattern matches it. Modules and the head file are never left out.
- In watch mode and in the Vite plugin's dev server, changes to excluded files don't trigger a rebuild.
- `--exclude` on the command line replaces the config's list.

### Story Format

| Key                  | Type       | Default         | Description                                                                                                                           |
| -------------------- | ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `formatId`           | `string`   | `"sugarcube-2"` | Story format ID. Without it, StoryData's `format` and `format-version` decide, and `sugarcube-2` only when StoryData names none.      |
| `formatPaths`        | `string[]` | `[]`            | Extra format directories, which outrank `TWEEGO_PATH`.                                                                                |
| `formatIndices`      | `string[]` | `[]`            | `http:`/`https:` URLs of SFA-compatible `index.json` files, consulted after `formatUrls` and before the Story Formats Archive.        |
| `formatUrls`         | `string[]` | `[]`            | `http:`/`https:` URLs of `format.js` files, consulted after local formats and before `formatIndices`.                                 |
| `useTweegoPath`      | `boolean`  | `true`          | Also search the `TWEEGO_PATH` environment variable for formats.                                                                       |
| `noRemote`           | `boolean`  | `false`         | Disable remote format fetching entirely.                                                                                              |
| `formatFetchTimeout` | `number`   | `30000`         | Milliseconds each story format request may take before it fails with a warning and the next source is tried. `0` turns the limit off. |

### Compilation

| Key               | Type      | Default    | Description                                                                                                                                                            |
| ----------------- | --------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startPassage`    | `string`  | `"Start"`  | Name of the starting passage. Without it, StoryData's `start` decides, and `Start` only when StoryData names none.                                                     |
| `trim`            | `boolean` | `true`     | Trim leading and trailing whitespace from passage content, in Twee and HTML sources.                                                                                   |
| `twee2Compat`     | `boolean` | `false`    | Enable Twee2 syntax compatibility mode.                                                                                                                                |
| `testMode`        | `boolean` | `false`    | Enable test/debug mode (sets the `debug` option in story data).                                                                                                        |
| `sourceInfo`      | `boolean` | `false`    | Embed source file/line as `data-` attributes on passage elements.                                                                                                      |
| `wordCountMethod` | `string`  | `"tweego"` | Word counting: `"tweego"` (characters / 5 after NFKD normalization, matches Tweego) or `"whitespace"` (words between white space, after removing comments and markup). |

### Head Injection

| Key        | Type       | Default | Description                                                                                                                                                        |
| ---------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `modules`  | `string[]` | `[]`    | JS or CSS files to inject into the HTML `<head>`.                                                                                                                  |
| `headFile` | `string`   | `""`    | Path to a raw HTML file whose contents are appended to `<head>`; `""` for none. Keep it out of the source folders, where an `.html` file is read as a Twine story. |

See [Head Injection](./cli#head-injection) for where they go in a template without a closing head tag.

### Tag Aliases

| Key          | Type                     | Default | Description                                                                                |
| ------------ | ------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| `tagAliases` | `Record<string, string>` | `{}`    | Map custom tag names to canonical special tags. Both are non-empty and hold no whitespace. |

See the dedicated [Tag Aliases](./tag-aliases) page for full details and examples.

## CLI Override

CLI flags take precedence over config file values. For example:

```json
{
  "sources": ["src/"],
  "formatId": "sugarcube-2",
  "startPassage": "Begin"
}
```

```sh
# Overrides formatId to harlowe-3, keeps startPassage as Begin
twee-ts -f harlowe-3
```

For `tagAliases`, CLI `--tag-alias` flags are **merged** on top of config values, so you can set defaults in the config and add or override aliases per invocation. Every other list on the command line (`--exclude`, `-m`, `--format-url`, `--format-index`) replaces the config's. See [Precedence](./cli#precedence).

## Scaffolding

Run `npx @rohal12/twee-ts --init` to generate a starter config and source files:

```sh
npx @rohal12/twee-ts --init
```

This creates:

- `twee-ts.config.json` with `$schema`, `sources` (`["src/"]`) and `output` (`"story.html"`)
- `src/StoryData.tw` with a generated IFID
- `src/Start.tw` with a starter passage

and reports:

```
Initializing new twee-ts project...
Created:
  twee-ts.config.json
  src/StoryData.tw
  src/Start.tw

Run: npx @rohal12/twee-ts
```

Files that already exist are kept as they are and reported as skipped (`Skipped (already exists): src/Start.tw`), so running `--init` in an existing project never replaces your story or its IFID.

## Validation

twee-ts validates the config file on load. A value of the wrong type stops the build (exit status 1) with an error that lists every problem:

```
error: Invalid config in /path/to/twee-ts.config.json:
  "sources" must be an array.
  "trim" must be a boolean.
```

The config file is read as strict JSON; a file that is not is an error giving the line and column. A key given twice is a warning (`$.sources is given more than once; the last one is used.`), and the last one is used. The checks are those of the JSON Schema, which is generated from the same table twee-ts checks with, so the two agree.

A key the config does not define is ignored, so its option keeps the default. twee-ts warns about each one and the build goes on. When the key differs from a real one only in letter case, `-` or `_`, the warning names the real key:

```
warning: /path/to/twee-ts.config.json: Unknown config key "formatID" (did you mean "formatId"?); it is ignored.
```

`$schema` is always allowed.

The config file is read like any other text file: it may start with a byte order mark, be UTF-16 (as Windows PowerShell 5's `>` writes it) and use CRLF line endings. See [Text encoding](./getting-started#text-encoding).

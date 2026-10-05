# CLI Reference

```
twee-ts [options] <sources...>
```

Sources can be files or directories. Directories are walked recursively for supported file types.

## Options

### Input / Output

| Flag                  | Description                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-o, --output <file>` | Output file path. Defaults to stdout. The file is never read as a source, even inside a source folder.      |
| `-f, --format <id>`   | Story format ID (e.g. `sugarcube-2`, `harlowe-3`). Default: `sugarcube-2`.                                  |
| `-s, --start <name>`  | Starting passage name. Default: `Start`.                                                                    |
| `--exclude <glob>`    | Leave out source files matching a glob. Repeatable. See [Excluding files](./configuration#excluding-files). |

### Output Modes

| Flag                    | Description                                         |
| ----------------------- | --------------------------------------------------- |
| _(default)_             | Compile to playable HTML using a story format.      |
| `-d, --decompile-twee3` | Output as Twee 3 source.                            |
| `--decompile-twee1`     | Output as Twee 1 source.                            |
| `-a, --archive-twine2`  | Output as Twine 2 archive (XML, no format wrapper). |
| `--archive-twine1`      | Output as Twine 1 archive.                          |
| `--json`                | Output the story model as JSON.                     |

See [Output Modes](./output-modes) for details on each mode.

### Head Injection

| Flag                  | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `-m, --module <file>` | JS or CSS file to inject into `<head>`. Repeatable.    |
| `--head <file>`       | Raw HTML file whose contents are appended to `<head>`. |

### Compilation Behavior

| Flag                         | Description                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `--twee2-compat`             | Enable Twee2 syntax compatibility.                                               |
| `--no-trim`                  | Don't trim leading/trailing whitespace from passages, in Twee and HTML sources.  |
| `-t, --test`                 | Enable test/debug mode (sets `debug` option in story data).                      |
| `--tag-alias <alias=target>` | Map a custom tag to a special tag. Repeatable. See [Tag Aliases](./tag-aliases). |
| `--source-info`              | Emit source file and line as `data-` attributes on passage elements.             |

### Story Formats

| Flag                   | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `--list-formats`       | List all available story formats and exit.         |
| `--format-index <url>` | URL to an SFA-compatible `index.json`. Repeatable. |
| `--format-url <url>`   | Direct URL to a `format.js` file. Repeatable.      |
| `--no-remote`          | Disable remote format fetching.                    |

See [Format Discovery](./story-formats) for how formats are located.

### Linting

| Flag     | Description                                                             |
| -------- | ----------------------------------------------------------------------- |
| `--lint` | Lint story structure (broken links, dead ends, orphans) without output. |

Exits with code 1 if errors are found (broken links, a starting passage that is missing or would be left out of Twine 2 output, compilation errors). Warnings (dead ends, orphans) do not cause a non-zero exit.

Like a build, linting leaves the output file (`-o`, or `output` in the config file) out of the sources, so an earlier build inside a source folder is not linted.

Links are read from passage markup and, in script passages, only from JavaScript strings. Stylesheets (passages tagged `stylesheet`, and loaded `.css` files) are CSS, so bracketed text in them, such as `content: "[[Decorative]]"`, is not a link.

```sh
$ twee-ts --lint ./story/
Format: SugarCube 2.37.3
Passages: 42 total (38 story, 4 info), 12,345 words, 15 files
Start: Start

Broken links (1):
  Kitchen -> Pantry (passage "Pantry" does not exist)

Dead ends (2): Ending1, Ending2

Orphans (1): UnusedRoom

Lint failed.
```

### Watch & Logging

| Flag              | Description                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-w, --watch`     | Watch for file changes and rebuild automatically. Requires `-o`. A build with errors is reported, the output file keeps the last good build, and the watcher keeps running. See [Exit Status](#exit-status). |
| `-l, --log-stats` | Print passage count, word count, and file count after compilation.                                                                                                                                           |
| `--log-files`     | Print the list of input files after compilation.                                                                                                                                                             |

### Config & Project

| Flag                  | Description                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--init`              | Scaffold a new project with `twee-ts.config.json` and starter files. Existing files are kept, never overwritten. |
| `-c, --config <file>` | Path to config file. Default: `twee-ts.config.json` in cwd.                                                      |
| `--no-config`         | Skip loading the config file.                                                                                    |

### Meta

| Flag            | Description     |
| --------------- | --------------- |
| `-h, --help`    | Show help text. |
| `-v, --version` | Show version.   |

### Cache Management

Manage the local cache of downloaded remote story formats.

```
twee-ts cache <subcommand>
```

| Subcommand     | Description                                             |
| -------------- | ------------------------------------------------------- |
| `list`         | List cached formats with name, version, size, and date. |
| `clear`        | Delete all cached formats.                              |
| `clear <name>` | Delete cached formats matching a name.                  |
| `size`         | Show total cache size and format count.                 |
| `path`         | Print the cache directory path.                         |

```sh
$ twee-ts cache list
SugarCube         2.37.3       245K   2026-02-15
Harlowe           3.3.9        512K   2026-01-20
Chapbook          2.2.0        189K   2026-03-01

$ twee-ts cache size
Total: 946K (3 formats)

$ twee-ts cache clear Harlowe
Cleared 1 cached format.

$ twee-ts cache path
/home/user/.cache/twee-ts/storyformats
```

## Exit Status

| Code | Meaning                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Success. Warnings (for example, a duplicate passage) are printed to stderr but do not change the exit status.                        |
| `1`  | Failure: invalid arguments, a fatal error, or a compilation that reported at least one error. `--lint` also exits 1 on broken links. |

When a compilation reports errors (malformed Twee source, an invalid or missing IFID, a missing starting passage, and so on), twee-ts prints them to stderr, writes no output, and exits with status 1. The output file is left as it was, and nothing is written to stdout. This matches Tweego, which stops on these errors before writing output.

```sh
$ twee-ts -o story.html src/
error: line 12: Malformed twee source; unterminated tag block.
Compilation failed with 1 error; output not written.
$ echo $?
1
```

In watch mode (`-w`), a build with errors is reported but not written: the output file keeps the last build without errors, byte for byte, and the watcher keeps running, so you can fix the source and save again. The next build without errors is written as usual.

```sh
$ twee-ts -w -o story.html src/
Built: 12 passages, 3400 words
error: line 12: Malformed twee source; unterminated tag block.
Build has 1 error; output not written. Still watching for changes.
```

The programmatic API is unaffected: `compile()`, `compileToFile()` and `watch()` still return non-fatal errors in `result.diagnostics`, and `compileToFile()` and `watch()` still write every build to their output file. Check the diagnostics yourself if you need the CLI's behaviour.

## Examples

```sh
# Compile a directory to stdout
twee-ts src/

# Compile to a file with a specific format
twee-ts -o story.html -f harlowe-3 src/

# Decompile an HTML file back to Twee 3 source
twee-ts -d -o story.twee story.html

# Watch mode with stats logging
twee-ts -w -l -o story.html src/

# Leave images out of the story (quote globs so the shell doesn't expand them)
twee-ts --exclude 'src/**/*.png' --exclude 'src/**/*.jpg' -o story.html src/

# Use tag aliases from the CLI
twee-ts --tag-alias library=script --tag-alias theme=stylesheet -o story.html src/

# Compile with a remote format by direct URL
twee-ts --format-url https://example.com/my-format/format.js -o story.html src/

# Use a custom config file
twee-ts -c configs/production.json src/
```

## Precedence

When the same option is set in multiple places, the order of precedence is:

1. CLI flag (highest)
2. Config file (`twee-ts.config.json`)
3. `StoryData` passage in source files
4. Built-in default (lowest)

For example, `-s Prologue` on the CLI overrides `"startPassage": "Begin"` in the config, which overrides the `start` field in `StoryData`.

# CLI Reference

```
twee-ts [options] <sources...>
```

Sources can be files or directories. Directories are walked recursively for supported file types.

## Options

### Input / Output

| Flag                  | Description                                                                |
| --------------------- | -------------------------------------------------------------------------- |
| `-o, --output <file>` | Output file path. Defaults to stdout.                                      |
| `-f, --format <id>`   | Story format ID (e.g. `sugarcube-2`, `harlowe-3`). Default: `sugarcube-2`. |
| `-s, --start <name>`  | Starting passage name. Default: `Start`.                                   |

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
| `--no-trim`                  | Don't trim leading/trailing whitespace from passages.                            |
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

Exits with code 1 if errors are found (broken links, compilation errors). Warnings (dead ends, orphans) do not cause a non-zero exit.

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

| Flag              | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `-w, --watch`     | Watch for file changes and rebuild automatically. Requires `-o`.   |
| `-l, --log-stats` | Print passage count, word count, and file count after compilation. |
| `--log-files`     | Print the list of input files after compilation.                   |

### Config & Project

| Flag                  | Description                                                          |
| --------------------- | -------------------------------------------------------------------- |
| `--init`              | Scaffold a new project with `twee-ts.config.json` and starter files. |
| `-c, --config <file>` | Path to config file. Default: `twee-ts.config.json` in cwd.          |
| `--no-config`         | Skip loading the config file.                                        |

### Meta

| Flag            | Description     |
| --------------- | --------------- |
| `-h, --help`    | Show help text. |
| `-v, --version` | Show version.   |

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

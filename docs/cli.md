# CLI Reference

```
twee-ts [options] <sources...>
```

Sources can be files or directories. Directories are walked recursively for supported file types, in code-point order of their entries on every operating system, so which of two passages with the same name wins doesn't depend on the OS. Inside a source directory, a symbolic link to a file is read, but a link to a directory is not followed, as in Tweego, so a link back to a parent can't make the walk read the same files again and again. A directory named as a source is followed even when it is a link; name a linked directory as a source to include it. The same file reached by two paths (a link and its target, say) is read once.

The command line is checked before anything is read or written. An unknown option, an option without its value or with an empty one, an option given twice (other than those marked repeatable), two options that conflict (two output modes, `--lint` with `--watch`, `-c` with `--no-config`) and an invalid `--tag-alias` are usage errors: twee-ts prints `error: …` and a pointer to `--help`, and exits with status 2. Sources whose names start with `-` go after `--`. `cache` is a subcommand only as the first word; to build a folder named `cache`, write `./cache` or put it after `--`.

Tweego's `-c`/`--charset` and `--list-charsets` are not supported: sources are read as UTF-8, or as UTF-16 after a UTF-16 byte order mark, and a file that is not valid UTF-8 as Windows-1252, as Tweego does by default. Here `-c` means `--config`; when it names a file that doesn't exist and looks like a charset, the error says so. Tweego's deprecated `--decompile` is accepted as `--decompile-twee3`.

## Options

### Input / Output

| Flag                  | Description                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-o, --output <file>` | Output file path; `-` (the default) for stdout. The file is never read as a source.                         |
| `-f, --format <id>`   | Story format ID (e.g. `sugarcube-2`, `harlowe-3`). Default: `sugarcube-2`.                                  |
| `-s, --start <name>`  | Starting passage name. Default: `Start`.                                                                    |
| `--exclude <glob>`    | Leave out source files matching a glob. Repeatable. See [Excluding files](./configuration#excluding-files). |

### Output safety

A build never writes over one of its inputs, in any output mode. The output is compared with every input by identity: its real path (links followed, dangling ones too), compared without letter case on a volume that ignores case, and by inode, so a hard link to an input counts as that input.

- Naming the output as a source, a module, the head file or the config file is an error (`path a.tw: Output file cannot be an input source.`, or `… (the head file).` and so on, exit status 1), and nothing is written. So is an output that is the story format's file.
- An output inside a source (or module) folder is left out of the sources, so an earlier build there is never read back. If a file is already there that the walk would load (a `.tw`, `.html`, `.css` file and so on), it is written over only when it is an earlier twee-ts build (Twine 2 HTML, archives and JSON carry the mark `creator="Twee-ts"`; Twee output carries none) or one this process wrote; otherwise it is the author's own file and the build stops with an error. Move the output out of the folder, or leave the file out with `--exclude`.

How the output is written depends on what is there:

| Target                                                                        | Written                                                                                                                             |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| nothing, or a regular file                                                    | atomically: a temporary file next to it, renamed into place, so a reader never sees part of a build; the file keeps its permissions |
| a regular file with more than one hard link                                   | in place, so every link sees the new build                                                                                          |
| a read-only file                                                              | refused (EACCES), as Tweego refuses it                                                                                              |
| a symbolic link                                                               | the file it finally points to, as above; the link stays                                                                             |
| `/dev/null`, a FIFO, a terminal, `/dev/stdout`, `/dev/fd/N`, `NUL` on Windows | written through, as a stream                                                                                                        |
| a folder, a socket, a block device                                            | refused                                                                                                                             |

On Windows, a rename over a file another program holds open (an antivirus scanner, a live-reload server) is retried for about 0.6 s.

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

The modules and the head file go on their own lines before the story format template's closing head tag, as in Tweego. HTML lets a document leave that tag out, so a template without one gets them before its body start tag instead (which the browser still reads as part of the head), with a warning; a template with neither gets nothing, with a warning. Tweego drops them from such templates without a word.

A font module (`.ttf`, `.otf`, `.woff`, `.woff2`) becomes an `@font-face` rule whose `font-family` is the file name without its extension, written as a CSS string, so quotes, backslashes and line breaks in the name are escaped.

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
| `--list-formats`       | List the format IDs `--format` accepts, and exit.  |
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

A link is broken when no passage has its name, or when its passage is one that Twine 2 output leaves out: a passage tagged `script`, `stylesheet` or `Twine.private`, StoryData, StoryTitle, or an empty StorySettings. The passage exists in the source but not in the playable story, so the link fails when it is clicked. The report says why. Links to special passages that the output keeps, such as StoryInit, PassageHeader or a `widget` passage, are valid.

Links are read from passage markup and, in script passages, only from JavaScript strings. JavaScript is read with a JavaScript parser, so a regular expression or a comment is never taken for a string; code that does not parse, such as TwineScript, is read exactly up to the error and token by token after it. Story JavaScript and `<<script>>` bodies are read as strict-mode code and `<script>` elements as sloppy-mode code, so an octal escape such as `\74` counts only in a `<script>` element. Stylesheets (passages tagged `stylesheet`, and loaded `.css` files) are CSS, so bracketed text in them, such as `content: "[[Decorative]]"`, is not a link. Passages that Twine 2 output leaves out never reach the player, so no links are read from `Twine.private` passages, StoryData or StoryTitle: a link in a private notes passage is not a broken link, and it does not keep a passage from being listed as an orphan. Script passages are still read, because Twine 2 output runs them.

```sh
$ twee-ts --lint ./story/
Format: SugarCube 2.37.3
Passages: 42 total (38 story, 4 info), 12,345 words, 15 files
Start: Start

Broken links (2):
  Kitchen -> Pantry (passage "Pantry" does not exist)
  Kitchen -> Notes (passage "Notes" is tagged "Twine.private", so it is left out of the story data)

Dead ends (2): Ending1, Ending2

Orphans (1): UnusedRoom

Lint failed.
```

### Watch & Logging

| Flag              | Description                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-w, --watch`     | Watch for file changes and rebuild automatically. Requires `-o`. A build with errors is reported, the output file keeps the last good build, and the watcher keeps running. A source folder that doesn't exist yet is waited for, and one that is deleted and created again is followed. See [Exit Status](#exit-status). |
| `-l, --log-stats` | Print passage count, word count, and file count to stderr after compilation, and after every build in watch mode.                                                                                                                                                                                                         |
| `--log-files`     | Print the source files read to stderr (and, as Tweego's "External files", the modules and head file) after compilation, and after every build in watch mode.                                                                                                                                                              |

### Config & Project

| Flag                  | Description                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--init`              | Scaffold a new project with `twee-ts.config.json` and starter files. Existing files are kept, never overwritten. |
| `-c, --config <file>` | Path to config file. Default: `twee-ts.config.json` in cwd. Paths in it are relative to its folder.              |
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
| `clear <name>` | Delete cached formats with a name (any letter case).    |
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

The cache keeps each download for the format index or format URL it came from; see [The Download Cache](./story-formats#the-download-cache).

## Output Streams

Standard output carries only what was asked for: the story, when no output file is given (`-o -`), or the answer of a query (`--help`, `--version`, `--list-formats`, the `cache` subcommands, the `--lint` report, the `--init` report). Everything else goes to standard error: warnings and errors, `--log-stats`, `--log-files`, and watch mode's messages. So `twee-ts -d -l src/ > story.tw` writes exactly the story to `story.tw`, the same bytes `-o story.tw` would. A reader that closes the pipe early (`twee-ts src/ | head`) ends the output quietly.

## Exit Status

| Code | Meaning                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success. Warnings (for example, a duplicate passage) are printed to stderr but do not change the exit status.                                  |
| `1`  | Failure: a fatal error, an input that can't be used, or a compilation that reported at least one error. `--lint` also exits 1 on broken links. |
| `2`  | Usage error: the command line itself can't be run (see above). Nothing is read or written.                                                     |

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

A fatal error, such as a story format that is not available, is printed with the diagnostics that explain it, in one-shot and watch mode:

```sh
$ twee-ts --no-remote -f nosuch-9 -o story.html src/
error: Story format "nosuch-9" is not available (remote fetching disabled). Found: sugarcube-2
No story format available for HTML output.
```

The output file is written as [Output safety](#output-safety) describes: a regular file is replaced atomically, so a live-reload server or browser that reads it never sees part of a build, and a failed write leaves the previous build.

The programmatic API is unaffected: `compile()`, `compileToFile()` and `watch()` still return non-fatal errors in `result.diagnostics`, and `compileToFile()` and `watch()` still write every build to their output file. Check the diagnostics yourself if you need the CLI's behaviour.

Watch mode waits for a source folder (or file, module or head file) that doesn't exist yet, and builds it once it appears; one that is deleted, or renamed away and replaced, is followed to the new one at its path. A file named through a symbolic link is watched where the link leads, and so is every link on the way: editing or replacing the target, or pointing the link elsewhere, rebuilds. So does a file a source folder reaches through a link to outside it. A folder created, deleted, moved in or out, or renamed under a watched folder rebuilds too, so its passages come and go with it. A build starts half a second after changes stop, but no later than a second after the first one, so a steady stream of changes still builds.

A path that can't be watched, such as a folder twee-ts may not read, is reported as `error: Cannot watch <path>: <reason>` and tried again on the next change in the folder above it, while the other paths are still watched. If nothing is left to watch, twee-ts exits with status 1. An error no edit to the sources can fix (the output is an input) stops watch mode with status 1, as Tweego stops.

## Inputs That Can't Be Used

What happens to an input that can't be used depends on its role and on how it was found: named on the command line or in the config (named), or found walking a named folder (found). One table decides it for every role, the same in the API:

| Failure                                             | Source or module, named                                                   | Source or module, found in a folder            | Head file                  | Config file                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------- | ------------------------------------------------------- |
| missing                                             | warning (`path a.tw: ENOENT…`)                                            | warning (it went away after the walk)          | fatal                      | fatal (`-c`); none when `twee-ts.config.json` is absent |
| unreadable                                          | error                                                                     | error                                          | fatal                      | fatal                                                   |
| a folder that can't be listed                       | warning                                                                   | warning                                        | —                          | —                                                       |
| a folder where a file is needed                     | error                                                                     | error                                          | fatal                      | fatal                                                   |
| a dangling symbolic link                            | warning                                                                   | skipped without a word (an editor's lock file) | fatal                      | fatal                                                   |
| a file type the role doesn't load                   | warning (`… Not a supported source file type (extension .twe); skipped.`) | skipped without a word                         | read whatever its type     | read whatever its type                                  |
| a FIFO, device or socket                            | warning                                                                   | skipped without a word                         | read (`--head <(…)` works) | read                                                    |
| text that can't be decoded (invalid UTF-16, UTF-32) | error                                                                     | error                                          | fatal                      | fatal                                                   |

A warning is printed and the build goes on. An error is reported with the other diagnostics, and the CLI writes nothing and exits with 1. A fatal problem stops the build before anything is written. Tweego decides the same where it decides: its walk skips links and unknown types in folders and warns about a path it can't walk, and it stops on a head file it can't read. Messages name the role, the path and the cause: `load head file h.html: ENOENT: no such file or directory, open 'h.html'`, `load module secret.js: EACCES: …`.

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

# Use a custom config file (its paths are relative to configs/)
twee-ts -c configs/production.json src/
```

## Precedence

When the same option is set in multiple places, the order of precedence is:

1. CLI flag (highest)
2. Config file (`twee-ts.config.json`)
3. `StoryData` passage in source files
4. Built-in default (lowest)

For example, `-s Prologue` on the CLI overrides `"startPassage": "Begin"` in the config, which overrides the `start` field in `StoryData`.

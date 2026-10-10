# CLI Reference

```
twee-ts [options] <sources...>
```

Sources can be files or directories. Directories are walked recursively for supported file types, in code-point order of their entries on every operating system, so which of two passages with the same name wins doesn't depend on the OS. Inside a source directory, a symbolic link to a file is read (Tweego skips it), but a link to a directory is not followed, as in Tweego, so a link back to a parent can't make the walk read the same files again and again. A directory named as a source is followed even when it is a link; name a linked directory as a source to include it. The same file reached by two paths (a link and its target, say) is read once.

The command line is checked before anything is built or written. These are usage errors: twee-ts prints `error: …` and a pointer to `--help`, and exits with status 2.

- an unknown option, an option without its value or with an empty one (also `cache clear ""`, which never means "everything"), an option that takes no value given one (`-d=x`), and an option given twice (other than those marked repeatable)
- options that conflict: two output modes (`-d --json`), `--lint` with `--watch`, `--log-stats`, `--log-files` or an output mode, `-c` with `--no-config`, and `--version`, `--init` or `--list-formats` with anything else (`--list-formats` takes `-c` or `--no-config`)
- an invalid `--tag-alias` or `--word-count-method`
- no sources, neither on the command line nor in the config
- watch mode without an output file (`-o`, or `output` in the config), or with `-o -`
- `cache` with options or extra arguments

Sources whose names start with `-` go after `--`. `cache` is a subcommand only as the first word; to build a folder named `cache`, write `./cache` or put it after `--`. `-h` and `--help` win over every other option: with one of them before any `--` (and not as the value of another option), twee-ts prints the help and exits with status 0, whatever else is on the line, even a malformed option. A short option takes its value as `-o file`, `-ofile` or, as in Tweego, `-o=file`; the long form is `--output=file`.

Tweego's `--charset` and `--list-charsets` are not supported, and are usage errors that say so: sources are read as UTF-8, or as UTF-16 after a UTF-16 byte order mark, and a file that is not valid UTF-8 as Windows-1252, as Tweego does by default. Here `-c` means `--config`; when it names a file that doesn't exist and looks like a charset (`-c utf-8`), the error (exit status 1) adds a note that says so. Tweego's deprecated `--decompile` is accepted as `--decompile-twee3`.

## Options

### Input / Output

| Flag                  | Description                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-o, --output <file>` | Output file path; `-` (the default) for stdout. The file is never read as a source.                         |
| `-f, --format <id>`   | Story format ID (e.g. `sugarcube-2`, `harlowe-3`). Default: StoryData's `format`, else `sugarcube-2`.       |
| `-s, --start <name>`  | Starting passage name. Default: StoryData's `start`, else `Start`.                                          |
| `--exclude <glob>`    | Leave out source files matching a glob. Repeatable. See [Excluding files](./configuration#excluding-files). |

### Output safety

A build never writes over one of its inputs, in any output mode. The output is compared with every input by identity: its real path (links followed, dangling ones too), compared without letter case on a volume that ignores case, and by inode, so a hard link to an input counts as that input.

- Naming the output as a source, a module, the head file or the config file is an error (`path a.tw: Output file cannot be an input source.`, or `… (the head file).` and so on, exit status 1), and nothing is written. So is an output that is the story format's file.
- An output inside a source (or module) folder is left out of the sources, so an earlier build there is never read back. If a file is already there that the walk would load (a `.tw`, `.html`, `.css` file and so on), it is written over only when it is an earlier twee-ts build (Twine 2 HTML, archives and JSON carry the mark `creator="Twee-ts"`; Twee output carries none) or one this process wrote; otherwise it is the author's own file and the build stops with an error. Move the output out of the folder, or leave the file out with `--exclude`.

How the output is written depends on what is there:

| Target                                                                                                            | Written                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| nothing, or a regular file                                                                                        | atomically: a temporary file next to it, renamed into place, so a reader never sees part of a build; the file keeps its permissions |
| a regular file with more than one hard link                                                                       | in place, so every link sees the new build                                                                                          |
| a writable file in a folder that takes no new file or rename (a read-only folder, a file bind-mounted on its own) | in place, as Tweego writes it; not atomic                                                                                           |
| a read-only file                                                                                                  | refused (EACCES), as Tweego refuses it                                                                                              |
| a symbolic link                                                                                                   | the file it finally points to, as above; the link stays                                                                             |
| `/dev/null`, a FIFO, a terminal, `/dev/stdout`, `/dev/fd/N`, `NUL` on Windows                                     | written through, as a stream                                                                                                        |
| a folder, a socket, a block device                                                                                | refused                                                                                                                             |
| nothing, in a folder that does not exist                                                                          | refused (ENOENT); the folder is not created                                                                                         |

An output that is refused fails a build (not watch mode, where a later build may find the folder) before the sources are read, and the error names the output path given (`Cannot write out/story.html: ENOENT: the folder out does not exist`), never the temporary file. On Windows, a rename over a file another program holds open (an antivirus scanner, a live-reload server) is retried for about 0.6 s.

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

Twine 1 output (HTML and archive) is stamped with the build time. Set `SOURCE_DATE_EPOCH` (whole seconds since 1970, UTC, as the [Reproducible Builds](https://reproducible-builds.org/specs/source-date-epoch/) project defines it) to build the same bytes every time. A value that is not such a number, or is after 9999-12-31T23:59:59Z (`253402300799`), the last time Twine 1 can record, fails a Twine 1 build; other output never reads the variable.

### Head Injection

| Flag                  | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `-m, --module <file>` | JS or CSS file to inject into `<head>`. Repeatable.    |
| `--head <file>`       | Raw HTML file whose contents are appended to `<head>`. |

The modules and the head file go on their own lines before the story format template's closing head tag, as in Tweego. twee-ts finds that tag the way a browser does, by parsing the template as HTML, so a look-alike in a comment, a script, an attribute value or template content is left alone. HTML lets a document leave the closing head tag out, so in a template without one (or whose head ends before it, at body content) they go where the head ends instead, with a warning; in a template with no head start tag either, where the browser creates the head. Only a template with no such place (one that is all an unclosed comment) gets nothing, with a warning. Tweego drops them from templates without a closing head tag without a word.

When the head file content does not stay in the head (it holds text or body elements, or leaves a comment, element or attribute open, which changes how the rest of the page is read), it is still injected, with a warning.

A font module (`.ttf`, `.otf`, `.woff`, `.woff2`) becomes an `@font-face` rule whose `font-family` is the file name up to its first dot (`My.Font.woff2` gives `My`), written as a CSS string, so quotes, backslashes and line breaks in the name are escaped.

Each module element gets an id from its file name up to its first dot, as in Tweego: `script-module-ui` for `ui.js`, `style-module-ui` for `ui.css` and for a font `ui.woff2` (each run of spaces, control characters and ASCII punctuation other than `_` becomes one `_`). When an earlier module already has that id (`lib/ui.js` and `vendor/ui.js`, or `ui.css` and `ui.woff2`), the later one gets `-2`, `-3` and so on after it (`script-module-ui-2`), with a warning, so the ids in the page stay unique. Tweego gives both the same id.

### Compilation Behavior

| Flag                         | Description                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `--twee2-compat`             | Enable Twee2 syntax compatibility.                                               |
| `--no-trim`                  | Don't trim leading/trailing whitespace from passages, in Twee and HTML sources.  |
| `-t, --test`                 | Enable test/debug mode (sets `debug` option in story data).                      |
| `--tag-alias <alias=target>` | Map a custom tag to a special tag. Repeatable. See [Tag Aliases](./tag-aliases). |
| `--source-info`              | Emit source file and line as `data-` attributes on passage elements.             |
| `--word-count-method <m>`    | Word counting for `--log-stats` and lint: `tweego` (default) or `whitespace`.    |

### Story Formats

| Flag                          | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `--list-formats`              | List the format IDs `--format` accepts, and exit.                                 |
| `--format-index <url>`        | URL to an SFA-compatible `index.json`. Repeatable.                                |
| `--format-url <url>`          | Direct URL to a `format.js` file. Repeatable.                                     |
| `--no-remote`                 | Disable remote format fetching.                                                   |
| `--no-default-format-indices` | Don't ask the Story Formats Archive; only the configured format URLs and indices. |

See [Format Discovery](./story-formats) for how formats are located.

### Linting

| Flag     | Description                                                             |
| -------- | ----------------------------------------------------------------------- |
| `--lint` | Lint story structure (broken links, dead ends, orphans) without output. |

Exits with code 1 if errors are found (broken links, a missing or empty story title, a starting passage that is missing or would be left out of Twine 2 output, compilation errors, and the errors Twine 2 HTML output gives about the story's own data, such as text HTML cannot carry: U+0000 or a lone surrogate, or a story option with white space, and what it reports about the modules and the head file: a module that cannot be used, or text HTML cannot carry in one). A head file that cannot be read stops lint, as it stops a build. Warnings (dead ends, orphans) do not cause a non-zero exit. The report goes to standard output; the compilation's warnings and errors are part of it, in a `Diagnostics:` section, when there are any. Its `Format:` line is the format StoryData names. The report is the same in every locale: counts are grouped in thousands with commas (`241,676 words`).

Like a build, linting leaves the output file (`-o`, or `output` in the config file) out of the sources, so an earlier build inside a source folder is not linted.

A link is broken when no passage has its name, or when its passage is one that Twine 2 output leaves out: a passage tagged `script`, `stylesheet` or `Twine.private`, StoryData, StoryTitle, or an empty StorySettings. The passage exists in the source but not in the playable story, so the link fails when it is clicked. The report says why. Links to special passages that the output keeps, such as StoryInit, PassageHeader or a `widget` passage, are valid.

Links are read from passage markup and, in script passages, only from JavaScript strings. JavaScript is read with a JavaScript parser, so a regular expression or a comment is never taken for a string; code that does not parse, such as TwineScript, is read exactly up to the error and token by token after it. Story JavaScript and `<<script>>` bodies are read as strict-mode code and `<script>` elements as sloppy-mode code, so an octal escape such as `\74` counts only in a `<script>` element. Stylesheets (passages tagged `stylesheet`, and loaded `.css` files) are CSS, so bracketed text in them, such as `content: "[[Decorative]]"`, is not a link. Passages that Twine 2 output leaves out never reach the player, so no links are read from `Twine.private` passages, StoryData or StoryTitle: a link in a private notes passage is not a broken link, and it does not keep a passage from being listed as an orphan. Script passages are still read, because Twine 2 output runs them.

<!-- docs-test: fixture=lint exit=1 output -->

```sh
$ twee-ts --lint src/
Format: SugarCube 2.37.3
Passages: 8 total (5 story, 3 info), 27 words, 5 files
Start: Start

Broken links (2):
  Kitchen -> Pantry (passage "Pantry" does not exist)
  Kitchen -> Notes (passage "Notes" is tagged "Twine.private", so it is left out of the story data)

Dead ends (2): Ending1, Ending2

Orphans (1): UnusedRoom

Lint failed.
```

### Watch & Logging

| Flag              | Description                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-w, --watch`     | Watch for file changes and rebuild automatically. Requires an output file (`-o`, or `output` in the config). A build with errors is reported, the output file keeps the last good build, and the watcher keeps running. A source folder that doesn't exist yet is waited for, and one that is deleted and created again is followed. See [Exit Status](#exit-status). |
| `-l, --log-stats` | Print passage count, word count, and file count to stderr after compilation, and after every build in watch mode.                                                                                                                                                                                                                                                     |
| `--log-files`     | Print the source files read to stderr (and, as Tweego's "External files", the modules injected and the head file) after compilation, and after every build in watch mode.                                                                                                                                                                                             |

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

| Subcommand     | Description                                            |
| -------------- | ------------------------------------------------------ |
| `list`         | List cached formats with name, version, size and date. |
| `clear`        | Delete all cached formats.                             |
| `clear <name>` | Delete cached formats with a name (any letter case).   |
| `size`         | Show total cache size and format count.                |
| `path`         | Print the cache directory path.                        |

```sh
$ twee-ts cache list
SugarCube        2.37.3       245K   2026-02-15
Harlowe          3.3.9        512K   2026-01-20
Chapbook         2.2.0        189K   2026-03-01

$ twee-ts cache size
Total: 946K (3 formats)

$ twee-ts cache clear Harlowe
Cleared 1 cached format.

$ twee-ts cache path
/home/user/.cache/twee-ts/storyformats
```

The date is when the format was downloaded. With nothing cached, `list` prints `No cached formats.`, `size` prints `Cache is empty.` and `clear` prints `Cache is already empty.` (or `No cached formats matching "Harlowe".`). The cache keeps each download for the format index or format URL it came from, and `list` does not say which; see [The Download Cache](./story-formats#the-download-cache) and `listCachedFormats()` in the [API](./api#remote-formats).

## Output Streams

Standard output carries only what was asked for: the story, when no output file is given (`-o -`), or the answer of a query (`--help`, `--version`, `--list-formats`, the `cache` subcommands, the `--lint` report, the `--init` report). Everything else goes to standard error: warnings and errors (except under `--lint`, whose report lists them), `--log-stats`, `--log-files`, and watch mode's messages. So `twee-ts -d -l src/ > story.tw` writes exactly the story to `story.tw`, the same bytes `-o story.tw` would. A reader that closes the pipe early (`twee-ts src/ | head`) ends the output quietly. Any other failure to write there (a full disk behind `> story.html`, an I/O error) prints `error: Cannot write standard output: <reason>` and ends with status 1; a failure of standard error itself only sets the status.

A warning or error about a source names the file and line, as `src/Start.tw:4: …` (a message that already names its file, such as `load src/a.tw: line 3: …`, is printed as it is), in the build output and in the `--lint` report. Warnings of Node itself (such as an experimental feature) are printed as Node prints them, and `NODE_NO_WARNINGS` and `--no-warnings` silence them.

## Exit Status

| Code | Meaning                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success. Warnings (for example, a duplicate passage) are printed to stderr but do not change the exit status.                                  |
| `1`  | Failure: a fatal error, an input that can't be used, or a compilation that reported at least one error. `--lint` also exits 1 on broken links. |
| `2`  | Usage error: the command line itself can't be run (see above). Nothing is built or written.                                                    |

When a compilation reports errors (malformed Twee source, an invalid IFID or a missing one in Twine 2 output, a missing starting passage, and so on), twee-ts prints them to stderr, writes no output, and exits with status 1. The output file is left as it was, and nothing is written to stdout. This matches Tweego, which stops on these errors before writing output.

<!-- docs-test: fixture=broken exit=1 output -->

```sh
$ twee-ts -o story.html src/
error: src/Start.tw:4: Malformed twee source; unterminated tag block.
Compilation failed with 1 error; output not written.
$ echo $?
1
```

In watch mode (`-w`), a build with errors is reported but not written: the output file keeps the last build without errors, byte for byte, and the watcher keeps running, so you can fix the source and save again. The next build without errors is written as usual.

<!-- docs-test: fixture=broken output -->

```sh
$ twee-ts -w -o story.html src/
Watch mode started. Press CTRL+C to stop.
Built: 3 passages, 3 words
error: src/Start.tw:4: Malformed twee source; unterminated tag block.
Build has 1 error; output not written. Still watching for changes.
```

Every build reports its `Built:` line first, then its warnings and errors.

A fatal error, such as a story format that is not available, is printed with the diagnostics that explain it, in one-shot and watch mode:

<!-- docs-test: exit=1 output -->

```sh
$ twee-ts --no-remote -f nosuch-9 -o story.html src/
error: Story format "nosuch-9" is not available (remote fetching disabled). Found: harlowe-3, sugarcube-2.
error: No story format available for HTML output.
```

In watch mode the last line is `Build error: No story format available for HTML output.`, and the watcher keeps running.

The output file is written as [Output safety](#output-safety) describes: a regular file is replaced atomically, so a live-reload server or browser that reads it never sees part of a build, and a failed write leaves the previous build.

The programmatic API is unaffected: `compile()`, `compileToFile()` and `watch()` still return non-fatal errors in `result.diagnostics`, and `compileToFile()` and `watch()` still write every build to their output file. Check the diagnostics yourself if you need the CLI's behaviour.

Watch mode waits for a source folder (or file, module or head file) that doesn't exist yet, and builds it once it appears; one that is deleted, or renamed away and replaced, is followed to the new one at its path. A file named through a symbolic link is watched where the link leads, and so is every link on the way: editing or replacing the target, or pointing the link elsewhere, rebuilds. So does a file a source folder reaches through a link to outside it. A folder created, deleted, moved in or out, or renamed under a watched folder rebuilds too, so its passages come and go with it. A build starts half a second after changes stop, but no later than a second after the first one, so a steady stream of changes still builds.

A path that can't be watched, such as a folder twee-ts may not read, is reported as `error: Cannot watch <path>: <reason>` and tried again on the next change in the folder above it, while the other paths are still watched. If nothing is left to watch, twee-ts exits with status 1. An error no edit to the sources can fix (the output is an input, an option out of range) stops watch mode with status 1, as Tweego stops.

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

A source or module given twice, under the same path or another spelling of it (a link, a folder that holds it), is loaded once, and every repeat is skipped with a warning, as in Tweego: `load module a.js: Skipping duplicate.` Only the modules injected, and the head file, are listed as `External files` (`stats.externalFiles`). The config file found in the working directory is no config only when nothing is at its path; a dangling link there is fatal, as the table says.

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

A command-line option overrides the same setting in the config file, which overrides the built-in default. `--tag-alias` adds to the config's `tagAliases` instead (a CLI alias wins over the config's for the same tag); every other repeatable option (`--exclude`, `-m`, `--format-url`, `--format-index`) replaces the config's list.

The start passage and the story format can also come from the `StoryData` passage, which ranks between the config and the default:

1. CLI flag (highest)
2. Config file (`twee-ts.config.json`)
3. `StoryData` passage in source files (`start`; `format` and `format-version`)
4. Built-in default (`Start`; `sugarcube-2`) (lowest)

An output mode flag (`-d`, `--decompile-twee1`, `--json`, `-a`, `--archive-twine1`) changes the format of the output, not where it goes: the `output` path from the config file still applies unless `-o` is given. With `"output": "story.html"` in the config, `twee-ts -d src/` writes Twee 3 source into `story.html`. Give `-o` (`-o -` for standard output) to write elsewhere.

For example, `-s Prologue` on the CLI overrides `"startPassage": "Begin"` in the config, which overrides the `start` field in `StoryData`. `-t` adds the `debug` option to those StoryData gives; `"testMode": false` doesn't remove one StoryData sets.

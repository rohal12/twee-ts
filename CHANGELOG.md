# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The Rollup plugin and the Vite plugin's build no longer overwrite an authored file at the story's path inside a source folder: an existing Twine HTML file or other file of a type the sources load, which twee-ts did not build, fails the build with `OUTPUT_IS_INPUT` (naming the file), as the command line, `compileToFile()` and `watch()` do; an earlier build of the story is still written over. Chunks and assets stay the bundler's to write, since an earlier build's chunk cannot be told from a file of yours, and the dev server, which writes nothing, is unaffected (#402)
- `tweeTsPlugin()` of the Vite plugin throws a `TweeTsError` (`INVALID_OPTIONS`) that names twee-ts and the Vite version under a Vite older than 8 (a forced install past the peer dependency), instead of Vite's `Could not resolve entry module "index.html"`; the `entry`-before-Vite-8 and newer-Node.js claims in the docs and `TweeTsErrorCode` are replaced by what the code does (#368)
- `compileIncremental()` no longer replays a stale cache entry of a file another path to the same file shadowed while it changed (a source replaced by a link to another source, the target edited, then the link replaced by a file): a path skipped as a duplicate keeps no cache entry, so it is read again once it loads; a property test checks incremental builds against `compile()` for any sequence of writes, edits through links and relinks (#400)
- An in-memory source of a type in-memory sources don't load (anything but Twee, CSS and JavaScript) is skipped with its one warning; its content is no longer decoded first, which added a Windows-1252 warning for binary content (#404)
- A module given twice (`-m a.js -m a.js`, the same file under another spelling, or named and found in a module folder) is skipped with a warning, `load module a.js: Skipping duplicate.`, as Tweego and twee-ts do for sources, instead of silently (#391)
- `stats.externalFiles` and `--log-files`' `External files:` list only the modules injected into the head (and the head file), as Tweego does: a module of a type modules don't load (`readme.txt`, `img.png` in a module folder), one that could not be read and a duplicate are no longer listed (#391, #398)
- A Twine 1 format's optional `userlib.js` or `footer.html` that is there but can't be used (a file it may not read, a folder, a link loop, text that can't be decoded) stops the build with `FORMAT_UNAVAILABLE` (`Format component cannot be read: …`), as Tweego stops, instead of leaving `"USER_LIB"` in the output or using the default footer without a word; only a missing file (or a dangling link) is done without, as before (#399)
- A `twee-ts.config.json` in the working directory that is a dangling symbolic link, a link loop or in a folder that can't be searched is fatal, as the input policy says, instead of being taken for no config; only nothing at the path means no config (#395)
- The command line prints `Watch mode started` only once watch mode has started: a watch that cannot start (an output that is an authored file in a source folder, an option out of range) printed the message first and the error after it (#403)
- The command line and the `--lint` report name the file and line of every warning and error about a source (`error: src/bad.tw:1: Malformed twee source; …`, the dangling-backslash warning, duplicate passages), where the parser's messages named only the line and a 600-file project gave no way to find the file; a message that already names its file (`load a.tw: line 3: …`) is not given a second prefix, and the build plugins no longer repeat the file either (#394)
- `-o=file` (and `-f=`, `-s=`, `-m=`, `-c=` and the other short options that take a value) means `-o file`, as in Tweego, instead of a file literally named `=file`; a short option that takes no value refuses one (`-d=x` is a usage error) (#385)
- `-h` and `--help` win over every other option, as the documentation says, also over unknown options, missing or empty values and options given twice (`twee-ts --help --bogus`, `-o a -o b -h`); after `--` they are sources as before (#382)
- A failure to write to standard output other than a closed pipe (`twee-ts -o - story.twee > /dev/full`) prints `error: Cannot write standard output: …` and exits with status 1 instead of ending in an uncaught-exception stack trace; a failure of standard error sets the exit status 1 (#374)
- The command line no longer replaces Node's handling of warnings: `NODE_NO_WARNINGS` and `--no-warnings` silence them again (the Node 22 special case it served is gone with the Node 24 requirement) (#373)
- `twee-ts cache clear ""` is a usage error (exit status 2) instead of clearing the whole download cache, and `clearCachedFormats('')` clears no format: only no name at all means every format (#366)
- `watch()` rejects with `OUTPUT_IS_INPUT` before watching anything when `outFile` is an existing file of a source or module type inside a source or module folder that twee-ts did not build (the migration guide's `outFile: 'src/Start.tw'`), as its documentation says and as it already did for a named source: the check ran in the first build, where the error stopped the watch without a word when no `onError` was given (#363)
- The Vite dev server keeps serving the files of the page it still serves while the story fails to compile: after a successful `entry` bundle followed by a failed story compile (an edit to a module while the Twee source has a syntax error), the retained page's hashed worker returned 404 and its `?no-inline` files changed under it, because the files of the new bundle replaced the old ones; they now stay those of the bundle the served story was compiled with until a story compiles with the new one, with the watcher on or off, and the collision check against other plugin instances reads the files actually served (#360)
- The Vite development server serves `compileOptions.outputMode` other than `html` as compiled, with a matching media type (`application/json` for JSON, `text/plain` for Twee), instead of inserting its reload client, which broke JSON and dropped the first Twee passage; archive output gets no client markup either (#358)
- `--lint` and `lint()` report a missing or empty `StoryTitle` as an error, as HTML output does, so a lint-only CI check no longer passes a story the compiler rejects; no story format is resolved for it (#356)
- HTML output reports an error for a story without a name, whatever the story format: no `StoryTitle` passage (as Tweego does) or an empty one, either of which stops SugarCube at startup; the CLI writes no output and plugins reject the build. Twee, archive and JSON output are unchanged (#351)
- A warning names a stylesheet source whose `@import` rules come after other rules of the story stylesheet, where browsers ignore them and the imported fonts or theme never load; in HTML, archive and JSON output, also for the Vite `entry` stylesheet. The text is kept as Tweego joins it; put imports first or add the file as a head module (#352)
- Scripts are joined with a statement boundary: each script (`.js` file or `[script]` passage) but the last ends on a line of its own followed by `;` in Twine 2 HTML, archive and JSON output, so a source without a final semicolon no longer swallows an IIFE, array literal or regular expression that starts the next one. A script that continues in the next script passage no longer works (D-18 in the differences from Tweego) (#348)
- `wordCountMethod: 'whitespace'` counts only the label of a link, whatever its form: `[[Text->Link]]`, `[[Link<-Text]]` and links with a setter (`[[Text|Link][$x to 1]]`) are read as SugarCube reads them, as `[[Text|Link]]` was (#349)
- The Vite dev server answers a request for a story page that another plugin instance also claims, as its own story (`index.html` and its folder alias, nested paths, under a `base`) or as an emitted `entry` asset, with an error asking for a distinct `outputFilename`, as the production build does, instead of serving whichever instance comes first. Stories with distinct names and an asset two instances emit with the same bytes are served as before (#346)
- The Vite dev server no longer bundles the `entry` (and reloads the page) a second time when a request for the story caught up with a change before the watcher reported it: a watcher event for a module that is still, state and content, what the last bundle read is skipped. An edit is never missed, also one a file system with coarse timestamps leaves the file's state unchanged for (its content differs), and saving a module unchanged or touching it still bundles again; files the bundle's plugins watch (CSS `@import`s, `url()` targets) and story sources are rebuilt on every event, as before (#343)
- The Vite dev server and `vite build --watch` bundle the `entry` again when a file is added to, deleted from or renamed in a folder one of its `import.meta.glob()` calls reads, so a new widget, translation or image a glob selects reaches the story without editing the importer or restarting: eager, lazy and `Object.keys()` globs, nested, negated, `base`, root-relative and aliased patterns, a folder outside the root or not yet created, with the dev watcher on or off (checked before the story is served), for an entry bundled inside the build and for one bundled separately, also when the call is in a module a later plugin compiles (a component file, TypeScript with type arguments), and for a recursive glob that reaches a folder through a link (a directory symlink or junction), as Vite's glob follows it (#341)
- The Vite dev server serves the story and the files the `entry` emits separately (`?no-inline` imports) before Vite's own file serving, so a file of the same name in `public/` (or a custom `publicDir`) or in the root no longer stands in for them: dev now serves the bytes the build writes, as `vite build` writes them over the public copy; also for `index.html` and a nested `outputFilename`. Vite's host, CORS, proxy and base handling still come first, and other public files are served as before (#339)
- Folder watch mode notices a folder that is moved out or deleted right after it was created: a folder whose creation was reported only through a file in it was not remembered, so its removal looked like a change to an unknown path and no build followed; every build now refreshes the folders it knows (#337)
- `--init` also writes `src/StoryTitle.tw` (`My Story`), so the scaffolded story opens in SugarCube, which refuses a story without a name; an existing file is kept (#333)
- The Vite `entry` starts with a `;`, so a story script that ends without a semicolon no longer swallows the entry's opening parenthesis as a call (inside the build, in a separate entry build and in dev) (#334)
- The Vite dev server answers a request for an emitted file that two plugin instances emit with different bytes with an error naming the file, as the production build does, instead of serving the first instance's bytes to both (#335)
- A CSS file an `entry` imports as a URL (`import url from './theme.css?url'`, also `?url&no-inline`) stays a file of the build and is no longer added to the Story Stylesheet, in dev, inside a production build and in a separately bundled one; a stylesheet imported for its effect still applies (#331)
- The Vite dev server reloads an open story page after a rebuild under a `base` with a space or non-ASCII character (`/my game/`, `/café/`): Vite encodes such a base and its client could not match the page-limited reload message, so the page stayed stale; the message now carries no page path then and every page reloads (#329)

- Saving a story format to the shared download cache retries a rename that Windows refuses for a moment (EPERM) because another process has the file open, as writing build output already did, instead of dropping the entry with a warning
- The separately bundled `entry` keeps Vite's public-asset resolution: a public file (`/logo.svg?url`, `new URL('/logo.svg', import.meta.url)`, CSS `url('/logo.svg')`) resolves in dev and in production builds that bundle the entry on their own, and follows `base`; the entry build uses the outer build's `publicDir` and still copies no public file (#327)
- Folder watch mode keeps seeing edits to a file that an editor saved by replacing it: on Linux the recursive watches that saw events are started again before the next build, since the old registration stayed on the replaced file and later edits left the output stale (#325)
- The Vite dev server also bundles the entry again when a link imported without its file extension (`import './dependency'` for a `dependency.ts` link) is retargeted: the import is noted at the file the resolver chose (#320)
- `vite build --watch` with an entry the build bundles separately registers the entry, the modules and plugin-watched files of a bundle that failed (so correcting a syntax error, or creating a missing import in a folder that holds no build output, builds again), and the authored location of every import that goes through a link, so retargeting such a link rebuilds (#322, #307)
- The Vite dev server also keeps the files a failed entry bundle's plugins watch and the folder where an unresolved import would be created, so creating the missing file recovers the story with the watcher on or off, also when the failure follows a good bundle (#269)
- The Vite and Rollup plugins accept the `{ base, glob }` excludes the types declare and `loadConfigFile()` returns, and refuse malformed objects with `INVALID_OPTIONS` (#323)
- A format template holding a very wide `<template>` (150000 child elements) no longer overflows the stack when `{{STORY_DATA}}` is validated (#314)
- Module and head file content is no longer put inside an open `<template>` element in a format template's head: a closing head tag the parser ignores there is not taken as the end of the head, so the content goes where it stays in the head, or the template is reported to have no place for it
- The Vite dev server bundles the entry again when a link it is spelled through (the entry itself, a relative or absolute import, or a folder an import passes through) is retargeted, with the watcher on or off, instead of serving the old target's bundle until a restart (#320)
- A relative `exclude` in a config whose folder name holds glob syntax (`chapter[one]`, `chapter{one,two}`, `!chapter`, a POSIX backslash) keeps excluding exactly that folder's files: the config returns such a glob as `{ base, glob }` (new type `ExcludeGlob`), the folder is matched literally and only the supplied suffix is a glob, so a near-match sibling is no longer excluded (#316)
- The Vite dev server decodes the configured `base` as it decodes the request, so a base with `%3F`, `%23` or `%2F` serves the story and bundle assets (#317)
- A bundle asset with an extension that is an inherited object key (`.constructor`, `.__proto__`) is served as `application/octet-stream`, not an invalid `Content-Type` (#318)
- A `null` or empty repeated `options` array in StoryData drops the slots of the earlier arrays, as Go replaces the slice, so a later `[null]` no longer brings back a cleared option (#306)
- The Vite dev server keeps the modules a failed first entry bundle loaded, so fixing an imported module recovers the story with the watcher off, too (#269)
- Validating where `{{STORY_DATA}}` lands in a format template walks the HTML tree with an explicit stack, so deeply nested templates no longer fail with a `RangeError` (#314)
- Repeated fields in one StoryData object or passage metadata block follow Go's `encoding/json`: a later `null` leaves an earlier string or number (`start`, `format`, `format-version`, `ifid`, `zoom`, `position`, `size`) and clears `options` and `tag-colors`; a repeated `tag-colors` object is merged into the earlier one, and a repeated `options` array decodes into the slots of the earlier one (#306)
- Escape warnings for JavaScript and CSS find their line with a line index and binary searches instead of rescanning the text before each warning, so many warning sites no longer take quadratic time (#309)
- The Vite and Rollup plugins keep a literal backslash in a POSIX input path (source, folder, module or head file) instead of reading it as a separator, so watching and the dev server's catch-up see edits to such files (#308)
- `vite build --watch` also watches the authored location of an input reached through a link, and each link among the folders above it, so pointing a source, module or head file link (or a link above a source folder) at another target rebuilds the story and then follows edits to the new target on Linux and Windows; on macOS the bundler's watcher registers a link by its target's real path and drops the event at the link's own path, so a retargeted link is read with the next build something else starts (#307)
- The Rollup plugin warns, in watch mode, about an input whose name holds a backslash on POSIX: Rollup's watcher reads it as a separator and cannot watch the file (#308)
- Escape-site classification in JavaScript and CSS (`code-context.ts`) looks each site's literal up by binary search instead of rescanning every literal, so builds with many `</script>` or `</style>` strings no longer take quadratic time (#304)
- A named output that becomes an authored source or module file inside a named folder while a story format is being resolved (edited, or created at a path that was empty) is rejected with `OUTPUT_IS_INPUT` before the write, and the file's bytes are kept: the folders are walked again at the write boundary (#301)
- `watch()` follows the target of a symlinked source whose target name holds a backslash on POSIX: link targets are split with the platform's separators, as Windows still reads both spellings (#239)
- A build writes over an output of its own, inside a source or module folder, only while the file holds exactly what was written: its content is checked as well as its size, inode and modification time, so a same-size edit in place that restores the modification time makes it the author's file (`OUTPUT_IS_INPUT`, bytes kept) (#285)
- The Vite dev server's catch-up sees an entry file or import edited while the entry was bundled, with no watcher or a missed event: the states it compares are those from before the bundle read the files, and a file the bundle found itself and that changed during it is bundled again on the next request (#286)
- `--list-formats` leaves out cached Story Formats Archive downloads when `useDefaultFormatIndices` is `false`, unless the same index is configured in `formatIndices`, as a build resolves formats (#287)
- Lint and `storyInspect()` read `<<button "Text" "Passage">>` as a link, as `<<link>>` (SugarCube runs both with one handler), and an element with a `data-passage` attribute (`<a data-passage="Hall">`) as SugarCube's `htmlTag` parser follows it: the start tag is read with the HTML parser, and media elements, elements with an `href`, a passage set by an attribute directive and an element without its end tag name none. The text of a start tag is no longer read as markup (#293)
- Twine 2 HTML, archive and JSON output keep the same tag colors: the Twine 2 named colors in any letter case and hex colors of 3, 4, 6 or 8 digits, as written. Any other color (`rgb(1,2,3)`, `#12345`) is left out with a warning in every one of them, instead of silently in HTML and not at all in JSON (#294)
- JSON output writes `start` for the start passage the other output modes use when StoryData names none: `Start`, when the story has such a passage (#295)
- A build checks its output against every input again after the story format is resolved, as its last step before the caller writes: an output link retargeted at a source, module, head file, config file or format file while a format downloads is `OUTPUT_IS_INPUT`, and the input and the previous output are kept (#301)
- Tag aliases (config, schema and `--tag-alias`) use the Twee whitespace grammar: a tag with U+0085 is rejected as the two tags the header reads, and one with U+FEFF, which Twee keeps in a tag, is accepted (#302)
- Two modules with the same file stem (`lib/ui.js` and `vendor/ui.js`, or `ui.css` and `ui.woff2`) no longer give two elements the same id: the later one gets `-2`, `-3` and so on after the id, with a warning (#296)
- Module element ids are unique across the whole page in `compile()`, `compileToFile()`, incremental builds and the watch and plugin paths: the build keeps one id namespace instead of starting a new one for each module, so `lib/ui.js` and `vendor/ui.js` no longer both get `script-module-ui` (#296)
- Twine 2 HTML and archive output reject story fields HTML cannot carry: an active option with U+0000, a lone surrogate, white space or no characters, and a format name or version with U+0000 or a lone surrogate in the archive (HTML output advertises the selected format, so the StoryData fields it replaces are not checked) (#271)
- Watching a named source whose parent folder is replaced by a regular file, or whose path a lookup cannot search (ENOTDIR, EACCES, ELOOP), no longer ends the process with an uncaught exception; the watcher treats it as not there yet and rebuilds when the path is restored (#281)
- Tag aliases keep a passage's own tags as written, a repeated tag included, whether or not an alias applies; they used to drop the repeat only when an alias added a tag (#297)
- A StoryData or passage metadata key with `İ` or `ı` (U+0130, U+0131) no longer matches a field with `i`, as in Go's `encoding/json` and Tweego: `"İfid"` is an unknown key, not the IFID (#298)
- A format cache writer's cleanup no longer removes the content directory that another writer, saving the same bytes again for the same origin, has just published: the directory is set aside, the record read again, and put back when the record names it, and a writer whose content is gone when it publishes writes it again (#291)
- With a relative `base` (`'./'`) and a nested `outputFilename`, the URLs of the files the Vite `entry`'s build writes besides the story (an asset marked `?no-inline`, a worker) find the output folder, in the script and in its stylesheet, instead of a folder next to the story page; a config's own `experimental.renderBuiltUrl` decides first (#289)
- The Vite dev server reloads for an edit to an `entry` file outside the root made before the watcher had set it up (on macOS, FSEvents starts reporting a moment after): once the file is watched, its state is compared with the bundle's (#292)
- docs/api.md describes how `storyInspect()` and lint read links, with the forms that are read and the known gaps; the docs tests check each form against the link reader (#299)

### Fixed

- An authored file of a loadable type inside a source or module folder is no longer taken for an earlier build, and overwritten, because its text quotes a build mark: an earlier build is recognised by its structure (JSON output by its creator and passages, Twine 2 HTML and archives by their `tw-storydata` element, Twine 1 HTML by its store area and version text, HTML only from a `.html` or `.htm` file), so such a file is refused (`OUTPUT_IS_INPUT`) and kept (#273)
- `new URL('./image.png', import.meta.url)` and Vite's worker URLs in a Vite `entry` give valid URLs in the story script, in dev and in both production entry builds: `import.meta.url` stands for the story page's URL. The dev server serves the files of the entry bundle (a worker, a stylesheet) with their own media types, not `application/octet-stream` (#274)
- Saving a verified download over a damaged content directory of the format cache writes the damaged or missing files again, so the next offline build finds the format (#275)
- A cache writer's cleanup removes the content directory its record replaced, and any other that no record names once it is older than ten minutes, and it reads the published record when it cleans up: it no longer removes the content another writer's record names or is still writing (#276)
- A Twine 1 format downloaded from an index builds from its verified `code.js` and `userlib.js` when the cache cannot be written, and from the cached copy's verified bytes otherwise (#277)
- Each redirect of a format download is checked before it is followed: the endpoint of a hop from `https:` to `http:` (or from an `https:` hop back to `http:`) is never contacted, so an HTTPS → HTTP → HTTPS chain is refused, and a chain is cut off after 20 redirects (#279)
- Text HTML cannot carry (U+0000, a lone surrogate) in a script or style module is an error, as in a source, and no longer reaches the page changed without a word (#280)
- A named source or module whose parent folder cannot be searched is an `unreadable` error, and one beneath a regular file is a missing-path warning, as the input policy says, instead of a raw `EACCES` or `ENOTDIR` exception; the other inputs are still checked (#281)
- Tag aliases that chain (`{ library: 'script', script: 'Twine.private' }`) give every tag they reach on the first application, so compiling to Twee and compiling that again with the same aliases gives the same story. Applying the aliases again adds nothing (#282)
- The Vite dev server reloads when a file under a source folder link's new target changes after the link is retargeted: the source folders' identities are read for each change, not once at startup (#283)
- `docs/tweego-differences.md` lists the output and input differences from Tweego 2.1.1 found by comparing the two tools (D-20 to D-29: the StoryData JSON, attribute values, story attributes, the format of a Twine 2 archive, Twine 1 output, end tags in code, statistics, symbolic links and unsupported named sources, Windows-1252 bytes, HTML parsing), each with a test named after its number, and a test checks that every listed number has one (#384)
- The documentation matches the code: `--list-formats` shows a cached download under the name its index spells, the `Compile Result` and plugin option types show their read-only modifiers (the docs type check now compares read-only properties and the shipped type's assignability to the documented one), the Error Handling table lists `FORMAT_UNAVAILABLE`, Inline Sources lists the types they support, Twee output keeps the tags after aliasing, and an output mode flag keeps the `output` path of the config file; the docs site is built on Node.js 24 and no longer warns about the `twee` language (#392)
- `pnpm install` fails with a clear message on a Node.js older than 24 (`devEngines`), and the README and the new CONTRIBUTING.md state the prerequisites, including the `ERR_PNPM_NO_MATCHING_VERSION` that a standalone pnpm 10 or 11 prints (#380)

## [2.0.0] - 2026-10-06

[Migrating to 2.0](docs/migrating-to-2.md) explains each breaking change and what to do about it.

### Breaking

- **Runtime:** Node.js 24 or newer is required (`engines`) and the `vite` peer dependency is `>=8`; CI tests only the latest Node 24, Vite 8 and Rollup 4 (#250)
- **Vite plugin:** Vite 8 or newer is required; the code paths for Vite 5, 6 and 7 (the `config` hook, the shared last-config fallback for builds without environments, the `rollupOptions` name as the plugin's own setting, and the "needs Vite 8" error for `entry`) are removed. A user config may still name `build.rollupOptions`, which Vite 8 accepts
- **CLI:** standard output carries only the story (or a query's answer); `--log-stats`, `--log-files` and watch mode's messages go to standard error, and `--log-files` also works when the story goes to standard output. Scripts that read the statistics from standard output read standard error instead (FS-01, #247)
- **CLI:** usage errors exit with status 2, not 1, print `error: …` (not `Error: …`) and a pointer to `--help`, and are found before anything is built: unknown options, a missing or empty value, an option given twice, conflicting options (two output modes, which used to pick the first; `--lint` with `-w`, `-l`, `--log-files` or an output mode; `-c` with `--no-config`; `--version`, `--init` or `--list-formats` with other options or sources, which used to be ignored), an invalid `--tag-alias` or `--word-count-method`, no sources, watch mode without an output file, and `cache` with build options. `cache` is a subcommand only as the first word, never after `--`; `--help` wins over every other option (FS-02, FS-08, FS-10, FS-16, FS-19, #247)
- **CLI and API:** a missing or unreadable head file is fatal (`TweeTsError`, `INPUT_UNAVAILABLE`), as in Tweego, instead of a warning; an unreadable module is an error naming it; a source named directly whose type twee-ts doesn't load is a warning (FS-05, FS-17, #247)
- **CLI and API:** an output file inside a source folder that already holds an author's file of a source type (not an earlier twee-ts build) is refused (`OUTPUT_IS_INPUT`) instead of silently left out and overwritten; exclude it or move the output (FS-07, #247)
- **CLI and API:** the output is written by what is at its path: a read-only file is refused (`EACCES`) instead of replaced, a hard-linked file is written in place, and FIFOs, devices and `/dev/stdout` are written through (FS-03, #247)
- **Config:** paths in a config file (`sources`, `exclude`, `output`, `modules`, `headFile`, `formatPaths`) are relative to the config file's folder, not the working directory; `loadConfig()` and `loadConfigFile()` return them rebased onto the working directory. A config in the working directory is unaffected; for `-c dir/twee-ts.config.json`, drop the `dir/` prefix from its paths (FS-11, #247)
- **Config:** `output` and the entries of `sources`, `exclude`, `modules`, `formatPaths`, `formatIndices` and `formatUrls` must not be empty; tag aliases and their targets must be non-empty and hold no white space. Config errors are `TweeTsError`s (FS-16, FS-19, #247)
- **Story sources:** a StoryData passage that is not valid JSON is an error, not a warning, and a StoryData field of the wrong type (`"format-version": 3`, `"options": "debug"`, `"start": ["A"]`) is an error where it used to be dropped silently; Tweego stops on both. Fix the StoryData passage the error names (JS-9, #246)
- **Story sources:** a later StoryData, StorySettings or StoryTitle passage decides its part of the story alone: a malformed StoryData leaves the story without the earlier one's IFID, format and start, and a StorySettings passage without `obfuscate:rot13` or `ifid` turns ROT13 off and drops the legacy IFID an earlier one set (#236, #246)
- **Story sources:** media passages and font families are named after the file up to its first dot, as in Tweego: `bg.night.png` is the passage `bg`, `My.Font.woff2` the family `My` (also for font modules). Rename files whose inner dots should be kept (#246)
- **Story sources:** passage metadata whose `position` or `size` is not a string is discarded with a warning, as in Tweego, where it used to keep the other keys; `Position` and other case variants are read as `position` and `size` (#246)
- **Story sources:** a passage name that ends in a lone backslash loses it, as in Tweego, with a warning; write `\\` for a backslash (#246)
- **Story sources:** names, tags and the text of passages, StoryTitle and StorySettings are trimmed and split at Go's white space, as in Tweego: U+0085 is white space, U+FEFF is not (#246)
- **Story sources:** with `trim: false`, a passage whose content is only white space is empty (trailing blank lines are dropped) (#246)
- **Lint and inspection:** `storyInspect()` and lint list as orphans the story passages that no chain of links reaches from the start passage or an info passage, so a passage that links only to itself, or a group that links only among itself, is listed (#246)
- **Story formats:** a `format.js` must be valid JavaScript: one that is not, such as a file with an unterminated comment after the `storyFormat()` call, is skipped with the parser's message and position. Fix the file; a browser cannot load it either (#245)
- **Story formats:** the format object is the object literal passed to the file's one `storyFormat()` call, or the whole file when it is nothing but an object literal. A file whose object was found only as the first `{` of other code, or that calls `storyFormat()` more than once, is skipped. Write the object as `window.storyFormat({…})` (#245)
- **Story formats:** format objects are read by a stated subset of JavaScript literals (see the story formats guide). Values outside it, which were partly accepted before, are errors that name the property and its line and column: for example a signed property key (`{-1: 1}`, a syntax error in JavaScript) or a `__proto__` key, which sets the prototype in JavaScript (#245)
- **Story formats:** one selection policy for every source ([How a Format Is Chosen](docs/story-formats.md#how-a-format-is-chosen)): the first source (local folders, then each format URL, then each format index) with an answering format wins; within a source, an exact version beats a newer one, and the greater version beats exact letter case. A same-major older version is used, with a warning, only when no source has an answering one, whatever source holds it. An online build's choice no longer depends on what the cache holds (#224, #248 F01, F03)
- **Story formats:** downloads are cached by where they came from. A download from a format index is used only by builds that consult that index, and only while it matches the checksums the index lists; a download from a format URL only by builds that list that URL. `noRemote` builds use the cached downloads of their own `formatUrls` and `formatIndices` and of the Story Formats Archive, not every download on the machine. The cache directories of twee-ts 1.x are no longer read: run `twee-ts cache clear` (which also removes them) and let the next online build download again (#248)
- **Story formats:** a format URL is requested again on every online build that reaches it (conditionally, with its ETag or Last-Modified), instead of using its cached copy for ever; offline, the cached copy is used as before (#248 F08)
- **Story formats:** `formatUrls` and `formatIndices` accept only absolute `http:` and `https:` URLs without credentials; anything else (a `file:` URL, a relative path) is an error diagnostic that points to `formatPaths` (#248 F17)
- **Story formats:** versions follow SemVer 2.0.0 strictly besides Tweego's leading `v` and short `1`/`1.2` forms: a number with a leading zero (`01.2.3`, `1.0.0-01`) or a major, minor or patch above 2^53 − 1 is not a version, and a format with such a version is skipped with a warning (#248 F18)
- **Story formats:** an empty or relative `XDG_CACHE_HOME` is ignored, as the XDG Base Directory spec says (#248 F18)
- **HTML output:** text that HTML cannot carry is an error (so the CLI writes no file): U+0000 and lone surrogates in a passage name, tag or text or in the story name (the browser drops or replaces them, so links to such a passage break), and a tag that is empty or holds white space (it reads back as other tags). Remove those characters (#244 H14)
- **HTML output:** `{{STORY_NAME}}` is escaped for the place it is in the template, as the HTML parser reads it: in a JavaScript string or template literal, `\`, line breaks, U+2028 and U+2029 are escaped as well (so SugarCube's engine script stays valid for a title such as `Back\`), a URL attribute (`href`, `src`, …) gets the name percent-encoded, a JSON data block or CSS string gets JSON or CSS escaping instead of HTML escaping, and a place no escaping fits gets a warning. A format that relied on the HTML-escaped name in a URL, JSON or CSS needs no workaround any more (#244 H9)
- **Twine 1 output:** obfuscation (`obfuscate:rot13`) follows the StorySettings passage the output carries: when it is `Twine.private` (or an alias of it), the story format cannot learn the setting, so the tiddlers are written unencoded, with a warning; untag StorySettings to obfuscate (#149)
- **Twine 1 output:** under `obfuscate:rot13`, a passage whose name ROT13 turns into `StorySettings`, or whose tag it turns into `Twine.image`, is an error: the story format would not decode it. Rename the passage or tag (#244 H15)
- **API:** `StoryBuilder` changes its story only through its methods: `builder.story` is gone, and the passages it hands out are frozen copies. Read the story with `build()`, which now returns a frozen snapshot that later changes do not reach, and replace direct changes to `builder.story.passages` with `add()`, the new `remove()` and `rename()` methods (#171)
- **API:** `watch()` rejects options that can't work (an output that is a named input, an option out of range) with a `TweeTsError` instead of reporting them through `onError`, and stops watching when such an error appears in a later build (FS-13, #247)
- **API:** `fetchAndCacheFormat` is removed: it cached a download for every project by name and version. Use `formatIndices`, or `resolveRemoteFormat` with the index URL (#248)
- **API:** `listCachedFormats`, `getCacheSize` and `clearCachedFormats` cover downloads from format URLs too, and `clearCachedFormats(name)` matches the format name without regard to letter case instead of a directory name (#248 F10). `discoverCachedFormats` keys its map by cache entry. `CachedFormatEntry` has new `source` and `origin` fields
- **Plugins:** the Vite and Rollup plugins check their options when created and throw a `TweeTsError` (`INVALID_OPTIONS`) naming the option for an unknown option (a misspelt `outputFileName`, say), a value of the wrong type, `compileOptions.sources` or `compileOptions.formatId` (set the plugin's `sources` and `format` instead; the two plugins used to give them opposite precedence), and an `outputFilename` that is not a plain relative path (`./index.html`, `../x.html`, `a//b.html`, a backslash, `?`, `#`, `%` or a name Windows reserves). Migrate by moving those values to the top-level options and writing `index.html` for `./index.html` (#249)
- **Vite plugin:** the dev entry build evaluates the user's configuration for the dev command, as the dev server does: a config function sees `command: 'serve'`, `apply: 'build'` plugins no longer run in dev (and `apply: 'serve'` ones do), and plugins' `config`, `configEnvironment` and `configResolved` hooks see the dev command. A build-only plugin the entry needs in dev must apply to both commands (#249)
- **Plugins:** a Vite build fails with an error naming the file when the bundle already holds a file named as the story's `outputFilename` (the user's own `index.html` input, or another twee-ts instance); it used to replace that file silently. The Rollup plugin fails the same way (#249)
- **Vite plugin:** the dev server's story reload message names the story's path, so with an `outputFilename` other than `index.html` only the pages showing the story reload (#249)
- **API:** `compileIncremental()` freezes the passages and diagnostics it keeps in the caller's cache (`FileCacheEntry`), and every compile hands out `CompileResult.story` as a frozen copy that shares no object with the cache, so a change to a result can no longer alter what the next build replays. Code that changed cached passages or the result's passages in place must make changed copies (#246 S-4)
- **API:** `resolveRemoteFormat(name, version, indices, urls, options)` is now `resolveRemoteFormat(name, version, { ...options, indices, urls })`. Its errors are `TweeTsError`s with code `INVALID_OPTIONS` (an unusable URL or time limit) or `FORMAT_UNAVAILABLE` (no source answered and some failed; every failure is in `diagnostics`) instead of `RangeError` and `Error` (#250 API-3, API-6)
- **API:** `parseSemver()` and `semverCompare()` are removed: they dropped prerelease identifiers, so `2.0.0-beta.1` compared equal to `2.0.0`. Use `parseVersion()` and `compareVersions()`, the functions format selection uses (`semverCompare(parseSemver(a), parseSemver(b))` becomes `compareVersions(parseVersion(a), parseVersion(b))`, each `parseVersion()` result checked for `null`) (#250 API-6)
- **API:** the result types are read-only, as `CompileResult.story` already was: `CompileResult` and its `diagnostics` and `stats` (`files`, `externalFiles`), `Diagnostic`, `LintResult`, `StoryMap` (its lists and maps) and `BrokenLink`, `getCacheSize()`'s result and `TweeTsError.diagnostics`. `TweeTsConfig`'s lists and the `tagAliases` of `TweeTsConfig`, `CompileOptions` and `applyTagAliases()` are read-only too, so a frozen or `as const` value can be passed. Copy a result's list (`[...result.diagnostics]`) to change it (#250 API-4)
- **API:** `parseFormatJSON(source)` no longer takes a second argument, which it ignored; drop it from calls (#250 API-6)
- **API:** a Twine 1 format whose required component (`engine.js`, `jquery.js`, …) is missing, a story format that can no longer be decoded when its template is read, and a template with too many placeholders to analyse stop the build with a `TweeTsError` (code `FORMAT_UNAVAILABLE`, the read error as `cause`) instead of a plain `Error` (#250 API-3)
- **Decompiling:** Twine 2 HTML keeps the `tw-storydata` attributes as the story's metadata and name: a `tw-passagedata` named StoryData, or named StoryTitle without holding the story name, is kept under the next free name (`StoryData 2`) with a warning, instead of replacing the IFID, format and start passage (or the name) the attributes give, as Tweego does. Rename such a passage in Twine 2 to keep its name (#246 S-1, [D-14](docs/tweego-differences.md))

### Added

- `TweeTsError` has a `code` (`OUTPUT_IS_INPUT`, `INPUT_UNAVAILABLE`, `INVALID_OPTIONS`, `BUILD_FAILED`); `TweeTsErrorCode` is exported (#247)
- `StoryBuilder.remove()`, `rename()`, `get()` and `passages` (#171)
- `Twine1Metadata` and `Twine2Metadata`, the types of `Story.twine1` and `Story.twine2`, are exported (#250)
- The plugins export their `PluginCompileOptions` type, the `compileOptions` they accept (#249)
- CommonJS builds of `@rohal12/twee-ts/vite` and `@rohal12/twee-ts/rollup`; `require()` of either no longer fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` (#250)
- `@rohal12/twee-ts/package.json` and `@rohal12/twee-ts/schemas/*.json` are exported, so `require.resolve()` and `import.meta.resolve()` find them (#250)
- `THIRD_PARTY_NOTICES` and `UNLICENSE` ship in the package. The notices reproduce Tweego's BSD licence and the licence of every package bundled into `dist/`; the build regenerates them from what it bundled (#250)
- A canonical path identity (`src/path-identity.ts`) that every path comparison uses: real paths with dangling links followed, case folded on case-insensitive volumes (probed per volume), Windows drive letters, `\\?\` and UNC forms normalised (#247)
- UTF-16 sources, modules, head files and config files with a byte order mark are decoded (PowerShell 5's `>` writes them); invalid UTF-16 and UTF-32 are errors naming the file (FS-18, #247)
- `--log-files` lists the modules and head file as external files, as Tweego does; `CompileStats.externalFiles` (#247)
- `-o /dev/stdout`, `/dev/fd/N`, FIFOs, `/dev/null` and Windows device names work as output targets (FS-03, #247)
- Tweego's deprecated `--decompile` is accepted; `--charset`, `--list-charsets` and `-c` given a charset name explain that twee-ts reads UTF-8 (#247)
- With `entry`, a Vite build keeps the user's own inputs (an `index.html` landing page, an array or object of inputs, a library) and bundles the entry with a build of its own, and several twee-ts instances in one build each bundle their own entry (#249)
- StoryData keys match regardless of letter case, as in Tweego (`IFID`, `Format-Version`), with a warning; unknown and repeated keys are warned about (#246)
- Twine 1 entries of a format index are downloaded (`header.html`, with `code.js` and `userlib.js` when listed) and used for a format ID (#248 F04)
- A format ID also finds a local format by its name and major version, as it does in format URLs and indices, so `--format sugarcube-2` finds SugarCube 2.37.3 in a folder named `sugarcube-2.37` (#248 F14)
- What decoding leaves out of the story format a build uses (a function-valued property it skipped, a field of the wrong type it ignored) is a warning that names the format file, or the URL a downloaded format came from (#248)
- Warnings for head file content that does not stay in the head (text, body elements, or an unclosed comment, element or attribute), for a Twine 1 format with no store area for the IFID comment, for a carriage return in a script or stylesheet passage (the script element cannot carry it), and for a `</script`, `</style` or `<!--` in code where the backslash the compiler writes after the `<` changes the code (#244)
- Documentation: [Differences from Tweego](docs/tweego-differences.md) lists every intended difference, each with a test (#246), and [Migrating to 2.0](docs/migrating-to-2.md) every breaking change. Every code example in the README and the docs is type-checked against the built package and run by the test suite, shell examples are run against a fixture project with their exit status, and the CLI options, config keys, exported names and file types the docs list are compared with the code (#243)
- `formatResolutionTimeout` (compile option and config key; default 120000 ms, 0 for none) limits the whole story format search, besides `formatFetchTimeout`'s limit on each request. When it passes, the request in progress is aborted with a warning naming the option, and the format URLs and indices not yet asked answer from the download cache only (#248)
- `useDefaultFormatIndices: false` (compile option, config key, CLI `--no-default-format-indices`; `useDefaultIndices` for `resolveRemoteFormat`) leaves out the Story Formats Archive indices, so a project with its own format index never contacts the archive (#248)
- `TweeTsErrorCode` member `FORMAT_UNAVAILABLE`, and the exported `RemoteResolveOptions` type (#250)
- `WatchPathError`, the error `watch()` passes to `onError` for a path it cannot watch, is exported, with the path as `path` (#250 API-3)
- `parseVersion()` and `compareVersions()` (SemVer 2.0.0 precedence, prereleases included) and the `SemVer`, `Twine2FormatJSON`, `ParseOptions` and `ParseResult` types, which public signatures use, are exported (#250 API-5, API-6)
- The plugins' `sources` option accepts a readonly array (`['src'] as const`) (#250 API-2)
- An option `compile()`, `compileToFile()` or `watch()` does not read (a misspelt one, or `format` for `formatId`) is a warning that suggests the option meant, as an unknown config key is (#248 F16)
- `twee-ts --init` and `scaffoldConfig()` name the JSON schema of the installed release (`https://unpkg.com/@rohal12/twee-ts@<version>/schemas/…`), so editors check a config against the keys that release reads (#250)
- `SOURCE_DATE_EPOCH` sets the build time Twine 1 output is stamped with (`"TIME"`, the tiddlers' `created`), so the same sources build the same bytes; a value that is not whole seconds is an error

### Changed

- CI runs on the latest Node (24), Vite (8) and Rollup (4) only, and the contract matrix on Linux; the plugin peer-version test run (`vitest.peer.config.ts`) is removed, and the "plugin peers" job type-checks a consumer config against the packed plugins
- JavaScript (format.js files, story scripts, macro arguments) is read with acorn, which is bundled into the package; twee-ts still has no runtime dependencies and still runs no JavaScript it reads (#245)
- HTML is parsed with parse5, which is bundled into the package in place of htmlparser2; twee-ts still has no runtime dependencies (#244)
- In a template without a closing head tag that ends the head, the modules and head file go where the head ends (or where the browser creates the head), with a warning that names the line and column; they used to go before the body start tag, or nowhere when there was none (#244)
- `{{STORY_DATA}}` and the Twine 1 `"STORY"` are replaced at their first occurrence where the browser reads the data as elements of the page; a look-alike in a comment, script or title before it is left alone. With no such occurrence, the first one is replaced, with an error (#244)
- The round trip compile → decompile returns the story except for the documented cases (see the HTML decompiler in docs/api.md): left-out passages, script and stylesheet passages joined, and `</script`, `</style` and double-escaped `<!--` in them coming back with the backslash the compiler writes (#244 H16)
- The `CLOSING_HEAD_TAG` constant and the `scanHeadTags()` and `findHeadStartEnd()` scanners are removed from the (internal) modules (#244 H17)
- The published package is the tarball that CI packed and checked on Linux, macOS and Windows; the release job installs nothing and runs no package scripts (#250)
- Loading the package through both `import` and `require()` in one process still loads the ESM and the CommonJS build separately (the dual package hazard); use one of the two (#250)
- Mutation testing (StrykerJS) of the lexer, parser, Twee syntax, story model, SemVer, link markup and JSON decoder runs weekly in CI, informational only, against per-file scores recorded in `mutation-baseline.json` (93.7% overall); `pnpm run mutation` runs it locally (#250)
- Workflow files are checked by Prettier like the rest of the repository (#250 CI-4)

### Fixed

- `watch()` ignores a hard link of the output that is made after the watch starts or after the output is replaced, instead of rebuilding for it again and again; the output's inodes are read when a path is checked, not once at the start (#268)
- The Vite dev server watches the configured `entry` before its first bundle, so correcting an entry that failed to bundle (inside the root or not, with the file watcher off or on) brings the story back (#269)
- The Vite dev server's catch-up before serving the story also compares change times, so an in-place edit that restores the modification time is served, for story sources and the entry alike (#270)
- Passage `position` and `size` that HTML cannot carry (U+0000, a lone surrogate) are an output error in the modes that write them (Twine 2: both; Twine 1: `position`), instead of silently becoming U+FFFD (#271)
- `StoryDisplayTitle` and passages tagged `init` are info passages, as SugarCube treats them: they are no story passages, orphans or dead ends, and the links in `StoryDisplayTitle` count as reachable (#272)
- `format.js` files are parsed as JavaScript, so a regular expression literal holding a quote or `/*`, an HTML-like comment (`<!--`, `-->`), or an identifier that ends in `storyFormat` (`éstoryFormat`) before the call no longer hides the format or picks the wrong object, in local discovery, downloads and the download cache alike (#245)
- A line comment ended by CR, U+2028 or U+2029 before the `storyFormat()` call no longer hides the format (#221)
- A function-valued property such as Harlowe's `setup` is left out wherever it is in the format object and however it is written (`setup() {}`, `setup: () => {}`), and the properties after it, such as `proofing`, are kept (#245)
- Numbers in format objects get JavaScript's values: a legacy octal `010` is 8, as are keys such as `{010: 1}`; numeric separators, `- 1` and template literals without substitutions are read (#245)
- Positions in format.js errors count CR, CR LF, U+2028 and U+2029 as line breaks, also in downloaded files (#245)
- The link check reads JavaScript with a JavaScript parser, so a regular expression after `if (…)`, `while (…)`, a block or a function declaration no longer hides a broken link or reports a phantom one, and a division after a variable named `of` or after `1.` is read as one (#245)
- Strings in `<script>` elements are read as sloppy-mode JavaScript, so a link written with octal escapes (`'\74\74goto "Room">>'`) is checked (#245)
- Indexed formats whose `format.js` names no format stay resolvable offline, by ID and by name, and are listed and cleared by their index name (#237)
- A format index's download URLs are resolved against the URL the index was served from (after redirects), with each part percent-encoded, so an index URL with a query, a fragment, another file name or a redirect works (#238, #248 F05)
- Every failing source is reported, with its URL and the cause (such as `ECONNREFUSED`, the JSON error, or why a `format.js` cannot be used), even when a later source answers; a checksum mismatch names the URL and both hashes (#248 F06, F07). When nothing answers, the error lists the candidates with the requested name and why each does not answer
- A missing or unparseable `format-version` still takes the greatest version of any major, but with a warning (Tweego's, for an unparseable one) instead of silently (#248 F09)
- A download that cannot be written to the cache (a read-only home directory) is used for that build, with a warning, instead of failing it (#248 F11)
- Responses larger than 32 MiB are refused while they stream (#248 F12)
- An index checksum is matched by exact file name; a checksum that is not a string skips the entry with a reason, and a malformed digest fails the download it is for (#248 F13)
- A format URL accepts any format name, as a local folder does; cache paths never contain format names (#248 F15, #238)
- Cached files are checked against their SHA-256 when read, and a downloaded format is used from the bytes that were checked, never read back from disk (#248)
- The output is never written over a named source, module, head file, config file or story format, in any output mode, by any spelling (`./`, absolute, through a link, a hard link, another letter case on a case-insensitive volume) (#157, #247)
- Watch mode rebuilds when a folder is moved out of, renamed in or deleted from a watched folder, and when a symbolic link in it is created, retargeted or deleted; edits to the target of a named symlinked source, module or head file, and of a file a source folder links to outside it, rebuild too (FS-04, #239, #247)
- Watch mode builds at most a second after the first change of a steady stream, instead of waiting for the stream to stop (FS-12, #247)
- The incremental cache also compares size, inode and status-change time, so a write that keeps the modification time is seen (#247)
- Exclude globs match the file extension regardless of case (`*.png` leaves out `Photo.PNG`), the whole path on a case-insensitive volume, and paths reached through a symbolic link working directory (FS-06, FS-14, #247)
- Reported paths are relative to the working directory even when it is reached through a link (`/var` vs `/private/var`) (FS-06, #247)
- A dangling symbolic link in a source folder (an editor's lock file) is skipped without a warning, as in Tweego (FS-15, #247)
- Folder entries are read in code-point order on every OS, so duplicate passages resolve the same way on Windows (#247)
- `-o ''` and `"output": ""` are rejected instead of failing to write (FS-19, #247)
- CLI usage errors print one line and a usage hint, not a stack trace; a closed stdout pipe ends quietly instead of with an unhandled EPIPE (FS-08, FS-09, #247)
- `--tag-alias __proto__=…` keeps the alias (#241)
- `--list-formats` lists only the cached downloads a build would consider (from the configured format URLs and indices, and the Story Formats Archive), not every download in the cache; `cache list` still lists them all (#247)
- On Windows, renaming the output over a file another program holds open is retried (#247)
- The dev entry build replays the user's whole configuration: everything passed to `createServer()` or on the command line, on top of the config file, apart from the keys that configure servers or logging. `base`, `envPrefix`/`envDir`, `css`, `resolve.conditions`/`extensions`, `assetsInclude` and the rest now apply in dev as in a build (#249, #222)
- The dev entry build prints no progress lines (`transforming...`, `rendering chunks...`), at any log level (#249)
- Every file the entry was bundled from is watched, also outside the Vite root (a shared package of a monorepo, a workspace link) and modules whose code the bundler inlined; watcher events, module ids and the files a plugin adds with `addWatchFile` are matched by file identity (the real path, without case on a case-insensitive volume); with `server.watch: null` a request for the story catches up with them (#249, #242)
- The story is built in the client environment only: an SSR or other environment, and an SSR build, no longer get a copy (#249)
- The dev server serves the story after Vite's own middlewares, so its host check (403 for another `Host` on Vite 5.4.12+), `server.headers` and `Cache-Control: no-cache` apply; only GET and HEAD get the story. An `outputFilename` of `dir/index.html` is also served at `dir/`, as static hosts serve it, and files the entry emits separately are found by their decoded names (`keep%20file.png`) (#249)
- `rollup --watch` and `vite build --watch` start no build for an edit to a file `exclude` leaves out, and the Vite and Rollup plugins register the same files (#249)
- The Vite and Rollup plugins match `exclude` globs against a file as the sources spell it, also when a watcher reports its real path: an edit to an excluded file in a source folder reached through a link (or `/var` on macOS, which is `/private/var`) no longer rebuilds the story and reloads the page (#242)
- The optional properties of the public option types (`CompileOptions`, `CompileToFileOptions`, `WatchOptions`, `TweeTsConfig`, `DecompileOptions`, `InspectOptions`, `RemoteFetchOptions`, `Passage`, the options of `parseTwee()`, and the Vite and Rollup plugin options) accept an explicit `undefined`, so projects with `exactOptionalPropertyTypes` can pass values such as `formatId: process.env.FORMAT`. `CompileResult.format` is typed `StoryFormatInfo | undefined`, as compile sets it (#250)
- TypeScript projects that compile to CommonJS (`module: node16`/`nodenext` in a `.cts` file or a CommonJS package) get the CommonJS declarations instead of TS1479; every entry point has `types` per `import`/`require` condition (#250)
- `moduleResolution: node10` finds the types of `@rohal12/twee-ts` and `@rohal12/twee-ts/rollup` (`main`, `types`, `typesVersions`). `@rohal12/twee-ts/vite` still needs `node16`, `nodenext` or `bundler`, because Vite's own types do (#250)
- The compiler is bundled once per format and shared by every entry point, so `TweeTsError` and module state such as the format caches are the same objects whether loaded through `@rohal12/twee-ts`, `/vite` or `/rollup`; the unpacked package shrinks from 4.0 MB to 2.4 MB (#250)
- The Vite plugin compares and watches its sources, head file, modules and the entry's dependencies by real path, so `vite build --watch` rebuilds and the dev server sees changes on macOS (`/var` is `/private/var`), on Windows (8.3 short names such as `RUNNER~1`) and in projects reached through a symbolic link (#250)
- On case-insensitive file systems (macOS, Windows), a story format folder that both `storyformats` and `storyFormats` reach is searched once, at the rank of its first name, so format precedence matches Linux (#250)
- Builds from a git checkout (tests, git dependencies, `pnpm link`) report the version `0.0.0-development` in `--version` and `creator-version` instead of the stale `1.2.0`; published packages report the released version (#250)
- Twee output checks each passage by reading it back with the Twee parser, so a text line that starts with a byte order mark and `::` is reported (and indented in stylesheets and scripts) like one that starts with `::`, and a carriage return or a metadata key that reads back as another is reported; Twee 1 output warns that it leaves out metadata (#246)
- A passage metadata key such as `__proto__` or `constructor` is kept in the model, in JSON output and in Twee output (#241)
- `StoryBuilder` lookups always agree with its passages (#171)
- Duplicate passage warnings and StoryData, StorySettings and StoryIncludes diagnostics carry the file and line of the passage, and a duplicate warning names the passage it replaces (#246)
- The `tweego` word count matches Tweego: empty comments (`/**/`) are removed and a letter with its accents counts once (#246)
- Twee2 conversion (`--twee2-compat`, `.tw2` files) gives Tweego's result when a line holds U+2028 or U+2029 (#246)
- An unterminated tag block after an escaped line end is reported on the header's line (#246)
- Parsing with `trim: false`, the word counts and Twee2 conversion take linear time on adversarial input (#246)
- JSON output leaves out passage metadata entries with an empty value, as Twee output does (#246)
- The structure of a story format template (the end and start of the head, the Twine 1 store area, the context of each placeholder) is found by parsing it as browsers do (parse5), not by scanning for tags. Modules, the head file and the Vite client are no longer injected into, or dropped because of, comments ending in `--!>`, `<!-->` or `<!--->`, bogus comments (`</ `, `</!`), double-escaped script text, `noscript`, `noframes`, `xmp`, `iframe`, `noembed` or `plaintext` text, template content, SVG CDATA, or attribute names holding `=` or quotes (#244 H1–H6, #223)
- In a template without a head start tag, the Vite client goes into the head the browser creates, after the doctype, instead of before the doctype, where it put the dev page into quirks mode (#244 H7)
- The Twine 1 IFID comment goes before the store area element the story format finds, written with any quotes, letter case or attribute order, not before a look-alike in a comment or script (#244 H8)
- The Vite `base` is escaped in the client's `src` attribute (#244 H10)
- Decompiling reads HTML as a browser does: the story is the one a story format finds (not a `tw-storydata` in template content or past a double-escaped script), passage text is the element's `textContent` (text in elements included), and line breaks and NUL are handled as the HTML parser does, also for `decompileHTML()` called with a string (#244 H11–H13)
- A carriage return in a passage name, tag or text is written as `&#13;`, which keeps it, instead of raw, which the browser reads as a line feed (#244 H14)
- The documentation describes 2.0 as it is (#243, #247, #248): `applyTagAliases()` returns a new array, `tweeLexer()` takes one argument, `validateIFID()` returns `null` for a valid IFID, `annotation` and `widget` passages are written to the output (use `Twine.private` for private notes), the script element in the tag alias table, what decompiling returns, `StoryIncludes` is ignored with a warning, a StorySettings `ifid` is used when StoryData has none, `--word-count-method` and the other usage errors, the font family rule for modules, the CLI's transcripts and the JSON output keys. The packaging guide no longer documents a `format` compile option or `node_modules` discovery that do not exist, and its type declarations load their globals (#248 F16)
- The link check reads a `<script>` element in passage text only when it runs, as jQuery (which SugarCube 2 inserts it with) and HTML's script type rules decide: a template (`type="text/template"`), JSON, a script with a `src` and a classic script marked `nomodule` name no passages, and a `type="module"` script is read as module code (#245)
- After a syntax error in story code, a block statement right after a statement that ends in a block, and `await` before a regular expression, are read correctly; strings after them were missed or invented (#245)
- The lint report writes `1 word` and `1 file`, not `1 words, 1 files` (#250 CLI-3)
- The link check, `storyInspect()` and lint read the link component of image markup (`[img[pic.png][Room]]`, also as a macro argument or in a script string), which SugarCube goes to on a click; such a passage is no longer reported as an orphan, and a missing one is a broken link (#245)
- Twee2 conversion writes a position as a JSON string, so a `"` or `\` in `<…>` no longer adds metadata keys or breaks the metadata block ([D-16](docs/tweego-differences.md)) (#245)
- Every time stamp in one Twine 1 output is the same build time; tiddlers written across a minute boundary used to get different `created` values
- The config schema gives `formatId` and `startPassage` no default: left out, StoryData's format and start passage decide, so an editor that fills in the stated default no longer overrides them; their descriptions say they override StoryData
- Decompiling reads `startnode`, `pid` and `zoom` whole: a value with anything else in it (`2abc`, ` 2`, `0x2`, `1.5x`) is a warning, where it was read in part, and a `startnode` that no passage has as its `pid` is a warning (#244 U5, [D-15](docs/tweego-differences.md))
- A media, font, stylesheet or script passage keeps its generated name through tag aliases and every other changed copy the compiler makes, so a passage from the sources with the same name still moves it aside instead of replacing it (#246 S-5)

## [1.18.2] - 2026-10-06

### Fixed

- Output files that are dangling symlinks (absolute, relative or chained) are written through to their final target and the link is kept (#219)
- `ReadonlyPassage` and `CompileResult.story` make `tags` and `metadata` read-only at compile time; code that mutated them through the read-only types no longer compiles (#220)
- The `storyFormat` object is located lexically, so JavaScript comments containing braces around it no longer break local, URL or cached format loading (#221)
- A same-major older story format from the project's configured format URLs is used, with the older-version warning, when no at-or-above version is available, as for local and shared-cache formats (#224)
- The Vite dev server's entry build uses the plugins and the `define` and alias overrides passed to `createServer()`, with or without a config file (#222)
- The Vite dev server puts its client script after the real head start tag, not in a comment, an inline script or an attribute value that looks like one (#223)

### Changed

- Coverage thresholds are raised and the untested lines and branches reviewed; no behavior change

## [1.18.1] - 2026-10-05

### Fixed

- Modules are injected at the real head end tag, not at tag text inside inline scripts, comments, raw-text elements or attribute values (#201)
- Sources are loaded in the order supplied when inline sources and files are mixed, for plain and incremental builds (#202)
- `compile()` and `compileToFile()` check the abort signal after format resolution and before writing, so an aborted build rejects and keeps the previous output (#203)
- Remote format checksums are verified against the downloaded bytes, so a UTF-8 BOM no longer fails a correct checksum (#204)
- Each caller of a shared format request keeps its own timeout and its own checksum validation (#205, #206)
- A format downloaded through an index is rejected when its name or version differs from the selected entry (#207)

### Changed

- `loadConfig()` throws, naming the file, when the config file exists but cannot be read, as `loadConfigFile()` does, instead of returning `null` and ignoring the config
- CI runs coverage in its own job, with thresholds that fail the build when coverage drops, a job summary and an uploaded report

## [1.18.0] - 2026-10-05

### Added

- `CompileOptions.signal` cancels a compile's story format requests, and `watch()` passes its own signal, so aborting a watch no longer waits for a stalled download. `CompileOptions.formatFetchTimeout` (config key `formatFetchTimeout`, default 30 s, `0` turns it off) times out each format request. `resolveRemoteFormat`, `fetchAndCacheFormat` and `fetchDirectFormat` take an optional `RemoteFetchOptions` (#182)
- The array options of `CompileOptions` (`sources`, `exclude`, `modules`, `formatPaths`, `formatIndices`, `formatUrls`) accept readonly arrays
- `loadConfig()` and `loadConfigFile()` take an optional diagnostics array that receives warnings, and `unknownConfigKeyWarnings()` is exported (#159, #165)

### Fixed

- Source discovery leaves out every path a build writes, compared by real path, so an output reached through a symlink or a symlinked working directory is no longer read back as a source (#152)
- Symlinked folders inside a source folder are no longer followed, as in Tweego, so link cycles can no longer multiply files or hang the walk. A folder named directly as a source is still followed (#160)
- Naming the output file as a source, module or head file is an error ("Output file cannot be an input source."), instead of dropping the file and overwriting it with an empty build (#157)
- The Vite and Rollup plugins leave out the story HTML of every output, the chunks, assets and copied public files a build writes, and output folders inside a source folder, in builds, the dev server and watch mode. The Vite plugin reads the bundler's `output.dir`, not only `build.outDir` (#153, #155, #184)
- `rollup --watch` works when `output.dir` is a story source folder (#187)
- Restarting a Vite dev server, or building with the same plugin instance, no longer stops another server's rebuilds (#179)
- Format files that are not strict JSON are parsed without changing text inside strings, and a format that cannot be used is skipped with a warning (#154)
- Format names and IDs match without regard to letter case in local, cached and remote lookups alike, preferring an exact-case match, so a local format that differs only in case is used without a download (#156)
- A format requested by ID is found even when a newer version of the same format sits in another folder (#161)
- Prerelease format versions compare by SemVer precedence, so a release wins over its beta, and versions written `v1.0.0`, `1.0` or `1` are accepted, as in Tweego (#162, #164)
- A format folder in `formatPaths` takes precedence over one with the same name in `TWEEGO_PATH`; the search order is documented (#163)
- `--list-formats` lists cached formats under IDs that `-f` accepts, and includes `formatPaths` from the config (#174)
- The CLI prints why a story format is missing (the diagnostics of a fatal error), in one-shot and watch mode (#176)
- Downloaded story formats and compiled output are written atomically, so parallel builds sharing a cache and live-reload servers never read a half-written file. Concurrent requests for the same format within one process share one download (#173, #181)
- Formats downloaded from `formatUrls` are cached by URL and looked up before the shared name/version cache, so one project's patched copy no longer stands in for another's (#180)
- `watch()` and `twee-ts -w` write and report every build while edits keep arriving during builds (#188)
- An exception thrown from `watch()`'s `onError` no longer crashes the process (#183)
- Watch mode keeps working when a watched source folder is deleted and recreated, or replaced, and waits for a source folder that does not exist yet; a path that cannot be watched is reported (#175, #177)
- A changed file that fails to load no longer brings back its old content on a later incremental build, and `changedFiles` entries match however the path is written (#178, #170)
- Twine 1 output with `obfuscate:rot13` encodes passage names, tags and text as Twine 1.4 does (leaving `StorySettings` and `Twine.image` passages alone), so the story plays, and decompiling such HTML decodes them (#149)
- Twee output warns about passages that cannot round-trip, such as text lines starting with `::` and names with surrounding spaces or line breaks; in stylesheet and script passages such lines are indented by one space (#150)
- The Twine 1 start passage name is escaped for its `<script>` context (#151)
- Font family names generated from font file names are escaped as CSS strings (#169)
- When a story format template has no closing head tag, modules and the head file go before `<body` with a warning, instead of being dropped silently (#185)
- A StoryData passage that replaces an earlier one replaces all story metadata, as in Tweego, instead of inheriting fields it leaves out (#167)
- Passage names generated for loaded files (imported story scripts and stylesheets, CSS, JS, font and media files) are unique across the whole story: a name that is taken gets a number instead of replacing a passage (#168)
- `StoryBuilder` stays correct after direct changes to `story.passages` (#171)
- `storyInspect().passagesByTag` lists a passage once per tag (#172)
- `decompileHTML()` warns about an invalid or missing `ifid` (#186)
- A config file starting with a UTF-8 BOM loads (#158)
- Text files that are not valid UTF-8 are read as Windows-1252 with a warning, as Tweego does, instead of replacing characters with U+FFFD (#159)
- A passage header after a BOM in the middle of a Twee source (from concatenated files) is recognised (#166)

### Changed

- Unknown keys in a config file produce a warning, with a suggestion for case or `-`/`_` mismatches (#165)
- `watch()` writes and reports every finished build again, reversing the 1.17.1 change that skipped builds superseded by newer edits (#188)
- Output files are replaced by renaming a temporary file, so they get a new inode on each build and writing needs write permission on the folder (#181)
- Story format requests time out after 30 seconds by default (#182)
- Every compile warns about unusable `format.js` files in the format search folders (#154)
- Twine 1 format components with CRLF line endings are converted to LF, as in Tweego (#159)

## [1.17.1] - 2026-10-05

### Fixed

- `watch()` and CLI watch mode run one build at a time. Changes saved during a build go into one follow-up build, so a slow earlier build (such as one waiting for a remote story format) can no longer finish last and overwrite the output with older passages (#136)
- The Vite and Rollup plugins no longer read the story HTML they write back as a source when it sits inside a source folder, which restored edited and deleted passages on the next build. Watch mode no longer rebuilds without end when the HTML is written into a watched folder (#135)
- CLI watch mode prints the file list and statistics after each build with `--log-files` and `--log-stats`, as a one-shot build does (#133)
- Lint and `storyInspect(story, { target })` read no links from passages the output leaves out, such as `Twine.private` notes, StoryData and StoryTitle: their links are not reported as broken and do not keep a passage from being listed as an orphan. Script passages are still read (#134)
- Importing Twine 2 HTML keeps the story JavaScript and stylesheet when a real passage is named `Story JavaScript` or `Story Stylesheet`. The code passage gets the first free name (`Story JavaScript 2`, …) instead of being replaced (#137)
- A story title or start passage name containing a format placeholder (`{{STORY_DATA}}`, `{{STORY_NAME}}`, or Twine 1's `"STORY"` and others) no longer breaks the output: placeholders are filled from the format template in one pass, and inserted text stays literal (#138)
- A `UUID://…//` wrapped IFID in StoryData, StorySettings, `createIFID()` or imported HTML is stored and written as the bare UUID, with one wrapper in the Treaty of Babel comment instead of two (#139)
- Modules and the head file are injected before a closing head tag in any letter case or with whitespace (`</HEAD>`, `</head >`), and only into the format template, never into story data (#140)

### Changed

- `watch()` no longer writes or reports a build that changes made while it ran have superseded; the follow-up build is written and reported instead (#136)

## [1.17.0] - 2026-10-05

### Added

- `decompileHTML(html, options?)` takes `DecompileOptions` with `trim` (default `true`). With `trim: false`, Twine 2 passages, Twine 1 tiddlers and the story stylesheet and script keep their whitespace (#122)
- `storyInspect(story, { target })` checks link destinations against what Twine 2 or Twine 1 output emits. A link to a passage that the output leaves out is a broken link, and the new optional `BrokenLink.omission` says why. Without a target, inspection is unchanged. `InspectOptions`, `PassageOutputTarget`, `PassageOmission` and `OmittingTag` are now exported (#124)

### Fixed

- The CLI no longer reads its own output file back as a source when it sits inside a source folder. Before, the next build restored edited and deleted passages from the earlier output. `--lint` also leaves the output file (`-o`, or `output` in the config) out (#118)
- CLI watch mode keeps the last good output when a rebuild reports errors, instead of overwriting it with a story that cannot start; the next good save writes again. The programmatic `watch()` still writes every build (#119)
- `compileIncremental()` and `watch()` reparse a file listed as changed even when its modification time did not change, as after a timestamp-preserving write or on a filesystem with coarse timestamps (#120)
- Twee output writes the StoryData the build used, so a start passage override (`startPassage` / `-s`), test mode (`-t`) and a generated IFID survive a Twee round trip. A story without a StoryData passage gets one only when `-s` or `-t` is given (#121)
- Loading compiled HTML with `trim: false` / `--no-trim` keeps leading and trailing passage whitespace, and changing `trim` reparses a cached HTML file (#122)
- The Rollup plugin fails the build on compile errors (such as a missing starting passage or malformed Twee) and emits no HTML. Warnings go through Rollup's warnings instead of the console (#123)
- Lint and `--lint` report links to passages that Twine 2 output leaves out (passages tagged `script`, `stylesheet` or `Twine.private`, StoryData, StoryTitle, an empty StorySettings), with the reason. Links to special passages the output keeps, such as StoryInit, stay valid (#124)
- Short lines of unclosed link markup (`[[unfinished`) no longer use up the link scan budget, which left later links in the passage unchecked (#125)
- Lint and inspection read no links from stylesheets (passages tagged `stylesheet` and loaded `.css` files), so CSS such as `content: "[[Decorative]]"` is no longer a broken link (#126)

### Changed

- Twee output built with test mode records `"options": ["debug"]` in StoryData, so compiling that Twee again keeps debug mode on without `-t` (#121)

## [1.16.1] - 2026-10-05

### Security

- `clearCachedFormats(name)` and `twee-ts cache clear <name>` reject a name that is not a single cache entry, such as `..` or one containing a path separator, instead of recursively deleting a folder outside the format cache. A symlinked cache entry is never followed (#86)
- Story formats downloaded from an index or a direct URL are cached only when their name and version are safe directory names (the version must be SemVer), and never through a symlinked cache folder. Before, a format named `../../escaped` was written outside the cache (#87)

### Fixed

- The default format `sugarcube-2` (and any other format ID, such as `harlowe-3`) now resolves from the Story Format Archive and from direct format URLs, which name formats `SugarCube` / `Harlowe`. Before, a fresh project with no local formats failed with "No story format available for HTML output." (#89)
- The download cache is checked before the network, so a format downloaded once works offline and with `noRemote` / `--no-remote` (#92)
- A Harlowe format with a function-valued `setup` property loads from a direct URL, not only from a local `harlowe-*` folder (#93)
- Full HTML output writes the story format it was built with into `<tw-storydata format format-version>`, rather than the StoryData values, which may be empty or name another format. Archive output keeps the source values (#91)
- An explicit `startPassage` / `-s` now reaches JSON output (`start`), the returned `Story`, and lint and inspection, which no longer list it as an orphan (#95)
- HTML output reports an error when the starting passage is left out of the story data: a special passage (`StoryData`, `StoryTitle`), or one tagged `script`, `stylesheet` or `Twine.private`. Before, the output had `startnode=""` (#108)
- `lint()` and `--lint` report a missing or left-out starting passage as an error, without needing a story format (#96)
- `compileToFile()` and `watch()` no longer read their own output back as a source when it sits inside a source folder, which restored stale passages on the next build (#88)
- Watch mode rebuilds with the new content when a source given as a single file changes, including when an editor saves by replacing the file (#103)
- Watch mode rebuilds when the head file changes, wherever it lives and whatever its extension (#104)
- `vite build --watch` and `rollup --watch` rebuild when sources, modules or the head file change, including files added to or deleted from a source folder (#105)
- In-memory sources (`{ filename, content }`, string or Buffer) and `parseTwee()` strip a leading BOM and normalize CRLF and CR line endings, as file sources already did. Before, CRLF after a tag or metadata block was a fatal lexer error (#97)
- Loading Twine 2 HTML keeps the story name, as a `StoryTitle` passage, so HTML-to-Twee and HTML-to-HTML conversions no longer lose the title (#98)
- Decompiling Twine 2 HTML keeps story-level tags (`<tw-storydata tags>`) (#99)
- Decompiling Twine 1 HTML built with `obfuscate:rot13` decodes the passages, so they are not encoded twice on recompiling (#100)
- `compileIncremental()` reparses a cached file when `trim` or `twee2Compat` changed since it was cached. `FileCacheEntry` has a new optional `parseOptionsKey` field; an entry without it is reparsed once (#106)
- Story JavaScript, stylesheets and head modules containing `</script` or `</style`, even inside a string, no longer end their element early in Twine 2 output. Such sequences are written as `<\/script` / `<\/style`, which leaves the code's meaning unchanged, and a `<!--` that would stop the element from closing is escaped too (#107)
- Lint and inspection read reverse-arrow links (`[[Room<-go]]`) and links with setters (`[[go->Room][$x to 1]]`, brackets in the setter included), and ignore links inside comments (`<!-- -->`, `/% %/`, `/* */`) and outside strings in JavaScript (#101, #102)
- `twee-ts --init` no longer overwrites an existing `src/StoryData.tw` or `src/Start.tw` (and its IFID); files that already exist are reported as skipped (#85)

### Changed

- The CLI exits with status 1 when a build reports errors, and then writes no output file and nothing to stdout, as Tweego does. A missing IFID is one such error, so a story without one no longer builds. Watch mode reports the errors and keeps watching (#94)
- A requested story format that is unavailable is now an error instead of a silent switch to another format. The request is the explicit `formatId` / `-f`, else the StoryData format, else `sugarcube-2`. Before, a StoryData request for Harlowe could compile with SugarCube, and an explicit `formatId` was ignored during the remote fallback. When only an older version of the same major version is available, it is still used, with a warning (#90)
- A default compile that finds a suitable format in the download cache uses it instead of fetching a newer one (#92)
- Link markup is split at the first `|`, `->` or `<-`, as SugarCube does: `[[a|b->c]]` targets `b->c` (#101)
- `parseFormatJSON()`'s second argument is now optional and ignored (#93)

## [1.16.0] - 2026-10-05

### Added

- `exclude` option: glob patterns for source files to leave out, matched against each file's path relative to the working directory. It works in `compile()`, `compileToFile()`, `compileIncremental()` and `watch()`, as the `exclude` key in `twee-ts.config.json`, as `--exclude <glob>` (repeatable) on the CLI, and as `compileOptions.exclude` in the Vite and Rollup plugins. Like Tweego, twee-ts loads every image, audio and video file in a source folder as a base64 passage, so artwork kept next to the passages and served separately went into the HTML a second time; with enough of it the build failed with `RangeError: Invalid string length`. In watch mode and the Vite dev server, a change to an excluded file triggers no rebuild. Modules and the head file are never excluded. Needs Node.js 22.5 or newer, for `path.matchesGlob` (#83)

## [1.15.4] - 2026-10-02

### Fixed

- Vite plugin: the dev server no longer keeps serving an old story after a story folder is deleted and created again, as `git rebase` can do. In that case chokidar stops watching the folder, and under Deno a watcher reopened in the same tick gets no events at all (denoland/deno#36937). Each request for the story now compares the sources, the head file and the modules with what the last compile read, and compiles again first if any were added, removed or changed; a request with nothing changed compiles nothing (#80)
- `storyInspect()`, `lint()` and `--lint` now check `<<link>>` and `<<goto>>` calls whose label or passage name contains an apostrophe or a double quote, reading their string arguments as SugarCube does, escapes included. Before, those calls were skipped, so a missing passage behind one went unreported (#79)

## [1.15.3] - 2026-09-25

### Fixed

- Vite plugin with `entry`: the dev server now rebuilds the story when a file the entry's CSS reaches changes — a stylesheet pulled in through a nested `@import`, or a font or image referenced with `url()` — and when a file imported with `?raw` or `?inline` changes. Before, only a change to a JavaScript module or a story source rebuilt it. Files registered with `addWatchFile` by any plugin in the entry build, including per-environment plugins, now count; plugin objects are wrapped as copies and never modified

## [1.15.2] - 2026-09-25

1.15.1 was tagged but never reached npm (its publish failed); its changes ship in this release.

### Fixed

- A source or module path that does not exist or cannot be read is reported as a warning (`path <p>: …`), as Tweego does, instead of being skipped silently. Before, the first sign was often an unrelated error such as "Story IFID not found"

### Changed

- Built with tsdown instead of tsup, which is no longer maintained. The published files, exports and types are unchanged, and the TypeScript 6 `ignoreDeprecations` workaround is gone (#57)
- Development dependencies updated to their latest versions, including TypeScript 7 and Vitest 5. This clears all open Dependabot alerts; none affected the published package, which has no runtime dependencies
- GitHub Actions updated to their Node 24 releases
- Published from GitHub Actions through npm trusted publishing, so the package now carries npm provenance

## [1.15.0] - 2026-09-25

### Added

- Vite plugin `entry` option: bundles a JS/TS file and the CSS it imports into the story as Story JavaScript and Story Stylesheet (Vite 8). Fonts and images it uses are inlined, so the story stays one file; a `?no-inline` import is written next to the HTML and served in dev
- The Vite plugin warns when the entry's folder is inside `sources`

### Fixed

- Vite plugin dev server: the page now loads Vite's client, so reloads reach it; compile and bundling errors appear in Vite's overlay while the last good story keeps being served
- Vite plugin dev server: changes to `.js`/`.css` sources, the head file, modules and the entry's imports now recompile the story; rapid saves are compiled once; a save that keeps the old modification time is picked up
- Vite plugin dev server: no rebuild starts after the server closes, including in middleware mode, and a failure while reporting an error no longer stops later rebuilds
- Vite plugin build: compile errors fail the build, naming file and line once
- Vite plugin build without an entry: needs no `index.html`, and an `index.html` in the project root no longer replaces the story (it did on Vite 5 and 6)
- In-memory `.js` and `.css` sources are loaded as script and stylesheet instead of being dropped
- The CLI and `creator-version` report the published version instead of 1.2.0

### Changed

- `vite` is an optional peer dependency (`>=5`) of `@rohal12/twee-ts/vite`

## [1.14.0] - 2026-03-28

### Added

- TypeScript 6.0 support

### Changed

- Bump htmlparser2 from 10.1.0 to 12.0.0
- Bump picomatch from 4.0.3 to 4.0.4

## [1.13.1] - 2026-03-19

### Fixed

- `String.replace` `$&` corruption when inlining JS modules — `$&`, `` $` ``, `$'`, and `$<digits>` in module content were silently replaced by `String.replace()` special patterns, corrupting bundled JavaScript ([#46](https://github.com/rohal12/twee-ts/issues/46))
- Same `String.replace` corruption in Twine 2 and Twine 1 HTML output renderers when story content contains replacement patterns

## [1.13.0] - 2026-03-06

### Added

- Branded `IFID` type for compile-time safety — prevents passing unvalidated strings where an IFID is expected ([#25](https://github.com/rohal12/twee-ts/issues/25))
- `createIFID()` function to validate and brand an IFID string
- `ReadonlyStory` and `ReadonlyPassage` types for immutable post-construction access ([#26](https://github.com/rohal12/twee-ts/issues/26))
- `StoryBuilder` class that separates mutable construction from immutable consumption ([#8](https://github.com/rohal12/twee-ts/issues/8))
- `Diagnostic` is now a discriminated union on `level`, with optional `fatal` field on error diagnostics ([#9](https://github.com/rohal12/twee-ts/issues/9))
- `ItemType` converted from `const enum` to `const` object pattern for runtime access and `--isolatedModules` compatibility ([#11](https://github.com/rohal12/twee-ts/issues/11))

### Changed

- `CompileResult.story` now returns `ReadonlyStory` instead of `Story`
- Output renderers (`toTwine2HTML`, `toTwine2Archive`, `toTwine1HTML`, `toTwee`) now accept `ReadonlyStory` and no longer take `diagnostics` parameter — they are pure transforms ([#12](https://github.com/rohal12/twee-ts/issues/12))
- `ensureIFID()` moved from output phase to compilation phase in `buildOutput()` ([#12](https://github.com/rohal12/twee-ts/issues/12))
- `storyInspect()` now accepts `ReadonlyStory`
- Lexer `emit()` now has a comment block explaining the line-counting invariant ([#10](https://github.com/rohal12/twee-ts/issues/10))

## [1.12.0] - 2026-03-06

### Added

- HTML decompiler: parse compiled Twine 2 and Twine 1 HTML files back into a `Story` model ([#18](https://github.com/rohal12/twee-ts/issues/18))
  - Twine 2: parses `<tw-storydata>`, `<tw-passagedata>`, `<style>`, `<script>`, and `<tw-tag>` elements
  - Twine 1: parses `<div id="store-area">` / `<div id="storeArea">` with `<div tiddler="...">` children, including tiddler unescape
  - Resolves start passage from `startnode` pid, preserves passage metadata (position, size, tags)
- `decompileHTML()` and `DecompileResult` type exported from the public API
- `.htm` and `.html` files now supported as compile inputs — enables `twee-ts -d story.html -o story.twee` round-trip workflow
- `htmlparser2` bundled as a dev dependency (zero runtime deps maintained via tsup bundling)

## [1.11.0] - 2026-03-06

### Added

- Configurable word counting method via `wordCountMethod` option ([#21](https://github.com/rohal12/twee-ts/issues/21))
  - `"tweego"` (default): NFKD normalize, divide character count by 5 (matches Tweego output)
  - `"whitespace"`: standard whitespace-based word count after stripping comments, macros, links, and HTML tags
- `--word-count-method` CLI flag
- `wordCountMethod` config file option
- `WordCountMethod` type exported from the public API
- JSON Schema section in the configuration docs explaining `$schema` usage and SchemaStore integration

## [1.10.0] - 2026-03-06

### Added

- JSON Schema for `twee-ts.config.json` — provides editor autocomplete and validation in VS Code, WebStorm, and other JSON Schema-aware editors ([#23](https://github.com/rohal12/twee-ts/issues/23))
- `scaffoldConfig()` now emits a `$schema` field pointing to the published schema
- Schema published alongside the npm package at `schemas/twee-ts.config.schema.json`

## [1.9.0] - 2026-03-06

### Added

- Vite plugin incremental compilation — persistent cache across rebuilds, dev server middleware serving compiled output, and incremental recompilation on `.tw`/`.twee` file changes via HMR ([#38](https://github.com/rohal12/twee-ts/issues/38))
- `compileIncremental()` public API function for plugins and advanced users to manage their own cache and changed-file tracking
- `FileCacheEntry` type exported from the public API
- CI test coverage reporting with `@vitest/coverage-v8`

## [1.8.0] - 2026-03-06

### Added

- `twee-ts cache` CLI subcommand for managing the remote format cache ([#24](https://github.com/rohal12/twee-ts/issues/24)):
  - `cache list` — list cached formats with name, version, size, and modification date
  - `cache clear [name]` — delete all cached formats or only those matching a name
  - `cache size` — show total cache size and format count
  - `cache path` — print the cache directory path
- `listCachedFormats()`, `clearCachedFormats()`, `getCacheSize()` programmatic API functions
- `CachedFormatEntry` type exported from the public API

## [1.7.0] - 2026-03-06

### Added

- `--lint` CLI flag for linting story structure without producing output — reports broken links, dead ends, orphans, and compilation diagnostics ([#16](https://github.com/rohal12/twee-ts/issues/16), [#20](https://github.com/rohal12/twee-ts/issues/20))
- `lint()` and `formatLintReport()` programmatic API functions for CI/CD integration
- `LintResult` type exported from the public API
- Exit code 1 when lint finds errors (broken links, compilation errors); warnings do not cause non-zero exit

## [1.6.0] - 2026-03-06

### Added

- Incremental compilation in watch mode — cached parsed passages per source file with mtime-based invalidation, so only changed files are re-read and re-parsed on rebuild ([#14](https://github.com/rohal12/twee-ts/issues/14))
- `FileCacheEntry` internal type for the passage cache
- `loadSourcesCached()` loader function with optional `changedFiles` parameter to skip stat calls for unchanged files
- `watchFilesystem` now passes changed filenames to the build callback during the debounce window, enabling O(changed) stat calls instead of O(n)

## [1.5.1] - 2026-03-06

### Changed

- Passage lookups (`storyHas`, `storyGet`, `storyIndex`) now use an O(1) name index instead of linear scans, improving performance for large projects ([#27](https://github.com/rohal12/twee-ts/issues/27))

## [1.5.0] - 2026-03-06

### Added

- Source location tracking for passages — the parser now records source file and line number on every parsed passage (`Passage.source`)
- `--source-info` CLI flag and `sourceInfo` compile option to emit `data-source-file` and `data-source-line` attributes on `<tw-passagedata>` elements in HTML output
- `SourceLocation` type exported from the public API

## [1.4.0] - 2026-03-05

### Added

- ROT13 obfuscation support for Twine 1 output — when `obfuscate:rot13` is set in `StorySettings`, tiddler content is ROT13-encoded (except `StorySettings` itself, per spec)
- `created` and `modifier` attributes on Twine 1 tiddler elements per the Twine 1 HTML output spec
- `fullAttrEscape()` utility for spec-compliant attribute escaping (escapes `<`, `>`, `&`, `"`, `'`)
- `rot13()` utility function for ROT13 encoding
- `tags` attribute on `<tw-storydata>` element per the Twine 2 HTML output spec
- Relaxed JSON parsing for story format metadata — handles trailing commas, single-quoted strings, and unquoted property keys (e.g. Harlowe)
- SemVer-based format version pruning — within each `(name, major)` group, only the highest `minor.patch` version is kept
- Optional story format metadata fields: `author`, `description`, `image`, `url`, `license`
- Twine 1 formats now use the folder name as a default format name
- Unnamed Twine 2 story formats default to `"Untitled Story Format"` per spec
- Arbitrary passage metadata keys preserved through parsing, marshalling, and JSON output (not just `position`/`size`)

### Changed

- Tag colors in `<tw-tag>` elements are now validated against the spec: only the 7 named colors (`gray`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`) and hex color values are emitted
- Trailing blank lines are stripped from passage content regardless of the `trim` option, per the Twee 3 spec (MUST requirement)
- `StoryData` JSON decode errors downgraded from `error` to `warning` diagnostic level
- IFID missing error message simplified to `"Story IFID not found. Add an IFID to your story: ..."`
- Twine 1 `storeArea` div no longer includes the `hidden` attribute

## [1.3.0] - 2026-03-05

### Added

- Twine spec compliance test suites in `specs/` validated against the official [iftechfoundation/twine-specs](https://github.com/iftechfoundation/twine-specs):
  - `twine1-htmloutput-spec.test.ts` — 34 tests covering Twine 1 HTML output (root structure, passage attributes, tiddler escaping, special passages, Twine.private filtering)
  - `twine2-htmloutput-spec.test.ts` — 59 tests covering Twine 2 HTML output
  - `twine2-archive-spec.test.ts` — 20 tests covering Twine 2 archive output
  - `twine2-jsonoutput-spec.test.ts` — 39 tests covering Twine 2 JSON output
  - `twine2-storyformats-spec.test.ts` — 21 tests covering story format discovery
  - `twee3-spec.test.ts` — 125 tests covering Twee 3 syntax
- Spec test suites included in vitest config (`specs/**/*.test.ts`)

### Changed

- JSON output now follows the [Twine 2 JSON Output Specification](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-jsonoutput-doc.md): top-level `format`, `format-version`, `start`, `tag-colors`, `zoom`, `creator`, `creator-version`, `style`, `script` keys instead of nested `twine2` object
- JSON output excludes `StoryTitle`, `StoryData`, `Twine.private`, `script`, and `stylesheet` passages from the passages array (scripts/stylesheets merged into top-level `style`/`script` fields)
- Missing IFID diagnostic changed from `warning` to `error` with actionable message showing the required StoryData JSON
- Twine 2 zoom attribute uses `String()` instead of conditional `toFixed(1)` for simpler, lossless formatting

### Fixed

- IFID is now set on the story object before the diagnostic is pushed (consistent ordering)
- `.vscode-diagnostics.json` added to `.gitignore`

## [1.2.0] - 2026-03-05

### Added

- `jsStringEscape()`, `commentSanitize()`, and `htmlCommentSanitize()` escape utilities for safe injection into JS strings, block comments, and HTML comments
- `src/util.ts` — shared file I/O utilities (`readUTF8`, `readBase64`, `baseNameWithoutExt`)
- `src/version.ts` — single source of truth for the package version constant
- Exhaustive `never` default cases in output mode switch (compiler) and lexer item type switch (parser)
- SFA index validation (`validateSFAIndex`, `isValidEntry`) with structural type checks
- Test for non-mutation of original passages in `applyTagAliases`

### Changed

- `applyTagAliases` now returns new passage array instead of mutating input (immutable API)
- `storyAdd` creates new passage objects instead of mutating input passages
- `findEntry` now returns `{ entry, formatType }` so download URLs use the correct twine1/twine2 path
- All `JSON.parse` calls validated with runtime type checks before casting
- Replaced non-null assertions (`!`) with optional chaining and defaults throughout
- Replaced `basename(f).split('.')[0]!` pattern with `baseNameWithoutExt()`
- Deduplicated `readUTF8`/`readBase64` from formats.ts, loader.ts, and modules.ts into shared util
- Plugin `generateBundle` uses typed `this` parameter instead of `this as unknown as ...` cast
- Error handlers now use typed `catch (e: unknown)` with `instanceof Error` checks
- Remote format errors propagated with context instead of silently swallowed
- Head file read errors reported as diagnostics instead of silently ignored
- Unknown file extensions return `application/octet-stream` instead of empty string
- CLAUDE.md expanded with TypeScript best practices and PR review guidelines

### Fixed

- `tweeUnescape` now preserves trailing backslash instead of silently dropping it
- Remote format download URL uses correct `twine1`/`twine2` path based on format type
- Removed `htm`/`html` from known source extensions (not valid Twee source files)
- Output escaping: passage names sanitized in CSS/JS block comments, HTML comments, and JS string literals

## [1.1.2] - 2026-03-04

### Changed

- Update vitest from v3 to v4
- Add prettier with CI formatting check

## [1.1.1] - 2026-03-04

### Fixed

- Set `publishConfig.access` to `public` for scoped package

## [1.1.0] - 2026-03-04

### Added

- Tag aliases: map custom tags to special tags (e.g. `library` → `script`) via config (`tagAliases`), CLI (`--tag-alias`), or programmatic API
- `applyTagAliases()` exported from the public API for direct use
- VitePress documentation site with dedicated pages for CLI, configuration, tag aliases, output modes, API, plugins, and story formats
- GitHub Actions workflows for CI, docs deployment, and automated npm releases

### Changed

- README trimmed to a concise overview linking to the full docs site
- `story-format-packages.md` moved under VitePress with frontmatter

## [1.0.1] - 2026-03-04

### Fixed

- Use scoped package name in npx commands

## [1.0.0] - 2026-03-04

### Added

- Tag aliases: map custom tags to special tags (e.g. `library` → `script`) via config (`tagAliases`), CLI (`--tag-alias`), or programmatic API
- `applyTagAliases()` exported from the public API for direct use
- VitePress documentation site with dedicated pages for CLI, configuration, tag aliases, output modes, API, plugins, and story formats
- GitHub Actions workflow for CI (test matrix on Node 22 and 24)
- GitHub Actions workflow for deploying docs to GitHub Pages
- GitHub Actions workflow for automated npm releases via `release-npm-action`
- Unit tests for `applyTagAliases` (idempotency, no duplication, empty map, no-op)
- Config validation tests for `tagAliases` field
- Integration tests: `library` alias treated as `script`, `theme` alias treated as `stylesheet` in Twine 2 HTML output
- `packageManager` field in `package.json` for CI compatibility with `pnpm/action-setup`
- `docs:dev`, `docs:build`, and `docs:preview` scripts

### Fixed

- Add `packageManager` field for pnpm/action-setup
- Guard release and docs workflows to only run on main

## [0.1.0] - 2026-03-03

### Added

- Initial release: complete TypeScript reimplementation of Tweego
- Twee lexer (synchronous generator) and parser
- Story model with Twine 1 and Twine 2 metadata
- Output modes: HTML, Twee 3, Twee 1, Twine 2 archive, Twine 1 archive, JSON
- Story format discovery with SemVer matching
- Remote format fetching from the Story Formats Archive with local caching
- File loading for `.tw`, `.twee`, `.css`, `.js`, font, and media files
- CLI with full Tweego-compatible flag set
- Config file support (`twee-ts.config.json`) with validation
- `--init` scaffolding command
- Watch mode with filesystem polling
- Programmatic API: `compile()`, `compileToFile()`, `watch()`
- Vite and Rollup plugins
- Inline source support (pass Twee content without files on disk)
- Twee2 compatibility mode
- IFID generation and validation
- HTML, attribute, tiddler, and Twee escaping utilities
- Story inspection API (`storyInspect`) for broken link detection
- `TweeTsError` with collected diagnostics
- 129 tests across 11 test suites

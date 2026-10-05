# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A same-major older story format from the project's configured format URLs is used, with the older-version warning, when no at-or-above version is available, as for local and shared-cache formats (#224)

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

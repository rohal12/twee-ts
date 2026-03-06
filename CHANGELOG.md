# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

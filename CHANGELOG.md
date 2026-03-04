# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-3-4

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

### Changed

- README trimmed to a concise overview linking to the full docs site
- `story-format-packages.md` moved under VitePress with frontmatter

## [0.1.0] - 2026-3-3

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

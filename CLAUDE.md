# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**twee-ts** is a TypeScript reimplementation of [Tweego](https://www.motoslave.net/tweego/) (a Go-based Twee-to-HTML compiler for Twine interactive fiction). The Go reference source lives in `./tweego/`.

## Stack

- Node.js 22+, zero runtime dependencies
- TypeScript 5.9+ with strict mode (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`)
- pnpm package manager
- tsup for bundling (ESM + CJS dual output)
- Vitest for testing
- Prettier for formatting
- VitePress for documentation

## Architecture

### Compilation pipeline

`.twee` files → **lexer** (generator/yield state machine) → **parser** (tokens → Passage[]) → **StoryBuilder** (assembles Story model) → **output renderer** (Twine 2 HTML, Twine 1 HTML, or Twee source)

The **compiler** (`compile()`, `compileToFile()`, `watch()`) orchestrates this pipeline end-to-end. The **loader** handles file I/O for all input types (twee, css, js, media, fonts).

### Key source layout

```
src/
  types.ts        — All public interfaces (single source of truth for types)
  index.ts        — Public API surface (re-exports from implementation modules)
  lexer.ts        — State-machine generator (function* + yield), ports Go's goroutine+channel pattern
  parser.ts       — Consumes lexer items → Passage[]
  story.ts        — StoryBuilder: assembles Story model, StoryData JSON marshal/unmarshal
  compiler.ts     — Main orchestrator: compile(), compileToFile(), watch()
  output-twine2.ts, output-twine1.ts, output-twee.ts — Output renderers
  formats.ts      — Story format discovery with SemVer matching
  remote-formats.ts — Remote format fetching from Story Format Archive
  loader.ts       — File loading (twee, css, js, media, fonts)
  html-parser.ts  — Decompile Twine HTML back to Story model
  inspect.ts      — Story inspection (passage map, broken links)
  lint.ts         — Linter for story validation
  config.ts       — Config file loading and validation
  plugins/        — Vite and Rollup plugins
bin/
  twee-ts.ts      — CLI entry point
test/
  *.test.ts       — Unit tests (one per src module)
  fixtures/       — Test fixtures including minimal story formats
specs/
  *.test.ts       — Specification conformance tests (Twee3, Twine HTML output, etc.)
```

## Code style

- Single quotes, trailing commas, 120 char print width, 2-space indent (enforced by Prettier)
- Use `import type` for type-only imports
- Prefer `node:` prefix for Node.js built-in imports (e.g. `node:fs`, `node:path`)
- Use `.js` extensions in relative imports (required by Node16 module resolution)
- Errors: collect diagnostics in results; only throw `TweeTsError` for fatal conditions
- No default exports; use named exports everywhere
- Types go in `src/types.ts`; implementation files import from there

## TypeScript best practices

Follow type-first development: define data models and function signatures before implementation, then let the compiler guide completeness.

### Make illegal states unrepresentable

- Use discriminated unions for mutually exclusive states (e.g. `ItemType` enum, `OutputMode` literal union)
- Use `const` assertions for literal unions that need both a runtime array and a type
- Be explicit about required vs optional fields in interfaces

### Exhaustive handling

- Use exhaustive `switch` with a `never` check in the default case for union types:
  ```ts
  default: {
    const _exhaustive: never = value;
    throw new Error(`unhandled case: ${_exhaustive}`);
  }
  ```
- Every code path must return a value or throw

### Functional patterns

- Prefer `const` over `let`; use `readonly` and `Readonly<T>` for immutable data
- Prefer `array.map/filter/reduce` over `for` loops where readability allows
- Write pure functions for business logic; isolate side effects in dedicated modules
- Avoid mutating function parameters; return new objects/arrays instead

### Error handling

- Propagate errors with context; catching requires re-throwing or returning a meaningful result
- Handle edge cases explicitly: empty arrays, `undefined` inputs, boundary values
- Use `await` for async calls; wrap external calls with contextual error messages
- Validate data at system boundaries (CLI args, file input, network responses) with manual checks (no Zod — zero runtime deps)

## Testing

- Run: `pnpm test`
- Tests use Vitest with `describe`/`it`/`expect`
- Test fixtures in `test/fixtures/`
- Real-world validation: the `../tweego/CleanSlate/` project (605 passages, 241K words) compiles successfully
- Add or update focused tests when changing logic; test behavior, not implementation details
- New features need tests; bug fixes need regression tests

## Commands

- `pnpm test` — run all tests (unit + spec conformance)
- `pnpm test test/lexer.test.ts` — run a single test file
- `pnpm test -t "test name"` — run tests matching a name pattern
- `pnpm run test:watch` — run tests in watch mode
- `pnpm run test:coverage` — run tests with V8 coverage report
- `pnpm run typecheck` — strict type checking
- `pnpm run build` — production build (ESM + CJS via tsup)
- `pnpm run format:check` — check formatting
- `pnpm run format` — fix formatting
- `pnpm run docs:dev` — local VitePress dev server

## Releasing

Releases use `tobua/release-npm-action@v3` (`.github/workflows/release.yml`), which runs on every push to `main`. It reads `CHANGELOG.md` to detect whether a new version exists vs what's published on npm. If the latest changelog version is newer, it bumps `package.json`, creates a git tag, and publishes to npm.

### How to release

1. **Create a release branch** named `release/X.Y.Z`
2. **Rebase onto latest main** before committing — ensures clean history
3. **Run all checks**: `pnpm run format && pnpm run typecheck && pnpm test && pnpm run build`
4. **Update `CHANGELOG.md`** with a new version section using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format:

   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD

   ### Added

   - ...
   ```

   Do NOT update `package.json` version manually — the action handles that.

5. **Open a PR** with title `release: vX.Y.Z` and reviewer `rohal12`
6. **CRITICAL**: The PR body MUST contain `release-npm` as a standalone line. The action looks for this annotation in the merge commit message body to trigger a publish. Without it, the action skips with `No release requested.`
7. **After merge**, the release workflow runs typecheck + tests + build, then publishes. Verify: `npm view @rohal12/twee-ts version`

### SemVer rules

- **patch** (X.Y.Z+1): bug fixes, test additions, formatting
- **minor** (X.Y+1.0): new features, new exports, new CLI flags
- **major** (X+1.0.0): breaking API changes, removed exports, changed behavior

### Commit message conventions

| Prefix   | Use for                    |
| -------- | -------------------------- |
| `feat:`  | New features, new exports  |
| `fix:`   | Bug fixes                  |
| `docs:`  | Documentation only         |
| `style:` | Formatting, no code change |
| `test:`  | Adding/updating tests      |
| `chore:` | Tooling, CI, dependencies  |

## PR review guidelines

When reviewing PRs, check for:

1. **Type safety** — no `any` casts, no `@ts-ignore`, no non-null assertions (`!`) without justification
2. **Exhaustive handling** — switch statements on union types must have a `never` default case
3. **Import style** — `import type` for types, `node:` prefix for builtins, `.js` extensions on relative imports
4. **Error handling** — diagnostics collected in results, `TweeTsError` only for fatal errors, errors propagated with context
5. **Immutability** — prefer `const`, `readonly`, and `Readonly<T>`; avoid mutating function parameters
6. **Test coverage** — new features need tests, bug fixes need regression tests
7. **No runtime deps** — this is a zero-dependency package; dev dependencies only
8. **Backwards compatibility** — public API changes in `src/types.ts` and `src/index.ts` must be intentional
9. **Formatting** — code passes `pnpm run format:check`

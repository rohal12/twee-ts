# CLAUDE.md

This is the root instruction file for Claude Code and Claude Code GitHub Actions.

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

```
src/
  lexer.ts        — State-machine generator (function* + yield), ports Go's goroutine+channel pattern
  parser.ts       — Consumes lexer items → Passage[]
  story.ts        — Story builder, StoryData JSON marshal/unmarshal
  compiler.ts     — Main orchestrator: compile(), compileToFile(), watch()
  output-twine2.ts, output-twine1.ts, output-twee.ts — Output renderers
  formats.ts      — Story format discovery with SemVer matching
  remote-formats.ts — Remote format fetching from Story Format Archive
  loader.ts       — File loading (twee, css, js, media, fonts)
  types.ts        — All public interfaces (single source of truth)
  plugins/        — Vite and Rollup plugins
bin/
  twee-ts.ts      — CLI entry point
test/
  fixtures/       — Test fixtures including minimal story formats
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

- `pnpm test` — run tests
- `pnpm run typecheck` — strict type checking
- `pnpm run build` — production build
- `pnpm run format:check` — check formatting
- `pnpm run format` — fix formatting

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

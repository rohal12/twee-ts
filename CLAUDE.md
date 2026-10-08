# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**twee-ts** is a TypeScript reimplementation of [Tweego](https://www.motoslave.net/tweego/) (a Go-based Twee-to-HTML compiler for Twine interactive fiction). The Go reference source lives in `./tweego/`.

## Stack

- Node.js 24+, zero runtime dependencies: parse5 (HTML) and acorn (JavaScript) are bundled into `dist/`, and `THIRD_PARTY_NOTICES` covers them
- TypeScript 7 (native compiler) with strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters` and the rest of `tsconfig.json`)
- pnpm package manager
- tsdown for bundling (ESM + CJS dual output, one build graph)
- Vitest for testing, fast-check for property-based tests
- ESLint (typescript-eslint strict), knip, Prettier
- VitePress for documentation

## Architecture

### Compilation pipeline

Sources → **loader** (by extension; Twee, Twine HTML, CSS, JS, media, fonts) → **lexer** (generator state machine) → **parser** (items → Passage[]) → **StoryBuilder** (the story model, derived from its passages) → **format resolution** (local folders, format URLs, format indices) → **output renderer** (Twine 2 / Twine 1 HTML or archive, Twee 3 / Twee 1, JSON) → **output check** and atomic write.

The **compiler** (`compile()`, `compileToFile()`, `watch()`, `compileIncremental()`) runs the pipeline. Every path comparison goes through **path-identity**; every input failure is decided by **input-policy**.

### Source layout

```
src/
  index.ts             Public API surface (re-exports only)
  types.ts             Public interfaces (single source of truth for types)
  compiler.ts          compile(), compileToFile(), watch(), compileIncremental(); TweeTsError
  cli-request.ts       CLI argv → typed request (parseCliArgs), merged with the config (resolveBuild)
  config.ts            Config loading; CONFIG_SPEC is the one table behind validation and the JSON schema
  loader.ts            Loads each input type; media-types.ts maps extensions
  filesystem.ts        Source walk, exclude globs, output overlap checks, watch mode
  path-identity.ts     Canonical path identity (real path, case folding per volume, Windows forms)
  input-policy.ts      One table: what each input role does when it can't be used
  atomic-write.ts      Writes output and cache files by what is at the target path
  source-text.ts, util.ts  Text decoding (UTF-8/16, Windows-1252 fallback) and normalisation
  twee-syntax.ts       Shared Twee rules: Go whitespace, escaping, header lines
  lexer.ts, parser.ts  Twee → passages; twee2-compat.ts converts Twee2 headers
  story.ts             StoryBuilder and StoryData/StorySettings/StoryTitle decoding
  passage.ts, passage-omission.ts, start-passage.ts  Passage helpers, which passages an output leaves out
  json-decode.ts       Strict JSON parser and typed decoders (duplicates kept, own-property safe)
  formats.ts           Local format discovery and the one selection policy
  format-resolution.ts Gathers candidates from every source, selects, obtains
  format-decode.ts     Reads format.js with acorn, never evaluating it
  remote-formats.ts    Format URLs and indices: requests, limits, checksums
  format-cache.ts      The download cache, keyed by provenance
  semver.ts            SemVer 2.0.0 with Tweego's extensions
  js-syntax.ts, js-chars.ts, javascript-strings.ts  The one way to read JavaScript (acorn) and its character classes
  html-structure.ts    Every location in HTML, from a parse5 parse (never by matching markup)
  html-parser.ts       Decompiles Twine 2 / Twine 1 HTML
  template.ts, escape.ts, code-context.ts, modules.ts  Format template filling, per-context escaping, head injection
  html-output-check.ts Text HTML cannot carry; code the escapers change
  output-twine2.ts, output-twine1.ts, output-twee.ts, twine1-obfuscation.ts  Renderers
  inspect.ts, lint.ts, link-markup.ts, sugarcube-macros.ts  Link graph, lint, SugarCube link/macro reading
  ifid.ts, word-count.ts, version.ts
  plugins/
    options.ts         Options both plugins share, checked once (PluginCompileOptions)
    vite.ts, vite-dev.ts, vite-entry.ts  Vite plugin, dev server, `entry` bundling
    rollup.ts          Rollup plugin
    diagnostics.ts, paths.ts, watch-targets.ts  Shared plugin helpers
bin/twee-ts.ts         CLI entry point
scripts/               Package check, duplication measurement, licence notices, ESLint restrictions
validation/contracts/  The compiler contract matrix, run against dist/ (vitest.contracts.config.ts)
validation/release/    The release gate: review areas, evidence record checks (gate.ts), the command
validation/evidence/   Committed evidence records and review reports, one folder per release
test/                  *.test.ts (unit, property, differential); helpers/; fixtures/
                       docs-snippets.test.ts and docs-reference.test.ts keep the docs executable and in sync
specs/                 Specification conformance tests (Twee 3, Twine HTML/archive/JSON, story formats)
```

## Hardening rules

- **Spec-exact parsers only.** Read HTML with parse5 (`html-structure.ts`), JavaScript with acorn (`js-syntax.ts`), JSON with `json-decode.ts`, versions with `semver.ts`. No ad-hoc scanners; state the supported subset where full support isn't intended and reject the rest with a diagnostic, never silently produce another value.
- **No literal HTML matching.** Never search markup text for tags, doctypes or the store area (ESLint enforces it outside `html-structure.ts`).
- **Own-property-safe objects.** Objects built from untrusted keys use `Map`, `Object.create(null)` or `Object.fromEntries`/`defineProperty`; `__proto__` must survive as an ordinary key (ESLint bans `__proto__` literals).
- **Fix the defect class, not the case.** Enumerate the input dimension (spec states, grammar productions, file types, option sources, platforms) and cover it with table-driven, property-based (fast-check) or differential tests against an oracle; every reported defect gets a regression test that failed first.
- **Duplication budget.** `duplication-budget.json` may only go down; remove a new clone rather than raise it.
- **Docs are tested.** Every code block in README.md and docs/ is type-checked and run (see `test/docs-snippets.test.ts`); CLI flags, config keys and exported names are compared with the code. Update docs with behaviour.
- **Required checks** before pushing: `pnpm run format`, `typecheck`, `lint`, `knip`, `pnpm test`, `pnpm test:coverage` (thresholds never lowered, no `v8 ignore`), `pnpm run build`, `pnpm run duplication jscpd` and `pnpm run duplication fallow`. Incompatible behaviour changes carry a `BREAKING CHANGE:` footer and a CHANGELOG `[Unreleased]` entry.

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
- Test fixtures in `test/fixtures/`; shared test helpers in `test/helpers/`
- Every test must assert something (`expect.requireAssertions` in `vitest.config.ts`), and no `expect()` may sit inside a conditional (`vitest/no-conditional-expect`): assert the outcome the spec or the code gives, unconditionally
- Real-world validation: the `../tweego/CleanSlate/` project (605 passages, 241K words) compiles successfully
- Browser tests (`test/vite-plugin-entry-browser.test.ts`) drive Chromium through `playwright-core`: the browser at `CHROME_PATH`, else Playwright's own Chromium, else an installed Google Chrome (the CI runners have one). Without any they are skipped locally and fail in CI
- Add or update focused tests when changing logic; test behavior, not implementation details
- New features need tests; bug fixes need regression tests

## Commands

- `pnpm test` — run all tests (unit + spec conformance)
- `pnpm test test/lexer.test.ts` — run a single test file
- `pnpm test -t "test name"` — run tests matching a name pattern
- `pnpm run test:watch` — run tests in watch mode
- `pnpm run test:coverage` — run tests with V8 coverage report
- `pnpm run typecheck` — strict type checking (`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch` and the other flags in `tsconfig.json`)
- `pnpm run lint` — ESLint with typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` and the Vitest rules (`eslint.config.js`; typescript-eslint runs on TypeScript 6, see `.pnpmfile.cjs`)
- `pnpm run knip` — unused files, exports and dependencies (`knip.jsonc`); exports of the package entry points count as used
- `pnpm run build` — production build (ESM + CJS via tsdown); also regenerates `THIRD_PARTY_NOTICES`
- `pnpm run check:package` — build, pack, and check the tarball as consumers use it (`scripts/check-package.mjs`)
- `pnpm run mutation` — mutation testing of the core modules with StrykerJS (`stryker.config.mjs`, a few minutes); `pnpm run mutation:summary` compares the scores with `mutation-baseline.json` (`--update` rewrites it). Informational: never a gate
- `pnpm run test:contracts` — build, then run the compiler contract matrix (`validation/contracts/`) against `dist/`
- `pnpm run release:gate` — the release gate; `--always` checks the evidence for HEAD, `--fingerprint [commit]` and `--checks <commit>` print what a record needs (docs/compiler-validation.md)
- `pnpm run format:check` — check formatting
- `pnpm run format` — fix formatting
- `pnpm run docs:dev` — local VitePress dev server
- `pnpm run docs:build` — build the docs site (fails on dead links)
- `pnpm test test/docs-snippets.test.ts test/docs-reference.test.ts` — run the documentation's examples and reference checks
- `pnpm run duplication` — measure code duplication in `src/` and `bin/` with jscpd, PMD CPD and fallow against `duplication-budget.json`; CPD needs Java and `PMD_BIN` set to PMD's `bin/pmd` (version and SHA-256 in `.github/workflows/duplication.yml`)
- `pnpm run duplication fallow --base origin/main` — one tool, also failing when the tree adds duplication compared with a git ref

## Releasing

Releases use `tobua/release-npm-action@v5` (`.github/workflows/release.yml`), which runs on every push to `main` but publishes only when the head commit's message contains the annotation `release-npm` (see step 6). It then runs semantic-release: the version bump comes from the Conventional Commit types since the last tag (`feat:` → minor, `fix:` → patch), and it publishes to npm and creates a git tag and a GitHub release. Nothing is committed back, so `package.json` in git keeps its old version; `src/version.ts` reads the published version at runtime. The `CHANGELOG.md` section is for readers; it does not decide the version.

It publishes through npm trusted publishing (OIDC): there is no npm token, the workflow needs `id-token: write`, and the release job must run on Node 24 or later, because OIDC publishing needs npm 11.5.1+. semantic-release pushes the git tag before `npm publish`, so if a publish fails, the tag stays and the next release takes the following version.

`package.json` in git always holds the version `0.0.0-development`, so local builds, tests, git dependencies and `pnpm link` report that marker instead of a stale release number. The release workflow installs, tests and builds in jobs without write permissions; the package job (`.github/workflows/package.yml`, shared with CI) packs and checks the tarball on Linux, macOS and Windows. The release job alone gets `contents: write` and `id-token: write`: it installs nothing, unpacks that checked tarball, and the release action versions and publishes that folder (`FOLDER`) with npm lifecycle scripts turned off. semantic-release writes the release version into the published `package.json`, which `src/version.ts` reads at runtime.

### How to release

1. **Create a release branch** named `release/X.Y.Z`
2. **Rebase onto latest main** before committing — ensures clean history
3. **Run all checks**: `pnpm run format && pnpm run typecheck && pnpm test && pnpm run build`, then **record the
   validation evidence**. The release workflow's gate refuses to publish without a committed record for the exact
   revision: the required CI checks passed on the frozen commit, and three independent full review sweeps of it (one
   per method, every review area) left no P1/P2 finding open. Follow "How to prepare a release" in
   [docs/compiler-validation.md](docs/compiler-validation.md), check with
   `GITHUB_TOKEN=$(gh auth token) pnpm run release:gate --always`, and merge the PR while it is up to date with `main`.
4. **Update `CHANGELOG.md`** with a new version section using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format:

   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD

   ### Added

   - ...
   ```

   Do NOT update `package.json` version manually — the action handles that.

5. **Open a PR** with title `release: vX.Y.Z` and reviewer `rohal12`
6. **CRITICAL**: The PR body MUST contain `release-npm` as a standalone line. The action looks for this annotation in the merge commit message body to trigger a publish. Without it, the action skips with `No release requested.`

   The reverse matters too: the action treats `release-npm` **anywhere** in the merge commit message as a release request, including inside its own name `release-npm-action`. In any PR that should not release, don't write that string in the title or body, or in commit messages; call it "the release action". A Dependabot PR that bumps the action always contains it, so merging one releases any `fix:`/`feat:` commits already waiting on `main`. When there is nothing to release, the run passes (`FAIL_ON_SKIP: 'false'`).

7. **After merge**, the release workflow runs the format check, typecheck and tests, builds and checks the tarball on every platform, runs the release gate, then publishes that tarball. Verify: `npm view @rohal12/twee-ts version`

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

### Closing issues

A PR that resolves an issue must say so with a closing keyword, or merging leaves the issue open: put `Fixes #N` (one line per issue) in the PR body, and in the commit message footer when you write the commit. A bare mention such as "(#325)" closes nothing. Check the body of any PR that already exists, including one created from the UI, before ending the task; add the keywords yourself. Leave an issue out only when the PR fixes part of it, and say what remains in the PR body.

## PR review guidelines

Whole-compiler review sweeps follow [docs/compiler-validation.md](docs/compiler-validation.md): cover every review
area in `validation/release/areas.ts`, run the contract matrix (`pnpm run test:contracts`), and add a new variant of
an existing defect class to its group and its owning issue. A failing contract case is a product defect: fix it,
never its expectation.

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

### Code duplication

The `Duplication` workflow measures `src/` and `bin/` with jscpd (exact copies), PMD CPD (exact copies, grouped)
and fallow (semantic: renamed identifiers, changed literals). A PR fails when a tool's share exceeds
`duplication-budget.json`, or when it adds duplicated lines and raises the share compared with its base. Remove a new
clone rather than raising the budget; when a PR removes duplication, lower the budget to the new values so the gain is
kept.

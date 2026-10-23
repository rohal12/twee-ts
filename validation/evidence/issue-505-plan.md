# Incremental bookkeeping implementation plan

**Goal:** Fix #505 without changing source order, duplicate precedence or cache invalidation.

**Architecture:** Resolve changed identities once before loading source groups and purge the cache once afterwards.
Keep the standalone cached loader as a wrapper around group loading and build bookkeeping.

**Tech stack:** TypeScript, Node.js 24, Vitest, pnpm.

**Spec:** [Issue #505](https://github.com/rohal12/twee-ts/issues/505), including its closure checks.

## Constraints and review focus

- Preserve mixed file/inline order, alias identity, parse-option invalidation and duplicate-input diagnostics.
- Purge removed files after all groups, including builds containing only inline sources or no sources.
- Bound change iteration and cache traversal for cold and warm builds with all, one, no or omitted changes.
- Keep the standalone `loadSourcesCached()` behavior used by loader tests.
- Follow `CLAUDE.md`: run focused tests and fast checks locally; run the full suite through CI after pushing.
- Recheck #436's required observation window and retain `blocked` while insufficient history exists.

## Task 1: Cache bookkeeping

- [x] Run baseline incremental and source-order tests: 47 passed.
- [x] Add operation-count regressions in `test/compiler-order-abort.test.ts` and observe failure.
- [x] Extract change normalization, group loading and cache purging in `src/loader.ts`.
- [x] Move bookkeeping outside the ordered loading loop in `src/compiler.ts`.
- [x] Run incremental, source-order and loader tests; add inline-only and empty-build cleanup coverage: 94 passed.
- [x] Update `CHANGELOG.md`; run format, typecheck and lint (zero errors; one existing disabled-test warning).
- [x] Review the diff, commit with `Fixes #505`, push and check for an existing PR before opening one: PR #506.
- [x] Keep this internal plan under validation evidence, outside the documentation site's required sidebar.
- [ ] Watch CI and report its outcome, retaining #436 for the remaining observation requirement.

# Compiler Quality Gate Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline; independent reviewers perform the final open sweeps.

**Goal:** Replace fixed-matrix convergence claims with reproducible evidence of supported behavior, known-defect closure, and three independent clean open reviews.

**Architecture:** Preserve revision-1 reports. Add regression tests for the five confirmed defects, a contract inventory, and executable validation including generated interactions and packaged entry points. A fail-closed gate binds checks and review evidence to the same product and validation fingerprint; evidence-only commits do not invalidate it.

**Tech Stack:** Existing TypeScript, Vitest, Node integration scripts, GitHub Actions.

**Spec:** The user-approved workflow in docs/compiler-validation.md, extended by this plan.

## Global Constraints

- Preserve existing 59 cases and historical reports; never hide known failures.
- Node >=22; supported Vite peer range >=5; platform and version evidence gaps remain explicit.
- No claim of mathematically guaranteed bug freedom.
- Reviews inspect the whole supported implementation beyond the regression matrix.
- Any actionable finding invalidates the clean-review streak; fixes require a fresh frozen revision.

## Review Focus

- Replaced metadata must remove legacy settings and IFIDs as well as Twine 2 fields.
- An indexed format without a name must compile from cache offline by both name and ID.
- URL queries, fragments, and reserved path characters must not alter download paths.
- Named symlink sources must rebuild on target edits, replacement, and link retargeting.
- All JavaScript line terminators must end wrapper comments on local and downloaded paths.

### Task 1: Close confirmed defect classes

**Files:** src/{story,formats,remote-formats,filesystem}.ts; test/compiler-review-regressions.test.ts; test/watch-symlinks.test.ts.
**Interfaces:** Existing public compiler, format and watcher APIs; no new production exports.

- [x] Add real-behavior regressions and sibling cases; run targeted Vitest checks and observe the five known failures.
- [x] Correct metadata replacement, wrapper trivia, indexed cache identity, URL derivation, and symlink target observation.
- [x] Run targeted tests, typecheck, full suite; commit fixes and tests.

### Task 2: Install evidence and release gate

**Files:** validation/{contract-inventory.json,review-state.mjs,release-gate.mjs,extended-contracts.mjs}; test/review-state.test.ts; docs/compiler-validation.md; AGENTS.md; package.json; .github/workflows/{ci,release}.yml.
**Interfaces:** Gate takes evidence JSON containing fingerprint, inventory hash, checks and ordered reviews; exits nonzero for missing, stale, incomplete or failed evidence.

- [x] Write gate tests rejecting missing evidence, changed revision, absent support coverage, repeated reviewers/methods, known failures and findings after clean reviews; observe RED.
- [x] Implement runtime evidence validation and deterministic product/validation fingerprint.
- [x] Add supported-contract inventory mapped to existing tests and explicit gaps; generated interactions and installed tarball checks supplement the old fixed matrix.
- [x] Wire integration validation into CI across supported environments and make release require complete review evidence.
- [x] Run tests and contract scripts; commit implementation.

### Task 3: Freeze, review, and report honestly

**Files:** validation/reports/2026-10-06-quality-gate*.json/.md; validation/release-evidence.json.
**Interfaces:** Same frozen product fingerprint for every check and reviewer; distinct open-review methods and reviewers.

- [ ] Run typecheck, tests, build, fixed and expanded contracts; capture exact commands, environment, seeds and results.
- [ ] Perform three independent open sweeps: implementation/invariants, adversarial public integration, package/compatibility and support claims.
- [ ] Reproduce any findings, group by invariant, fix with RED→GREEN and restart reviews after product changes.
- [ ] Record evidence and unresolved environmental gaps. Verify the gate accepts complete synthetic evidence and rejects incomplete actual evidence; never manufacture missing CI/browser/platform results.
- [ ] Report local results, tickets addressed, and remaining release requirements.

Resume notes: the first open cohort was interrupted and found uncovered defects.
Its clean streak is zero. Fixes expand owning invariants, add native-platform evidence,
use a pinned standards-based HTML parser, validate arbitrary string keys and
non-HTML output protection, and execute the public documentation examples.
Source/validation changes require a new frozen revision and fresh independent sweeps.

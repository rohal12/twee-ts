# Compiler Validation and Releases

How twee-ts is validated, and what a release needs before it is published. This page is for maintainers and
reviewers; nothing here changes how the package behaves.

Three layers of evidence back a release:

1. **The test suite** (`pnpm test`): unit, property-based and differential tests of the sources, the
   specification conformance tests, and the documentation's own examples.
2. **The compiler contract matrix** (`pnpm run test:contracts`): fixed cases of public behaviour, each with a
   stable ID, run against the build in `dist/` the way a user's project imports it.
3. **Continuous integration**: the tests on Linux, macOS and Windows with every supported Node.js, the packed
   tarball checked as consumers install it, the plugins against every supported Vite and Rollup, coverage floors
   and the duplication budget. Mutation testing of the core modules (`pnpm run mutation`, weekly in CI) is
   informational: its scores against `mutation-baseline.json` go into the evidence record, but never block.

The **release gate** then refuses to publish unless a committed evidence record shows that all of that passed for
the exact revision being released, and that three independent full review sweeps of that revision left no P1 or
P2 finding open.

## The compiler contract matrix

The matrix lives in `validation/contracts/`. `cases.ts` declares every case: a group, the invariant the group
checks, the issue that owns it, and the input variants. A case ID is the group and the variant's position
(`RESOLVE-07`), so an ID keeps its meaning for good: groups and variants are only ever appended, never reordered,
renamed or removed (`matrix.contract.ts` freezes revision 1).

```sh
pnpm run test:contracts                       # build, then run every case
pnpm exec vitest run --config vitest.contracts.config.ts -t RESOLVE   # one group, against the current build
```

Each case gets an empty folder of its own, with the story format cache and the home folder inside it, so no
installed story format and no earlier download answers. The cases never reach the network: they serve story
formats and indices from loopback servers, and any other request fails. They import `@rohal12/twee-ts` and
`@rohal12/twee-ts/vite`, which the contracts' Vitest config points at the build; their types are checked against
the sources by `pnpm run typecheck`.

| Group                       | Invariant and variants                                                                                                                                                                                                                                                                                                                                                                                     | Owner                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `WRITE-01`–`WRITE-07`       | Atomic output keeps the destination and the intent of a link: new and existing files, a valid link, absolute and relative dangling links, a dangling chain, a cycle                                                                                                                                                                                                                                        | [#219](https://github.com/rohal12/twee-ts/issues/219) |
| `TYPE-01`–`TYPE-05`         | The published declarations reject writes to a compiled passage: tags, tag elements, metadata, source location, name                                                                                                                                                                                                                                                                                        | [#220](https://github.com/rohal12/twee-ts/issues/220) |
| `FORMAT-01`–`FORMAT-07`     | Equivalent `storyFormat()` wrappers decode alike through the parser, a local format, and a download used offline: strict and relaxed objects, comments with braces, braces in values                                                                                                                                                                                                                       | [#221](https://github.com/rohal12/twee-ts/issues/221) |
| `RESOLVE-01`–`RESOLVE-09`   | Local formats, format URLs and indices (online, then from the cache) select the same version of the major asked for; only an older one warns                                                                                                                                                                                                                                                               | [#224](https://github.com/rohal12/twee-ts/issues/224) |
| `HEAD-01`–`HEAD-10`         | Modules and the Vite client become real elements of the template's head, past comment, script and attribute look-alikes of a head tag                                                                                                                                                                                                                                                                      | [#223](https://github.com/rohal12/twee-ts/issues/223) |
| `VITE-01`–`VITE-05`         | Production and development entry builds keep the user's configuration: inline config, `define`, aliases, a virtual-module plugin, a config file overridden inline                                                                                                                                                                                                                                          | [#222](https://github.com/rohal12/twee-ts/issues/222) |
| `INPUT-01`–`INPUT-06`       | Files and inline sources normalize alike; source order decides; cold and warm caches agree; a forced change at the same mtime and a changed parse option are seen; name clashes                                                                                                                                                                                                                            | —                                                     |
| `OUTPUT-01`–`OUTPUT-06`     | HTML metadata and text round-trip; JSON start and debug overrides; private passages are left out and cannot start; Twee keeps the effective metadata; a missing IFID is reported in Twine 2 output                                                                                                                                                                                                         | —                                                     |
| `CLI-01`–`CLI-02`           | A failed build keeps the previous output and exits 1; output inside a source folder is never read back                                                                                                                                                                                                                                                                                                     | —                                                     |
| `ABORT-01`–`ABORT-02`       | A cancelled compile rejects with the caller's reason and keeps the previous output                                                                                                                                                                                                                                                                                                                         | —                                                     |
| `INTERACT-01`–`INTERACT-06` | One case per output mode: generated stories (fast-check, fixed seed) from files and inline sources, three line endings, trimmed or not, with tag aliases and a replaced StorySettings, build alike cold, incremental and warm                                                                                                                                                                              | —                                                     |
| `DEPS-01`–`DEPS-08`         | The Vite entry's bundle follows the files an `import.meta.glob()` selects, as a fresh build does: in dev (request catch-up) a file added to an eager glob, deleted from a lazy one, renamed under a keys-only one, the first file of a folder created; in dev with the watcher; under `vite build --watch`; a file added to a folder a recursive glob reaches through a link, with and without the watcher | [#341](https://github.com/rohal12/twee-ts/issues/341) |

Revision 1 (`WRITE-01` to `ABORT-02`, 59 cases) was declared against v1.18.1, where 16 cases failed; all 59 passed
on v1.18.2 and pass on `main`. Revision 2 added the `INTERACT` group, revision 3 the `DEPS` group. The symbolic-link cases are skipped on Windows,
as the unit tests of atomic writes are.

**A failing case is a product defect.** Never change an expectation to match the code. Fix the defect class (see
the hardening rules in `CLAUDE.md`), add a regression test to `test/` that failed first, and keep the case. A new
variant of an existing invariant is appended to its group and reported on the owning issue; a new invariant is a
new group.

## Reviewing the compiler

A review sweep is bounded and recorded, so that successive sweeps cover a known scope and fix defect classes
rather than single examples.

1. **Freeze the target.** Record the commit and its fingerprint (`pnpm run release:gate --fingerprint <commit>`),
   the Node.js, pnpm and Vite versions, and the scope. Results from different revisions are different reviews.
2. **Cover every area.** `validation/release/areas.ts` splits the supported surface into review areas; every file
   under `src/`, `bin/` and `schemas/` and every documentation page belongs to one (`test/release-gate.test.ts`
   checks it). A full sweep covers every area, and looks beyond the registered cases: the matrix and the test
   suite are a floor, not the scope.
3. **Run the evidence.** Build, type-check, run the tests and the contract matrix. Probe with temporary fixtures,
   isolated caches, loopback servers and the public API. A probe that cannot run is blocked evidence, neither a
   pass nor a defect.
4. **Investigate classes.** Follow a failure to its cause, and check the sibling code paths and the controls of
   the same domain. Classify it: a missed defect, a regression, an uncovered supported combination, or a contract
   that is unsupported or unclear.
5. **Keep the issue ledger.** Add a new variant to the issue that owns its invariant; open an issue only for an
   independently fixable cause. Each issue states the invariant and its boundary, the failing and passing cases,
   the code paths inspected, the root cause and the closure checks.
6. **Report.** Passing, failing, blocked and unreviewed work separately, with the commands, seeds and environment.

Each sweep uses one of three methods, and a release needs one of each, by three different reviewers:

| Method                       | Looks at                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implementation`             | The code against its invariants: each module's contract, its edge cases, the sibling paths of every defect class                                   |
| `adversarial-integration`    | The public API, the CLI and the plugins with hostile and unusual input: odd file systems, encodings, markup, formats                               |
| `compatibility-distribution` | The package as users get it: platforms, Node.js and peer versions, real story formats and browsers, Tweego parity, what the documentation promises |

Severities: **P1** loses or corrupts data, is a security hole, or breaks common use; **P2** gives wrong output or
behaviour for supported input, or breaks a documented contract; **P3** affects an edge case, a diagnostic or
performance; **P4** is cosmetic.

## The release gate

The release workflow (`.github/workflows/release.yml`) runs the gate (`pnpm run release:gate`) in a job of its
own before the release job. When the head commit carries no release annotation, the gate passes at once: there is
nothing to publish, so ordinary pushes to `main` are never held up. When it does, the gate refuses the release
unless all of this holds:

- an evidence record under `validation/evidence/` is for this revision: its fingerprint is the fingerprint of the
  commit being released;
- the record's frozen commit has that fingerprint too;
- every check run of the frozen commit passed (a re-run counts in place of the run it repeats), every required
  check (`lint`, `test`, `coverage`, `package`, `plugin peers`, `contracts`, `duplication`) ran, and the record lists
  exactly the required runs;
- at least three review sweeps, by three different reviewers and using all three methods, each reviewed this
  revision, covered every review area, and has its report next to the record, unchanged since it was recorded;
- no sweep has an open P1 or P2 finding, every rejected finding gives its reason, and every open P3 or P4 finding
  names the issue that tracks it.

The **fingerprint** of a revision is a SHA-256 over every file of its tree (path, mode and content) except
`validation/evidence/` and `CHANGELOG.md`. Product, tests, validation, workflows and documentation all count, so
any change to them makes a new revision that needs its own evidence. The evidence and the changelog are written
after the revision is frozen, so leaving them out lets the record describe the commit that adds it, and its squash
merge.

The gate cannot tell how thorough a review was: a sweep's report is a trusted record of what its reviewer did.
What the gate does guarantee is that no release goes out without that record, for that exact revision.

### How to prepare a release

1. On the release branch, rebased onto `main`, freeze the revision: commit everything but the changelog and the
   evidence, and push it. Wait for CI on that commit to finish green. (A later push to the pull request cancels CI
   runs still in progress, so don't push again until it is done.)
2. Print its fingerprint and its passing required checks:

   ```sh
   pnpm run release:gate --fingerprint <commit>
   GITHUB_TOKEN=$(gh auth token) pnpm run release:gate --checks <commit>
   ```

3. Run three full sweeps of that commit: three reviewers, one method each. Each writes its report to
   `validation/evidence/<version>/sweep-<n>.md`: the method, the commit and fingerprint, the commands, seeds and
   environment, the areas covered, every finding with its severity, and what was not covered.
4. If a sweep finds a P1 or P2 defect, fix it (with its regression test and sibling cases), freeze the new
   revision and start again from step 1: sweeps of an earlier revision don't count.
5. Write `validation/evidence/<version>/record.json`:

   <!-- docs-test: not-config -->

   ```json
   {
     "schemaVersion": 1,
     "release": "2.0.0",
     "commit": "<the frozen commit, 40 hex digits>",
     "fingerprint": "<its fingerprint, 64 hex digits>",
     "checks": ["contracts", "coverage", "lint", "…every name --checks printed"],
     "reviews": [
       {
         "reviewer": "<who>",
         "method": "implementation",
         "fingerprint": "<the fingerprint the sweep reviewed>",
         "completedAt": "2026-10-07T12:00:00Z",
         "areas": [
           "api",
           "syntax",
           "story",
           "inputs",
           "files",
           "formats",
           "output",
           "cli",
           "plugins",
           "distribution",
           "documentation"
         ],
         "report": "sweep-1.md",
         "reportSha256": "<sha256 of sweep-1.md>",
         "findings": [
           {
             "id": "S1-1",
             "severity": "P3",
             "title": "…",
             "status": "open",
             "issue": "https://github.com/rohal12/twee-ts/issues/…"
           },
           { "id": "S1-2", "severity": "P2", "title": "…", "status": "rejected", "reason": "…why it is not a defect" }
         ]
       }
     ],
     "informational": [
       {
         "source": "mutation testing (pnpm run mutation:summary)",
         "summary": "total 93.5 against the baseline 93.7; src/story.ts 86.0 against 87.1",
         "url": "<the mutation workflow run>"
       }
     ]
   }
   ```

   with one entry in `reviews` for each sweep. `informational` is optional: evidence the gate shows in its log but
   never judges. Record the mutation scores of the frozen commit there: run the Mutation testing workflow on it
   (or `pnpm run mutation` and `pnpm run mutation:summary` locally), and note how they compare with
   `mutation-baseline.json`. A lower score is no reason to refuse a release, but the sweeps should look at the
   modules whose score fell.

6. Commit the record, the reports and the changelog on top of the frozen commit, and nothing else. Check the
   evidence as the release workflow will:

   ```sh
   GITHUB_TOKEN=$(gh auth token) pnpm run release:gate --always
   ```

7. Open the release pull request with the release annotation (see `CLAUDE.md`, "How to release"), and merge it
   while it is up to date with `main`: a merge that brings in other changes makes another revision, and the gate
   refuses it.

### What the evidence claims

A release with evidence claims: **these checks passed on this revision, and three recorded full sweeps of it by
independent reviewers found no open P1 or P2 defect.** It does not claim the compiler has no bugs. A later finding
shows where the review missed something: record why, extend the matrix or the tests to cover the class, and the
next release's sweeps start from there.

The matrix and CI do not run story formats in a real browser, compare output with a Tweego binary, or fetch the
live Story Formats Archive; those remain part of the `compatibility-distribution` sweep, and its report says what
it ran.

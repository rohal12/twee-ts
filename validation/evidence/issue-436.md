# Issue 436: intermittent CI failures

Rechecked on 2026-10-21 against main at `58a86f3`. GitHub had one open issue,
[#436](https://github.com/rohal12/twee-ts/issues/436), no blocked issues and no open PRs.

## Original failures

- **Windows Vite cleanup:** [#437](https://github.com/rohal12/twee-ts/pull/437)
  traced the writer to Vite's dependency optimizer. The test servers disable discovery with nothing included;
  Vite creates no optimizer. Cleanup also checks for a leftover cache and for writes after shutdown.
- **Windows CLI init:** #437 builds the CLI once in a setup hook and runs the shipped JavaScript.
  Each subprocess no longer pays for a cold tsx compilation. The subprocess exit and generated files remain
  the asserted signals.
- **macOS watch equivalence:** [#440](https://github.com/rohal12/twee-ts/pull/440)
  traced the missed events to libuv replacing the shared FSEvents stream whenever a watch starts or closes.
  `folder-stream.ts` probes the replacement stream and triggers a full build once it runs again.
  This covers a renamed folder too: its tracked paths change, the probe observes the stream restart,
  and the full build reads the current tree. The FS-04 rename/move and the named generated-sequence
  counterexample now each run five times with fresh fixtures; every repetition must pass.
- **Late Vite events:** [#439](https://github.com/rohal12/twee-ts/pull/439) removed the fixed settling delay.
  A page request drains the reported events, including those waiting out the debounce, before the
  counters are checked. [#442](https://github.com/rohal12/twee-ts/issues/442) also fixed a request
  overtaking a build chained while another build ran.

## History rescan

Read the latest 100 `ci.yml` runs and fetched every failed job log in the window after #437.
The window ends at [39429945114](https://github.com/rohal12/twee-ts/actions/runs/39429945114).
After #437 there are 63 workflows, including eight cancelled workflows, and 55 completed test jobs
on each of macOS and Windows. Neither the Vite ENOTEMPTY failures nor CLI init timeout recurred.
After #440 there are 54 workflows and 46 completed test jobs on each OS. No watch-equivalence
failure recurred after that fix. Cancelled jobs do not count as passes.

The rescan found two remaining classes addressed by this change:

| Failure                              | Evidence                                                                                                                                                                                                                                                                                                   | Cause and fix                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear code fails a timing ratio     | [39429945114](https://github.com/rohal12/twee-ts/actions/runs/39429945114), script passages on macOS and Windows; [39203839100](https://github.com/rohal12/twee-ts/actions/runs/39203839100), unclosed tags; [39155510132](https://github.com/rohal12/twee-ts/actions/runs/39155510132), prose comparisons | A ratio of elapsed times still includes scheduling, JIT and collection costs. These tests now count characters searched or sliced by real string and regex operations, including the receiver that an endsWith call may flatten. The growth bound remains eight for four times the input. |
| Output changes after Rollup shutdown | [39109034798](https://github.com/rohal12/twee-ts/actions/runs/39109034798), entry.js changed from zero to 28 bytes                                                                                                                                                                                         | Rollup's close() stops watching but does not await an active result.write(). All Rollup test watchers and the shared Vite build-watch helper now close after END and bundle disposal, then remove their projects.                                                                         |

The other failures in this window were resolved on their branches: the earlier HTML sibling timing check
now counts indexed reads (#464); watch exclusion across aliased parent paths (#464); config path semantics
(#478); recursive-watch ELOOP (#489); and intermediate contract, link-watch and documentation expectations.
The earlier watch-equivalence failure at 38136948300 is the counterexample #440 fixed. The differential
word-count failure at 38129692564 predates #439's SugarCube compatibility fixes.

## Regression evidence

- A real Rollup writeBundle hook held behind a promise reproduces the late writer without a sleep.
  Registering its ordinary close() fails cleanup with a changed project; waiting for END passes and the
  final write completes before the directory is removed.
- A failed generateBundle still disposes its result before cleanup; an idle watcher closes immediately,
  and concurrent stop calls share one close. The output-failure regression failed before disposal of
  ERROR results was added during review.
- Restoring the original pre-#463 joinCode implementation fails both the script and stylesheet work checks.
  The fixed join passes. Removing the cached failed macro search in walkMarkup fails the top-level-elements
  word-count check; restoring it passes.
- The measurement helper preserves native regex results and lastIndex and restores every instrumented
  built-in even when the operation throws. Its scope is searched and sliced characters; it does not count
  regex backtracking or direct indexed character reads.

The history is evidence for the existing fixes. Observation of 50 completed macOS and Windows workflows
after the final changes continues through normal CI; this report records the available counts explicitly.
The PR's matrix runs the repeated real-OS watch cases and the new deterministic regressions.

## Local verification

Formatting and strict typecheck passed. Lint passed with the existing disabled-test warning in
vite-plugin-build-scope.test.ts. All 450 focused tests across 13 files passed, covering every changed
test file and the original CLI, late-event and watch-equivalence cases. The full suite, contracts,
coverage, packaging and duplication checks run in CI, following CLAUDE.md.

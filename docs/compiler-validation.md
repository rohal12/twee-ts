# Compiler validation and release evidence

## Open review gate (revision 2)

A green fixed matrix proves those cases, not that the repository is bug free.
Revision 1's 59 cases missed metadata replacement, nameless indexed offline
reuse, index URL components, individual symlink targets, and JavaScript line
terminators. Those are now permanent Vitest regressions for #236–#239 and #221.
The older reports below remain unchanged as historical evidence.

The supported contract is inventoried in
[`validation/contract-inventory.json`](../validation/contract-inventory.json).
It assigns every compiler/CLI/schema file to a behavior area, maps existing
regression tests, and lists interactions. Inventory omissions are reviewed
before tests. New source files that have no area fail the release gate.

1. Freeze a product and validation revision. `node validation/release-gate.mjs
--fingerprint` prints its SHA-256 and inventory hash. The fingerprint includes
   sources, CLI, schemas, dependencies, tests, validation scripts, CI, agent
   instructions and API/support documentation. Evidence/report-only commits do
   not change the audited product. Record the actual Git commit too.
2. Run `pnpm validate:collect` on Linux, macOS and Windows with Node 22 and 24.
   It captures typecheck, unit tests, build, fixed contracts, 288 deterministic
   cross-feature cases, isolated packed installation, and gate tests. Actual
   runtime/platform determine each evidence label. A changed fingerprint during
   a command invalidates that result.
3. Run installed-plugin build/dev/edit tests against Vite 5.0.0, 6.0.0, 7.0.0
   and 8.3.1. CI provisions these versions separately. Entry bundling remains
   Vite 8+ and has additional regression tests. This is representative version
   evidence, not a proof of every release allowed by `vite >=5`.
4. Run real browser and reference-compiler checks, explicitly provisioning their
   inputs: `BROWSER_FORMAT_PATH=/path/to/storyformats node
validation/browser-contracts.mjs` (real SugarCube, Chromium) and
   `TWEEGO_BINARY=/path/to/tweego node validation/tweego-contracts.mjs`.
   Record their exact versions/checksums and limitations. Missing tools never
   mean pass. These scripts currently need provisioned inputs and are not
   automatically satisfied by the CI matrix.
5. Run three independent full **open** sweeps of that same frozen revision.
   Assign distinct reviewers and methods: implementation/invariants,
   adversarial public integration, and compatibility/distribution. Each covers
   every inventory area, actively looks beyond registered cases, and records
   omitted probes. An incomplete sweep or actionable finding resets the streak.
   Fix by invariant, add sibling cases, rerun earlier checks, freeze the resulting
   revision and restart the three sweeps. Repeating a matrix or limiting reviews
   to the latest diff does not count as an open sweep.
6. Assemble `validation/release-evidence.json` from the captured reports and
   review records, then run `pnpm validate:release`. Missing/stale artifacts,
   nonzero exits, known failures, uncovered support, incomplete scope, or fewer
   than three independent clean sweeps block the release workflow. A reviewer
   attestation remains a trusted human/agent record: the gate cannot establish
   that an asserted review was exhaustive.

`validation/run-check.mjs --id ID --environment ENV --report FILE -- COMMAND
ARGS...` captures a check's command, exit, output, timing and fingerprint. For
fixed-matrix checks add `--result FILE` so the gate rejects known failures even
when baseline comparison exits zero. Checks in release evidence contain
`id`, `environment`, `command`, `exitCode`, `artifact`, and `sha256` of the
artifact bytes. Each artifact must match the frozen fingerprint.

Evidence schema version 1 also contains `fingerprint`, `inventorySha256`,
`openFindings`, `supportGaps`, and chronological `reviews`. Each review contains
`id`, `reviewer`, `method`, `fingerprint`, `inventorySha256`, `status`
(`clean`, `findings`, or `incomplete`), `findings`, `coverage` (all area IDs),
`artifact`, and its `sha256`. Record findings and gaps explicitly; never clear
those arrays merely to pass the gate. The executable gate tests show acceptance
and rejection examples.

The resulting claim is: **no known actionable defects, with recorded validation
and three clean open sweeps of this revision under the stated contract**.
No finite review process guarantees that another sweep can never find a bug.
A further finding is evidence that the discovery process missed a behavior;
record why, extend the invariant coverage, and invalidate the previous readiness
claim. Maintain the release ledger rather than restarting undocumented reviews.

## Historical fixed-matrix procedure (revision 1)

The procedure and reports below describe the old bounded baseline. They remain
useful for regression comparisons; their stopping criteria are superseded by
revision 2 for release-readiness and whole-repository convergence claims.

This is the standing procedure for validating twee-ts. Its purpose is to make
successive reviews cover a known scope and repair defect classes, rather than
produce unrelated batches of example-specific fixes. It does not promise that a
compiler has no undiscovered bugs.

## Review procedure

1. **Freeze the target.** Record `git rev-parse HEAD`, source changes in the working
   tree, Node/pnpm/Vite versions, and the requested scope. Do not compare results
   from different product revisions as though they were the same review.
2. **Set the boundary before probing.** Start with the cases in
   `validation/compiler-contracts.mjs`. Each has a stable ID, expected invariant,
   input variant, and owning issue when known. Add an uncovered behavior explicitly;
   record why it belongs to the supported contract. Never silently grow the scope.
3. **Run the evidence.** Build, typecheck, run the existing suite, and run the matrix.
   Use temporary fixtures, isolated caches, loopback servers, actual public APIs,
   parsed HTML elements, and TypeScript rejection checks. A missing dependency or
   failed fixture setup is blocked evidence, not a compiler defect or a pass.
4. **Investigate failing classes.** Follow the failing public call path to its
   cause. Check the sibling implementations and positive controls in that domain.
   Classify the result as a missed old defect, a regression from a fix, an uncovered
   supported combination, or an unsupported/ambiguous contract. Only confirmed
   supported defects become bug tickets.
5. **Maintain the issue ledger.** Update the invariant's existing ticket with new
   failing case IDs, evidence, affected paths, and closure checks. Create a new
   ticket only for an independently actionable cause with no owner. Do not merge
   independent fixes merely because they share a subsystem.
6. **Fix and re-run in a separate implementation task.** Turn the class's failing
   rows into permanent regression tests in the existing test suites, keep positive
   controls, and check related paths. Then re-run the whole matrix and normal
   checks. Do not change expectations to match the broken implementation.
7. **Stop and report the bounded result.** Report passing, failing, blocked, and
   unreviewed work separately. A review is complete when the declared cases have
   evidence and every failure has an owner or an explicit unresolved-contract
   decision. A fix is complete only when its closure rows pass without regressions.

## Commands

From the repository root after installing dependencies:

```sh
pnpm run build
pnpm run typecheck
pnpm test
node validation/compiler-contracts.mjs --report /tmp/twee-ts-contracts.json
```

The matrix command exits **1 when any contract fails**, including known bugs.
It does not alter compiler sources, download real formats, or modify real stories.
The fixtures and caches are disposable. It requires the built `dist` artifacts
and development dependencies, including TypeScript, Vite, and htmlparser2.

For a regression comparison against the latest accepted run (v1.18.2):

```sh
node validation/compiler-contracts.mjs \
  --baseline validation/reports/2026-10-06-v1.18.2.json \
  --report /tmp/twee-ts-contracts-next.json
```

A baseline comparison exits 0 only when there are no new failures or blocked
cases and no baseline cases have disappeared. **That means no regression against
the baseline; it does not mean the known defects are fixed.** The report still
lists all failing cases. Added cases are reported separately, including their
results; they must be assessed before replacing the baseline.

The matrix's TypeScript probes use `@ts-expect-error`: rejection is the expected
behavior. An unused directive means the public API wrongly allows the mutation.
The probes are kept outside `test/` so known defects do not silently break the
ordinary test command. Runtime freezing is not an assumed contract.

## Fixed behavior matrix, revision 1

The executable matrix is the case-level source of truth. IDs never change meaning;
extend the matrix by adding IDs, not reusing or deleting them. This first revision
declares 59 representative cases before its run. It is not a full Cartesian
product of every compiler option.

| Domain and IDs            | Invariant and declared variants                                                                                                                                                                                           | Owning issue                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `WRITE-01`–`WRITE-07`     | Atomic output preserves file/link intent: new/existing files, valid link, absolute/relative dangling links, dangling link chain, link cycle                                                                               | [#219](https://github.com/rohal12/twee-ts/issues/219)                                               |
| `TYPE-01`–`TYPE-05`       | Public read-only passages reject tag append/index writes, metadata edits, source edits, and name edits                                                                                                                    | [#220](https://github.com/rohal12/twee-ts/issues/220)                                               |
| `FORMAT-01`–`FORMAT-07`   | Equivalent wrappers work through the parser, local compilation, and direct download/offline compilation: strict/relaxed objects, inner comments, leading/trailing/surrounding brace comments, braces inside string values | [#221](https://github.com/rohal12/twee-ts/issues/221)                                               |
| `RESOLVE-01`–`RESOLVE-09` | Local, configured URL, and shared index-cache formats implement exact/newer/older same-major selection; older selections warn                                                                                             | [#224](https://github.com/rohal12/twee-ts/issues/224)                                               |
| `HEAD-01`–`HEAD-10`       | Module and Vite client injection use actual HTML tags: ordinary head, comment, script, attribute look-alikes, quoted `>` in a head attribute                                                                              | [#223](https://github.com/rohal12/twee-ts/issues/223) for client failures; module path is a control |
| `VITE-01`–`VITE-05`       | Production and development entry builds preserve configuration: ordinary inline config, define, aliases, virtual-module plugin, file config with inline override                                                          | [#222](https://github.com/rohal12/twee-ts/issues/222)                                               |
| `INPUT-01`–`INPUT-06`     | File/inline normalization, mixed-source precedence, cold/warm cache parity, forced changes at the same mtime, parse-option invalidation, generated-name collisions preserve authored data                                 | Previously fixed issues; re-open their owner on demonstrated regression                             |
| `OUTPUT-01`–`OUTPUT-06`   | HTML metadata/text round trip, JSON overrides, private passage omission, omitted start errors, effective Twee metadata, missing-IFID diagnostics agree with the advertised output                                         | Previously fixed issues; re-open their owner on demonstrated regression                             |
| `CLI-01`–`CLI-02`         | Compilation errors preserve the previous output and exit nonzero; generated output under sources never reads back into the next build                                                                                     | Previously fixed issues; re-open their owner on demonstrated regression                             |
| `ABORT-01`–`ABORT-02`     | Pre-aborted and in-flight cancelled compiles reject with the supplied reason and preserve existing output                                                                                                                 | Previously fixed issues; re-open their owner on demonstrated regression                             |

The existing unit/specification suites remain a separate evidence layer. Their
test count and coverage do not expand the matrix's declared guarantees.

## Ticket structure and closure

Keep one issue per independently fixable invariant violation. Each issue needs:

- invariant and supported boundary, including what is not being promised;
- stable failing case IDs and working controls;
- affected entry points and sibling paths inspected;
- root cause and whether it predates or follows recent fixes;
- original reproduction, preserved rather than replaced by an abstract plan;
- concrete closure checks and suggested permanent regression-test locations;
- reviewed product commit and evidence commands.

The six originally tracked issues are six independent implementation concerns,
resolved in v1.18.2 and verified in the release ledger below. New variants should
extend their acceptance criteria when the same invariant fails again. Closure
requires every assigned failing row to pass, the controls to remain green, and the
full matrix to gain no regressions. A partial fix keeps the issue open.

## Convergence ledger

Save each run with its product revision and matrix revision. Report transitions:
previously failing to passing, passing to failing, newly tested, blocked, and
unchanged failures. Count failing **classes** as well as failing inputs. Do not
use ticket count, line coverage, or a single successful story as a quality verdict.

The first run is recorded in `validation/reports/2026-10-06.json` and summarized in
`validation/reports/2026-10-06.md`. Documentation and validation artifacts were
added in the working tree; the compiler target remains the recorded product SHA.

The release follow-up is recorded in `validation/reports/2026-10-06-v1.18.2.json`
and summarized in `validation/reports/2026-10-06-v1.18.2.md`. On release commit
`ab249c22d9c2c7c893e6e56839dcfa0e94d3ae7d`, the unchanged 59-case matrix has
59 passing cases: all 16 original failures are fixed, all 43 controls still pass,
and no cases are blocked. This is the latest accepted baseline for subsequent
comparisons. Keep the initial failing baseline unchanged as historical evidence.

## Explicit limits

This matrix exercises the installed Node 22 and Vite 8 versions on Linux. Windows,
other supported Node/Vite versions, browser execution and gameplay, live public
format archives, sustained filesystem-watch churn, and adversarial size/security
audits are unreviewed here. Existing suites contain additional tests for some of
these domains, but that does not establish a platform or integration sweep.

Future sessions must keep these limits visible. Expanding one requires a declared
scope extension with its own evidence; it is not grounds to reinterpret an old
bounded review as a promise of exhaustive validation.

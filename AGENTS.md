# Compiler validation and reviews

Read [docs/compiler-validation.md](docs/compiler-validation.md) and
[validation/contract-inventory.json](validation/contract-inventory.json) first.
The 59-case matrix is a historical regression baseline. Passing it is not open
review convergence. Review the whole supported surface, including interactions
and support claims; identify omissions in the inventory before testing.

Use the user-approved three-method open review gate: implementation/invariants,
adversarial integration, and compatibility/distribution. Every reviewer covers
all inventory areas using their assigned method. Record the exact frozen
fingerprint, scope hash, reviewed commit, commands, seeds, environment, covered
areas, findings and limits. A finding or incomplete review resets the clean
streak; changes to product or validation invalidate previous clean sweeps.

Group failures by invariant and update their owning GitHub issue. Fix the class,
add sibling regression cases, and rerun earlier passing checks. Do not call a
case passing without executing it, suppress known failures, narrow promised
support to obtain green evidence, or close an issue from one example alone.

Evidence files are auditable records, not mathematical proofs. Missing platform,
peer-version, browser or differential results remain release blockers. Run
`pnpm validate:release` before claiming readiness; a green normal test suite or a
no-new-regressions matrix comparison cannot bypass it.

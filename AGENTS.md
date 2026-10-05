# Compiler reviews

For compiler validation and whole-repository reviews, read
[`docs/compiler-validation.md`](docs/compiler-validation.md) first. Use its fixed
behavior matrix and stopping criteria. A diff review still reviews the whole diff;
the matrix adds the affected behavior checks, rather than replacing that review.

Record the reviewed commit, exact commands, case IDs, and explicit limits. Re-run
previously passing cases after fixes. Group failures by violated invariant and
update the owning issue instead of opening a ticket for every input variant.
Never describe untested cases as passing or close an issue from one example alone.

Validation artifacts in `validation/` deliberately include failing contracts until
their owning issues are fixed. They are separate from the normal Vitest suite;
do not weaken their assertions or hide their failures to obtain a green result.

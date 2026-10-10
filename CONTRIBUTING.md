# Contributing

## Prerequisites

- **Node.js 24 or later.** `devEngines` in `package.json` makes `pnpm install` fail on an older version.
- **pnpm 12**, the version `packageManager` pins. Install it with `npm install -g pnpm@12`, or run `corepack enable` and
  Corepack reads the pinned version. A standalone pnpm 10 or 11 prints `ERR_PNPM_NO_MATCHING_VERSION` for
  `@pnpm/linux-x64@12.10.1` on every command, because it tries to switch to the pinned pnpm 12 and pnpm 12 renamed its
  platform packages. Update pnpm first.

```sh
pnpm install --frozen-lockfile
```

## Checks a change has to pass

```sh
pnpm run format
pnpm run typecheck
pnpm run lint
pnpm run knip
pnpm test
pnpm run test:coverage
pnpm run build
pnpm run duplication jscpd
pnpm run duplication fallow
```

Also run `pnpm run test:contracts` when you change the compiler pipeline. Coverage thresholds are never lowered, the
duplication budget (`duplication-budget.json`) only goes down, and every code block in `README.md` and `docs/` is
type-checked and run, so update the docs together with the behavior (`pnpm test test/docs-snippets.test.ts
test/docs-reference.test.ts`, `pnpm run docs:build`).

A bug fix comes with a regression test that fails without the fix. `CLAUDE.md` describes the architecture, the
hardening rules and the code style in full.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`,
`chore:`). A change that is not backward compatible has a `BREAKING CHANGE:` footer and an entry in the `[Unreleased]`
section of `CHANGELOG.md`. A pull request that resolves an issue says so with a closing keyword on its own line
(`Fixes #123`).

Releases need recorded validation evidence; see [docs/compiler-validation.md](docs/compiler-validation.md).

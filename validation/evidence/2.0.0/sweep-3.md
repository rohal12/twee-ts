# Sweep 3 (round 3): compatibility-distribution

## Method

`compatibility-distribution`, reviewer **sweep-compat-r3**: the package as users get it (the packed tarball installed
into fresh ESM and CJS consumer projects, its CLI, exports, declarations, version behaviour, notices), Tweego 2.1.1
parity on real projects and targeted fixtures, real story formats in real browsers (Chromium, Firefox, WebKit), the
Vite and Rollup plugins under several peer versions, the live Story Formats Archive, and every page of the
documentation (README, docs/, migrating-to-2, CHANGELOG `[Unreleased]`/`[2.0.0]`) read against the behaviour.

## Target

- Commit `5ed23d7ca541f416ca8241467dd1570ab801ef68` (detached checkout in an isolated worktree; tree left clean)
- Fingerprint `be22a07a3b165fb43956530724138bb5c29706a7eab17d5a2f8b3d64a220fd95` (reproduced with
  `pnpm run release:gate --fingerprint 5ed23d7ca541f416ca8241467dd1570ab801ef68`)
- CI on the commit (`gh run list --commit 5ed23d7…`): CI run 38151731359 success (test ubuntu/macos/windows,
  coverage, lint, contracts, plugin peers Vite 8 + Rollup 4, plugin tests Vite 8.0 and 8.2, package pack and
  consumers on three OSes); Duplication 38151731419 success; Release 38151731403 success (gate, verify, package, release
  job ran without a publish request); Deploy docs 38151731401 still queued when checked. The suite was not rerun here,
  as instructed.

## Environment

- Linux 7.0.0-34-generic x86_64, shared machine (other sweeps running in parallel)
- Node v24.21.0 (nvm; the default node is v22.18.0, used only for a Node 22 probe), pnpm 12.10.1, npm from Node 24
- Tweego 2.1.1+81d1d71 binary (`/media/clemens/storage/git/twine/tweego/tweego`), formats copied from
  `tweego/storyformats` to an isolated `TWEEGO_PATH` (`/tmp/s3r3/fmt`); isolated `HOME` for every CLI run
- Twine 1.4 `targets` (engine.js, jquery.js, modernizr.js, jonah, sugarcane) fetched from the `tweecode/twine`
  repository for the Twine 1 comparison
- playwright-core 1.64.0 (separate install): Chromium build 1248 (Playwright's), Firefox build 1543 and WebKit build
  2359 (older cached Playwright builds, launched through `executablePath`; both worked)
- Vite 8.0.0, 8.2.4, 8.3.4 (latest), and 7.2.2 (forced past the peer range); Rollup 4.64.5 (latest 4.x);
  TypeScript 5.9.3 in the Vite consumers
- Network: the live Story Formats Archive, SchemaStore and GitHub raw files were reachable

## Commands

```
git fetch origin && git checkout --detach 5ed23d7ca541f416ca8241467dd1570ab801ef68
export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH
pnpm install --frozen-lockfile                 # ok
pnpm run release:gate --fingerprint 5ed23d7... # be22a07a...fd95
pnpm run build                                 # ok
pnpm run check:package                         # all package checks passed (publint --strict, attw, TS 5.9.3/7.0.2 x
                                               # nodenext/node16-cjs/bundler/node10 x exactOptionalPropertyTypes on/off,
                                               # runtime ESM+CJS, one build graph, {@link} targets, npx --version/compile)
pnpm run docs:build                            # ok, no dead links
npm pack --pack-destination /tmp/s3r3/pack     # 38 files, 1.7 MB packed, 6.7 MB unpacked
npm install <tarball> into /tmp/s3r3/esm ("type": "module") and /tmp/s3r3/cjs (CommonJS)
```

Helper scripts (all in `/tmp/s3r3/scripts`, not in the repository):

- `both.sh <name> <args>` runs `tweego -o out/<name>.tweego <args>` and the tarball's
  `twee-ts --no-remote --no-config -o out/<name>.tweets <args>` with the same `HOME`/`TWEEGO_PATH`; `cmp.sh` diffs them
  (`>` split into lines), `modes.sh` runs every output mode and every local format, `projects.sh` the real projects.
- `/tmp/s3r3/pw/probe.mjs <browser> [exe]` opens each built HTML file, checks the start passage text, the story
  script's global, `document.title`, clicks the visible `Go next` link and checks the second passage; `vprobe.mjs`
  and `vdev.mjs` drive a Vite build (preview) and dev server (edit, glob add/delete, entry module edit, break, fresh
  page during the error, fix).
- `vsetup.sh`, `vpreview.sh`, `vdev.sh`, `vwatch.sh` (per Vite version), `rollup.sh`, `cliprobe.sh`, `cliwatch.sh`,
  `fx.sh` + `gen-fixtures.mjs` (targeted parity fixtures), `media.sh`, `t1cmp.sh`/`t1rot.sh` (Twine 1),
  `remote.sh`/`twine1.sh` (live archive).

## Areas covered

### api

- ESM and CJS consumers: `import`/`require` of `@rohal12/twee-ts`, `/rollup`, `/vite` (with Vite installed; without
  it, a clear `ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND` for `vite`, as the optional peer implies),
  `/schemas/twee-ts.config.schema.json`, `/package.json`. Both builds export the same 37 names.
- `compile()` in all output modes, `INVALID_OPTIONS` for an unknown `outputMode`, the `FORMAT_UNAVAILABLE` error of a
  Twine 1 format missing `code.js` (TweeTsError, as the code and the Error Handling table say; see S3-2 for the
  paragraph under the table).
- Version behaviour (`src/version.ts`): with the installed `package.json` rewritten to `2.0.0`, as semantic-release
  publishes it, the CLI (`--version`, `creator-version` in HTML/archive/JSON, the `--init` `$schema` URL) and the CJS
  build report 2.0.0; the ESM build reports `0.0.0` when a global `__dirname` exists (S3-1).

### syntax

- Targeted parity fixtures against Tweego (`-d`, `-a`, `-l` word counts): Unicode word counting (combining marks, the
  U+0301 U+09BE case of #367, ZWJ, CJK, emoji), comments, macro markup, Twee2 header without StoryData (`.tw2`),
  metadata (number `position`, `Position` key), trailing backslash, Go whitespace (U+0085, U+3000, U+00A0), escaped
  names, scripts without semicolons, Windows-1252 and UTF-16 input. Every difference is a documented D-entry, except
  the UTF-16 one (documented elsewhere, missing from the differences page: S3-3).

### story

- CleanSlate (folder and `cleanslate.twee`), The Good Son, The Shadow of Olympus (Twee and two HTML builds), Course of
  Temptation (HTML; its Twee source is malformed and fails in both with the same message, twee-ts naming the file
  and adding the consequent missing-start error): start passage, IFID, zoom, tag colours, options identical apart from
  D-20/D-21/D-22. `-s Other` fails identically. `--init` scaffold builds and has a title (#333).

### inputs

- Every extension in the getting-started table plus upper-case `.PNG`, `.txt`, `.md` and a dotted font name: `-d` and
  HTML identical to Tweego apart from D-20/D-22. Windows-1252 fallback warning identical in text to Tweego's.
  Missing head file: exit 1, `load head file …` error. UTF-16 BOM source read as UTF-16 (Tweego reads it as
  Windows-1252 and finds no passage; see S3-3).

### files

- CLI watch mode: edit, break (output kept byte for byte), fix, folder added and deleted, `--log-files` per build; one
  cosmetic finding (S3-5). Read-only output refused with `EACCES`; `-o=out1.html` writes `out1.html` (#385).
  Format request timeout on a black-hole address: the process exits 1.1 s after start with
  `formatFetchTimeout: 1000` (#376).

### formats

- All nine local formats of the Tweego install (sugarcube-1/2, harlowe-1/2/3, chapbook-1, snowman-1/2, paperthin-1)
  byte-compared with Tweego on CleanSlate: identical apart from D-22 (and D-30 for SugarCube 1). No Harlowe warning
  (#372).
- Live Story Formats Archive: an online build in an empty `HOME` downloaded SugarCube 2.37.3; `-f` builds downloaded
  Harlowe 3.3.9 and 2.1.0, Chapbook 2.3.1 and 1.2.3, Snowman 2.1.5 and 1.5.0, SugarCube 1.0.35; `harlowe-4` fails
  with a list of what the index offers. Twine 1 entries (`sugarcane-1`, `jonah-1`, `responsive-1`) fail with
  `Required format component not found: …/engine.js`, as docs/story-formats.md says. `cache list`, `cache path`,
  `--list-formats` (index-spelled names, as documented).
- Twine 1.4's real Jonah and Sugarcane with engine.js/jquery.js/modernizr.js: Twine 1 HTML identical to Tweego apart
  from D-24 (created/modifier, `Built on` UTC, byline), `SOURCE_DATE_EPOCH` gives the documented `created` stamp.

### output

- CleanSlate in every mode (`-d`, `--decompile-twee1`, `-a`, `--archive-twine1`, `-t`, `--no-trim -d`, every format):
  only documented differences. Decompiling Tweego's and twee-ts's CleanSlate HTML gives the same Twee from both
  tools (apart from `zoom`, D-20). Twine 1 HTML decompiled (`-d`, `--decompile-twee1`) identical to Tweego.
- Real browsers: a story whose name holds `& " < > ' \ ${x} </script> é` and whose script and stylesheet hold
  `</script><!-- x` and `</style>`, built for every local format and for the archive's formats, starts, runs its
  script, shows the exact title and follows its link in Chromium, Firefox and WebKit for SugarCube 1 and 2, Harlowe 2
  and 3, Chapbook 1 and 2, Snowman 1 and 2 (Paperthin shows the proofing text; it has no links). Tweego's builds of the
  same story do not start in any format (D-25). Without end tags in code, Tweego's builds start too, except SugarCube
  1.0.35 (D-30); Harlowe 1.x starts with neither compiler. CleanSlate's HTML from both tools loads in Chromium without a
  page error.
- ROT13 (`obfuscate:rot13`) Twine 1 HTML: twee-ts's Jonah and Sugarcane builds start and follow links; Tweego's do not
  start (output-modes.md documents it; the differences page does not: S3-3).

### cli

- Usage errors (exit 2, `Run "twee-ts --help" for usage.`): `-d --json`, `--lint -w`, `-o ''`, an empty source,
  `--charset`, `cache clear ''`, `--list-formats --no-remote`, `--version extra`, `-w` without `-o`, `-w -o -`.
  `--help --bogus` exits 0 (#382). `-c utf-8` adds the charset note. `-l -o -`: story alone on stdout, statistics on
  stderr. `-c dir/cfg.json` resolves paths against the config folder. `--decompile` accepted. A story with no passages
  gives the three expected errors.

### plugins

- Vite 8.3.4, 8.2.4 and 8.0.0: production build with `entry` (TS, CSS import with an inlined SVG `url()`, eager
  `import.meta.glob`, `new Worker(new URL(...))`), served by `vite preview` and opened in Chromium: story, entry,
  worker answer, glob count and CSS all present; no page errors.
- Dev server on all three: initial page, story edit reload, glob file added (count 2) and deleted (count 1), entry
  module edit, a break shows the overlay while the last good story stays, a fresh page during the error gets the old
  story and the overlay, the fix reloads.
- `vite build --watch`: on 8.3.4 and 8.2.4 a story edit, a source file added to the folder, an entry module edit and a
  file added to a glob folder each rebuild; on 8.0.0 the two folder additions are read only with a later build, as
  docs/plugins.md says for 8.0/8.1.
- Vite 7.2.2 forced with `--legacy-peer-deps`: `TweeTsError: twee-ts vite plugin: Vite 7.2.2 is not supported…`
  (#368); a normal `npm install` refuses Vite 7 through the peer range.
- Rollup 4.64.5: ESM `rollup.config.js` (Harlowe 3, `outputFilename`, tag alias) and CJS `rollup.config.cjs`; a
  duplicate passage warning goes through Rollup's warning output with file and line; `rollup -w` rebuilds on an edit,
  keeps the last output on an error (reported with file and line), rebuilds after the fix.

### distribution

- Tarball: 38 files (`dist`, `schemas`, `THIRD_PARTY_NOTICES`, `UNLICENSE`, `README.md`, `package.json`), no stray
  files, no `dependencies`, peer `vite >=8` optional, `engines.node >=24`; `bin` runs through `npx` and `.bin`.
- THIRD_PARTY_NOTICES lists Tweego, acorn, entities and parse5, exactly the packages bundled (acorn@8.19.0,
  entities@8.1.0, parse5@8.0.1 by the region markers in `dist`).
- Node 22: the CLI runs normally (engines only warns on install), consistent with docs, which promise only `engines`.
- `src/version.ts`: S3-1.

### documentation

- Read in full: README.md, docs/index, getting-started, cli (options, usage errors, output safety, streams, exit
  status), configuration, output-modes, plugins, api (core functions, options, result, error handling, option
  checks), story-formats (discovery, search order, listing, metadata, pruning, Twine 1, indices), story-format-packages
  (usage, what twee-ts reads), migrating-to-2, tweego-differences, compiler-validation (review sections), CHANGELOG
  `[Unreleased]`. Skimmed: tag-aliases, the rest of api.md (utility exports), CHANGELOG `[2.0.0]`.
- Claims run against the tarball: listed under the other areas; findings S3-2, S3-3, S3-4.
- docs/configuration.md says SchemaStore keeps no copy; the live catalog entry still points to SchemaStore's own copy
  (`raw.githubusercontent.com/SchemaStore/schemastore/master/src/schemas/json/twee-ts.config.json`): known #378.

## Findings

### S3-1 (P3) The ESM build reports version 0.0.0 when the process has a global `__dirname`

Not tracked (no open or closed issue covers it).

Reproduction (tarball installed in an ESM project, its `package.json` version set to `2.0.0` as the release writes it):

```
$ node ver.mjs            # import('@rohal12/twee-ts'), compile JSON, print creator-version
plain 2.0.0
$ node ver.mjs shim       # same, after globalThis.__dirname = import.meta.dirname
shim 0.0.0
$ node -e "import('@rohal12/twee-ts').then(m => m.compile({sources:['s.tw'], outputMode:'twine2-archive'})).then(r => console.log(r.output.match(/creator-version=\"[^\"]*\"/)[0]))"
creator-version="0.0.0"
$ node -e "require('@rohal12/twee-ts').compile(...)"   # CJS build: 2.0.0
```

Root cause: `moduleDir()` in `src/version.ts` picks `__dirname` whenever `typeof __dirname === 'string'`. In the ESM
build that name is not module-scoped, so it resolves to a global when one exists: `node -e`/`node -p` and the REPL
define `__dirname` (`.`) on the global object, and ESM code (or a bundler banner) that shims
`globalThis.__dirname` for CommonJS-era dependencies does too. The walk then starts at the wrong folder, finds no
`@rohal12/twee-ts` package.json and falls back to `0.0.0`, which is written as `creator-version` into Twine 2 HTML,
archives and JSON (and the `--init` `$schema` URL if the CLI ran that way). The CLI's own entry is unaffected in
normal runs.

Suggested issue: "[P3] The ESM build reads a global `__dirname` and reports version 0.0.0 (creator-version) under
`node -e`, the REPL or a `globalThis.__dirname` shim". Invariant: `VERSION` is the installed package's version in
every module format and host. Fix: decide the module directory per output format at build time (tsdown `define`, or
`import.meta.url` in the ESM entry and `__dirname` only in CJS), not by probing a global; regression test that loads
`dist/index.js` with `globalThis.__dirname` set to another folder.

### S3-2 (P4) docs/api.md's Error Handling section misstates two cases

Not tracked (#392 fixed other items of this table).

- The `BUILD_FAILED` row lists "an unknown `outputMode`", but option checking rejects it first with
  `INVALID_OPTIONS` (`Invalid compile option: "outputMode" must be one of: …`, reproduced with the tarball);
  `BUILD_FAILED` for it exists only in the unreachable exhaustive `default` of `runBuild()`.
- The paragraph under the table says "a Twine 1 format whose required file is missing" rejects with an ordinary
  `Error` naming the file, while the `FORMAT_UNAVAILABLE` row (and the code, `componentUnavailable()` in
  `src/output-twine1.ts`) make it a `TweeTsError`: reproduced, a Jonah folder without `code.js` throws
  `TweeTsError FORMAT_UNAVAILABLE Required format component not found: fmts/jonah/code.js: …`.

Suggested issue: "[P4] docs/api.md Error Handling: unknown outputMode is INVALID_OPTIONS, and a missing Twine 1
component is FORMAT_UNAVAILABLE (contradicting paragraph)".

### S3-3 (P4) docs/tweego-differences.md, which says it lists every intended difference, omits three

Not tracked (#384 added D-20 to D-30; these three were not among its items).

Each is documented elsewhere, so it is intended, but the page says "This page lists every difference that is
intended … Any other difference is a bug", and has no D-entry or test for them:

1. **Program folder.** Tweego searches `storyformats` (and its other folder names) next to its own executable first
   (`programDir` in `tweego/config.go`); twee-ts does not (`getFormatSearchDirs()`), as getting-started.md
   ("Compatibility with Tweego") says. docs/story-formats.md's search order ends with "as in Tweego".
2. **UTF-16 sources.** A source with a UTF-16 byte order mark is read as UTF-16 (getting-started.md "Text encoding");
   Tweego 2.1.1 reads it as Windows-1252 (0xFF is invalid UTF-8) and finds no passage: reproduced, `tweego -d
utf16.tw` writes nothing and `-a` fails, twee-ts writes the story.
3. **ROT13 obfuscation.** With `obfuscate:rot13`, twee-ts encodes the Twine 1 tiddlers (output-modes.md says so,
   naming Tweego); Tweego writes them unencoded. Reproduced in Chromium with Twine 1.4's Jonah and Sugarcane:
   twee-ts's builds start and follow links, Tweego's do not start.

Suggested issue: "[P4] Differences from Tweego: add the program folder, UTF-16 sources and ROT13 obfuscation" with a
test per entry, as the page requires.

### S3-4 (P4) Markdown slips in the differences page and the changelog

Not tracked.

- docs/tweego-differences.md: D-28 and D-32 are on consecutive lines with no blank line, so the site renders them as
  one paragraph (`… Go's charmap). D-32. Size limits. A JavaScript string …`, seen in the built
  `tweego-differences.html`).
- CHANGELOG.md `[Unreleased]` has two `### Fixed` headings (lines 15 and 126) and two lists separated by blank lines
  inside the first (lines 63 and 82); the fold into `[2.0.0]` should merge them.

### S3-5 (P4) CLI watch mode prints "Built: N passages" for a build it does not write

Not tracked (#403 was the order of `Watch mode started`).

```
$ twee-ts --no-remote -w -o out.html src     # then break src/story.tw
Built: 2 passages, 0 words
error: src/story.tw:7: Malformed twee source; unterminated tag block.
error: Starting passage "Start" not found.
Build has 2 errors; output not written. Still watching for changes.
```

`onBuild` in `bin/twee-ts.ts` logs `Built: …` before it counts the errors, so a failed build first claims to be built
and the counts are those of the broken story. Suggested: print `Built:` only for a written build (or `Build failed:`
with the counts after the errors).

### Rediscovered known issues

- #378 (open, P3): SchemaStore's catalog still points at its own copy; docs/configuration.md line 19 says it keeps
  none.
- #436 (open): no intermittent failure observed here; CI on the commit is green on all three OSes.

## Passing (worked as documented)

Package checks; ESM/CJS consumers; CLI from the tarball; notices; CleanSlate and four other real projects identical to
Tweego apart from D-entries in every mode and format; decompile parity; targeted Twee fixtures; media table; Twine 1
with real Jonah and Sugarcane; all Twine 2 formats of the Tweego install and of the live archive in Chromium, and the
local ones in Firefox and WebKit; Vite 8.0.0/8.2.4/8.3.4 build, preview, dev and build watch; Vite 7 refusal; Rollup
ESM/CJS/watch; CLI usage errors, watch mode, output safety spot checks; remote timeouts; docs build.

## Failing

Only S3-1 to S3-5 above. No P1 or P2.

## Blocked

- Windows and macOS behaviour (case folding, rename retries, FSEvents, rolldown-notify link caveats): no such machine
  here; CI covers the test suite there.
- Twine 1 `responsive`: its `header.html` is not in the `tweecode/twine` repository path used (404), so it was not
  compared.
- The docs deploy workflow for the commit was still queued when checked.

## Not covered

- The full test suite, coverage, contracts and duplication tools (CI ran them on the commit, as instructed).
- Seeded fuzzing against Tweego (round 2 ran 1,450 generated files; this sweep used targeted fixtures for the areas
  changed since).
- Vite dev server `base` variants, nested `outputFilename`, multiple instances, link retargeting and `addWatchFile`
  folders (#393) in a real browser; left to the plugin test suite and the contract matrix.
- Harlowe 1.x start (does not start with either compiler in Chromium); Chapbook 2/Snowman link clicks were probed by
  the visible `Go next` text only.
- The lint SugarCube macro table and the `whitespace` word count against SugarCube in a browser (CI has a
  Chromium/Firefox/WebKit comparison test).

Open P1: 0, open P2: 0

# Release review sweep: twee-ts 2.0.0, round 3, sweep 1

- Reviewer: sweep-implementation-r3
- Method: implementation
- Commit: 5ed23d7ca541f416ca8241467dd1570ab801ef68
- Fingerprint: be22a07a3b165fb43956530724138bb5c29706a7eab17d5a2f8b3d64a220fd95 (`pnpm run release:gate --fingerprint 5ed23d7…` reproduced it)

## Environment

- OS: Linux 7.0.0-34-generic (x86_64)
- Node: v24.21.0; pnpm 12.10.1; Vite 8.3.4; Vitest 5.0.3

## Commands run

- `git checkout --detach 5ed23d7ca541f416ca8241467dd1570ab801ef68`; `pnpm install --frozen-lockfile`
- `pnpm run release:gate --fingerprint 5ed23d7…` -> be22a07a…fd95 (matches)
- `pnpm run build` -> exit 0
- `pnpm run test:contracts` -> 4 files, 85 tests passed, exit 0
- CI on the frozen commit (cited, not rerun): `gh run list --commit 5ed23d7…`: CI run 38151731359 success
  (lint, test ubuntu/macos/windows, coverage, plugin peers, plugin tests Vite 8.0/8.2, package pack + consumers
  on three OSes, contracts), Duplication 38151731419 success, Release 38151731403 success.
- Probes (scripts under /tmp/s1probe, against dist/ unless noted; no randomness, so no seeds):
  - stream.ts (src via tsx): watchFilesystem with `stream.shared: true` on Linux: no build loop, probe folder removed
  - css.mjs: 14 stylesheet @import placements through compile() JSON output
  - roundtrip.mjs: Twine 2 HTML output of special passage text/names/script/style and decompileHTML back
  - cli.sh: CLI build, stats, lint, output in a source folder, stdout, usage errors, cache subcommands
  - hdr.mjs: 14 Twee 3 header forms
  - wc.mjs: whitespace word count of `<svg>` / `<style>` after skipped regions
  - watch.mjs: watch() through edit, atomic save, new folders, file links, retargeted links, folder links,
    folder rename, link delete
  - cfgp: config-relative sources/exclude/output with `-c proj/twee-ts.config.json`
  - t1.mjs: Twine 1 HTML, Twine 1 archive, Twine 2 archive, JSON and Twee 1 output of special names, tags and text,
    decompiled back (local Twine 1 header.html fixture)
  - dollar.mjs: `$&`, `$'`, `` $` ``, `$$`, `$1`, `{{STORY_NAME}}`/`{{STORY_DATA}}` in passage text and story name,
    Twine 2 and Twine 1 templates (no replacement-pattern leaks; context escaping as docs/story-format-packages.md says)
  - aw.mjs: compileToFile to a file link, a dangling link chain, a hard link, a 0640 file, a read-only file, a writable
    file in a read-only folder, a new file there, 254-byte ASCII and 244-byte UTF-8 names, /dev/null, a link cycle
  - opts.mjs, buf.mjs: option checks (empty sources, `__proto__` tag alias, wrong types, unknown keys, empty
    strings), inline Buffer/HTML/unknown-type sources
  - fmt.mjs: format selection tiers (pinned, exact, newer, older, any, id; pruning with a prerelease; missing major;
    proofing; version only; unparsable version) over six local format folders
  - lint.mjs: lint link reading for every row of the docs/api.md link table plus comments, `<<script>>`, `<script>`
  - wcperf.mjs: whitespace word count on 13 adversarial 20k–50k-element passages at 1x and 2x (all linear, < 0.4 s)
  - cli2.sh: EPIPE, closed stdout, /dev/full, `-o -`, `-o=file`, `--output=file`, `-dt`, `-l -d`, `--init` twice,
    `--list-formats` combinations
  - t2.mjs: Twee2 `<x,y>` headers with `twee2Compat`
  - enc.mjs: UTF-16LE/BE with BOM, UTF-8 BOM, Windows-1252 Twee and CSS, UTF-16 without BOM
  - rw.mjs: `rollup --watch` (Rollup 4.64.4 API) with a two-hop link chain retargeted at each hop and directly
  - vdev.mjs: Vite 8.3.4 dev server with `entry` (dependency + `import.meta.glob`), requests right after a story edit,
    a dependency edit and a glob file add; then `vite build`
  - inc.mjs: compileIncremental vs compile after a same-size edit with restored mtime, rename, changedFiles with
    `./`, delete, link added, changedFiles naming a link
  - `node scripts/check-package.mjs` (after the build): all package checks passed (types for TS 5.9.3/7.0.2 under
    every resolution, ESM/CJS runtime, one build graph, CLI through npx, version)

## Areas covered

- **api**: compile/compileToFile/watch/compileIncremental/lint option checks (CONFIG_SPEC rules, INVALID_OPTIONS,
  unknown-option warning, `__proto__` keys), incremental equivalence (inc.mjs, contract matrix), watch() ordering and
  fatal handling (code read of compiler.ts watch loop), TweeTsError codes. No defect.
- **syntax**: lexer/parser header forms and errors (hdr.mjs), Twee2 compat (t2.mjs), normalization and decoding
  (enc.mjs, buf.mjs), link and macro reading (lint.mjs; code read of the walkPassageMarkup refactor in
  sugarcube-macros.ts: htmlEndTagAt, closerReader, ownElementReader, svgElementsOf against SugarCube 2.37.3's own
  parsers in test/fixtures/sugarcube-oracle). S1-1 is in svgElementsOf.
- **story**: special passages, start passage, IFID, lint broken links/dead ends/orphans against the documented table,
  Tweego word count (stripComments vs Tweego's comment regex, segment iterator), whitespace word count (wc.mjs,
  wcperf.mjs; code read of readMarkup/OpenElements/countWhitespaceWords). S1-1.
- **inputs**: loader by extension, encodings, inline sources, duplicate spellings and links of one file (deduplicated),
  exclude globs relative to the config folder, folder links not followed (as Tweego's walk). No defect.
- **files**: atomic-write (temporaryName byte budget, strategy table, link resolution, permissions, in-place fallback,
  error naming; aw.mjs), folder-stream.ts (probe generation/attempt/settle logic, subscription lifetime, no build loop
  with `shared: true`, probe folder removed; stream.ts), watchFilesystem integration (arm/close call streamReplaced),
  watch() end to end (watch.mjs), output-in-source-folder rule (documented second-run refusal for Twee output). No
  defect. Note: with `shared: true` on Linux each re-arm before a build triggers one more full build; `shared` is only
  on by default on macOS, where that re-arm does not run, so it has no effect in practice.
- **formats**: selection tiers and pruning (fmt.mjs, matches docs/story-formats.md), remote URL checks and redirect
  rules (code read of remote-formats.ts: manual redirects, https->http refused, size limit, 304 handling), cache write
  protocol (code read of format-cache.ts: content dirs by hash, record publish, repair, stale cleanup race handling).
  No defect.
- **output**: Twine 2 HTML/archive/JSON, Twine 1 HTML/archive, Twee 3/1 round trips (roundtrip.mjs, t1.mjs),
  template replacement (dollar.mjs), script/style escaping, css-imports.ts tokenizer and rule consumer against CSS
  Syntax 3 (code read: url( whitespace/quote lookahead, bad-url remnants, block matching with mismatched closers,
  at-rule classification) and 14 placements (css.mjs), JSON vs HTML join of stylesheets. No defect.
- **cli**: help, usage errors and exit codes, `-o` forms, stdout failures, `--init`, config-relative paths, lint
  report, `cache` subcommands (cli.sh, cli2.sh, cfgp). No defect.
- **plugins**: Rollup watch with link chains (rw.mjs; code read of link-watch.ts and the rollup.ts `followed` map),
  Vite dev server catch-up and entry rebundling (vdev.mjs; code read of the catchUp change), Vite build with entry,
  code read of the `vite build --watch` import retarget/claiming-plugin and worker-glob paths in vite.ts and
  pluginWith/withWorkerPlugin in vite-entry.ts. S1-2 (P4, code reading).
- **distribution**: exports map, typesVersions, engines/devEngines (Node >= 24), peer `vite >=8`, files list; build
  leaves the tree clean (THIRD_PARTY_NOTICES unchanged); check-package.mjs passed; CI package job passed on three OSes.
  No defect.
- **documentation**: claims checked against behaviour for config path relativity and exclude, output inside a source
  folder (cli.md, api.md, plugins.md), format selection and pruning (story-formats.md), lint link table (api.md),
  `{{STORY_NAME}}` context escaping (story-format-packages.md, migrating-to-2.md), Rollup watch link handling
  (plugins.md). Docs snippets/reference tests ran in CI. No defect.

## Findings

### S1-1 (P4) Whitespace word count reads a rendered `<svg>` element as text after an earlier `<svg` with no `>` of its own

- Status: open, not tracked (a new variant of the class #435/#422 closed: whitespace word count differs from what
  SugarCube shows). Suggested: a new P4 issue, or a reopen/comment on #435.
- Reproduction (dist/, /tmp/s1probe/wc.mjs):
  ```js
  import { compile } from '@rohal12/twee-ts';
  const src = ':: StoryTitle\nT\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\n';
  for (const text of ['<svg>hi there</svg>', '/* <svg */ <svg>hi there</svg>'])
    console.log(
      (
        await compile({
          sources: [{ filename: 'a.tw', content: src + text + '\n' }],
          outputMode: 'twee3',
          wordCountMethod: 'whitespace',
        })
      ).stats.words,
    );
  // 0, then 2: SugarCube drops the comment and renders the same <svg> element (0 words, as in the first case);
  // twee-ts reads "<svg>hi" and "there</svg>" as two words of text.
  ```
  Of the regions the walk skips, only `/* … */` and `/% … %/` comments can hold such a `<svg`: a macro, `<<script>>`
  body, `<nowiki>` or `<!-- -->` ends with a `>` of its own, which stops `[^>]*>` (`<<set $a to "<svg">> <svg>…` counts
  correctly). 20000 such comments before one `<svg>x</svg>` give 1 word instead of 0 (wcperf.mjs `comment_svg`).
- Root cause: `svgElementsOf()` (src/sugarcube-macros.ts ~L1028) lists the `<svg…>`/`</svg…>` tags of the whole text
  from offset 0, each running `[^>]*>` to the next `>` and resuming after it, without regard to the regions the walk
  skips. A `<svg` inside a comment with no `>` before the real opener absorbs the real opener (`[^>]*>` reaches its
  `>`), so the real opener's offset is not in the map, `ownElementReader` returns undefined, `htmlTagReader` refuses it
  (`startsOwnElement`), and the element is walked as text. SugarCube's svgTag parser only starts its
  `<(\/?)svg[^>]*>` search at `w.nextMatch` after an opener the wikifier actually matched, so the comment's `<svg` is
  never read. `<style` is not affected: `ownElementReader` searches its `>` from the opener's own offset.
- Suggested issue text: "The `whitespace` word count lists the `<svg` tags of the whole passage from its start
  (svgElementsOf) instead of from the opener the walk reaches, so a `<svg` without a `>` in a `/* */` or `/% %/`
  comment before a real `<svg>` element hides that element, which is then counted as text
  (`/* <svg */ <svg>hi there</svg>` counts 2 words, SugarCube shows none). Closure: read an svg element's tags from
  its own opener's end, as SugarCube's lookahead does (still linear: tags are found from each reached opener forward,
  never before it), and add comments holding `<svg`/`</svg` to the oracle generator."

### S1-2 (P4) Vite dev server: a request that waits for a running build can be answered before the rebuild a debounced event asked for

- Status: open; not yet listed, belongs as a new variant on open issue #436 (or its own P4 issue if #436 stays
  CI-only); a narrower variant of the #436 dev-server row fixed in 07c6165 ("answer a dev server
  request after the events the watcher reported"). Not reproduced: it needs a save that leaves size, inode and times
  unchanged (a file system with coarse timestamps), which this Linux/ext4 machine does not give. Found by code
  reading; P3/P4 need no reproduction.
- Path: src/plugins/vite-dev.ts `catchUp` (L746–L761) and `noteChange` (L702–L710). A request arrives while rebuild A
  runs and an event E is pending: catchUp awaits `queue` (A). If the 50 ms debounce fires meanwhile, `noteChange`'s
  timer moves E out of `pending` into rebuild B, chained after A. When A settles, catchUp resumes first (it awaited
  A's promise before B was chained), finds `pending` empty and, under coarse timestamps, no state change, and returns
  without awaiting B, so the response carries A's story although E was reported before the request. B then sends a
  full reload, so the page corrects itself; hence P4.
- Suggested issue text: "catchUp() awaits the queue as it was when the request came; a rebuild that the debounce
  timer chains while it waits is not awaited, so the response can predate a change the watcher reported first.
  Closure: after `await queue`, await again while `queue` changed (or have the timer callback leave its files visible
  to catchUp until its rebuild starts), with a test that holds a build open past the debounce."

## Blocked or not covered

- macOS and Windows behaviour (FSEvents stream replacement in folder-stream.ts, case-insensitive path identity,
  Windows device names and rename retries): not runnable here; reviewed by code reading only, and covered by CI's
  macOS and Windows test jobs on this commit (run 38151731359). The folder-stream probe ran on Linux with
  `stream.shared: true`, which exercises the probe logic but not FSEvents.
- Remote format downloads were reviewed by code reading only (no loopback-server probe in this sweep); the contract
  matrix (`pnpm run test:contracts`) and CI cover them.
- `vite build --watch` with workers and retargeted links (#424/#320 paths in vite.ts) was reviewed by code reading
  only; no probe.
- The full test suite and coverage were not rerun locally (CI run 38151731359 passed them on three OSes).
- Tweego parity of statistics (passage count, word totals) was not checked against a Tweego binary (left to the
  compatibility-distribution sweep).

## Summary

Findings: S1-1 (P4, whitespace word count after a comment holding `<svg`), S1-2 (P4, dev-server catch-up race under
coarse timestamps, code reading). Neither is tracked yet; both are new P4 variants of closed or open classes (#435,
#436).

Open P1: 0, open P2: 0

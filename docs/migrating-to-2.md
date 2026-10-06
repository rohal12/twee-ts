---
outline: deep
---

# Migrating to 2.0

twee-ts 2.0 makes the compiler stricter and more exact: input it used to accept and quietly turn into something else is now an error, and its reading of Twee, StoryData and story formats follows Tweego and the specifications more closely. This page lists every incompatible change since 1.18, with what to do about it. The [changelog](https://github.com/rohal12/twee-ts/blob/main/CHANGELOG.md) has the complete list, additions and fixes included.

Most projects need to check four things:

1. Node.js is 22.12 or newer.
2. Paths in a config file named with `-c` are relative to that file's folder.
3. Scripts that read `--log-stats` output read standard error, and treat exit status 2 as a usage error.
4. The story still builds without errors: some input that 1.x accepted, such as a StoryData passage that is not valid JSON, is now an error.

## Node.js 22.12

**Before:** Node.js 22.0 and later. **After:** `engines` requires Node.js 22.12 or newer, the first Node 22 release that loads ES modules through `require()` without a flag.

**Migrate:** upgrade Node.js. CI tests 22.12.0 and the latest Node 22 and 24.

## Command line

### Standard output carries only the story

**Before:** `--log-stats`, `--log-files` and watch mode's messages went to standard output, and `--log-files` did nothing when the story went to standard output. **After:** standard output carries only the story (or a query's answer: `--help`, `--version`, `--list-formats`, `cache`, `--lint`, `--init`); everything else goes to standard error.

**Migrate:** a script that reads the statistics from standard output reads standard error (`2>`) instead. `twee-ts -l src/ > story.html` now writes exactly the story.

### Usage errors exit with status 2

**Before:** a bad command line exited with status 1, after printing `Error: …`, and some conflicts were ignored. **After:** every command line that can't be run is a usage error: twee-ts prints `error: …` and `Run "twee-ts --help" for usage.`, and exits with status 2, before building anything. That covers unknown options, a missing or empty value, an option given twice, conflicting options (`-d --json`, `--lint` with `-w`, `-l`, `--log-files` or an output mode, `-c` with `--no-config`, `--version`, `--init` or `--list-formats` with anything else), an invalid `--tag-alias` or `--word-count-method`, no sources, and watch mode without an output file. `cache` is a subcommand only as the first word, never after `--`.

**Migrate:** remove conflicting options (two output modes used to pick the first silently). Scripts that check for status 1 treat 2 as a usage error. To build a folder named `cache`, write `./cache`. See [the CLI reference](./cli).

### Inputs that can't be used

**Before:** a missing head file was a warning. **After:** one table decides what happens to every input that can't be used ([Inputs That Can't Be Used](./cli#inputs-that-can-t-be-used)): a missing or unreadable head file is fatal, as in Tweego (`TweeTsError`, `INPUT_UNAVAILABLE`), an unreadable module is an error naming it, and a source named directly whose type twee-ts doesn't load is a warning.

**Migrate:** fix the path of `--head` / `headFile`, or remove it.

### Output safety

**Before:** an output file inside a source folder was silently left out of the sources and overwritten, whatever it was; a read-only output was replaced; a hard link to the output was broken by the atomic rename. **After:**

- An output inside a source folder that already holds an author's file of a source type (not an earlier twee-ts build) is refused (`OUTPUT_IS_INPUT`).
- The output is written by what is at its path: a read-only file is refused (`EACCES`), a hard-linked file is written in place, and FIFOs, devices and `/dev/stdout` are written through.
- `-o ''` and `"output": ""` are rejected.

**Migrate:** move the output out of the source folder, or leave the file out with `--exclude`. Make a read-only output writable. See [Output safety](./cli#output-safety).

## Config files

### Config paths are relative to the config file

**Before:** paths in a config file were relative to the working directory. **After:** `sources`, `exclude`, `output`, `modules`, `headFile` and `formatPaths` are relative to the folder that holds the config file. A config in the working directory is unaffected. `loadConfig()` and `loadConfigFile()` return the paths rebased onto the working directory.

**Migrate:** for `twee-ts -c dir/twee-ts.config.json`, drop the `dir/` prefix from the paths in that file.

<!-- docs-test: skip — a 1.x config, shown for comparison -->

```json
{
  "sources": ["dir/src/"],
  "output": "dir/story.html"
}
```

becomes

```json
{
  "sources": ["src/"],
  "output": "story.html"
}
```

### Stricter values

**Before:** empty entries were accepted. **After:** `output` and the entries of `sources`, `exclude`, `modules`, `formatPaths`, `formatIndices` and `formatUrls` must not be empty, and tag aliases and their targets must be non-empty and hold no white space. A config file that fails validation is a `TweeTsError` (`INVALID_OPTIONS`).

**Migrate:** remove empty entries; a tag can't hold white space, so an alias that does could never match.

## Story sources

### StoryData errors

**Before:** a StoryData passage that was not valid JSON was a warning, and a field of the wrong type (`"format-version": 3`, `"options": "debug"`, `"start": ["A"]`) was dropped silently. **After:** both are errors, so the CLI writes no output (Tweego stops on both).

**Migrate:** fix the StoryData passage the error names.

### The last special passage decides alone

**Before:** a later StoryData, StorySettings or StoryTitle passage was merged with earlier ones. **After:** as in Tweego, the last passage of each name decides its part of the story alone: a malformed last StoryData leaves the story without the earlier one's IFID, format and start, and a last StorySettings without `obfuscate:rot13` or `ifid` turns ROT13 off and drops the legacy IFID an earlier one set.

**Migrate:** keep one StoryData, StorySettings and StoryTitle passage each; twee-ts warns about the duplicates and names both.

### Media and font names stop at the first dot

**Before:** `bg.night.png` became the passage `bg.night`. **After:** as in Tweego, media passages and font families are named after the file up to its first dot: `bg.night.png` is the passage `bg`, `My.Font.woff2` the family `My`.

**Migrate:** rename files whose inner dots should be kept (`bg-night.png`), or refer to the new names.

### Reading Twee as Tweego does

- Passage metadata whose `position` or `size` is not a string is discarded, with a warning, as in Tweego; it used to keep the other keys. `Position` and other case variants are read as `position` and `size`.
- A passage name that ends in a lone backslash loses it, with a warning; write `\\` for a backslash.
- Names, tags and the text of passages, StoryTitle and StorySettings are trimmed and split at Go's white space: U+0085 is white space, U+FEFF is not.
- With `trim: false` (`--no-trim`), a passage whose content is only white space is empty: trailing blank lines are dropped, as the Twee 3 specification requires.

**Migrate:** nothing, unless a warning names a passage.

### Orphans

**Before:** a passage counted as reached when any link led to it. **After:** `storyInspect()` and lint list as orphans the story passages that no chain of links reaches from the start passage or an info passage, so a passage that links only to itself, or a group that links only among itself, is listed.

**Migrate:** link the passages listed, or remove them.

## Story formats

### `format.js` is read as JavaScript

**Before:** the format object was found by scanning for the first `{`. **After:** `format.js` is parsed as JavaScript (acorn) and never run:

- The file must be valid JavaScript; one that is not is skipped with the parser's message and position.
- The format object is the object literal passed to the file's one `storyFormat()` call, or the whole file when it is nothing but an object literal. A file that calls `storyFormat()` more than once, or whose object was found only as the first `{` of other code, is skipped.
- The object is read by a stated subset of JavaScript literals ([Format Metadata](./story-formats#format-metadata)). Anything outside it is an error naming the property and its line and column, for example a signed key (`{-1: 1}`) or a `__proto__` key.

**Migrate:** fix the file (a browser couldn't load it either), and write the object as `window.storyFormat({…})`.

### One selection policy

**Before:** each source (local folders, format URLs, indices, the cache) chose by rules of its own, and what an online build chose could depend on what the cache held. **After:** one policy for every source ([How a Format Is Chosen](./story-formats#how-a-format-is-chosen)): the first source (local folders, then each format URL, then each format index) with an answering format wins; within a source, an exact version beats a newer one, and the greater version beats exact letter case. A same-major older version is used, with a warning, only when no source has an answering one. An online build's choice no longer depends on the cache.

**Migrate:** name an exact `format-version` in StoryData when you depend on one.

### The download cache is keyed by provenance

**Before:** downloads were cached by format name and version and shared by every project, and a format URL's cached copy was used forever. **After:**

- A download from a format index is used only by builds that consult that index, and only while it matches the checksums the index lists; a download from a format URL only by builds that list that URL.
- A format URL is requested again on every online build that reaches it (conditionally, with its ETag or Last-Modified); offline, its cached copy is used.
- `noRemote` builds use the cached downloads of their own `formatUrls` and `formatIndices` and of the Story Formats Archive, not every download on the machine.
- The cache folders of twee-ts 1.x are no longer read. An empty or relative `XDG_CACHE_HOME` is ignored, as the XDG Base Directory specification says.

**Migrate:** run `twee-ts cache clear` once (it also removes the 1.x folders) and let the next online build download again. An offline machine needs one online build per project.

### Remote sources and versions

- `formatUrls` and `formatIndices` take only absolute `http:` and `https:` URLs without credentials; anything else, such as a `file:` URL or a relative path, is an error. **Migrate:** put a local `format.js` in a folder named like a format ID and list its parent in `formatPaths`.
- Versions follow SemVer 2.0.0 strictly, besides Tweego's leading `v` and short `1`/`1.2` forms: a number with a leading zero (`01.2.3`, `1.0.0-01`) or a major, minor or patch above 2<sup>53</sup> − 1 is not a version, and a format with one is skipped with a warning. **Migrate:** fix the format's version.

## HTML output

- **Text HTML cannot carry is an error** (so the CLI writes no file): U+0000 and lone surrogates in a passage name, tag or text or in the story name, and a tag that is empty or holds white space (it reads back as other tags). **Migrate:** remove those characters.
- **`{{STORY_NAME}}` is escaped for its place in the template**, as the HTML parser reads it: in a JavaScript string or template literal also for JavaScript, in a URL attribute percent-encoded, in a JSON data block or a CSS string with JSON or CSS escaping; a place no escaping fits gets a warning. **Migrate:** a format that undid the HTML escaping in a URL, JSON or CSS can drop that workaround.
- **Modules and the head file** go before the closing head tag the browser sees. In a template without one, they go where the head ends, with a warning (they used to go before the body start tag, or nowhere). `{{STORY_DATA}}` and the Twine 1 `"STORY"` are replaced at their first occurrence where the browser reads the data as elements; a look-alike in a comment, script or title before it is left alone.
- **Twine 1 obfuscation** follows the StorySettings passage the output carries: when it is tagged `Twine.private` (or an alias of it), the tiddlers are written unencoded, with a warning. Under `obfuscate:rot13`, a passage whose name ROT13 turns into `StorySettings`, or whose tag it turns into `Twine.image`, is an error. **Migrate:** untag StorySettings to obfuscate; rename the passage or tag.

## API

### StoryBuilder

**Before:** `builder.story` gave the builder's mutable story, and changes to `builder.story.passages` could leave its lookups wrong. **After:** the story changes only through the builder's methods. `builder.story` is gone; `build()` returns a frozen snapshot that later changes don't reach; `get()`, `passages` and `build()` hand out frozen copies; new `remove()`, `rename()`, `get()` and `passages`.

<!-- docs-test: skip — 1.x code, which no longer compiles -->

```typescript
// 1.x
const story = builder.story;
story.passages.push(passage);
story.passages = story.passages.filter((p) => p.name !== 'Notes');
story.passages[0].name = 'Start';
```

```typescript
// 2.0
import { StoryBuilder } from '@rohal12/twee-ts';
import type { Diagnostic, Passage } from '@rohal12/twee-ts';

const builder = new StoryBuilder();
const diagnostics: Diagnostic[] = [];
const passage: Passage = { name: 'Draft', tags: [], text: 'Once upon a time.' };
builder.add(passage, diagnostics); // was story.passages.push(passage)
builder.remove('Notes'); // was a filter or splice
builder.rename('Draft', 'Start', diagnostics); // was an assignment to name
const story = builder.build(); // read the story from a snapshot
console.log(story.passages.map((p) => p.name)); // ['Start']
```

To reorder passages, build a new `StoryBuilder` and add them in the new order.

### `watch()` rejects options that can't work

**Before:** an output that was a named input, or an option out of range, was reported through `onError` and the watch went on. **After:** the promise `watch()` returns rejects with a `TweeTsError` (`OUTPUT_IS_INPUT`, `INVALID_OPTIONS`) before anything is watched, and when such an error appears in a later build, it goes to `onError` and watching stops.

```typescript
import { TweeTsError, watch } from '@rohal12/twee-ts';

try {
  const controller = await watch({ sources: ['src/'], outFile: 'src/Start.tw' });
  controller.abort();
} catch (err) {
  if (err instanceof TweeTsError && err.code === 'OUTPUT_IS_INPUT') console.error(err.message);
  else throw err;
}
```

**Migrate:** `await` the promise inside `try`/`catch` (or `.catch()`), and stop expecting these errors in `onError`.

### `TweeTsError.code`

**After:** `TweeTsError` has a `code` (`OUTPUT_IS_INPUT`, `INPUT_UNAVAILABLE`, `INVALID_OPTIONS`, `BUILD_FAILED`; the type `TweeTsErrorCode`), and errors loading a config file are `TweeTsError`s. **Migrate:** branch on `err.code` instead of matching messages. See [Error Handling](./api#error-handling).

### `fetchAndCacheFormat()` is removed

**Before:** `fetchAndCacheFormat(entry, downloadUrl, options)` downloaded an index entry into a cache shared by every project. **After:** it is gone, since a download is now cached for where it came from. **Migrate:** list the index in `formatIndices` (config or `compile()`), or call `resolveRemoteFormat(name, version, [indexUrl])`.

### The format cache functions

`listCachedFormats()`, `getCacheSize()` and `clearCachedFormats()` cover downloads from format URLs too. `clearCachedFormats(name)` matches the format name without regard to letter case, where it used to match a folder name. `discoverCachedFormats()` keys its map by cache entry, not by name and version. `CachedFormatEntry` has new `source` (`'index'` or `'url'`) and `origin` fields. **Migrate:** read the format's name and version from the map's values, not its keys.

### Removed internal exports

The `CLOSING_HEAD_TAG` constant and the `scanHeadTags()` and `findHeadStartEnd()` scanners are gone from the internal modules; they were never exported from the package. Use [`decompileHTML()`](./api#html-decompiler) to read compiled HTML.

## Plugins

### Options are checked when the plugin is created

**Before:** an unknown or misspelt option was ignored, and `compileOptions.sources` and `compileOptions.formatId` were accepted (the two plugins gave them opposite precedence). **After:** both plugins throw a `TweeTsError` (`INVALID_OPTIONS`) naming the option for an unknown option, a value of the wrong type, `compileOptions.sources` or `compileOptions.formatId`, and an `outputFilename` that is not a plain relative path (`./index.html`, `../x.html`, `a//b.html`, a backslash, `?`, `#`, `%` or a name Windows reserves).

<!-- docs-test: skip — 1.x options, which 2.0 rejects -->

```typescript
tweeTsPlugin({
  sources: ['src/story'],
  outputFileName: './index.html',
  compileOptions: { formatId: 'harlowe-3' },
});
```

```typescript
import { tweeTsPlugin } from '@rohal12/twee-ts/vite';

const plugin = tweeTsPlugin({
  sources: ['src/story'],
  outputFilename: 'index.html',
  format: 'harlowe-3',
});
console.log(plugin.name);
```

### Vite

- **The dev entry build is evaluated for the dev command**, as the dev server is: a config function sees `command: 'serve'`, `apply: 'build'` plugins no longer run in dev (and `apply: 'serve'` ones do), and plugins' `config`, `configEnvironment` and `configResolved` hooks see the dev command. **Migrate:** a build-only plugin the entry needs in dev must apply to both commands.
- **Name clashes fail the build**: a bundle that already holds a file named as the story's `outputFilename` (your own `index.html` input, or another twee-ts instance) fails the build, naming the file, where the story used to replace it silently. The Rollup plugin does the same. **Migrate:** give the story another `outputFilename`, or rename the other file.
- **The reload message names the story's path**, so with an `outputFilename` other than `index.html` only the pages showing the story reload.

## Package

- The package ships ESM and CommonJS builds of every entry point, and `@rohal12/twee-ts/vite` and `/rollup` can now be `require()`d. Loading the package through both `import` and `require()` in one process loads two copies (the dual package hazard), so `instanceof TweeTsError` fails across them: use one of the two.
- `THIRD_PARTY_NOTICES` ships in the package: twee-ts bundles parse5 and acorn, which keep their own licences. Keep the file when you redistribute or bundle twee-ts.

# Story Formats

A story format provides the HTML template that turns your Twee source into a playable story. twee-ts is compatible with all Twine 2 and Twine 1 story formats.

## Format Discovery

A build asks for one story format (see [Format Selection](#format-selection)) and looks for it in these sources, in this order:

1. **Local format directories** (see [Search Order](#search-order))
2. **`formatUrls`**, each in the order given (see [Custom Remote Sources](#custom-remote-sources))
3. **`formatIndices`**, each in the order given, then the [Story Formats Archive](https://videlais.github.io/story-formats-archive/) (its official, then its unofficial index)

The first source that has a format answering the request is used, and later sources are not consulted, so a format that a local directory has is used without the network. [How a Format Is Chosen](#how-a-format-is-chosen) gives the exact rules. With `noRemote: true` (or when a source cannot be reached), each format URL and format index answers from what was downloaded from it before; see [The Download Cache](#the-download-cache).

### Search Order

Local formats are read from these directories, lowest rank first:

1. The home directory's `storyformats`, `.storyformats`, `story-formats`, `storyFormats` and `targets` subdirectories
2. The same subdirectories of the working directory
3. Each directory in the **`TWEEGO_PATH`** environment variable (unless `useTweegoPath: false`)
4. Each directory in **`formatPaths`**, from the config or the API

When two directories hold a format folder with the same name, the later one in this list wins: `formatPaths` override `TWEEGO_PATH`, which overrides the home and working directories, as in Tweego. Within `TWEEGO_PATH` or `formatPaths`, a later entry wins over an earlier one.

A `format.js` that cannot be read or parsed, or whose `version` is not a version, is skipped with a warning that names the folder and the reason:

```
warning: format broken-1: Skipping format; Could not decode the story format object: Unsupported identifier "nope" at property version (line 3, column 12); only literal data is read. (…/broken-1/format.js)
```

### Listing Available Formats

```sh
twee-ts --list-formats
```

Output:

```
Local story formats:
  harlowe-3: Harlowe 3.3.9 (Twine 2)
  sugarcube-2: SugarCube 2.37.3 (Twine 2)
  jonah: jonah  (Twine 1)

Cached remote formats:
  chapbook-2: chapbook 2.3.1
  sugarcube-2: sugarcube 2.37.3 (also cached: 2.36.1)
```

Local formats are listed after [pruning](#semver-version-pruning), by search directory and then folder name; a Twine 1 format shows its folder name and no version. The list reads `formatPaths` and `useTweegoPath` from the config file (unless `--no-config`). A cached download is listed under the ID of its name and major version, with the name and version as its source records them (an index may write `sugarcube` where the format's own name is `SugarCube`), and only when a build would consider it: when it came from one of the configured `formatUrls` or `formatIndices`, or from the Story Formats Archive (see [The Download Cache](#the-download-cache)). `twee-ts cache list` lists every download.

## Format Directory Structure

Each format lives in a directory containing a `format.js` file:

```
storyformats/
├── sugarcube-2/
│   └── format.js
├── harlowe-3/
│   └── format.js
└── snowman-2/
    └── format.js
```

The directory name serves as the **format ID** (e.g. `sugarcube-2`). Use this ID with `--format` or `formatId`. An ID request always uses that folder, even when another folder holds a newer version of the same format (see [SemVer Version Pruning](#semver-version-pruning)).

IDs and format names match without regard to letter case, in every source: `--format SugarCube-2` finds the `sugarcube-2` folder, and a StoryData format of `sugarcube` finds SugarCube. An ID also finds a format by its name and major version, so `--format sugarcube-2` finds SugarCube 2.37.3 in a folder named `sugarcube-2.37` too. When two formats differ only in case and have the same version, the one whose case matches exactly is used (see [How a Format Is Chosen](#how-a-format-is-chosen)).

### Format Metadata

Twine 2 `format.js` files pass an object to `window.storyFormat()`, with the following fields:

| Field         | Required | Description                                        |
| ------------- | -------- | -------------------------------------------------- |
| `name`        | No       | Display name (defaults to "Untitled Story Format") |
| `version`     | Yes      | Version string (e.g. `"2.37.3"`), see below        |
| `source`      | Yes      | HTML template source                               |
| `proofing`    | No       | Whether this is a proofing format                  |
| `author`      | No       | Format author                                      |
| `description` | No       | Format description                                 |
| `image`       | No       | Format icon/image URL                              |
| `url`         | No       | Format homepage URL                                |
| `license`     | No       | Format license                                     |

Twine 2 runs `format.js` as a classic script, so twee-ts reads it as JavaScript too, with a real JavaScript parser ([acorn](https://github.com/acornjs/acorn), bundled), but never runs it:

- The file must be valid JavaScript. If it is not, the format is skipped with the parser's message and the line and column of the error, counting every JavaScript line break (LF, CR, CR LF, U+2028 and U+2029).
- The format object is the object literal passed to the file's one call of `storyFormat`: `window.storyFormat({…})`, `storyFormat({…})`, `window['storyFormat']({…})`, `window.storyFormat?.({…})` and the like, anywhere in the file. Comments (HTML-like `<!--` and `-->` comments included), strings, template literals and regular expressions around the call are read as JavaScript reads them. A file with no such call is read only if all of it is one object literal, as Tweego reads it; a file with several calls is skipped.
- The object is read as data. Supported, with JavaScript's own values: string, number, `true`, `false` and `null` literals (in every notation JavaScript allows, such as `'single quotes'`, `0x1F`, `010` or `1_000`), a `-` or `+` before a number, template literals without `${…}`, arrays and nested objects, keys that are names, strings or numbers, comments and trailing commas. Of duplicate keys, the last value wins, as in JavaScript.
- A property whose value is a function, such as Harlowe's `setup`, is left out wherever it is in the object, however it is written.
- Anything else in the object is an error that names the property and its line and column: variables (`undefined`, `NaN` and `Infinity` included), BigInts, regular expressions, computed keys, spreads, getters and setters, shorthand properties, array holes, operators and calls. So is a `__proto__` key, which in JavaScript sets the object's prototype instead of adding a property.

An optional field of the wrong type, such as a numeric `name`, is ignored, with a warning naming the format file when a build uses the format.

The `version` must be a [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) version such as `2.37.3` or `2.0.0-beta.1`. As in Tweego, a leading `v` (or `V`) is allowed, and `1.0` or `1` stand for `1.0.0`. As SemVer requires, numbers have no leading zeros (`01.2.3` and `1.0.0-01` are not versions), and the major, minor and patch numbers must be at most 9007199254740991 (2<sup>53</sup> − 1), so that they compare exactly; numeric prerelease parts may be any size. The version is kept as written.

### SemVer Version Pruning

When multiple versions of the same format are discovered, twee-ts keeps only the highest version within each major version for selecting a format by name (from `StoryData`) and for `--list-formats`. For example, if both SugarCube `2.36.1` and `2.37.3` are found, a `StoryData` request for SugarCube 2.36.1 uses `2.37.3`. Different major versions (e.g. Harlowe 2.x and 3.x) coexist.

Versions compare by SemVer precedence, so a release outranks its prereleases (`2.0.0` over `2.0.0-beta.1`). Between two copies of the same name and version, the one in the higher-ranked directory is kept (see [Search Order](#search-order)).

Pruning does not apply to a request by ID: `--format sugarcube-2` uses the `sugarcube-2` folder even when `sugarcube-2.37` holds a newer SugarCube 2.

### Twine 1 Formats

Twine 1 format directories (containing `header.html` instead of `format.js`) use the folder name as the format name and have no version, so only `--format <folder name>` (or `formatId`) selects one. A Twine 1 header that includes Twine 1's `engine.js`, `jquery.js` or `modernizr.js` reads them from the format directory that holds the format folder. A format's own `userlib.js` (for `"USER_LIB"`) and, in a format older than Twine 1.4, `footer.html` are optional: when nothing is at the path (or a dangling link), the placeholder stays and the default footer is used, as in Tweego. One that is there but can't be read (a file twee-ts may not read, a folder, text that can't be decoded) stops the build with `Format component cannot be read: …`.

## Remote Format Fetching

When no local format answers, twee-ts downloads the format from the project's format URLs or format indices, and finally from the [Story Formats Archive](https://videlais.github.io/story-formats-archive/).

Each request (an index or a format file) may take 30 seconds. One that takes longer fails with a warning, and the next source is tried. The `formatFetchTimeout` key of the [config file](./configuration#story-format), or the option of the same name in the [API](./api#compile-options), changes the limit. The whole search may take 120 seconds (`formatResolutionTimeout`; `0` turns it off): when that passes, the request in progress stops with a warning, and the format URLs and indices not yet asked answer from what was downloaded from them before. With `useDefaultFormatIndices: false` (or `--no-default-format-indices`), the Story Formats Archive is not asked, so a project with its own archive never contacts it. A response larger than 32 MiB is refused, also with a warning. Aborting a compile's `signal`, or a `watch()` controller, cancels requests still in progress, and nothing from them is written to the cache.

### Custom Remote Sources

You can specify custom format sources:

```sh
# SFA-compatible index
twee-ts --format-index https://example.com/index.json

# Direct format.js URL
twee-ts --format-url https://example.com/my-format/format.js
```

Or in the config file:

```json
{
  "formatIndices": ["https://example.com/index.json"],
  "formatUrls": ["https://example.com/my-format/format.js"]
}
```

Only absolute `http:` and `https:` URLs are accepted, without a user name or password; anything else is an error. To use a format file from disk, put its `format.js` in a folder (named like a format ID, e.g. `my-format-1/format.js`) and list the folder's parent in `formatPaths`: `file:` URLs are not supported. A fragment (`#…`) is ignored. Each redirect is checked before it is followed: it must stay on `http:` or `https:`, and once a download has used `https:` no later hop may use `http:` (the `http:` endpoint is never contacted). A chain is cut off after 20 redirects.

A format URL's `format.js` names the format and version it offers. A build that reaches a format URL downloads it every time; when a copy is cached, the request is conditional (`If-None-Match` / `If-Modified-Since`), so an unchanged file is not downloaded again.

### Format Indices

A format index is an `index.json` in the layout of the [Story Formats Archive](https://videlais.github.io/story-formats-archive/): an object with a `twine2` list and a `twine1` list of entries. Either list may be missing. Each entry needs a `name` and a SemVer `version`; `files` (a list of file names), `checksums` (an object mapping a file name to its SHA-256 as a hex string, compared without regard to letter case) and `proofing` (a boolean) are optional. Other members (`author`, `description`, …) are not used. An entry without this shape, or with a member of the wrong type or a repeated member, is skipped; when no format answers a request, the error lists the skipped entries with the requested name and why each was skipped. An index that is not JSON (the warning gives the line and column), not an object, or whose `twine1` or `twine2` field is not a list, fails with a warning naming its URL.

An entry's files are downloaded from `twine2/<name>/<version>/<file>` (or `twine1/…`), resolved against the URL the index was served from after any redirects, with each part percent-encoded. As with any relative URL, the index's own file name and query string do not carry over: for `https://example.com/archive/formats.json?rev=3`, SugarCube 2.37.3's `format.js` is `https://example.com/archive/twine2/SugarCube/2.37.3/format.js`.

Each downloaded file is checked against the checksum the index lists for that exact file name; on a mismatch a warning names the URL and both hashes, and the entry is not used. A listed checksum that is not a SHA-256 hex digest fails the download too, with a warning naming the URL and the listed value. Checksums of files twee-ts does not download (`LICENSE`, icons) are not looked at. A file the index lists no checksum for is used, with a warning that it was not verified. A Twine 2 `format.js` must also be the format the entry names (the same name without regard to case, the same version by SemVer precedence); a `format.js` that names no format is known by the entry's name.

For a Twine 1 entry, `header.html` is downloaded, with `code.js` and `userlib.js` when the entry lists them. Most Twine 1 headers (Jonah, Sugarcane, Responsive) also include Twine 1's own `engine.js`, which no index provides, so such a format fails at build time with `Required format component not found: …/engine.js: …`. Install those formats locally instead, with Twine 1's `engine.js` (and `jquery.js` or `modernizr.js`, when the header uses them) in the format directory that holds the format folder. SugarCube's Twine 1 build needs nothing else.

### The Download Cache

Downloads are cached at:

```
~/.cache/twee-ts/storyformats/
```

(`$XDG_CACHE_HOME/twee-ts/storyformats/` when `XDG_CACHE_HOME` is set to an absolute path; an empty or relative value is ignored, as the XDG Base Directory spec says.)

Each download is cached for where it came from:

- A download from a format index is kept for that index URL and that entry (its Twine version, name and version as listed). A build uses it only when it consults the same index, and only while it matches the checksums that index lists then. An index entry is otherwise treated as unchanging: it is not downloaded again.
- A download from a format URL is kept for that URL. A build that reaches the URL online checks it again (see above); offline it uses the cached copy.

So a patched copy of a format, served from your own URL or index, is used only by projects that list that URL or index, and never stands in for the format with the same name and version in another project. Online, the format chosen never depends on what the cache holds: the cache only saves downloads.

Offline (`noRemote: true`, or when a URL or index cannot be reached), each format URL answers with its cached copy, and each format index with the formats downloaded from it before, by the same rules as online. When a source cannot be reached, a warning says so and which cached copy is used.

Every cached file is stored with its SHA-256 and checked when it is read; a copy that does not match is not used (online, it is downloaded again, with a warning for a format index entry). Files are written under a temporary name and renamed into place, so a twee-ts process never reads a half-written format, and concurrent compiles in one process download each format once. When the cache cannot be written (a read-only home directory, for example), the download is used for that build only, with a warning.

`twee-ts cache list`, `cache size` and `cache clear [name]` cover every download; `cache clear <name>` matches the format name without regard to case. The cache directories of twee-ts 1.x (`storyformats/<name>/<version>/` and `storyformat-urls/`) are not read; `twee-ts cache clear` removes them.

### Disabling Remote Fetching

```sh
twee-ts --no-remote
```

```json
{
  "noRemote": true
}
```

Formats downloaded before from the configured format URLs and indices, and from the Story Formats Archive, are still used.

## Format Selection

The format is selected in this order of precedence:

1. `--format` CLI flag / `formatId` config key: a **format ID**
2. The `format` and `format-version` fields in the `StoryData` passage: a **name and version**
3. Default: the format ID `sugarcube-2`

The first of these that is set is the request twee-ts looks for, in every source above. If it can't be found, the build fails with an error naming it, the local formats found, and the candidates with the requested name with why each one does not answer; twee-ts never swaps in a different story format.

The compiled HTML's `<tw-storydata>` element records the format and version it was built with. Archive output (`twine2-archive`) keeps the `StoryData` values as written (empty when it names no format, and `--format` is not used), where Tweego writes the format it finds; see [Differences from Tweego](./tweego-differences).

### How a Format Is Chosen

This is the whole policy, and it is the same for every source.

**Identity.** Format names match without regard to letter case (`sugarcube` finds `SugarCube`). A format ID matches a format when it is the format's local folder name (without regard to case), or the format's name in lower case with each run of whitespace replaced by `-`, followed by `-` and its major version (SugarCube 2.37.3 is `sugarcube-2`). A name-and-version request matches only Twine 2 formats; an ID can also name a Twine 1 format.

**Versions** compare by [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) precedence (see [Format Metadata](#format-metadata) for what counts as a version): a prerelease ranks below its release (`2.1.0-rc.1` is older than `2.1.0`), and build metadata is ignored (`2.1.0+b7` is `2.1.0`). Prereleases are otherwise ordinary versions: as in Tweego, `2.38.0-beta.1` is the greatest SugarCube 2 when a source has it. Name an exact version in `StoryData` to avoid that.

**Tiers.** A candidate answers a request in one of these tiers, best first:

| Tier   | Request          | Candidate                                                |
| ------ | ---------------- | -------------------------------------------------------- |
| pinned | ID               | its local folder is the ID                               |
| exact  | name and version | the requested version                                    |
| newer  | name and version | the requested major version, above the requested version |
| any    | name, no version | any version (see below)                                  |
| id     | ID               | its name and major version give the ID                   |
| older  | name and version | the requested major version, below the requested version |

A candidate with another name does not answer; nor does one of another major version when the request gives a version, or one without a SemVer version unless the request is an ID naming its folder.

**Choosing.** Among the candidates that answer in any tier but `older`, the one from the earliest source wins: local folders, then each format URL in order, then each format index in order. Within one source, the better tier wins (an exact version beats a newer one), then the greater version, then a name in the request's exact letter case, then (local folders) the higher-ranked search directory. Only when no source has such a candidate is an `older` one used, chosen in the same order, with a warning:

```
warning: Story format "SugarCube" at version "2.38.0" is not available; using SugarCube 2.37.3 instead.
```

As the earliest source wins, sources are consulted one at a time, and later ones are not contacted once one answers.

**Local folders, as in Tweego.** For a name request, only the greatest version of each name and major version among the local folders is a candidate ([SemVer Version Pruning](#semver-version-pruning)), so `StoryData` SugarCube 2.36.1 uses a local 2.37.3 even when a local 2.36.1 exists. For an ID request, every folder is a candidate, so a pinned folder is used as it is.

**A missing or unparseable `format-version`** takes the greatest version of any major version, with a warning (Tweego's, for an unparseable one):

```
warning: format "SugarCube": Auto-selecting greatest version; Could not parse version "2.x".
warning: format "SugarCube": Auto-selecting greatest version; StoryData gives no format-version.
```

**An ID that matches formats with different names** (`Sugar Cube` and `sugar-cube` both give `sugar-cube-2`) takes the best by the rules above, with a warning naming them.

**Failures.** When the chosen candidate cannot be downloaded or fails a check (checksum, identity, a damaged cached copy), a warning names the URL and the cause, and the choice is made again without it. A source that cannot be reached is a warning too, whether or not a later source then answers.

## Special Passages

twee-ts recognizes the following special passage names. They are **info passages**: not counted as story passages or in the word count, and never listed by lint as dead ends or orphans. twee-ts itself reads only `StoryTitle`, `StoryData` and `StorySettings` (and warns about `StoryIncludes`); the others are the passages story formats such as SugarCube give a meaning, and twee-ts writes them as usual.

Twine 2 output leaves out `StoryTitle`, `StoryData` and a `StorySettings` passage with no settings, and writes the others as `<tw-passagedata>` elements; Twine 1 output writes all of them as tiddlers; JSON output leaves out `StoryTitle` and `StoryData`.

| Passage             | Purpose                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `StoryTitle`        | Story name (required for Twine 1 and for HTML output unless an imported story names it)     |
| `StoryData`         | JSON metadata: IFID, format, format version, start passage, options, tags, tag colors, zoom |
| `StoryAuthor`       | Author name                                                                                 |
| `StoryInit`         | SugarCube initialization code                                                               |
| `StoryMenu`         | SugarCube sidebar menu items                                                                |
| `StorySubtitle`     | Story subtitle                                                                              |
| `StoryBanner`       | SugarCube story banner                                                                      |
| `StoryDisplayTitle` | SugarCube formatted title shown in the UI bar                                               |
| `StoryCaption`      | SugarCube sidebar caption                                                                   |
| `StoryInterface`    | SugarCube custom UI template                                                                |
| `StoryShare`        | SugarCube sharing links                                                                     |
| `StorySettings`     | Twine 1 settings (see below)                                                                |
| `StoryIncludes`     | Tweego's include list: ignored, with a warning                                              |
| `PassageReady`      | SugarCube: runs before each passage                                                         |
| `PassageDone`       | SugarCube: runs after each passage                                                          |
| `PassageHeader`     | SugarCube: rendered before each passage                                                     |
| `PassageFooter`     | SugarCube: rendered after each passage                                                      |
| `MenuOptions`       | Menu option passages                                                                        |
| `MenuShare`         | Menu sharing passages                                                                       |
| `MenuStory`         | Menu story passages                                                                         |

When the sources hold more than one `StoryData` passage (a leftover copy in another file, or the one an imported Twine 2 HTML file brings), the last one replaces the earlier ones entirely, as in Tweego, and twee-ts warns that it replaced the passage, naming the file and line of each. A field the last one leaves out, such as `options`, `start` or `tag-colors`, gets its default rather than the earlier passage's value. A last `StoryData` that is not valid JSON still replaces the earlier ones: the story then has none of their metadata, and an error says so. The same holds for `StoryTitle` and `StorySettings`: the story's title, its Twine 1 settings and its legacy IFID always come from the last passage of each name alone.

`StoryData` is read as Tweego reads it. Keys match regardless of letter case (`IFID` is `ifid`, with a warning), a repeated key takes its last value (with a warning), except that a repeated `tag-colors` object is merged into the earlier one and a repeated `options` array fills the slots of the earlier one, as Go decodes into an existing map and slice. `null` leaves an earlier string or number as it was (empty when it is first) and clears `options` and `tag-colors`. A field of the wrong type, such as `"format-version": 3` or `"options": "debug"`, is an error and is left out; Tweego stops there. An unknown key is a warning. The passage is then rewritten from what was read, so a value left out is always reported. See [Differences from Tweego](./tweego-differences).

### StorySettings (Twine 1)

The `StorySettings` passage configures Twine 1-specific behavior using `key:value` pairs, one per line:

```twee
:: StorySettings
jquery:off
hash:off
bookmark:on
modernizr:off
undo:off
obfuscate:rot13
exitprompt:off
blankcss:off
```

| Setting      | Values     | Effect                                                                                           |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------ |
| `jquery`     | `on`/`off` | Include jQuery library in output                                                                 |
| `modernizr`  | `on`/`off` | Include Modernizr library in output                                                              |
| `obfuscate`  | `rot13`    | ROT13-encode tiddler names, tags and content (except `StorySettings` and `Twine.image` passages) |
| `undo`       | `on`/`off` | Enable undo support                                                                              |
| `bookmark`   | `on`/`off` | Enable bookmark support                                                                          |
| `hash`       | `on`/`off` | Enable URL hash-based navigation                                                                 |
| `exitprompt` | `on`/`off` | Prompt before navigating away                                                                    |
| `blankcss`   | `on`/`off` | Start with blank CSS (no default styles)                                                         |

twee-ts acts on three of these when it writes Twine 1 output: `jquery:on` and `modernizr:on` insert `jquery.js` and `modernizr.js` from the format directory, and `obfuscate:rot13` encodes the tiddlers (see [Twine 1 Archive](./output-modes#twine-1-archive): a `StorySettings` passage tagged `Twine.private` turns obfuscation off, with a warning, and a passage whose name or tag ROT13 turns into `StorySettings` or `Twine.image` is an error). The others are passed to the Twine 1 story format.

The `ifid` and `zoom` settings are obsolete, and twee-ts warns about them; put both in `StoryData`. `zoom` is ignored. A valid `ifid` is kept as the legacy IFID, and when no `StoryData` IFID is available it becomes the story's IFID, with the warning `Story IFID not found; reusing "ifid" entry from the "StorySettings" special passage.` Neither counts as a setting, so a `StorySettings` passage with only these is empty.

Keys and values are lower-cased and trimmed, and a repeated key takes its last value. When the sources hold more than one `StorySettings` passage, the last one decides all the settings: one it leaves out, such as `obfuscate:rot13`, is off, even if an earlier passage set it.

## Special Tags

| Tag             | Effect                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `script`        | Combined into the story's script element (Twine 2 HTML and archive) or the JSON `script` field |
| `stylesheet`    | Combined into the story's style element (Twine 2 HTML and archive) or the JSON `style` field   |
| `Twine.private` | Left out of Twine 2 and Twine 1 output (HTML and archive) and JSON; Twee output keeps it       |
| `annotation`    | An info passage, written as usual                                                              |
| `widget`        | An info passage, written as usual; SugarCube reads it as widget definitions                    |
| `Twine.*`       | Any tag starting with `Twine.` makes an info passage                                           |

Passages with these tags are **info passages**: they are not counted as story passages or in the word count. Twine 2 output leaves out only `script`, `stylesheet` and `Twine.private` passages; `annotation`, `widget` and other `Twine.*` passages (such as media passages, tagged `Twine.image`) are written as `<tw-passagedata>` elements. Twine 1 output writes script and stylesheet passages as tiddlers, which Twine 1 story formats read by their tags.

You can extend this system with custom tag names using [Tag Aliases](./tag-aliases).

## Packaging Formats as npm Modules

Story formats can be published as npm packages for easy installation and type safety. See the dedicated [Packaging Formats](./story-format-packages) guide.

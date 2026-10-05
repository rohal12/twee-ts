# Story Formats

A story format provides the HTML template that turns your Twee source into a playable story. twee-ts is compatible with all Twine 2 and Twine 1 story formats.

## Format Discovery

twee-ts looks for the requested format in these sources, in order, and uses the first that has it:

1. **Local format directories** — see [Search order](#search-order) below
2. **`formatUrls`** — the project's direct `format.js` URLs: each URL's own cached copy, else a download (unless `noRemote: true`). See [Custom Remote Sources](#custom-remote-sources)
3. **Download cache** — formats downloaded earlier from format indices (see [Remote Format Fetching](#remote-format-fetching)); used even with `noRemote: true` and without a network connection
4. **Remote** — fetched from the [Story Formats Archive](https://videlais.github.io/story-formats-archive/) or custom indices (unless `noRemote: true`)

A format that a local directory has is used without looking in the cache or on the network.

### Search Order

Local formats are read from these directories, lowest rank first:

1. The home directory's `storyformats`, `.storyformats`, `story-formats`, `storyFormats` and `targets` subdirectories
2. The same subdirectories of the working directory
3. Each directory in the **`TWEEGO_PATH`** environment variable (unless `useTweegoPath: false`)
4. Each directory in **`formatPaths`**, from the config or the API

When two directories hold a format folder with the same name, the later one in this list wins: `formatPaths` override `TWEEGO_PATH`, which overrides the home and working directories, as in Tweego. Within `TWEEGO_PATH` or `formatPaths`, a later entry wins over an earlier one.

A `format.js` that cannot be read or parsed, or whose `version` is not a version, is skipped with a warning that names the folder and the reason:

```
warning: format broken-1: Skipping format; Could not decode story format JSON chunk: Unexpected identifier "nope" at line 3, column 11 (…/broken-1/format.js)
```

### Listing Available Formats

```sh
twee-ts --list-formats
```

Output:

```
Local story formats:
  sugarcube-2: SugarCube 2.37.3 (Twine 2)
  harlowe-3: Harlowe 3.3.9 (Twine 2)

Cached remote formats:
  chapbook-2: Chapbook 2.2.0
  sugarcube-2: SugarCube 2.37.3 (also cached: 2.36.1)
```

Every ID listed is one `--format` accepts. Local formats are listed after [pruning](#semver-version-pruning); the list reads `formatPaths` and `useTweegoPath` from the config file (unless `--no-config`). A cached format is listed under the ID of its name and major version; when several versions are cached, `--format` takes the greatest.

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

IDs and format names match without regard to letter case, in local directories, the download cache and remote indices alike: `--format SugarCube-2` finds the `sugarcube-2` folder, and a StoryData format of `sugarcube` finds SugarCube. When two formats differ only in case, the one whose case matches exactly is used.

### Format Metadata

Twine 2 `format.js` files contain a JSON object with the following fields:

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

The object does not have to be strict JSON: as Twine 2 runs `format.js` as JavaScript, twee-ts also accepts the JavaScript object literal syntax some formats use, such as single-quoted strings, unquoted property keys, trailing commas and comments. Only the structure is relaxed; string values, including the `source`, are read exactly as JavaScript would read them. twee-ts also drops Harlowe's function-valued `setup` property, whether the format comes from a local directory or a download.

The `version` is read as Tweego reads it: a SemVer version such as `2.37.3` or `2.0.0-beta.1`, optionally with a leading `v`, and with `1.0` or `1` standing for `1.0.0`. The version is kept as written.

### SemVer Version Pruning

When multiple versions of the same format are discovered, twee-ts keeps only the highest version within each major version for selecting a format by name (from `StoryData`) and for `--list-formats`. For example, if both SugarCube `2.36.1` and `2.37.3` are found, a `StoryData` request for SugarCube 2.36.1 uses `2.37.3`. Different major versions (e.g. Harlowe 2.x and 3.x) coexist.

Versions compare by SemVer precedence, so a release outranks its prereleases (`2.0.0` over `2.0.0-beta.1`). Between two copies of the same name and version, the one in the higher-ranked directory is kept (see [Search Order](#search-order)).

Pruning does not apply to a request by ID: `--format sugarcube-2` uses the `sugarcube-2` folder even when `sugarcube-2.37` holds a newer SugarCube 2.

### Twine 1 Formats

Twine 1 format directories (containing `header.html` instead of `format.js`) use the folder name as the format name.

## Remote Format Fetching

When a format is not found locally, twee-ts automatically downloads it from the [Story Formats Archive](https://videlais.github.io/story-formats-archive/). Downloaded formats are cached at:

```
~/.cache/twee-ts/storyformats/
```

(`$XDG_CACHE_HOME/twee-ts/storyformats/` when `XDG_CACHE_HOME` is set.) The cache is shared by every project on the machine, and by twee-ts processes running at the same time: each cached file is written to a temporary file and then renamed into place, so a process never reads a half-written format, and concurrent compiles in one process download each format once.

Each request (an index or a `format.js`) may take 30 seconds. One that takes longer fails with a warning, and the next source is tried. The `formatFetchTimeout` option of the [API](./api#compile-options) changes the limit. Aborting a compile's `signal`, or a `watch()` controller, cancels requests still in progress, and nothing from them is written to the cache.

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

A remote lookup by format ID translates the ID to a name and major version: `sugarcube-2` finds the greatest SugarCube 2.x in an index, or a direct URL whose `format.js` names SugarCube 2.x.

A format downloaded from a direct URL is cached under that URL (in `~/.cache/twee-ts/storyformat-urls/`), not under its name and version, and a project's `formatUrls` are looked up before the formats downloaded from indices. So a patched copy of a format, served from your own URL, is used only by projects that list that URL, and never stands in for the official format with the same name and version in another project. Once a URL has been downloaded, its cached copy is used without the network. `twee-ts cache clear` removes these copies too; `cache list`, `cache size` and `cache clear <name>` cover only the formats downloaded from indices.

### Disabling Remote Fetching

```sh
twee-ts --no-remote
```

```json
{
  "noRemote": true
}
```

Formats already in the download cache are still used.

## Format Selection

The format is selected in this order of precedence:

1. `--format` CLI flag / `formatId` config key
2. The `format` and `formatVersion` fields in the `StoryData` passage
3. Default: `sugarcube-2`

The first of these that is set is the format twee-ts looks for, in every source above. If it can't be found, the build fails with an error naming it; twee-ts never swaps in a different story format.

When the `StoryData` passage specifies a format by name and version, twee-ts matches it against available formats using semantic versioning: the same major version, at or above the requested version. In the download cache and remote indices, the exact version wins when it is there; a prerelease is never taken as the exact match for its release. If only an older version of the same major is available, twee-ts uses it and warns.

The compiled HTML's `<tw-storydata>` element records the format and version it was built with. Archive output (`twine2-archive`) keeps the `StoryData` values as written.

## Special Passages

twee-ts recognizes the following special passage names. These passages carry metadata or structural content and are excluded from the regular passage list and word count.

| Passage          | Purpose                                                 |
| ---------------- | ------------------------------------------------------- |
| `StoryTitle`     | Story name (required for Twine 1)                       |
| `StoryData`      | JSON metadata: IFID, format, format version, tag colors |
| `StoryAuthor`    | Author name                                             |
| `StoryInit`      | SugarCube initialization code                           |
| `StoryMenu`      | SugarCube sidebar menu items                            |
| `StorySubtitle`  | Story subtitle                                          |
| `StoryBanner`    | SugarCube story banner                                  |
| `StoryCaption`   | SugarCube sidebar caption                               |
| `StoryInterface` | SugarCube custom UI template                            |
| `StoryShare`     | SugarCube sharing links                                 |
| `StorySettings`  | Twine 1 settings (see below)                            |
| `StoryIncludes`  | Additional source files to include                      |
| `PassageReady`   | SugarCube: runs before each passage                     |
| `PassageDone`    | SugarCube: runs after each passage                      |
| `PassageHeader`  | Prepended to every passage                              |
| `PassageFooter`  | Appended to every passage                               |
| `MenuOptions`    | Menu option passages                                    |
| `MenuShare`      | Menu sharing passages                                   |
| `MenuStory`      | Menu story passages                                     |

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

| Setting      | Values     | Effect                                                |
| ------------ | ---------- | ----------------------------------------------------- |
| `jquery`     | `on`/`off` | Include jQuery library in output                      |
| `modernizr`  | `on`/`off` | Include Modernizr library in output                   |
| `obfuscate`  | `rot13`    | ROT13-encode tiddler content (except `StorySettings`) |
| `undo`       | `on`/`off` | Enable undo support                                   |
| `bookmark`   | `on`/`off` | Enable bookmark support                               |
| `hash`       | `on`/`off` | Enable URL hash-based navigation                      |
| `exitprompt` | `on`/`off` | Prompt before navigating away                         |
| `blankcss`   | `on`/`off` | Start with blank CSS (no default styles)              |

The `ifid` and `zoom` settings are recognized but ignored as obsolete — use the `StoryData` passage for these values instead.

## Special Tags

| Tag          | Effect                                                |
| ------------ | ----------------------------------------------------- |
| `script`     | Passage content is combined into the JavaScript block |
| `stylesheet` | Passage content is combined into the CSS block        |
| `annotation` | Passage is excluded from compiled output              |
| `widget`     | Passage is treated as a SugarCube widget definition   |
| `Twine.*`    | Any tag starting with `Twine.` marks an info passage  |

Passages with special tags are classified as **info passages** and do not appear as regular `<tw-passagedata>` elements.

You can extend this system with custom tag names using [Tag Aliases](./tag-aliases).

## Packaging Formats as npm Modules

Story formats can be published as npm packages for easy installation and type safety. See the dedicated [Packaging Formats](./story-format-packages) guide.

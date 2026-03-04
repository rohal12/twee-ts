# Story Formats

A story format provides the HTML template that turns your Twee source into a playable story. twee-ts is compatible with all Twine 2 and Twine 1 story formats.

## Format Discovery

twee-ts searches for formats in the following order:

1. **`formatPaths`** — directories listed in the config or passed via the API
2. **`TWEEGO_PATH`** — the environment variable used by Tweego (unless `useTweegoPath: false`)
3. **Remote** — fetched from the [Story Formats Archive](https://videlais.github.io/story-formats-archive/) or custom URLs (unless `noRemote: true`)

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
```

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

The directory name serves as the **format ID** (e.g. `sugarcube-2`). Use this ID with `--format` or `formatId`.

## Remote Format Fetching

When a format is not found locally, twee-ts automatically downloads it from the [Story Formats Archive](https://videlais.github.io/story-formats-archive/). Downloaded formats are cached at:

```
~/.cache/twee-ts/storyformats/
```

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

### Disabling Remote Fetching

```sh
twee-ts --no-remote
```

```json
{
  "noRemote": true
}
```

## Format Selection

The format is selected in this order of precedence:

1. `--format` CLI flag / `formatId` config key
2. The `format` and `formatVersion` fields in the `StoryData` passage
3. Default: `sugarcube-2`

When the `StoryData` passage specifies a format by name and version, twee-ts matches it against available formats using semantic versioning.

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
| `StorySettings`  | SugarCube settings                                      |
| `StoryIncludes`  | Additional source files to include                      |
| `PassageReady`   | SugarCube: runs before each passage                     |
| `PassageDone`    | SugarCube: runs after each passage                      |
| `PassageHeader`  | Prepended to every passage                              |
| `PassageFooter`  | Appended to every passage                               |
| `MenuOptions`    | Menu option passages                                    |
| `MenuShare`      | Menu sharing passages                                   |
| `MenuStory`      | Menu story passages                                     |

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

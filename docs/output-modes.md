# Output Modes

twee-ts can produce output in several formats, controlled by the `outputMode` config key or CLI flags.

## HTML (default)

```sh
twee-ts -o story.html src/
```

Compiles a playable HTML file by inserting story data into a story format's HTML template. This is the primary output mode — it produces a single `.html` file that can be opened in any browser.

Requires a story format: the one `-f`/`formatId` names, else the one StoryData's `format` and `format-version` name, else `sugarcube-2`. It is looked for in the local format directories, then the format URLs and format indices and the Story Formats Archive, unless `--no-remote` is given; see [Story Formats](./story-formats).

Twine 2 HTML (and the Twine 2 archive) writes every passage as a `<tw-passagedata>` element except StoryTitle, StoryData, an empty StorySettings, and passages tagged `script`, `stylesheet` or `Twine.private`: the script and stylesheet passages go into the story's script and style elements, and the others are left out. The stylesheets are joined in order into one style element, so an `@import` must come in the first stylesheet, before any rule (twee-ts warns about one that does not, since browsers ignore it); a file added as a head module keeps its own style element.

## Twee 3

```sh
twee-ts -d -o story.twee src/
```

Decompiles to [Twee 3 notation](https://github.com/iftechfoundation/twine-specs/blob/master/twee-3-specification.md). Useful for converting between formats or extracting source from compiled HTML.

Does not require a story format.

The `StoryData` passage is written from the compiled story, so it records what `-s`/`startPassage` and `-t`/`testMode` (the `debug` option) changed, and compiling the Twee output again gives the same start passage and options. With no overrides, it is the `StoryData` passage as loaded, normalized to tab-indented JSON, plus the IFID twee-ts reports generating when the passage has none. A story without a `StoryData` passage gets one, after `StoryTitle`, only when `-s` or `-t` is given. A `StoryData` passage that is not valid JSON is written as it is. (A missing IFID and invalid StoryData are errors, so the CLI writes no output for them; `compile()` returns the output with the errors.)

Twee has no way to escape passage text, and its parser trims passage names and splits tags at whitespace, so some stories, typically ones decompiled from HTML, cannot be written as Twee that compiles back to the same story. twee-ts reads what it writes for each passage back with its Twee parser, writes the passage anyway, and reports a warning naming the passage and saying what changes, for example:

- A line of passage text that starts with `::` (after any byte order marks), which Twee reads as a new passage header. This is common in stylesheets (`::selection`, `::placeholder`, `::-webkit-scrollbar`). In passages tagged `stylesheet` or `script`, such a line is written indented by one space, which leaves the CSS or JavaScript working, so the stylesheet or script reads back whole; only a template literal or a string continued across lines would see the extra space. In other passages, the line is written as it is.
- A passage name that is empty, has leading or trailing whitespace, or holds a line break.
- A tag that is empty or holds whitespace (only the API, through `tagAliases`, can make one).
- A carriage return in passage text, which Twee reads as a line break.
- A metadata key that reads back as another one (`Position` reads as `position`).

The white space at either end of passage text is not compared, since Twee readers trim it (Tweego always does).

Tweego writes the same Twee without a warning.

## Twee 1

```sh
twee-ts --decompile-twee1 -o story.twee src/
```

Decompiles to Twee 1 notation (legacy format). The `StoryData` passage is written the same way as for Twee 3, and the same warnings are reported. Twee 1 escapes nothing in passage headers, so a name or tag holding `[`, `]`, `{`, `}` or `\` gets a warning too. Twee 1 has no passage metadata, so `position`, `size` and other metadata are left out, with one warning.

## Twine 2 Archive

```sh
twee-ts -a -o archive.html src/
```

Outputs the `<tw-storydata>` XML block without wrapping it in a story format's HTML template. This is the format used by Twine 2's import/export feature. The output conforms to the [Twine 2 HTML Output Spec](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-htmloutput-spec.md), including `tags`, `options`, and `<tw-tag>` elements for tag colors.

A tag color is written, as it is written in `StoryData`, when it is one of the specification's named colors (`gray`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, in any letter case) or a CSS hex color of 3, 4, 6 or 8 digits (`#f80`, `#ff8800cc`). Any other color (`rgb(1,2,3)`, `#12345`, `none`) is left out with a warning. Twine 2 HTML and JSON output follow the same rule; Twee output keeps the `StoryData` passage as written.

## Twine 1 Archive

```sh
twee-ts --archive-twine1 -o archive.html src/
```

Outputs a Twine 1-compatible archive with `<div tiddler>` elements. Each tiddler includes `tiddler`, `tags`, `created`, `modifier`, and `twine-position` attributes per the [Twine 1 HTML Output Spec](https://github.com/iftechfoundation/twine-specs/blob/master/twine-1-htmloutput-doc.md).

If a `StorySettings` passage contains `obfuscate:rot13`, each tiddler's `tiddler` name, tags and content are ROT13-encoded, except for `StorySettings` itself and `Twine.image` passages, as Twine 1.4 writes them and as its story formats (Sugarcane, Jonah, Responsive) decode them. The Twine 1 HTML output does the same, and decompiling Twine 1 HTML decodes these tiddlers again. (Tweego writes them unencoded, which those story formats then decode into the wrong names and text.)

Only the `StorySettings` passage that is written tells the story format to decode: when it is tagged `Twine.private` (or an alias of it), the tiddlers are written unencoded, with a warning. A passage whose name ROT13 turns into `StorySettings`, or whose tag it turns into `Twine.image`, cannot be decoded by the story format, and is an error.

## JSON

```sh
twee-ts --json -o story.json src/
```

Outputs the story model as JSON per the [Twine 2 JSON Output Specification](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-jsonoutput-doc.md). Useful for tooling, analysis, or custom processing:

<!-- docs-test: json-output -->

```json
{
  "name": "My Story",
  "ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",
  "format": "SugarCube",
  "format-version": "2.37.3",
  "start": "Start",
  "creator": "Twee-ts",
  "creator-version": "2.0.0",
  "style": "",
  "script": "",
  "passages": [
    {
      "name": "Start",
      "tags": [],
      "text": "Hello, world!"
    }
  ]
}
```

`ifid`, `format` and `format-version` are present when they are set, `tag-colors` when StoryData gives tag colors that Twine 2 output writes (see [Twine 2 Archive](#twine-2-archive)), and `zoom` when it is not 1. `start` is the start passage the other output modes use: the one StoryData or `-s`/`startPassage` names, or else `Start` when the story has a passage of that name in `passages` (as the Twine 2 `startnode` points at it); it is left out only when neither applies. JSON output uses no story format: `format` and `format-version` are StoryData's, and `-f` does not change them. `creator-version` is the twee-ts version.

`StoryTitle`, `StoryData`, `script`-tagged, `stylesheet`-tagged, and `Twine.private`-tagged passages are excluded from the `passages` array. Script and stylesheet content is merged into the top-level `script` and `style` fields. Passage metadata (arbitrary key-value pairs from the Twee 3 header) is included when present; as in Twee output, an entry with an empty value is left out, and every key, `__proto__` included, is kept.

## Config File

```json
{
  "outputMode": "html"
}
```

Valid values: `html`, `twee3`, `twee1`, `twine2-archive`, `twine1-archive`, `json`.

CLI flags override the config value. Two output mode flags (`-d --json`, say) are a usage error (exit status 2).

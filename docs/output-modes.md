# Output Modes

twee-ts can produce output in several formats, controlled by the `outputMode` config key or CLI flags.

## HTML (default)

```sh
twee-ts -o story.html src/
```

Compiles a playable HTML file by inserting story data into a story format's HTML template. This is the primary output mode — it produces a single `.html` file that can be opened in any browser.

Requires a story format. twee-ts defaults to `sugarcube-2` and will attempt to download it automatically if not found locally.

## Twee 3

```sh
twee-ts -d -o story.twee src/
```

Decompiles to [Twee 3 notation](https://github.com/iftechfoundation/twine-specs/blob/master/twee-3-specification.md). Useful for converting between formats or extracting source from compiled HTML.

Does not require a story format.

The `StoryData` passage is written from the compiled story, so it records what `-s`/`startPassage` and `-t`/`testMode` (the `debug` option) changed, and compiling the Twee output again gives the same start passage and options. With no overrides, it is the `StoryData` passage as loaded, normalized to tab-indented JSON, plus the IFID twee-ts reports generating when the passage has none. A story without a `StoryData` passage gets one, after `StoryTitle`, only when `-s` or `-t` is given. A `StoryData` passage that is not valid JSON is written as it is.

Twee has no way to escape passage text, and its parser trims passage names and splits tags at whitespace, so some stories, typically ones decompiled from HTML, cannot be written as Twee that compiles back to the same story. twee-ts writes them anyway and reports a warning naming the passage for each of these:

- A line of passage text that starts with `::`, which Twee reads as a new passage header. This is common in stylesheets (`::selection`, `::placeholder`, `::-webkit-scrollbar`). In passages tagged `stylesheet` or `script`, such a line is written indented by one space, which leaves the CSS or JavaScript working, so the stylesheet or script reads back whole; only a template literal or a string continued across lines would see the extra space. In other passages, the line is written as it is.
- A passage name that is empty, has leading or trailing whitespace, or holds a line break.
- A tag that is empty or holds whitespace (only the API, through `tagAliases`, can make one).

Tweego writes the same Twee without a warning.

## Twee 1

```sh
twee-ts --decompile-twee1 -o story.twee src/
```

Decompiles to Twee 1 notation (legacy format). The `StoryData` passage is written the same way as for Twee 3, and the same warnings are reported. Twee 1 escapes nothing in passage headers, so a name or tag holding `[`, `]`, `{`, `}` or `\` gets a warning too.

## Twine 2 Archive

```sh
twee-ts -a -o archive.html src/
```

Outputs the `<tw-storydata>` XML block without wrapping it in a story format's HTML template. This is the format used by Twine 2's import/export feature. The output conforms to the [Twine 2 HTML Output Spec](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-htmloutput-spec.md), including `tags`, `options`, and `<tw-tag>` elements for tag colors.

## Twine 1 Archive

```sh
twee-ts --archive-twine1 -o archive.html src/
```

Outputs a Twine 1-compatible archive with `<div tiddler>` elements. Each tiddler includes `tiddler`, `tags`, `created`, `modifier`, and `twine-position` attributes per the [Twine 1 HTML Output Spec](https://github.com/iftechfoundation/twine-specs/blob/master/twine-1-htmloutput-doc.md).

If a `StorySettings` passage contains `obfuscate:rot13`, each tiddler's `tiddler` name, tags and content are ROT13-encoded, except for `StorySettings` itself and `Twine.image` passages, as Twine 1.4 writes them and as its story formats (Sugarcane, Jonah, Responsive) decode them. The Twine 1 HTML output does the same, and decompiling Twine 1 HTML decodes these tiddlers again. (Tweego writes them unencoded, which those story formats then decode into the wrong names and text.)

## JSON

```sh
twee-ts --json -o story.json src/
```

Outputs the story model as JSON per the [Twine 2 JSON Output Specification](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-jsonoutput-doc.md). Useful for tooling, analysis, or custom processing:

```json
{
  "name": "My Story",
  "ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",
  "format": "SugarCube",
  "format-version": "2.37.3",
  "start": "Start",
  "tag-colors": {},
  "creator": "Twee-ts",
  "creator-version": "1.4.0",
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

`start` is present when `StoryData` sets it or when `-s`/`startPassage` overrides it, and omitted otherwise.

`StoryTitle`, `StoryData`, `script`-tagged, `stylesheet`-tagged, and `Twine.private`-tagged passages are excluded from the `passages` array. Script and stylesheet content is merged into the top-level `script` and `style` fields. Passage metadata (arbitrary key-value pairs from the Twee 3 header) is included when present.

## Config File

```json
{
  "outputMode": "html"
}
```

Valid values: `html`, `twee3`, `twee1`, `twine2-archive`, `twine1-archive`, `json`.

CLI flags override the config value. If both `-d` and `--json` are specified, the first applicable flag wins.

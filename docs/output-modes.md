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

## Twee 1

```sh
twee-ts --decompile-twee1 -o story.twee src/
```

Decompiles to Twee 1 notation (legacy format).

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

If a `StorySettings` passage contains `obfuscate:rot13`, tiddler content is ROT13-encoded (except for `StorySettings` itself).

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

`StoryTitle`, `StoryData`, `script`-tagged, `stylesheet`-tagged, and `Twine.private`-tagged passages are excluded from the `passages` array. Script and stylesheet content is merged into the top-level `script` and `style` fields. Passage metadata (arbitrary key-value pairs from the Twee 3 header) is included when present.

## Config File

```json
{
  "outputMode": "html"
}
```

Valid values: `html`, `twee3`, `twee1`, `twine2-archive`, `twine1-archive`, `json`.

CLI flags override the config value. If both `-d` and `--json` are specified, the first applicable flag wins.

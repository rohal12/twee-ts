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

Outputs the `<tw-storydata>` XML block without wrapping it in a story format's HTML template. This is the format used by Twine 2's import/export feature.

## Twine 1 Archive

```sh
twee-ts --archive-twine1 -o archive.html src/
```

Outputs a Twine 1-compatible archive with `<div tiddler>` elements.

## JSON

```sh
twee-ts --json -o story.json src/
```

Outputs the story model as JSON. Useful for tooling, analysis, or custom processing:

```json
{
  "name": "My Story",
  "ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",
  "passages": [
    {
      "name": "Start",
      "tags": [],
      "text": "Hello, world!",
      "metadata": null
    }
  ],
  "twine2": {
    "format": "SugarCube",
    "formatVersion": "2.37.3",
    "start": "Start",
    "tagColors": {},
    "options": {},
    "zoom": 1
  }
}
```

## Config File

```json
{
  "outputMode": "html"
}
```

Valid values: `html`, `twee3`, `twee1`, `twine2-archive`, `twine1-archive`, `json`.

CLI flags override the config value. If both `-d` and `--json` are specified, the first applicable flag wins.

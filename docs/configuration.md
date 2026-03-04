# Configuration

twee-ts automatically loads `twee-ts.config.json` from the current working directory. Use `-c <file>` to specify a different path, or `--no-config` to skip loading entirely.

## Minimal Config

```json
{
  "sources": ["src/"],
  "output": "story.html"
}
```

With this in place, run `npx twee-ts` with no arguments.

## Complete Reference

Every key with its default value:

```json
{
  "sources": ["src/"],
  "output": "story.html",
  "outputMode": "html",
  "formatId": "sugarcube-2",
  "startPassage": "Start",
  "formatPaths": [],
  "formatIndices": [],
  "formatUrls": [],
  "useTweegoPath": true,
  "modules": [],
  "headFile": "",
  "trim": true,
  "twee2Compat": false,
  "testMode": false,
  "noRemote": false,
  "tagAliases": {}
}
```

## Field Reference

### Sources & Output

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sources` | `string[]` | — | Files or directories to compile. Directories are walked recursively. |
| `output` | `string` | stdout | Output file path. |
| `outputMode` | `string` | `"html"` | One of `html`, `twee3`, `twee1`, `twine2-archive`, `twine1-archive`, `json`. |

### Story Format

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `formatId` | `string` | `"sugarcube-2"` | Story format directory ID. |
| `formatPaths` | `string[]` | `[]` | Extra directories to search for story formats. |
| `formatIndices` | `string[]` | `[]` | URLs to SFA-compatible `index.json` files for remote format lookup. |
| `formatUrls` | `string[]` | `[]` | Direct URLs to `format.js` files. |
| `useTweegoPath` | `boolean` | `true` | Also search the `TWEEGO_PATH` environment variable for formats. |
| `noRemote` | `boolean` | `false` | Disable remote format fetching entirely. |

### Compilation

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `startPassage` | `string` | `"Start"` | Name of the starting passage. |
| `trim` | `boolean` | `true` | Trim leading and trailing whitespace from passage content. |
| `twee2Compat` | `boolean` | `false` | Enable Twee2 syntax compatibility mode. |
| `testMode` | `boolean` | `false` | Enable test/debug mode (sets the `debug` option in story data). |

### Head Injection

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `modules` | `string[]` | `[]` | JS or CSS files to inject into the HTML `<head>`. |
| `headFile` | `string` | `""` | Path to a raw HTML file whose contents are appended to `<head>`. |

### Tag Aliases

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `tagAliases` | `Record<string, string>` | `{}` | Map custom tag names to canonical special tags. |

See the dedicated [Tag Aliases](./tag-aliases) page for full details and examples.

## CLI Override

CLI flags take precedence over config file values. For example:

```json
{
  "formatId": "sugarcube-2",
  "startPassage": "Begin"
}
```

```sh
# Overrides formatId to harlowe-3, keeps startPassage as Begin
twee-ts -f harlowe-3
```

For `tagAliases`, CLI `--tag-alias` flags are **merged** on top of config values, so you can set defaults in the config and add or override aliases per invocation.

## Scaffolding

Run `npx twee-ts --init` to generate a starter config and source files:

```sh
npx twee-ts --init
```

This creates:
- `twee-ts.config.json` with `sources` and `output`
- `src/StoryData.tw` with a generated IFID
- `src/Start.tw` with a starter passage

## Validation

twee-ts validates the config file on load. Invalid types or unknown values produce clear error messages:

```
Invalid config in twee-ts.config.json:
  "sources" must be an array of strings.
  "trim" must be a boolean.
```

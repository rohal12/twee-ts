# Tag Aliases

Tag aliases let you map custom tag names to tags such as `script`, `stylesheet`, `annotation`, `widget` and `Twine.private`. This is useful when you want more descriptive or project-specific tag names in your source while keeping the corresponding compiler or story-format behavior.

## How It Works

After loading all passages but before output generation, twee-ts **adds** the canonical tag to any passage that carries an alias tag. The original alias tag remains in the compiled story model and in Twee output. A passage emitted as `<tw-passagedata>` carries both tags; passages extracted as scripts or stylesheets, or omitted as private, have no such element.

For example, with `{ "library": "script" }`:

```
Passage tags before:  ['library']
Passage tags after:   ['library', 'script']
```

All existing special-tag checks (which look for `script`, `stylesheet`, etc.) now match. No changes are needed in the output modules.

The operation is **idempotent** — running it multiple times has the same effect as running it once. If the canonical tag is already present, it won't be duplicated.

## Usage

### Config File

```json
{
  "sources": ["src/"],
  "output": "story.html",
  "tagAliases": {
    "library": "script",
    "theme": "stylesheet",
    "dev-note": "Twine.private"
  }
}
```

### CLI

The `--tag-alias` flag takes `alias=target` pairs and can be repeated:

```sh
twee-ts --tag-alias library=script --tag-alias theme=stylesheet -o story.html src/
```

CLI aliases are **merged** on top of config file aliases. If both define the same alias key, the CLI value wins.

### Programmatic API

```typescript
import { compile } from '@rohal12/twee-ts';

const result = await compile({
  sources: ['src/'],
  tagAliases: {
    library: 'script',
    theme: 'stylesheet',
  },
});
```

You can also use the lower-level `applyTagAliases` function directly:

```typescript
import { applyTagAliases } from '@rohal12/twee-ts';
import type { Passage } from '@rohal12/twee-ts';

const passages: Passage[] = [{ name: 'Utils', tags: ['library'], text: 'window.x = 1;' }];

const resolved = applyTagAliases(passages, { library: 'script' });
// resolved[0].tags is ['library', 'script']
// passages[0].tags remains ['library']
```

Use the returned array. The function copies passages whose tags change and leaves the original passages and tag arrays unchanged; unchanged passages may be shared with the input.

## Example

Given this Twee source:

```twee
:: StoryData
{"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC"}

:: StoryTitle
My Story

:: Start
Hello, world!

:: Utils [library]
window.utils = { greet: () => "hi" };

:: Dark Theme [theme]
body { background: #1a1a1a; color: #eee; }

:: Design Notes [dev-note]
This passage is excluded from the compiled output.
```

With this config:

```json
{
  "tagAliases": {
    "library": "script",
    "theme": "stylesheet",
    "dev-note": "Twine.private"
  }
}
```

For Twine 2 HTML or archive output, the result is:

| Passage      | Original Tags | Resolved Tags               | Effect                                                           |
| ------------ | ------------- | --------------------------- | ---------------------------------------------------------------- |
| Utils        | `library`     | `library`, `script`         | Content goes into the `<script id="twine-user-script">` block    |
| Dark Theme   | `theme`       | `theme`, `stylesheet`       | Content goes into the `<style id="twine-user-stylesheet">` block |
| Design Notes | `dev-note`    | `dev-note`, `Twine.private` | Excluded from story passage data                                 |
| Start        | _(none)_      | _(none)_                    | Normal story passage, unaffected                                 |

All three aliased passages are classified as **info passages** and excluded from story-passage and word counts. In this example, their resolved tags also remove them from `<tw-passagedata>` output. Info classification alone does not omit a passage: `annotation` and `widget` passages remain ordinary passage elements.

Twee output keeps the resolved tags, including the original aliases. Decompiling HTML does not recover omitted private passages or the original names and alias tags of script and stylesheet passages: those code passages have been combined into their respective blocks.

## Common Aliases

| Alias      | Target          | Purpose                                      |
| ---------- | --------------- | -------------------------------------------- |
| `library`  | `script`        | Mark JavaScript utility passages             |
| `theme`    | `stylesheet`    | Mark CSS theme passages                      |
| `dev-note` | `Twine.private` | Development notes excluded from story output |
| `macro`    | `widget`        | SugarCube widget/macro definition passages   |

## Special Tags Reference

These tags can be used as alias targets. The output effects below describe Twine 2 HTML and archive output:

| Tag             | Effect                                                             |
| --------------- | ------------------------------------------------------------------ |
| `script`        | Passage content is combined into the `twine-user-script` block     |
| `stylesheet`    | Passage content is combined into the `twine-user-stylesheet` block |
| `annotation`    | Kept as passage data; excluded from story-passage and word counts  |
| `widget`        | Kept as passage data; SugarCube interprets the tag at runtime      |
| `Twine.private` | Passage is omitted from story passage data                         |

Any of these can be used as the target (right-hand side) of a tag alias. The alias (left-hand side) can be any string that is a valid Twee tag.

# Tag Aliases

Tag aliases let you map custom tag names to the tags twee-ts and story formats treat specially (`script`, `stylesheet`, `Twine.private`, `widget`, `annotation`). This is useful when you want more descriptive or project-specific tag names in your source while keeping full compatibility with Twine's special-tag behavior.

## How It Works

After loading all passages but before output generation, twee-ts **adds** the target tag to any passage that carries an alias tag. The alias tag is kept: Twee and JSON output write it, and so does a `<tw-passagedata>` element's `tags` attribute. (Script and stylesheet passages are not written as `<tw-passagedata>` elements, so their tags, aliases included, are not in Twine 2 HTML.)

For example, with `{ "library": "script" }`:

```
Passage tags before:  ['library']
Passage tags after:   ['library', 'script']
```

Every check for a special tag (`script`, `stylesheet`, `Twine.private`, …) then matches the passage.

A target that is itself an alias is followed: with `{ "library": "script", "script": "Twine.private" }` a passage tagged `library` gets `script` and `Twine.private` at once. Cycles and self-mappings end once no mapping adds a tag. The first application therefore gives the final tags, so compiling to Twee and recompiling with the same aliases changes nothing.

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

You can also use the lower-level `applyTagAliases` function directly. It returns a new array and leaves the passages passed in unchanged:

```typescript
import { applyTagAliases } from '@rohal12/twee-ts';
import type { Passage } from '@rohal12/twee-ts';

const passages: Passage[] = [{ name: 'Utils', tags: ['library'], text: 'window.x = 1;' }];

const aliased = applyTagAliases(passages, { library: 'script' });
console.log(aliased[0]?.tags); // ['library', 'script']
console.log(passages[0]?.tags); // ['library'], unchanged
```

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
A private note: Twine 2 HTML, Twine 1 HTML and JSON output leave it out.

:: Changelog [changes]
Kept in the output, but not counted as a story passage.
```

With this config:

```json
{
  "tagAliases": {
    "library": "script",
    "theme": "stylesheet",
    "dev-note": "Twine.private",
    "changes": "annotation"
  }
}
```

The result in Twine 2 HTML:

| Passage      | Original Tags | Resolved Tags               | Effect                                                                                                         |
| ------------ | ------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Utils        | `library`     | `library`, `script`         | Content goes into the `<script id="twine-user-script" type="text/twine-javascript">` element                   |
| Dark Theme   | `theme`       | `theme`, `stylesheet`       | Content goes into the `<style id="twine-user-stylesheet" type="text/twine-css">` element                       |
| Design Notes | `dev-note`    | `dev-note`, `Twine.private` | Left out of the output                                                                                         |
| Changelog    | `changes`     | `changes`, `annotation`     | A `<tw-passagedata>` element with `tags="changes annotation"`; an info passage, not counted as a story passage |
| Start        | _(none)_      | _(none)_                    | Normal story passage, unaffected                                                                               |

All four aliased passages are **info passages**: they are not counted as story passages or in the word count, and lint never lists them as dead ends or orphans. Only Changelog is written as a `<tw-passagedata>` element. Decompiling the HTML gives Utils and Dark Theme back as part of one `Story JavaScript` passage (tagged `script`) and one `Story Stylesheet` passage (tagged `stylesheet`), without their names or alias tags, and Design Notes not at all. Twee output (`-d`) keeps every passage with the tags as written.

## Common Aliases

| Alias      | Target          | Purpose                                    |
| ---------- | --------------- | ------------------------------------------ |
| `library`  | `script`        | Mark JavaScript utility passages           |
| `theme`    | `stylesheet`    | Mark CSS theme passages                    |
| `dev-note` | `Twine.private` | Development notes left out of the output   |
| `macro`    | `widget`        | SugarCube widget/macro definition passages |

## Special Tags Reference

These are the tags twee-ts treats specially, and so the useful alias targets:

| Tag             | Effect                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------- |
| `script`        | Content is combined into the story's script element (Twine 2) or the JSON `script` field |
| `stylesheet`    | Content is combined into the story's style element (Twine 2) or the JSON `style` field   |
| `Twine.private` | Left out of Twine 2 HTML, Twine 1 HTML, archives and JSON                                |
| `widget`        | An info passage, written as usual; SugarCube reads it as widget definitions              |
| `annotation`    | An info passage, written as usual                                                        |
| `Twine.*`       | Any tag that starts with `Twine.` makes an info passage                                  |

Script and stylesheet passages are info passages too. Twine 1 output writes script and stylesheet passages as ordinary tiddlers, which Twine 1 story formats read by their tags.

Both sides of an alias can be any tag name: non-empty and without white space. An alias whose target twee-ts doesn't treat specially just adds that tag.

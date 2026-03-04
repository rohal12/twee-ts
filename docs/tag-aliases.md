# Tag Aliases

Tag aliases let you map custom tag names to Twine's built-in special tags (`script`, `stylesheet`, `annotation`, `widget`). This is useful when you want more descriptive or project-specific tag names in your source while keeping full compatibility with Twine's special-tag behavior.

## How It Works

After loading all passages but before output generation, twee-ts **adds** the canonical tag to any passage that carries an alias tag. The original alias tag is preserved — it still appears in `<tw-passagedata>` tag attributes and in decompiled Twee output.

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
    "dev-note": "annotation"
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

applyTagAliases(passages, { library: 'script' });
// passages[0].tags is now ['library', 'script']
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
This passage is excluded from the compiled output.
```

With this config:

```json
{
  "tagAliases": {
    "library": "script",
    "theme": "stylesheet",
    "dev-note": "annotation"
  }
}
```

The result:

| Passage      | Original Tags | Resolved Tags            | Effect                                                           |
| ------------ | ------------- | ------------------------ | ---------------------------------------------------------------- |
| Utils        | `library`     | `library`, `script`      | Content goes into the `<style id="twine-user-script">` block     |
| Dark Theme   | `theme`       | `theme`, `stylesheet`    | Content goes into the `<style id="twine-user-stylesheet">` block |
| Design Notes | `dev-note`    | `dev-note`, `annotation` | Excluded from compiled output entirely                           |
| Start        | _(none)_      | _(none)_                 | Normal story passage, unaffected                                 |

All three aliased passages are classified as **info passages** and won't appear as `<tw-passagedata>` elements. Their original tags are preserved, so decompiling back to Twee produces `[library]`, `[theme]`, and `[dev-note]` as written.

## Common Aliases

| Alias      | Target       | Purpose                                    |
| ---------- | ------------ | ------------------------------------------ |
| `library`  | `script`     | Mark JavaScript utility passages           |
| `theme`    | `stylesheet` | Mark CSS theme passages                    |
| `dev-note` | `annotation` | Development notes excluded from output     |
| `macro`    | `widget`     | SugarCube widget/macro definition passages |

## Special Tags Reference

These are the built-in special tags that can be used as alias targets:

| Tag          | Effect                                                             |
| ------------ | ------------------------------------------------------------------ |
| `script`     | Passage content is combined into the `twine-user-script` block     |
| `stylesheet` | Passage content is combined into the `twine-user-stylesheet` block |
| `annotation` | Passage is excluded from compiled output                           |
| `widget`     | Passage is treated as a widget definition (SugarCube)              |

Any of these can be used as the target (right-hand side) of a tag alias. The alias (left-hand side) can be any string that is a valid Twee tag.

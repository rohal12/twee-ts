---
outline: deep
---

# Publishing a Twine Story Format as an npm Package

This document describes how to package a Twine 2 story format as an npm package for use with twee-ts and TypeScript-based Twine projects.

## Overview

A story format npm package serves up to three purposes:

1. **Compilation**: twee-ts uses the format's HTML template to produce playable story files
2. **Type safety**: story authors get autocomplete and type checking for the format's JavaScript API
3. **Source access**: story authors can read the format's source to understand how features work

Only the first is required. The other two are optional but significantly improve the authoring experience. twee-ts finds an installed package through `formatPaths`, as [Level 1](#level-1-compilation-only-minimum-viable-package) shows.

## Levels of Support

### Level 1: Compilation Only (minimum viable package)

This is the bare minimum: a package that holds the format's `format.js`, so twee-ts can build with it.

#### Package structure

```
my-format-1/
├── package.json
└── format.js
```

#### `package.json`

<!-- docs-test: package=@twine-formats/my-format-1 file=package.json -->

```json
{
  "name": "@twine-formats/my-format-1",
  "version": "1.0.0",
  "keywords": ["twine-story-format"],
  "files": ["format.js"]
}
```

The `"twine-story-format"` keyword helps people find format packages on npm; twee-ts does not read it.

#### `format.js`

Your existing Twine 2 format.js file, unchanged:

<!-- docs-test: format-js package=@twine-formats/my-format-1 file=format.js -->

<!-- prettier-ignore -->
```javascript
window.storyFormat({
  "name": "My Format",
  "version": "1.0.0",
  "source": "<html><head><title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>"
});
```

This is the standard format file as defined by the [Twine 2 Story Formats Spec](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-storyformats-spec.md).

#### Usage by story authors

```sh
npm install @twine-formats/my-format-1
```

twee-ts reads story formats from folders: each subfolder of a [format directory](./story-formats#search-order) that holds a `format.js` is a format. An npm scope folder is such a directory, so list it in `formatPaths`, in the [config file](./configuration):

```json
{
  "formatPaths": ["node_modules/@twine-formats"]
}
```

or through the [API](./api#compile-options):

```typescript
import { compile } from '@rohal12/twee-ts';

const result = await compile({
  sources: ['src/'],
  formatPaths: ['node_modules/@twine-formats'],
});
```

The package's folder name is then its format ID (`--format my-format-1`), and a `StoryData` passage that names `My Format` finds it by name and version, as for any local format (see [How a Format Is Chosen](./story-formats#how-a-format-is-chosen)). An unscoped package works the same way when its folder is listed directly: `formatPaths: ['node_modules']` makes every package with a `format.js` a format, so a scope keeps the list short.

twee-ts does not search `node_modules` by itself, and `compile()` has no option that takes a format module: `formatPaths` is the one way to add formats from disk. Packages and their versions stay under your project's control (and its lockfile), and nothing else in `node_modules` is read.

#### An ESM wrapper (optional)

Tools other than twee-ts may want the format's fields from JavaScript. A thin wrapper can export them; twee-ts does not use it:

<!-- docs-test: package=@twine-formats/my-format-1 file=index.js -->

```javascript
// index.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(__dirname, 'format.js'), 'utf-8');
const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));

export const name = json.name;
export const version = json.version;
export const source = json.source;
export const proofing = json.proofing ?? false;
```

This simple parse needs a `format.js` whose object is strict JSON with no `{` before it (in a comment, say), as in the example above; twee-ts itself also reads the JavaScript object literal syntax some formats use (see [Format Metadata](./story-formats#format-metadata)). Add `"type": "module"`, `"exports": { ".": "./index.js" }` and `index.js` to `files` in `package.json` when you ship it.

---

### Level 2: Type Declarations

This level adds TypeScript types for your format's runtime JavaScript API. Story authors get autocomplete and type checking when writing story scripts.

#### Additional files

```
my-format-1/
├── package.json
├── index.js
├── format.js
└── types/
    ├── index.d.ts
    └── globals.d.ts
```

#### `package.json` (updated)

<!-- docs-test: package=@twine-formats/my-format-1 file=package.json -->

```json
{
  "name": "@twine-formats/my-format-1",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./types/index.d.ts",
      "import": "./index.js"
    }
  },
  "keywords": ["twine-story-format"],
  "files": ["index.js", "format.js", "types"]
}
```

The types need an entry point to hang on, so this level ships the [optional ESM wrapper](#an-esm-wrapper-optional) as `index.js`.

#### `types/index.d.ts`

Declares the format metadata exports and any API types. Its first line loads `globals.d.ts`, which nothing else would load:

<!-- docs-test: package=@twine-formats/my-format-1 file=types/index.d.ts -->

```typescript
/// <reference path="./globals.d.ts" />

// Format metadata (exported by the optional wrapper)
export declare const name: string;
export declare const version: string;
export declare const source: string;
export declare const proofing: boolean;

// Format-specific API types (used by story authors)
// These describe the objects available at runtime in the browser.

export interface FormatConfig {
  // Replace with your format's actual configuration interface
  passages: {
    start: string;
  };
}

export interface MacroContext {
  name: string;
  args: unknown[];
  output: DocumentFragment;
  error(message: string): false;
}

export interface MacroDefinition {
  handler(this: MacroContext): void;
  tags?: string[] | null;
}
```

#### `types/globals.d.ts`

Declares the global variables that exist at runtime when a story is played. Story scripts reference these directly (e.g. `Config.passages.start`), so TypeScript needs to know about them:

<!-- docs-test: package=@twine-formats/my-format-1 file=types/globals.d.ts -->

```typescript
import type { FormatConfig, MacroDefinition } from './index.js';

declare global {
  /** Story format configuration object. */
  const Config: FormatConfig;

  /** Macro registration API. */
  const Macro: {
    add(name: string, definition: MacroDefinition): void;
    delete(name: string): void;
    has(name: string): boolean;
  };
}

export {};
```

The `export {}` at the end is required — it ensures the file is treated as a module, which is necessary for `declare global` to work.

#### Usage by story authors

Story authors add your package to their tsconfig.json `types` array, which loads `types/index.d.ts` and, through its reference, the global declarations:

<!-- docs-test: not-config — a tsconfig.json -->

```json
{
  "compilerOptions": {
    "types": ["@twine-formats/my-format-1"]
  }
}
```

Now their story scripts get full type support:

<!-- docs-test: no-run — a story script, which runs in the browser inside the story -->

```typescript
// story-script.ts
Config.passages.start = 'Prologue'; // autocomplete, type-checked

Macro.add('greet', {
  handler() {
    this.output.append('Hello!'); // `this` is typed as MacroContext
  },
});
```

Story authors can also import types explicitly when needed:

```typescript
import type { MacroContext } from '@twine-formats/my-format-1';

export function myHelper(ctx: MacroContext): void {
  ctx.output.append(`Hello from ${ctx.name}!`);
}
```

---

### Level 3: Readable Source

This level includes your format's pre-bundle source code in the package, so story authors can read how features are implemented.

#### Additional files

```
my-format-1/
├── package.json
├── index.js
├── format.js
├── types/
│   ├── index.d.ts
│   └── globals.d.ts
└── src/
    ├── config.js
    ├── state.js
    ├── engine.js
    ├── macro.js
    └── ...
```

#### `package.json` (updated)

Add `src` to the `files` array:

<!-- docs-test: not-config — an excerpt of the package.json above -->

```json
{
  "files": ["index.js", "format.js", "types", "src"]
}
```

That's all. The source is now included in the published package and accessible at `node_modules/@twine-formats/my-format-1/src/`.

#### Linking types to source

To let editors navigate from a type declaration to the implementing source, add `@see` tags to your type declarations:

<!-- docs-test: skip — an excerpt of types/index.d.ts above, with a tag added -->

```typescript
// types/index.d.ts

/**
 * Story format configuration.
 * @see {@link ../src/config.js} for the implementation.
 */
export interface FormatConfig {
  // ...
}
```

Or use declaration maps (`"declarationMap": true` in tsconfig) if your types are generated from the source.

---

## What twee-ts Reads

twee-ts reads only the package's `format.js`, from the folder the package is installed in, exactly as it reads any [local story format](./story-formats#format-metadata):

| Field                                              | Required | Description                                                                                |
| -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `name`                                             | no       | Format name (e.g. `"SugarCube"`); a format without one is `Untitled Story Format`          |
| `version`                                          | yes      | SemVer version (e.g. `"2.37.3"`); a format without a valid one is skipped with a warning   |
| `source`                                           | yes      | HTML template containing `{{STORY_NAME}}` and `{{STORY_DATA}}` placeholders                |
| `proofing`                                         | no       | Whether this is a proofing format. Default: `false`                                        |
| `author`, `description`, `image`, `url`, `license` | no       | Strings, reported in `StoryFormatInfo`; a value of another type is ignored, with a warning |

These correspond to the fields in the [Twine 2 Story Formats Spec](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-storyformats-spec.md).

A Twine 1 format package holds a `header.html` instead, as a Twine 1 format folder does. A Twine 1 header that includes Twine 1's `engine.js`, `jquery.js` or `modernizr.js` reads them from the folder above the format folder, which for a package is the scope folder (`node_modules/@twine-formats/`), where npm puts nothing. Only Twine 1 formats that need nothing outside their own folder, such as SugarCube's Twine 1 build, work as packages.

Each `{{STORY_NAME}}` gets the story name escaped for where it is, as the HTML parser reads the template: HTML-escaped in text and attribute values (as Twine 2 does), percent-encoded in a URL attribute such as `href`, and in a JavaScript string or template literal HTML-escaped (so SugarCube's `Util.unescape()` gets the name back) with `\`, line breaks, U+2028 and U+2029 (and, in a template literal, `` ` `` and `$`) escaped for JavaScript. A string in a JSON data block or a CSS string gets JSON or CSS escaping. Where no escaping keeps the value (JavaScript code outside a literal, raw text, inside a tag), the name is HTML-escaped as Twine 2 writes it, with a warning. `{{STORY_DATA}}` is replaced at its first occurrence where the browser reads the story data as elements of the page (not in a comment, a script or the title); when there is no such occurrence, the first one is replaced, with an error.

## Naming Convention

We recommend the `@twine-formats/` npm scope for community packages, with the format ID as the package name, so that the installed folder is the format ID:

- `@twine-formats/sugarcube-2`
- `@twine-formats/harlowe-3`
- `@twine-formats/chapbook-2`
- `@twine-formats/snowman-2`

A `StoryData` request finds a format by the `name` and `version` in its `format.js` whatever its folder is called, and `--format` finds it by its folder name or by its name and major version (`sugarcube-2`).

## Versioning

The package version should match the format version. When SugarCube releases 2.38.0, the package version should be 2.38.0. This keeps things predictable for story authors:

```sh
npm install @twine-formats/sugarcube-2@2.37.3
```

## Compatibility with Existing Tools

Packages that follow this guide remain compatible with Twine 2 and Tweego because they include the standard `format.js` file. Tweego users can point `TWEEGO_PATH` at the same scope folder. The optional wrapper and type declarations are additive: they don't change `format.js` in any way.

## Example: Minimal SugarCube Package

A complete, minimal package for SugarCube 2.37.3:

```sh
mkdir sugarcube-2 && cd sugarcube-2
```

Its `package.json`:

<!-- docs-test: package=@twine-formats/sugarcube-2 file=package.json -->

```json
{
  "name": "@twine-formats/sugarcube-2",
  "version": "2.37.3",
  "description": "SugarCube story format for Twine, packaged for twee-ts",
  "keywords": ["twine-story-format"],
  "files": ["format.js"],
  "license": "BSD-2-Clause"
}
```

Then copy the SugarCube `format.js` into the directory and publish:

```sh
npm publish --access public
```

A project then installs it and lists the scope folder:

```sh
npm install --save-dev @twine-formats/sugarcube-2
```

```json
{
  "formatPaths": ["node_modules/@twine-formats"]
}
```

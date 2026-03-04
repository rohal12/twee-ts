# Publishing a Twine Story Format as an npm Package

This document describes how to package a Twine 2 story format as an npm package for use with twee-ts and TypeScript-based Twine projects.

## Overview

A story format npm package serves up to three purposes:

1. **Compilation** — twee-ts uses the format's HTML template to produce playable story files
2. **Type safety** — story authors get autocomplete and type checking for the format's JavaScript API
3. **Source access** — story authors can read the format's source to understand how features work

Only the first is required. The other two are optional but significantly improve the authoring experience.

## Levels of Support

### Level 1: Compilation Only (minimum viable package)

This is the bare minimum. It lets twee-ts use your format for compilation.

#### Package structure

```
my-format/
├── package.json
├── index.js
└── format.js
```

#### `package.json`

```json
{
  "name": "@twine-formats/my-format",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": "./index.js"
  },
  "keywords": ["twine-story-format"],
  "files": ["index.js", "format.js"]
}
```

The `"twine-story-format"` keyword is required. twee-ts uses it to identify format packages in `node_modules`.

#### `format.js`

Your existing Twine 2 format.js file, unchanged:

```javascript
window.storyFormat({"name":"My Format","version":"1.0.0","source":"<html>...{{STORY_NAME}}...{{STORY_DATA}}...</html>"});
```

This is the standard format file as defined by the [Twine 2 Story Formats Spec](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-storyformats-spec.md).

#### `index.js`

A thin ESM wrapper that parses format.js and re-exports its fields:

```javascript
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

#### Usage by story authors

```sh
npm install @twine-formats/my-format
```

```typescript
import * as myFormat from '@twine-formats/my-format';
import { compile } from 'twee-ts';

const result = await compile({
  sources: ['src/'],
  format: myFormat,
});
```

Or with no code at all — twee-ts auto-discovers packages with the `twine-story-format` keyword from `node_modules`.

---

### Level 2: Type Declarations

This level adds TypeScript types for your format's runtime JavaScript API. Story authors get autocomplete and type checking when writing story scripts.

#### Additional files

```
my-format/
├── package.json
├── index.js
├── format.js
└── types/
    ├── index.d.ts
    └── globals.d.ts
```

#### `package.json` (updated)

```json
{
  "name": "@twine-formats/my-format",
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

#### `types/index.d.ts`

Declares the format metadata exports and any API types:

```typescript
// Format metadata (used by twee-ts)
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

Story authors add your package to their tsconfig.json `types` array to activate the global declarations:

```json
{
  "compilerOptions": {
    "types": ["@twine-formats/my-format"]
  }
}
```

Now their story scripts get full type support:

```typescript
// story-script.ts
Config.passages.start = "Prologue";  // autocomplete, type-checked

Macro.add("greet", {
  handler() {
    this.output.append("Hello!");    // `this` is typed as MacroContext
  }
});
```

Story authors can also import types explicitly when needed:

```typescript
import type { MacroContext } from '@twine-formats/my-format';

function myHelper(ctx: MacroContext): void {
  // ...
}
```

---

### Level 3: Readable Source

This level includes your format's pre-bundle source code in the package, so story authors can read how features are implemented.

#### Additional files

```
my-format/
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

```json
{
  "files": ["index.js", "format.js", "types", "src"]
}
```

That's all. The source is now included in the published package and accessible at `node_modules/@twine-formats/my-format/src/`.

#### Linking types to source

To let editors navigate from a type declaration to the implementing source, add `@see` tags to your type declarations:

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

## Required Exports

twee-ts requires the following named exports from the package's main entry point:

| Export     | Type      | Required | Description                                      |
|------------|-----------|----------|--------------------------------------------------|
| `name`     | `string`  | yes      | Format name (e.g. `"SugarCube"`)                 |
| `version`  | `string`  | yes      | Semantic version (e.g. `"2.37.3"`)               |
| `source`   | `string`  | yes      | HTML template containing `{{STORY_NAME}}` and `{{STORY_DATA}}` placeholders |
| `proofing` | `boolean` | no       | Whether this is a proofing format. Default: `false` |

These correspond to the fields in the [Twine 2 Story Formats Spec](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-storyformats-spec.md).

## Naming Convention

We recommend the `@twine-formats/` npm scope for community packages:

- `@twine-formats/sugarcube-2`
- `@twine-formats/harlowe-3`
- `@twine-formats/chapbook-2`
- `@twine-formats/snowman-2`

Unscoped names work too. The package name does not need to match the format name — twee-ts matches by the `name` and `version` exports, not by the package name.

## Versioning

The package version should match the format version. When SugarCube releases 2.38.0, the package version should be 2.38.0. This keeps things predictable for story authors:

```sh
npm install @twine-formats/sugarcube-2@2.37.3
```

## Compatibility with Existing Tools

Packages that follow this spec remain compatible with Twine 2 and Tweego because they include the standard `format.js` file. The ESM wrapper and type declarations are additive — they don't change the format.js in any way.

## Example: Minimal SugarCube Package

A complete, minimal package for SugarCube 2.37.3:

```sh
mkdir sugarcube-2 && cd sugarcube-2
```

```json
// package.json
{
  "name": "@twine-formats/sugarcube-2",
  "version": "2.37.3",
  "description": "SugarCube story format for Twine, packaged for twee-ts",
  "type": "module",
  "exports": {
    ".": "./index.js"
  },
  "keywords": ["twine-story-format"],
  "files": ["index.js", "format.js"],
  "license": "BSD-2-Clause"
}
```

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

Then copy the SugarCube `format.js` into the directory and publish:

```sh
npm publish --access public
```

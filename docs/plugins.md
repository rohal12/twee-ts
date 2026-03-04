# Vite & Rollup Plugins

twee-ts ships with first-class build tool plugins for Vite and Rollup.

## Vite Plugin

```typescript
// vite.config.ts
import { tweeTsPlugin } from '@rohal12/twee-ts/vite';

export default {
  plugins: [
    tweeTsPlugin({
      sources: ['src/story'],
      format: 'sugarcube-2',
    }),
  ],
};
```

### Options

```typescript
interface TweeTsVitePluginOptions {
  /** Source directories/files to compile. */
  sources: string[];
  /** Story format ID. */
  format?: string;
  /** Output filename in build output. Default: 'index.html'. */
  outputFilename?: string;
  /** Additional compile options (tagAliases, trim, modules, etc.). */
  compileOptions?: Partial<CompileOptions>;
}
```

### Features

- **Hot reload**: The plugin watches `.tw` and `.twee` files. Changes trigger a full page reload via Vite's dev server.
- **Build output**: During `vite build`, the compiled HTML is emitted as an asset with the configured filename.
- **Diagnostics**: Warnings and errors are logged to the console during build.

### Full Example

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { tweeTsPlugin } from '@rohal12/twee-ts/vite';

export default defineConfig({
  plugins: [
    tweeTsPlugin({
      sources: ['src/story'],
      format: 'sugarcube-2',
      outputFilename: 'index.html',
      compileOptions: {
        startPassage: 'Prologue',
        tagAliases: {
          library: 'script',
          theme: 'stylesheet',
        },
        modules: ['src/extra.js'],
        trim: true,
      },
    }),
  ],
});
```

## Rollup Plugin

```typescript
// rollup.config.js
import { tweeTsPlugin } from '@rohal12/twee-ts/rollup';

export default {
  plugins: [
    tweeTsPlugin({
      sources: ['src/story'],
      format: 'sugarcube-2',
    }),
  ],
};
```

### Options

```typescript
interface TweeTsRollupPluginOptions {
  /** Source directories/files to compile. */
  sources: string[];
  /** Story format ID. */
  format?: string;
  /** Output filename. Default: 'index.html'. */
  outputFilename?: string;
  /** Additional compile options. */
  compileOptions?: Partial<CompileOptions>;
}
```

### Full Example

```typescript
// rollup.config.js
import { tweeTsPlugin } from '@rohal12/twee-ts/rollup';

export default {
  input: 'src/entry.js', // Rollup requires an input
  plugins: [
    tweeTsPlugin({
      sources: ['src/story'],
      format: 'harlowe-3',
      outputFilename: 'story.html',
      compileOptions: {
        tagAliases: { macro: 'widget' },
      },
    }),
  ],
  output: {
    dir: 'dist',
  },
};
```

## Using `compileOptions`

Both plugins accept a `compileOptions` object that is spread into the `compile()` call. This lets you use any [CompileOptions](./api#compile-options) field:

```typescript
compileOptions: {
  startPassage: 'Prologue',
  tagAliases: { library: 'script' },
  modules: ['src/analytics.js'],
  headFile: 'src/head.html',
  trim: true,
  twee2Compat: false,
  testMode: false,
  noRemote: false,
}
```

The `sources` and `formatId` fields are set by the plugin's top-level `sources` and `format` options respectively, so don't set them again inside `compileOptions`.

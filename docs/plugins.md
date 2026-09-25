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
  /** Source directories/files to compile, relative to the working directory. */
  sources: string[];
  /** Story format ID. */
  format?: string;
  /** Output filename in build output. Default: 'index.html'. */
  outputFilename?: string;
  /** Additional compile options (tagAliases, trim, modules, etc.). */
  compileOptions?: Partial<CompileOptions>;
  /** A JS or TS file bundled into the story as Story JavaScript (its CSS as Story Stylesheet). Vite 8+. */
  entry?: string;
}
```

### Features

- **Dev server**: the compiled story is served at the base URL with Vite's client added. Any change to a source (Twee, `.js` and `.css` files inside `sources`), the head file, a module, or a file the entry imports recompiles the story and reloads the page. Saves that land within 50 ms are compiled once.
- **Error overlay**: compile and bundling errors appear in Vite's overlay with file and line, and the last good story keeps being served until the next successful compile.
- **Build output**: during `vite build` the compiled HTML is emitted with the configured filename. Errors fail the build; warnings go through Vite's logger.
- **Script entry**: see below.

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

### Bundling a script entry

With `entry`, Vite bundles a JS or TS file and everything it imports into one self-contained script (no `import`/`export` left), which becomes the story's Story JavaScript. CSS the entry imports becomes the Story Stylesheet. The story format runs it like any story script, so macros and configuration are in place before the first passage renders. The HTML is the only file the build writes, apart from Vite's `publicDir`. Requires Vite 8.

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { tweeTsPlugin } from '@rohal12/twee-ts/vite';

export default defineConfig(({ mode }) => ({
  plugins: [
    tweeTsPlugin({
      sources: ['src/story'],
      format: 'sugarcube-2',
      entry: 'src/app/index.ts',
      compileOptions: { testMode: mode === 'development' },
    }),
  ],
}));
```

In dev the entry is bundled with your own Vite config (so your other plugins apply), unminified and with an inline source map.

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

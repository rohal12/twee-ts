# Vite & Rollup Plugins

twee-ts ships with build tool plugins for Vite and Rollup. Both take the same options and give them the same meaning.

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

<!-- docs-test: mirror from=@rohal12/twee-ts/vite -->

```typescript
interface TweeTsVitePluginOptions {
  /** Source directories/files to compile, relative to the working directory. */
  sources: string[];
  /** Story format ID. */
  format?: string;
  /** Output file name, relative to the output folder. Default: 'index.html'. */
  outputFilename?: string;
  /** Additional compile options (tagAliases, trim, modules, exclude, …). */
  compileOptions?: PluginCompileOptions;
  /** A JS or TS file bundled into the story as Story JavaScript (its CSS as Story Stylesheet). Vite 8+. */
  entry?: string;
}
```

The options are checked when the plugin is created. An unknown option (a misspelt `outputFileName`, say), a value of the wrong type (`sources`, `compileOptions.modules` must be an array of non-empty strings and `compileOptions.exclude` an array of non-empty strings or `{ base, glob }` objects (what `loadConfigFile()` returns for a config in a folder whose name holds glob characters); `format`, `outputFilename`, `entry` and `compileOptions.headFile` non-empty strings), `compileOptions.sources` or `compileOptions.formatId` (set `sources` and `format` instead), an `outputFilename` that is not a plain relative path, and `entry` with a Vite older than 8 throw a `TweeTsError` (`INVALID_OPTIONS`) that names the option. The other compile options are checked by the compiler when the story is built.

`outputFilename` is a path inside the output folder: names separated by `/`, none of them empty, `.` or `..`, and no character a file system or a URL reads differently (`\ : * ? " < > |`, `#`, `%`, control characters), no name ending in `.` or a space, and no name Windows reserves (`con`, `nul`, `com1`, …).

### Vite versions

The plugin works with Vite 8 and every later release (the `vite` peer dependency is `>=8`). CI runs the plugin tests on the latest Vite 8 and type-checks a config against the packed plugins.

### Dev server

- **Serving**: the compiled story is served at the base URL, with Vite's client added, at the path a static host serves the build's file at: `outputFilename` below the base, and for `index.html` (or `dir/index.html`) also its folder. A query string is ignored and a percent-encoded path is decoded. Only `GET` and `HEAD` requests get the story. It is served after Vite's own middlewares, so Vite's host check and base handling apply to it as to any page, with `server.headers` and `Cache-Control: no-cache`.
- **Rebuilds**: a change to a source (Twee, `.js` and `.css` files inside `sources`), the head file, a module, or any file the entry was bundled from recompiles the story and reloads the pages that show it. Saves within 50 ms are compiled once.
- **Missed changes**: before the story is served, the plugin compares the sources, the head file, the modules and the entry's files with what the last compile read, and compiles again if any changed. So the story served is current even when the file watcher misses a change (after a folder is deleted and created again in quick succession, as `git rebase` does) or is off (`server.watch: null`); an open page then reloads only when you reload it.
- **Excluded files**: `compileOptions.exclude` leaves files out of the story (see [Excluding files](./configuration#excluding-files)). A change to an excluded file recompiles nothing, unless the entry uses the file.
- **Error overlay**: compile and bundling errors appear in Vite's overlay with file and line, also on a page that connects after the error, and the last good story keeps being served until the next successful compile. Before the first successful compile, a page with Vite's client is served so the overlay has somewhere to appear.
- **Several servers**: each dev server stops its own rebuilds when it closes, so a server restarted with `server.restart()` (or the `r` shortcut), or a `build()` run with the same plugin instance, leaves the running server recompiling.

### Build

- **Output**: `vite build` emits the story as `outputFilename`, in the client environment only. An SSR build and other environments (`createBuilder().buildApp()`) get no story. Errors fail the build; warnings go through Vite's logger.
- **Inputs**: when the config names no input of its own, the plugin gives Vite a stand-in input, so the build needs no `index.html` and an `index.html` in the project root does not replace the story. An input of your own (`build.rolldownOptions.input` / `build.rollupOptions.input`, Vite 8's top-level `input`, `build.lib`) is built as usual, next to the story.
- **Name clashes**: the build fails, naming the file, when another input or plugin (another twee-ts instance, say) already writes a file named `outputFilename`, or a file the entry emits.
- **Several instances**: each plugin instance writes its own story, with its own entry. One instance can take part in builds that run at once, as each build hook reads its own environment's configuration.
- **Build watch**: `vite build --watch` builds the story again when a source, the head file, a module or a file the entry was bundled from changes, and when a file is added to or deleted from a source folder. A folder that holds a file `exclude` leaves out, or a build output, is not watched as a whole, so editing those starts no build; a file added straight to such a folder is read with the next build something else starts. The watcher of Vite 8.0 and 8.1 reports no change inside a watched folder, so there a file added to a source folder is read with the next build too. An input reached through a link is watched by its real path and also where it was authored, so pointing a source, module or head file link (or a link above a source folder) at another target starts a build, and edits to the new target follow. On macOS the bundler's watcher (rolldown's `rolldown-notify`) registers a link by the real path of its target and drops an event at the link's own path, so replacing a link raises no event there, and a retargeted link is read with the next build something else starts. Only a registered folder reports the replacement, and it reports what the build writes there too, so the plugin cannot register the folder that holds both the link and the build output.
- **Output inside `sources`**: nothing a build writes is read as a source, so the output can sit inside a source folder; a later build, the dev server and their watchers leave it out. That covers the story HTML of every output (`outputFilename` in `build.outDir`, or in each `output.dir`), the chunks and assets each bundle writes, and the copies of the `public/` files Vite puts in the output folder. Paths are compared by their real path, so a link to the output folder doesn't let it back in.

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

With `entry`, Vite bundles a JS or TS file and everything it imports into one self-contained script (no `import`/`export` left), which becomes the story's Story JavaScript. CSS the entry imports becomes the Story Stylesheet. The story format runs it like any story script, so macros and configuration are in place before the first passage renders. Requires Vite 8.

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

What goes into the story, and where:

- **Script and stylesheet**: the bundled script is the story's Story JavaScript and runs after any script passages from `sources`; the CSS it imports is the Story Stylesheet, after any stylesheet passages from `sources`.
- **Fonts and images** the entry or its CSS use are inlined as data URLs, whatever their size, so the story stays one file. An import marked `?no-inline` is emitted as a separate file: the build writes it next to the HTML and the dev server serves it at the same URL.
- **`import.meta.url`**: the entry runs as a classic script in the story page, so `import.meta.url` stands for the story page's URL (taken up one level for each folder of a nested `outputFilename`), and `new URL('./image.png', import.meta.url)` and Vite's worker URLs (`new Worker(new URL('./worker.js', import.meta.url))`) give valid URLs. A worker is a file the build writes next to the HTML (under `assets/`), found at the URL Vite gives it from `base`. With a relative `base` (`'./'`), Vite makes the URLs of such files, and of an asset marked `?no-inline`, relative to the script or stylesheet that names them, which the story holds inline; with a nested `outputFilename` the plugin makes them find the output folder instead (through `experimental.renderBuiltUrl`; one in your config decides first). The dev server serves the files of the bundle with the media types a browser needs (a worker as `text/javascript`).
- **Source maps**: in dev the script carries an inline source map. A build ships no map file; with `build.sourcemap: 'inline'` the map stays inside the story.
- **Keep the entry outside `sources`.** twee-ts loads the `.js` and `.css` files it finds in source folders, unbundled, as script and stylesheet passages; the plugin warns when the entry's folder is inside `sources`.

#### Your configuration in the entry's bundle

The entry is bundled with your whole Vite configuration, in dev as in a build, so it behaves the same in both:

- **What comes across**: the config file, evaluated again, with everything passed to `createServer()`/`build()` or on the command line (`vite --base /game/`) on top, as Vite merges them: plugins, `define`, `resolve` (aliases, conditions, extensions), `base`, `envPrefix`/`envDir`/`.env` files, `css` (modules and the rest), `assetsInclude`, the `build` settings and every other key, except these, which configure servers, logging or what is built: `configFile`, `plugins` (every twee-ts instance is left out of the entry build), `root`, `mode`, `logLevel`, `customLogger`, `clearScreen`, `publicDir`, `server`, `preview`, `builder` and `devtools`.
- **What the entry build sets itself**: the entry is its only input, bundled into one IIFE script (`build.lib`, `build.ssr`, the bundler's `input` and the output's `format` and file names are replaced) and held in memory (nothing is written, `build.watch` is off). Your bundler `output` options apply to the entry when they are one object; an array of outputs describes your own files, and none of it applies.
- **The command**: in dev the configuration is evaluated for the dev command, as the dev server evaluates it: a config function sees `command: 'serve'`, `apply: 'serve'` plugins run and `apply: 'build'` ones don't, and plugins' `config`, `configEnvironment` and `configResolved` hooks see `command: 'serve'`. In a build they see `build`. Vite's own build plugins bundle the entry in both. The mode is the server's or build's (`import.meta.env.MODE`, `DEV`).
- **Quiet**: the entry build prints no progress lines; its warnings go to the server's or build's logger, and a failed bundle is reported once, in the overlay or as the build's error.
- **Where it is bundled**: in a build, when the config names no input of its own, the entry is bundled inside the build itself. Otherwise, and always in dev, with a build of its own; plugin objects passed inline are then shared with that build.

Once a bundle has succeeded, a change to a file it was built from bundles it again: its modules (also one the bundler inlined, also outside the Vite root, as a shared package of a monorepo or a workspace link is) and the files its plugins watch (CSS `@import`s, `url()` targets, a plugin's `addWatchFile`), matched by file identity: a path through a link, and on a case-insensitive volume one in another letter case, names the same file. While it is failing, any change in the project does as well, so creating a missing import brings the story back.

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

<!-- docs-test: mirror from=@rohal12/twee-ts/rollup -->

```typescript
interface TweeTsRollupPluginOptions {
  /** Source directories/files to compile, relative to the working directory. */
  sources: string[];
  /** Story format ID. */
  format?: string;
  /** Output file name, relative to the output folder. Default: 'index.html'. */
  outputFilename?: string;
  /** Additional compile options. */
  compileOptions?: PluginCompileOptions;
}
```

The options are checked as the Vite plugin's are (see above); there is no `entry`.

### Errors and warnings

- **Errors fail the build.** When the compile reports an error (a missing starting passage, malformed Twee, a story format that can't be found), the plugin fails the build through Rollup's `this.error()` and emits no HTML. Rollup reports it as an error from the `twee-ts` plugin, with the file and line where the compiler knows them. The build also fails when the bundle already holds a file named `outputFilename`.
- **Warnings** (a duplicate passage, unreadable passage metadata) go through Rollup's `this.warn()`, so they reach `onwarn`/`onLog` and Rollup's warning output like any other plugin warning. The story is still emitted.
- **Watch mode**: under `rollup --watch`, a change to a source, the head file or a module builds the story again. The files are registered with Rollup's watcher as `sources` names them, also through a link: Rollup's watcher follows the link and reports a change by that name (Vite's watcher reports real paths, so the Vite plugin registers those). Paths in warnings and errors are relative to the working directory, as the CLI prints them. An edit to a file `exclude` leaves out starts no build; a folder holding such a file, or an output, is watched by what it holds, so a file added straight to it is read with the next build something else starts. A failed build is reported and the watcher keeps running, so fixing the story rebuilds it. On Linux and macOS a backslash in a file name is an ordinary character, and the plugins read such a file as it is named; Rollup's watcher reads every backslash as a separator, so it cannot watch that file, and the plugin warns that an edit to it starts no build (Vite's watcher has no such limit).
- **Output inside `sources`**: nothing Rollup writes is read as a source, so the output can sit inside a source folder. That covers the story HTML of every output (`outputFilename` in `output.dir`, or next to `output.file`), when a build writes several outputs too, and the chunks and assets each bundle writes, old hashed chunks from earlier builds of the same plugin instance included. An `output.dir` inside a source folder is left out whole. Paths are compared by their real path, so a link to the output folder doesn't let it back in. Under `rollup --watch`, `output.dir` may even be a source folder itself; writing the outputs starts no build. When `output.dir` is a source folder itself, a hashed chunk left there by an earlier process is not known to be output and is read on the first build; write into a subfolder to avoid that.

The same holds when the Rollup plugin runs inside a `vite build`.

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

Both plugins accept a `compileOptions` object (`PluginCompileOptions`, exported by both entry points) that is passed to the compiler. It takes any [CompileOptions](./api#compile-options) field but `sources` and `formatId`, which come from the plugin's `sources` and `format`:

```typescript
import type { PluginCompileOptions } from '@rohal12/twee-ts/vite';

const compileOptions: PluginCompileOptions = {
  exclude: ['src/story/**/*.png'],
  startPassage: 'Prologue',
  tagAliases: { library: 'script' },
  modules: ['src/analytics.js'],
  headFile: 'head.html',
  trim: true,
  twee2Compat: false,
  testMode: false,
  noRemote: false,
};
console.log(compileOptions);
```

`exclude` never applies to `headFile` and `modules`. Keep the head file outside the source folders: an `.html` file in a source folder is read as a Twine story to import. `outputMode` is accepted too, and the story is then written in that mode under `outputFilename`.

/**
 * Ready-made Vite plugin for twee-ts.
 *
 * Compiles Twee sources into the story HTML. With `entry`, Vite also bundles a
 * script, and the CSS it imports, into the story as its Story JavaScript and
 * Story Stylesheet.
 *
 * In dev the compiled HTML is served at the base URL with Vite's client added.
 * Every change to a source, the head file, a module or a file the entry imports
 * recompiles it and reloads the page, and errors appear in Vite's overlay.
 */
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { build, version as viteVersion } from 'vite';
import type { ErrorPayload, InlineConfig, Plugin, ResolvedConfig } from 'vite';
import type { CompileOptions, CompileResult, Diagnostic, FileCacheEntry, InlineSource } from '../types.js';
import { compileIncremental, TweeTsError } from '../compiler.js';
import { isInside, isViteConfigTemp, toPosix } from './paths.js';

export interface TweeTsVitePluginOptions {
  /** Source directories/files to compile, relative to the working directory. */
  sources: string[];
  /** Story format ID. */
  format?: string;
  /** Output filename in build output. Default: 'index.html'. */
  outputFilename?: string;
  /** Additional compile options. `sources` and `formatId` come from the options above. */
  compileOptions?: Partial<CompileOptions>;
  /**
   * A JS or TS file, relative to the working directory. Vite bundles it and
   * everything it imports into one self-contained script that becomes the
   * story's Story JavaScript; CSS it imports becomes the Story Stylesheet.
   * Requires Vite 8.
   */
  entry?: string;
}

/** Passage names the bundled entry takes inside the story. */
const ENTRY_SCRIPT_NAME = 'twee-ts-entry.js';
const ENTRY_STYLE_NAME = 'twee-ts-entry.css';

/**
 * Set on the inline config of the build this plugin starts itself to bundle the
 * entry in dev. The plugin instance that build loads from the user's config file
 * sees it and stands aside.
 */
const INNER_BUILD_FLAG = '__tweeTsEntryBuild';

/** The bundled entry: its script, its stylesheet, and the files it was built from (forward-slash paths). */
interface EntryBundle {
  script: string;
  style: string;
  files: Set<string>;
}

/** The parts of a Vite output bundle this plugin reads. */
type BundleItem =
  | { type: 'chunk'; code: string; isEntry: boolean; moduleIds: readonly string[] }
  | { type: 'asset'; source: string | Uint8Array };

/** An error carrying the file and line Vite shows in its overlay. */
interface LocatedError extends Error {
  id?: string;
  loc?: { file: string; line: number; column: number };
}

function formatDiagnostic(d: Diagnostic): string {
  const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}: ` : '';
  return `${where}${d.message}`;
}

/** Returns the warnings; throws a LocatedError when the compile reported errors. */
function splitDiagnostics(result: CompileResult): Diagnostic[] {
  const errors = result.diagnostics.filter((d) => d.level === 'error');
  if (errors.length === 0) return result.diagnostics.filter((d) => d.level === 'warning');
  const error: LocatedError = new Error(errors.map(formatDiagnostic).join('\n'));
  const [first] = errors;
  if (first?.file) {
    error.id = first.file;
    error.loc = { file: first.file, line: first.line ?? 1, column: 1 };
  }
  throw error;
}

/** An error thrown by the compiler or bundler, with a TweeTsError's error diagnostics folded into its message. */
function fatalError(e: unknown): LocatedError {
  if (e instanceof TweeTsError) {
    const errors = e.diagnostics.filter((d) => d.level === 'error').map(formatDiagnostic);
    return new Error([...errors, e.message].join('\n'));
  }
  return e instanceof Error ? e : new Error(String(e));
}

function buildCompileOptions(options: TweeTsVitePluginOptions, entry: EntryBundle | undefined): CompileOptions {
  const inline: InlineSource[] = [];
  if (entry) {
    inline.push({ filename: ENTRY_SCRIPT_NAME, content: entry.script });
    if (entry.style !== '') inline.push({ filename: ENTRY_STYLE_NAME, content: entry.style });
  }
  return {
    ...options.compileOptions,
    sources: [...options.sources, ...inline],
    formatId: options.format ?? options.compileOptions?.formatId,
  };
}

/** Build settings that turn the entry into one IIFE script and one stylesheet. */
function entryBuildOptions(entryPath: string): NonNullable<InlineConfig['build']> {
  return {
    cssCodeSplit: false,
    rolldownOptions: {
      input: entryPath,
      output: { format: 'iife', entryFileNames: ENTRY_SCRIPT_NAME, assetFileNames: '[name][extname]' },
    },
  };
}

/** Removes the entry's script, stylesheet and script map from the bundle and returns them. */
function takeEntryFromBundle(bundle: Record<string, BundleItem>): EntryBundle {
  const entry: EntryBundle = { script: '', style: '', files: new Set() };
  const styles: string[] = [];
  for (const [fileName, item] of Object.entries(bundle)) {
    if (item.type === 'chunk') {
      if (item.isEntry) {
        entry.script = item.code;
        for (const id of item.moduleIds) if (!id.startsWith('\0')) entry.files.add(toPosix(id));
      }
      delete bundle[fileName];
    } else if (fileName.endsWith('.css')) {
      styles.push(typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source));
      delete bundle[fileName];
    } else if (fileName.endsWith('.js.map')) {
      delete bundle[fileName];
    }
  }
  entry.style = styles.join('\n');
  return entry;
}

/** Absolute forward-slash paths whose changes recompile the story: sources, head file, modules. */
function watchedInputs(options: TweeTsVitePluginOptions): string[] {
  const extra = options.compileOptions;
  return [...options.sources, ...(extra?.headFile ? [extra.headFile] : []), ...(extra?.modules ?? [])].map((p) =>
    toPosix(resolve(p)),
  );
}

/** Adds Vite's client to the page so reloads and the error overlay reach it. */
function injectViteClient(html: string, base: string): string {
  const tag = `<script type="module" src="${base}@vite/client"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return tag + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}

/** Served until the first successful compile, so the overlay has a page to appear on. */
function waitingPage(base: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<script type="module" src="${base}@vite/client"></script>` +
    '<title>twee-ts</title></head><body><p>The story has not compiled yet.</p></body></html>'
  );
}

function toOverlayError(e: unknown): ErrorPayload['err'] {
  const error = fatalError(e);
  return {
    // Bundler messages carry terminal colour codes; the overlay would show them raw.
    message: stripVTControlCharacters(error.message),
    stack: '',
    plugin: 'twee-ts',
    ...(error.id ? { id: error.id } : {}),
    ...(error.loc ? { loc: error.loc } : {}),
  };
}

/** Bundles the entry for dev with the user's own Vite config, unminified, with an inline source map. */
async function bundleEntryForDev(config: ResolvedConfig, entryPath: string): Promise<EntryBundle> {
  const inline: InlineConfig & Record<string, unknown> = {
    configFile: config.configFile ?? false,
    root: config.root,
    mode: config.mode,
    logLevel: 'error',
    publicDir: false,
    build: {
      ...entryBuildOptions(entryPath),
      write: false,
      minify: false,
      sourcemap: 'inline',
      emptyOutDir: false,
      copyPublicDir: false,
      watch: null,
    },
    [INNER_BUILD_FLAG]: true,
  };
  const out = await build(inline);
  const bundle: Record<string, BundleItem> = {};
  for (const result of Array.isArray(out) ? out : [out]) {
    if (!('output' in result)) throw new Error('twee-ts: the entry build returned a watcher instead of a bundle.');
    for (const item of result.output) bundle[item.fileName] = item;
  }
  return takeEntryFromBundle(bundle);
}

export function tweeTsPlugin(options: TweeTsVitePluginOptions): Plugin {
  const outputFilename = options.outputFilename ?? 'index.html';
  const cache = new Map<string, FileCacheEntry>();
  let innerBuild = false;

  if (options.entry && Number.parseInt(viteVersion, 10) < 8) {
    throw new Error(`twee-ts: the entry option needs Vite 8 or newer (found ${viteVersion}).`);
  }

  return {
    name: 'twee-ts',

    config(userConfig, env) {
      innerBuild = (userConfig as Record<string, unknown>)[INNER_BUILD_FLAG] === true;
      if (innerBuild || !options.entry || env.command !== 'build') return undefined;
      return { build: entryBuildOptions(resolve(options.entry)) };
    },

    generateBundle: {
      order: 'post',
      async handler(_outputOptions, bundle) {
        if (innerBuild) return;
        const entry = options.entry ? takeEntryFromBundle(bundle) : undefined;
        let result: CompileResult;
        try {
          result = await compileIncremental(buildCompileOptions(options, entry), cache);
        } catch (e) {
          return this.error(fatalError(e));
        }
        let warnings: Diagnostic[];
        try {
          warnings = splitDiagnostics(result);
        } catch (e) {
          return this.error(e as LocatedError);
        }
        for (const w of warnings) this.warn(formatDiagnostic(w));
        this.emitFile({ type: 'asset', fileName: outputFilename, source: result.output });
      },
    },

    async configureServer(server) {
      if (innerBuild) return;
      const base = server.config.base;
      const servePaths = outputFilename === 'index.html' ? [base, `${base}index.html`] : [`${base}${outputFilename}`];
      const inputs = watchedInputs(options);
      const entryPath = options.entry ? resolve(options.entry) : undefined;
      const root = toPosix(server.config.root);
      server.watcher.add(inputs);

      let html = '';
      let lastError: ErrorPayload['err'] | undefined;
      let entry: EntryBundle | undefined; // last good bundle
      let entryStale = true; // bundle again on the next rebuild
      let queue: Promise<void> = Promise.resolve();
      let pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;

      // The files that belong to the entry: after a good bundle, exactly the modules
      // it was built from; while there is none, or the last one failed, anything in
      // the project, so that creating a missing import brings it back.
      const touchesEntry = (file: string): boolean =>
        entryPath !== undefined && (entryStale ? isInside(file, [root]) : (entry?.files.has(file) ?? false));

      // `initial`: the compile at server start. No page is open yet, and Vite would
      // hold a full-reload for the first page that connects and reload it once.
      const rebuild = async (changed: ReadonlySet<string>, initial = false): Promise<void> => {
        try {
          if (entryPath && (entryStale || [...changed].some(touchesEntry))) {
            entryStale = true;
            entry = await bundleEntryForDev(server.config, entryPath);
            entryStale = false;
          }
          const result = await compileIncremental(buildCompileOptions(options, entry), cache);
          for (const w of splitDiagnostics(result)) server.config.logger.warn(`[twee-ts] ${formatDiagnostic(w)}`);
          html = injectViteClient(result.output, base);
          lastError = undefined;
          if (!initial) server.ws.send({ type: 'full-reload' });
        } catch (e) {
          lastError = toOverlayError(e);
          server.config.logger.error(`[twee-ts] ${lastError.message}`);
          server.ws.send({ type: 'error', err: lastError });
        }
      };

      await rebuild(new Set(), true);

      server.watcher.on('all', (event, file) => {
        if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
        const changed = toPosix(resolve(file));
        // Loading the config for the entry build writes and deletes one of these;
        // reacting to it would bundle again, and again.
        if (isViteConfigTemp(changed)) return;
        if (!isInside(changed, inputs) && !touchesEntry(changed)) return;
        pending.add(changed);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const files = pending;
          pending = new Set();
          queue = queue.then(() => rebuild(files));
        }, 50);
      });
      server.httpServer?.on('close', () => clearTimeout(timer));

      server.ws.on('connection', () => {
        if (lastError) server.ws.send({ type: 'error', err: lastError });
      });

      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (!servePaths.includes(path)) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html || waitingPage(base));
      });
    },
  };
}

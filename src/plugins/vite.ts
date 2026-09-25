/**
 * Ready-made Vite plugin for twee-ts.
 *
 * Compiles Twee sources into the story HTML. With `entry`, Vite also bundles a
 * script, and the CSS it imports, into the story as its Story JavaScript and
 * Story Stylesheet.
 */
import { resolve } from 'node:path';
import { version as viteVersion } from 'vite';
import type { InlineConfig, Plugin } from 'vite';
import type { CompileOptions, CompileResult, Diagnostic, FileCacheEntry, InlineSource } from '../types.js';
import { compileIncremental, TweeTsError } from '../compiler.js';

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

/** The bundled entry: its script, its stylesheet, and the files it was built from. */
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
        for (const id of item.moduleIds) entry.files.add(id);
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

    // Dev behaviour as in 1.14.0; Task 4 replaces these two hooks.
    async configureServer(server) {
      for (const source of options.sources) {
        server.watcher.add(source);
      }
      let compiledHtml = (await compileIncremental(buildCompileOptions(options, undefined), cache)).output;
      const servePath = outputFilename === 'index.html' ? '/' : `/${outputFilename}`;
      server.middlewares.use((req, res, next) => {
        if (req.url === servePath || (servePath === '/' && req.url === '/index.html')) {
          res.end(compiledHtml);
          return;
        }
        next();
      });
      server.watcher.on('change', (file) => {
        if (!file.endsWith('.tw') && !file.endsWith('.twee')) return;
        void compileIncremental(buildCompileOptions(options, undefined), cache).then((result) => {
          compiledHtml = result.output;
          server.ws.send({ type: 'full-reload' });
        });
      });
    },
  };
}

/**
 * twee-ts CLI entry point.
 * Uses node:util.parseArgs() for argument parsing.
 */
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { compileForOutputFile, watchWithWriteFilter } from '../src/compiler.js';
import { lintForOutputFile, formatLintReport } from '../src/lint.js';
import { discoverFormats, getFormatSearchDirs } from '../src/formats.js';
import { loadConfig, loadConfigFile, scaffoldConfig, CONFIG_FILENAME } from '../src/config.js';
import {
  discoverCachedFormats,
  getCacheDir,
  listCachedFormats,
  clearCachedFormats,
  getCacheSize,
} from '../src/remote-formats.js';
import type { CompileResult, Diagnostic, TweeTsConfig, OutputMode, WordCountMethod } from '../src/types.js';

import { VERSION } from '../src/version.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    format: { type: 'string', short: 'f' },
    start: { type: 'string', short: 's' },
    module: { type: 'string', short: 'm', multiple: true },
    head: { type: 'string' },
    'decompile-twee3': { type: 'boolean', short: 'd' },
    'decompile-twee1': { type: 'boolean' },
    'archive-twine2': { type: 'boolean', short: 'a' },
    'archive-twine1': { type: 'boolean' },
    'twee2-compat': { type: 'boolean' },
    'no-trim': { type: 'boolean' },
    lint: { type: 'boolean' },
    test: { type: 'boolean', short: 't' },
    watch: { type: 'boolean', short: 'w' },
    'log-stats': { type: 'boolean', short: 'l' },
    'log-files': { type: 'boolean' },
    'list-formats': { type: 'boolean' },
    json: { type: 'boolean' },
    init: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    // New flags
    'format-index': { type: 'string', multiple: true },
    'format-url': { type: 'string', multiple: true },
    'no-remote': { type: 'boolean' },
    'tag-alias': { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    'source-info': { type: 'boolean' },
    'word-count-method': { type: 'string' },
    config: { type: 'string', short: 'c' },
    'no-config': { type: 'boolean' },
  },
});

async function main(): Promise<void> {
  if (values.version) {
    console.log(`twee-ts v${VERSION}`);
    return;
  }

  if (values.help) {
    printUsage();
    return;
  }

  if (values['list-formats']) {
    listFormats();
    return;
  }

  if (values.init) {
    runInit();
    return;
  }

  if (positionals[0] === 'cache') {
    runCache(positionals.slice(1));
    return;
  }

  // Load config file (unless --no-config)
  let config: TweeTsConfig | null = null;
  if (!values['no-config']) {
    // Warnings, such as unknown keys, which leave the config usable.
    const configDiagnostics: Diagnostic[] = [];
    if (values.config) {
      config = loadConfigFile(values.config, configDiagnostics);
    } else {
      config = loadConfig(undefined, configDiagnostics);
    }
    logDiagnostics(configDiagnostics);
  }

  // Merge sources: positionals > config.sources
  const sources = positionals.length > 0 ? positionals : config?.sources;
  if (!sources || sources.length === 0) {
    console.error('Error: No input sources specified.');
    printUsage();
    process.exit(1);
  }

  // Determine output mode: CLI flag > config > default
  let outputMode: OutputMode = config?.outputMode ?? 'html';
  if (values['decompile-twee3']) outputMode = 'twee3';
  else if (values['decompile-twee1']) outputMode = 'twee1';
  else if (values['archive-twine2']) outputMode = 'twine2-archive';
  else if (values['archive-twine1']) outputMode = 'twine1-archive';
  else if (values.json) outputMode = 'json';

  // Parse --tag-alias flags (format: alias=target)
  let tagAliases: Record<string, string> | undefined;
  if (values['tag-alias'] || config?.tagAliases) {
    tagAliases = { ...config?.tagAliases };
    for (const pair of values['tag-alias'] ?? []) {
      const eq = pair.indexOf('=');
      if (eq < 1) {
        console.error(`Error: Invalid --tag-alias "${pair}". Expected format: alias=target`);
        process.exit(1);
      }
      tagAliases[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }

  // Word count method: CLI flag > config > default
  const VALID_WORD_COUNT_METHODS: WordCountMethod[] = ['tweego', 'whitespace'];
  const wordCountMethod: WordCountMethod | undefined = (() => {
    const raw = values['word-count-method'] ?? config?.wordCountMethod;
    if (raw === undefined) return undefined;
    if (!VALID_WORD_COUNT_METHODS.includes(raw as WordCountMethod)) {
      console.error(`Error: Invalid --word-count-method "${raw}". Expected: ${VALID_WORD_COUNT_METHODS.join(', ')}`);
      process.exit(1);
    }
    return raw as WordCountMethod;
  })();

  const outFile = values.output ?? config?.output ?? '-';
  // The output file, which every build (and lint) leaves out of the sources and modules,
  // so an earlier build inside a source folder is never read back as a source.
  const outPath = outFile === '-' ? undefined : outFile;

  // Lint mode: compile + inspect, no output
  if (values.lint) {
    const lintResult = await lintForOutputFile(
      {
        sources,
        exclude: values.exclude ?? config?.exclude,
        formatId: values.format ?? config?.formatId,
        startPassage: values.start ?? config?.startPassage,
        formatPaths: config?.formatPaths,
        modules: values.module ?? config?.modules,
        headFile: values.head ?? config?.headFile,
        trim: values['no-trim'] ? false : (config?.trim ?? true),
        twee2Compat: values['twee2-compat'] ?? config?.twee2Compat ?? false,
        testMode: values.test ?? config?.testMode ?? false,
        formatIndices: values['format-index'] ?? config?.formatIndices,
        formatUrls: values['format-url'] ?? config?.formatUrls,
        noRemote: values['no-remote'] ?? config?.noRemote ?? false,
        tagAliases,
        sourceInfo: values['source-info'] ?? config?.sourceInfo ?? false,
        wordCountMethod,
      },
      outPath,
    );
    console.log(formatLintReport(lintResult));
    const hasErrors = lintResult.brokenLinks.length > 0 || lintResult.diagnostics.some((d) => d.level === 'error');
    process.exit(hasErrors ? 1 : 0);
  }

  const compileOptions = {
    sources,
    exclude: values.exclude ?? config?.exclude,
    outputMode,
    formatId: values.format ?? config?.formatId,
    startPassage: values.start ?? config?.startPassage,
    formatPaths: config?.formatPaths,
    modules: values.module ?? config?.modules,
    headFile: values.head ?? config?.headFile,
    trim: values['no-trim'] ? false : (config?.trim ?? true),
    twee2Compat: values['twee2-compat'] ?? config?.twee2Compat ?? false,
    testMode: values.test ?? config?.testMode ?? false,
    useTweegoPath: config?.useTweegoPath,
    formatIndices: values['format-index'] ?? config?.formatIndices,
    formatUrls: values['format-url'] ?? config?.formatUrls,
    noRemote: values['no-remote'] ?? config?.noRemote ?? false,
    tagAliases,
    sourceInfo: values['source-info'] ?? config?.sourceInfo ?? false,
    wordCountMethod,
  };

  // The file list is left out when the story itself goes to stdout.
  const log: BuildLogOptions = {
    files: outPath !== undefined && (values['log-files'] ?? false),
    stats: values['log-stats'] ?? false,
  };

  if (values.watch) {
    if (outPath === undefined) {
      console.error('Error: Watch mode requires an output file (-o).');
      process.exit(1);
    }
    console.log('Watch mode started. Press CTRL+C to stop.');
    // As in a one-shot build, a build with errors is not written: the output file keeps
    // the last good build until a save fixes the errors.
    await watchWithWriteFilter(
      {
        ...compileOptions,
        outFile: outPath,
        onBuild(result) {
          console.log(`Built: ${result.stats.passages} passages, ${result.stats.words} words`);
          logDiagnostics(result.diagnostics);
          // A failed build must not stop the watcher: report it and wait for the next change.
          const errors = countErrors(result.diagnostics);
          if (errors > 0) {
            console.error(`Build has ${pluralize(errors, 'error')}; output not written. Still watching for changes.`);
          }
          logBuild(result, log);
        },
        onError(error) {
          console.error(`Build error: ${error.message}`);
        },
      },
      (result) => countErrors(result.diagnostics) === 0,
    );
  } else {
    const result = await compileForOutputFile(compileOptions, outPath);
    logDiagnostics(result.diagnostics);

    // Like Tweego, a build with errors produces no output: the output file (or stdout)
    // is left untouched and the exit status is 1, so scripts and CI can detect it.
    const errors = countErrors(result.diagnostics);
    if (errors > 0) {
      console.error(`Compilation failed with ${pluralize(errors, 'error')}; output not written.`);
      process.exitCode = 1;
    } else if (outPath === undefined) {
      process.stdout.write(result.output);
    } else {
      writeFileSync(outPath, result.output, 'utf-8');
    }

    logBuild(result, log);
  }
}

/** What --log-files and --log-stats print after a build, one-shot or in watch mode. */
interface BuildLogOptions {
  readonly files: boolean;
  readonly stats: boolean;
}

function logBuild(result: CompileResult, log: BuildLogOptions): void {
  if (log.files) console.log(`\nFiles: ${result.stats.files.join(', ')}`);
  if (log.stats) logStats(result);
}

function countErrors(diagnostics: readonly Diagnostic[]): number {
  return diagnostics.filter((d) => d.level === 'error').length;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function listFormats(): void {
  const dirs = getFormatSearchDirs();
  const formats = discoverFormats(dirs);

  console.log('Local story formats:');
  if (formats.size === 0) {
    console.log('  (none)');
  } else {
    for (const [id, f] of formats) {
      const type = f.isTwine2 ? 'Twine 2' : 'Twine 1';
      console.log(`  ${id}: ${f.name || id} ${f.version} (${type})`);
    }
  }

  const cached = discoverCachedFormats();
  if (cached.size > 0) {
    console.log('\nCached remote formats:');
    for (const [id, f] of cached) {
      console.log(`  ${id}: ${f.name} ${f.version}`);
    }
  }
}

function logDiagnostics(diagnostics: Array<{ level: string; message: string }>): void {
  for (const d of diagnostics) {
    if (d.level === 'error') console.error(`error: ${d.message}`);
    else console.warn(`warning: ${d.message}`);
  }
}

function logStats(result: {
  stats: { passages: number; storyPassages?: number; words: number; files: string[] };
}): void {
  const s = result.stats;
  console.log(`\nStatistics:`);
  console.log(`  Passages: ${s.passages}`);
  console.log(`  Words: ${s.words}`);
  console.log(`  Files: ${s.files.length}`);
}

interface ScaffoldFile {
  readonly path: string;
  readonly content: () => string;
}

const SCAFFOLD_FILES: readonly ScaffoldFile[] = [
  { path: CONFIG_FILENAME, content: scaffoldConfig },
  {
    path: 'src/StoryData.tw',
    content: () => `:: StoryData
{
\t"ifid": "${crypto.randomUUID().toUpperCase()}"
}
`,
  },
  {
    path: 'src/Start.tw',
    content: () => `:: Start
Welcome to your new Twine story!

This is the starting passage. Edit this file to begin writing your story.
`,
  },
];

/**
 * Writes `content` to `path` unless the file already exists.
 * The exclusive flag makes the check and the write one step, so an existing file is never truncated.
 * Returns false when the file was already there.
 */
function writeNewFile(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'EEXIST') return false;
    throw new Error(`Cannot create ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

function runInit(): void {
  console.log('Initializing new twee-ts project...');
  mkdirSync('src', { recursive: true });

  // Existing files are kept as they are: --init never overwrites a story, its IFID, or a config.
  const results = SCAFFOLD_FILES.map((file) => ({ path: file.path, created: writeNewFile(file.path, file.content()) }));
  const created = results.filter((r) => r.created).map((r) => r.path);
  const skipped = results.filter((r) => !r.created).map((r) => r.path);

  if (created.length > 0) {
    console.log('Created:');
    for (const path of created) console.log(`  ${path}`);
  }
  for (const path of skipped) console.log(`Skipped (already exists): ${path}`);
  console.log('\nRun: npx @rohal12/twee-ts');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}K`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}M`;
}

function runCache(args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case 'list': {
      const entries = listCachedFormats();
      if (entries.length === 0) {
        console.log('No cached formats.');
        return;
      }
      for (const e of entries) {
        const date = e.modifiedAt.toISOString().slice(0, 10);
        console.log(`${e.name.padEnd(16)} ${e.version.padEnd(10)} ${formatBytes(e.sizeBytes).padStart(6)}   ${date}`);
      }
      return;
    }
    case 'clear': {
      const name = args[1];
      const count = clearCachedFormats(name);
      if (count === 0) {
        console.log(name ? `No cached formats matching "${name}".` : 'Cache is already empty.');
      } else {
        console.log(`Cleared ${count} cached format${count === 1 ? '' : 's'}.`);
      }
      return;
    }
    case 'size': {
      const { totalBytes, count } = getCacheSize();
      if (count === 0) {
        console.log('Cache is empty.');
      } else {
        console.log(`Total: ${formatBytes(totalBytes)} (${count} format${count === 1 ? '' : 's'})`);
      }
      return;
    }
    case 'path': {
      console.log(getCacheDir());
      return;
    }
    default: {
      console.error(`Usage: twee-ts cache <list|clear|size|path>

  list          List cached formats with name, version, size
  clear         Delete all cached formats
  clear <name>  Delete cached formats matching name
  size          Show total cache size
  path          Print cache directory path`);
      process.exit(subcommand ? 1 : 0);
    }
  }
}

function printUsage(): void {
  console.log(`twee-ts v${VERSION} — TypeScript Twee-to-HTML compiler

Usage: twee-ts [options] <sources...>

Options:
  -o, --output <file>       Output file (default: stdout)
  -f, --format <id>         Story format ID (default: sugarcube-2)
  -s, --start <name>        Starting passage (default: Start)
  -m, --module <file>       Module file to inject into <head> (repeatable)
  --head <file>             Raw HTML file to append to <head>
  -d, --decompile-twee3     Output as Twee 3 source
  --decompile-twee1         Output as Twee 1 source
  -a, --archive-twine2      Output as Twine 2 archive
  --archive-twine1          Output as Twine 1 archive
  --json                    Output as JSON
  --twee2-compat            Enable Twee2 syntax compatibility
  --lint                    Lint story structure (broken links, dead ends, orphans)
  --no-trim                 Don't trim passage whitespace
  -t, --test                Enable test/debug mode
  -w, --watch               Watch for changes and rebuild
  -l, --log-stats           Log compilation statistics
  --log-files               Log input file list
  --list-formats            List available story formats
  --init                    Initialize a new project
  --format-index <url>      SFA-compatible format index URL (repeatable)
  --format-url <url>        Direct format.js URL (repeatable)
  --tag-alias <alias=target> Map a tag to a special tag (repeatable)
  --exclude <glob>          Leave out source files matching a glob (repeatable)
  --source-info             Emit source file/line as data- attributes on passages
  --word-count-method <m>   Word counting method: tweego (default), whitespace
  --no-remote               Disable remote format fetching
  -c, --config <file>       Config file path (default: ${CONFIG_FILENAME})
  --no-config               Skip config file loading
  -h, --help                Show this help
  -v, --version             Show version

Subcommands:
  cache list                List cached remote formats
  cache clear [name]        Clear cached formats (all or by name)
  cache size                Show total cache size
  cache path                Print cache directory path`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

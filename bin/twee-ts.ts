/**
 * twee-ts CLI entry point.
 *
 * The command line is parsed completely into a request first (src/cli-request.ts), then run. Standard
 * output carries only what was asked for: the story when it goes there, or the answer of a query command
 * (--help, --version, --list-formats, cache, --lint's report, --init's report). Diagnostics, logs, --log-stats
 * and --log-files go to standard error. Exit status: 0 success, 1 build or lint errors, 2 usage errors.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { compileForOutputFile, TweeTsError, watchWithWriteFilter } from '../src/compiler.js';
import type { ExtraInput } from '../src/compiler.js';
import { WatchPathError } from '../src/filesystem.js';
import { writeFileAtomic } from '../src/atomic-write.js';
import { lintForOutputFile, formatLintReport } from '../src/lint.js';
import { discoverAllFormats, getFormatSearchDirs, makeFormatId, pruneFormats } from '../src/formats.js';
import { loadConfig, loadConfigFile, scaffoldConfig, CONFIG_FILENAME } from '../src/config.js';
import {
  CACHE_USAGE,
  CliUsageError,
  looksLikeCharset,
  parseCliArgs,
  resolveBuild,
  usageText,
} from '../src/cli-request.js';
import type { BuildRequest, CacheAction, ConfigChoice, ResolvedBuild } from '../src/cli-request.js';
import { listRecords, loadEntry } from '../src/format-cache.js';
import {
  cachedUrlRecord,
  checkRemoteUrl,
  DEFAULT_SFA_INDICES,
  getCacheDir,
  listCachedFormats,
  clearCachedFormats,
  getCacheSize,
} from '../src/remote-formats.js';
import type { CompileResult, Diagnostic, TweeTsConfig, WatchOptions } from '../src/types.js';
import { compareVersions, parseVersion } from '../src/semver.js';

import { VERSION } from '../src/version.js';

/** Exit statuses. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

/** Writes to standard output: only the story, or a query command's answer. */
function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Writes a line to standard error: everything else. */
function log(text: string): void {
  process.stderr.write(`${text}\n`);
}

/**
 * A reader that goes away (`twee-ts … | head`) closes the pipe: the rest of the output is dropped
 * quietly, as other command-line tools do, instead of ending in an unhandled EPIPE error.
 */
function quietOnClosedPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED') return;
    throw e;
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return usageError(parsed.error);
  const { request } = parsed;
  switch (request.kind) {
    case 'help':
      out(usageText(VERSION, CONFIG_FILENAME));
      return EXIT_OK;
    case 'version':
      out(`twee-ts v${VERSION}`);
      return EXIT_OK;
    case 'init':
      runInit();
      return EXIT_OK;
    case 'cache-help':
      out(CACHE_USAGE);
      return EXIT_OK;
    case 'cache':
      runCache(request.action);
      return EXIT_OK;
    case 'cache-clear':
      runCacheClear(request.name);
      return EXIT_OK;
    case 'list-formats': {
      const config = readConfig(request.config);
      // Listed after the config is read, so the list shows what --format can select in this project.
      listFormats(config.config);
      return EXIT_OK;
    }
    case 'build':
      return runBuild(request);
    default: {
      const _exhaustive: never = request;
      throw new Error(`unhandled request: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function usageError(error: CliUsageError): number {
  log(`error: ${error.message}`);
  log('Run "twee-ts --help" for usage.');
  return EXIT_USAGE;
}

/** The config the request asks for, and its path (an input the output must not overwrite). */
function readConfig(choice: ConfigChoice): { readonly config: TweeTsConfig | null; readonly path?: string } {
  // Warnings, such as unknown keys, which leave the config usable.
  const diagnostics: Diagnostic[] = [];
  let result: { readonly config: TweeTsConfig | null; readonly path?: string };
  switch (choice.kind) {
    case 'none':
      return { config: null };
    case 'file':
      try {
        result = { config: loadConfigFile(choice.path, diagnostics), path: choice.path };
      } catch (e) {
        // Tweego's -c is --charset: say so when the "config file" is a charset name.
        if (e instanceof TweeTsError && e.code === 'INPUT_UNAVAILABLE' && looksLikeCharset(choice.path)) {
          const note = `-c is --config in twee-ts, not Tweego's --charset; twee-ts reads UTF-8 (or UTF-16 after a byte order mark) and falls back to Windows-1252.`;
          throw new TweeTsError(`${e.message}\nnote: ${note}`, e.diagnostics, { code: e.code, cause: e });
        }
        throw e;
      }
      break;
    case 'auto': {
      const config = loadConfig(undefined, diagnostics);
      result = config === null ? { config } : { config, path: CONFIG_FILENAME };
      break;
    }
    default: {
      const _exhaustive: never = choice;
      throw new Error(`unhandled config choice: ${JSON.stringify(_exhaustive)}`);
    }
  }
  logDiagnostics(diagnostics);
  return result;
}

async function runBuild(request: BuildRequest): Promise<number> {
  const config = readConfig(request.config);
  let build: ResolvedBuild;
  try {
    build = resolveBuild(request, config.config);
  } catch (e) {
    if (e instanceof CliUsageError) return usageError(e);
    throw e;
  }
  const compileOptions = { ...build.options, sources: build.sources };
  // The output file, which every build (and lint) leaves out of the sources and modules,
  // so an earlier build inside a source folder is never read back as a source.
  const outPath = build.output === '-' ? undefined : build.output;
  const extraInputs: ExtraInput[] = config.path === undefined ? [] : [{ role: 'config', path: config.path }];

  switch (build.action) {
    case 'lint': {
      const lintResult = await lintForOutputFile(compileOptions, outPath);
      out(formatLintReport(lintResult));
      const hasErrors = lintResult.brokenLinks.length > 0 || lintResult.diagnostics.some((d) => d.level === 'error');
      return hasErrors ? EXIT_FAILED : EXIT_OK;
    }
    case 'watch':
      // resolveBuild() refuses watch mode without an output file.
      return startWatch(compileOptions, outPath ?? build.output, request.log, extraInputs);
    case 'once': {
      const result = await compileForOutputFile(compileOptions, outPath, undefined, extraInputs);
      logDiagnostics(result.diagnostics);
      // Like Tweego, a build with errors produces no output: the output file (or stdout)
      // is left untouched and the exit status is 1, so scripts and CI can detect it.
      const errors = countErrors(result.diagnostics);
      let status = EXIT_OK;
      if (errors > 0) {
        log(`Compilation failed with ${pluralize(errors, 'error')}; output not written.`);
        status = EXIT_FAILED;
      } else if (outPath === undefined) {
        process.stdout.write(result.output);
      } else {
        writeFileAtomic(outPath, result.output);
      }
      logBuild(result, request.log);
      return status;
    }
    default: {
      const _exhaustive: never = build.action;
      throw new Error(`unhandled build action: ${String(_exhaustive)}`);
    }
  }
}

/** Starts watch mode; the process keeps running until it is stopped, or the watch stops on its own. */
function startWatch(
  options: Omit<WatchOptions, 'outFile'>,
  outFile: string,
  logOptions: BuildRequest['log'],
  extraInputs: readonly ExtraInput[],
): number {
  log('Watch mode started. Press CTRL+C to stop.');
  // As in a one-shot build, a build with errors is not written: the output file keeps
  // the last good build until a save fixes the errors.
  watchWithWriteFilter(
    {
      ...options,
      outFile,
      onBuild(result) {
        log(`Built: ${result.stats.passages} passages, ${result.stats.words} words`);
        logDiagnostics(result.diagnostics);
        // A failed build must not stop the watcher: report it and wait for the next change.
        const errors = countErrors(result.diagnostics);
        if (errors > 0) {
          log(`Build has ${pluralize(errors, 'error')}; output not written. Still watching for changes.`);
        }
        logBuild(result, logOptions);
      },
      onError(error) {
        process.exitCode = EXIT_FAILED;
        if (error instanceof WatchPathError) {
          // The other paths are still watched; with nothing left to watch, the process exits with status 1.
          log(`error: ${error.message}`);
        } else {
          logErrorDiagnostics(error);
          log(`Build error: ${error.message}`);
        }
      },
    },
    (result) => countErrors(result.diagnostics) === 0,
    { extraInputs },
  );
  // Until the watch ends; the status is set by onError if it fails.
  return EXIT_OK;
}

function logBuild(result: CompileResult, logOptions: BuildRequest['log']): void {
  if (logOptions.files) {
    log(`\nFiles: ${result.stats.files.join(', ')}`);
    const external = result.stats.externalFiles ?? [];
    if (external.length > 0) log(`External files: ${external.join(', ')}`);
  }
  if (logOptions.stats) logStats(result);
}

function countErrors(diagnostics: readonly Diagnostic[]): number {
  return diagnostics.filter((d) => d.level === 'error').length;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Order version strings from highest to lowest SemVer precedence (unparseable ones last). */
function byVersionDescending(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return Number(!left) - Number(!right);
  return compareVersions(right, left);
}

/**
 * The cached downloads a build with these settings would consider, as resolution considers them (see
 * format-resolution.ts): the cached copy of each configured format URL, and what was downloaded from each
 * configured format index and from the Story Formats Archive, each under the name and version its source
 * lists. A download from a URL or index the project doesn't configure is never used, so it isn't listed;
 * neither is an entry whose files are damaged. `cache list` lists every download.
 */
function consideredDownloads(
  formatUrls: readonly string[],
  formatIndices: readonly string[],
  diagnostics: Diagnostic[],
): { readonly name: string; readonly version: string }[] {
  const checked = (urls: readonly string[], option: string): string[] =>
    urls.flatMap((text) => {
      const result = checkRemoteUrl(text);
      if (result.ok) return [result.url];
      diagnostics.push({ level: 'warning', message: `${option}: ${result.reason}` });
      return [];
    });
  const indices = new Set([...checked(formatIndices, 'formatIndices'), ...DEFAULT_SFA_INDICES]);
  const fromUrls = checked(formatUrls, 'formatUrls').flatMap((url) => cachedUrlRecord(url) ?? []);
  const fromIndices = listRecords().filter((r) => r.origin.kind === 'index' && indices.has(r.origin.index));
  return [...fromUrls, ...fromIndices]
    .filter((record) => 'record' in loadEntry(record))
    .map((record) => (record.origin.kind === 'index' ? record.origin : record));
}

/**
 * Print the formats --format can select: local folders (pruned by SemVer), and the cached downloads a
 * build would consider (see consideredDownloads), by ID.
 */
function listFormats(config: TweeTsConfig | null): void {
  const diagnostics: Diagnostic[] = [];
  const searchDirs = getFormatSearchDirs(config?.formatPaths ?? [], config?.useTweegoPath ?? true);
  const formats = pruneFormats(discoverAllFormats(searchDirs, diagnostics));
  const downloads = consideredDownloads(config?.formatUrls ?? [], config?.formatIndices ?? [], diagnostics);
  logDiagnostics(diagnostics);

  out('Local story formats:');
  if (formats.size === 0) {
    out('  (none)');
  } else {
    for (const [id, f] of formats) {
      const type = f.isTwine2 ? 'Twine 2' : 'Twine 1';
      out(`  ${id}: ${f.name || id} ${f.version} (${type})`);
    }
  }

  // Cached downloads answer an ID request by name and major version, taking the greatest version.
  const cachedById = new Map<string, { readonly name: string; readonly version: string }[]>();
  for (const f of downloads) {
    const id = makeFormatId(f.name, f.version);
    cachedById.set(id, [...(cachedById.get(id) ?? []), f]);
  }
  if (cachedById.size > 0) {
    out('\nCached remote formats:');
    for (const [id, versions] of [...cachedById].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const [newest, ...older] = [...versions].sort((a, b) => byVersionDescending(a.version, b.version));
      if (!newest) continue;
      const also = older.length > 0 ? ` (also cached: ${older.map((f) => f.version).join(', ')})` : '';
      out(`  ${id}: ${newest.name} ${newest.version}${also}`);
    }
  }
}

function logDiagnostics(diagnostics: readonly { readonly level: string; readonly message: string }[]): void {
  for (const d of diagnostics) {
    if (d.level === 'error') log(`error: ${d.message}`);
    else log(`warning: ${d.message}`);
  }
}

/** Prints what a fatal TweeTsError collected (such as why no story format was found) before its message. */
function logErrorDiagnostics(error: unknown): void {
  if (error instanceof TweeTsError) logDiagnostics(error.diagnostics);
}

function logStats(result: CompileResult): void {
  const s = result.stats;
  log(`\nStatistics:`);
  log(`  Passages: ${s.passages}`);
  log(`  Words: ${s.words}`);
  log(`  Files: ${s.files.length}`);
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
  out('Initializing new twee-ts project...');
  mkdirSync('src', { recursive: true });

  // Existing files are kept as they are: --init never overwrites a story, its IFID, or a config.
  const results = SCAFFOLD_FILES.map((file) => ({ path: file.path, created: writeNewFile(file.path, file.content()) }));
  const created = results.filter((r) => r.created).map((r) => r.path);
  const skipped = results.filter((r) => !r.created).map((r) => r.path);

  if (created.length > 0) {
    out('Created:');
    for (const path of created) out(`  ${path}`);
  }
  for (const path of skipped) out(`Skipped (already exists): ${path}`);
  out('\nRun: npx @rohal12/twee-ts');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}K`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}M`;
}

function runCache(action: CacheAction): void {
  switch (action) {
    case 'list': {
      const entries = listCachedFormats();
      if (entries.length === 0) {
        out('No cached formats.');
        return;
      }
      for (const e of entries) {
        const date = e.modifiedAt.toISOString().slice(0, 10);
        out(`${e.name.padEnd(16)} ${e.version.padEnd(10)} ${formatBytes(e.sizeBytes).padStart(6)}   ${date}`);
      }
      return;
    }
    case 'size': {
      const { totalBytes, count } = getCacheSize();
      out(
        count === 0
          ? 'Cache is empty.'
          : `Total: ${formatBytes(totalBytes)} (${count} format${count === 1 ? '' : 's'})`,
      );
      return;
    }
    case 'path':
      out(getCacheDir());
      return;
    default: {
      const _exhaustive: never = action;
      throw new Error(`unhandled cache action: ${String(_exhaustive)}`);
    }
  }
}

function runCacheClear(name: string | undefined): void {
  const count = clearCachedFormats(name);
  if (count === 0) {
    out(name ? `No cached formats matching "${name}".` : 'Cache is already empty.');
  } else {
    out(`Cleared ${count} cached format${count === 1 ? '' : 's'}.`);
  }
}

quietOnClosedPipe(process.stdout);
quietOnClosedPipe(process.stderr);

main(process.argv.slice(2)).then(
  (status) => {
    // process.exitCode, not process.exit(): output still being written to a pipe is not cut off.
    if (process.exitCode === undefined || status !== EXIT_OK) process.exitCode = status;
  },
  (err: unknown) => {
    logErrorDiagnostics(err);
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = EXIT_FAILED;
  },
);

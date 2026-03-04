/**
 * twee-ts CLI entry point.
 * Uses node:util.parseArgs() for argument parsing.
 */
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileToFile, watch } from '../src/compiler.js';
import { discoverFormats, getFormatSearchDirs } from '../src/formats.js';
import { loadConfig, loadConfigFile, scaffoldConfig, CONFIG_FILENAME } from '../src/config.js';
import { discoverCachedFormats } from '../src/remote-formats.js';
import type { TweeTsConfig } from '../src/types.js';

const VERSION = '0.1.0';

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

  // Load config file (unless --no-config)
  let config: TweeTsConfig | null = null;
  if (!values['no-config']) {
    if (values.config) {
      config = loadConfigFile(values.config);
    } else {
      config = loadConfig();
    }
  }

  // Merge sources: positionals > config.sources
  const sources = positionals.length > 0 ? positionals : config?.sources;
  if (!sources || sources.length === 0) {
    console.error('Error: No input sources specified.');
    printUsage();
    process.exit(1);
  }

  // Determine output mode: CLI flag > config > default
  type OutputModeType = 'html' | 'twee3' | 'twee1' | 'twine2-archive' | 'twine1-archive' | 'json';
  let outputMode: OutputModeType = (config?.outputMode as OutputModeType | undefined) ?? 'html';
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

  const compileOptions = {
    sources,
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
  };

  const outFile = values.output ?? config?.output ?? '-';

  if (values.watch) {
    if (outFile === '-') {
      console.error('Error: Watch mode requires an output file (-o).');
      process.exit(1);
    }
    console.log('Watch mode started. Press CTRL+C to stop.');
    await watch({
      ...compileOptions,
      outFile,
      onBuild(result) {
        console.log(`Built: ${result.stats.passages} passages, ${result.stats.words} words`);
        logDiagnostics(result.diagnostics);
      },
      onError(error) {
        console.error(`Build error: ${error.message}`);
      },
    });
  } else {
    if (outFile === '-') {
      const result = await compile(compileOptions);
      process.stdout.write(result.output);
      logDiagnostics(result.diagnostics);
      if (values['log-stats']) logStats(result);
    } else {
      const result = await compileToFile({ ...compileOptions, outFile });
      logDiagnostics(result.diagnostics);
      if (values['log-files']) {
        console.log(`\nFiles: ${result.stats.files.join(', ')}`);
      }
      if (values['log-stats']) logStats(result);
    }
  }
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

function runInit(): void {
  console.log('Initializing new twee-ts project...');
  mkdirSync('src', { recursive: true });

  writeFileSync(
    join('src', 'StoryData.tw'),
    `:: StoryData
{
\t"ifid": "${crypto.randomUUID().toUpperCase()}"
}
`,
  );

  writeFileSync(
    join('src', 'Start.tw'),
    `:: Start
Welcome to your new Twine story!

This is the starting passage. Edit this file to begin writing your story.
`,
  );

  // Scaffold config file if it doesn't exist
  if (!existsSync(CONFIG_FILENAME)) {
    writeFileSync(CONFIG_FILENAME, scaffoldConfig());
    console.log(`Created: ${CONFIG_FILENAME}`);
  }

  console.log('Created:');
  console.log('  src/StoryData.tw');
  console.log('  src/Start.tw');
  console.log('\nRun: npx @rohal12/twee-ts');
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
  --no-remote               Disable remote format fetching
  -c, --config <file>       Config file path (default: ${CONFIG_FILENAME})
  --no-config               Skip config file loading
  -h, --help                Show this help
  -v, --version             Show version`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

/**
 * Code duplication check: measures the shipped code (src/ and bin/) with one
 * or more tools and fails when duplication exceeds the budget or, given a
 * base ref, grows relative to it.
 *
 *   pnpm run duplication                                  # all three tools
 *   pnpm run duplication fallow --base origin/main        # one tool, against main
 *
 * The tools see different things, so CI runs all three:
 * - jscpd: exact copies (identical token streams).
 * - PMD CPD: exact copies, grouping repeats of the same code into one clone
 *   with every occurrence. Needs Java and PMD: set PMD_BIN to PMD's `bin/pmd`,
 *   or put `pmd` on PATH.
 * - fallow (semantic mode): copies with renamed identifiers and changed
 *   literals; it misses some exact copies the other two find.
 *
 * jscpd and fallow read their settings from .jscpd.json and .fallowrc.json;
 * CPD takes jscpd's paths and minimum token count. A base ref is measured from
 * a temporary git worktree with this tree's settings, so a settings change
 * never shows up as a change in duplication. The budget is in
 * duplication-budget.json. In GitHub Actions the result is also written to the
 * job summary.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifySources,
  countLines,
  failures,
  parseArguments,
  parseBudget,
  parseCpdReport,
  parseFallowReport,
  parseJscpdReport,
  parseScanSettings,
  percentage,
  renderSummary,
} from './duplication-core.js';
import type { Arguments, BaseMeasurement, Measurement, ScanSettings, Tool } from './duplication-core.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'node_modules', '.bin');
const JSCPD_CONFIG = join(ROOT, '.jscpd.json');
const FALLOW_CONFIG = join(ROOT, '.fallowrc.json');
const BUDGET = join(ROOT, 'duplication-budget.json');
/** Reports of a few hundred clones with their code run to megabytes. */
const MAX_BUFFER = 256 * 1024 * 1024;

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`cannot read ${path}`, { cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${path} is not valid JSON`, { cause });
  }
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `command`; throws, naming `what`, only when it can't be started. */
function spawn(command: string, args: readonly string[], cwd: string, what: string): Run {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (result.error)
    throw new Error(`${what} could not run in ${cwd}: ${result.error.message}`, { cause: result.error });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `command` and returns its output; throws with its error output when it exits non-zero. */
function run(command: string, args: readonly string[], cwd: string, what: string): string {
  const result = spawn(command, args, cwd, what);
  if (result.status !== 0) {
    throw new Error(`${what} failed in ${cwd} (exit ${result.status ?? 'by signal'}):\n${result.stderr.trimEnd()}`);
  }
  return result.stdout;
}

/**
 * The files the tools scan in `tree`: tracked and untracked, without ignored
 * ones, as jscpd (`gitignore: true`) and fallow see them.
 */
function listSources(tree: string, settings: ScanSettings): readonly string[] {
  const output = run(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...settings.paths],
    tree,
    'listing the source files',
  );
  // A file deleted but not yet staged is still listed as tracked
  const files = [...new Set(output.split('\0').filter((f) => f !== '' && existsSync(join(tree, f))))].sort();
  const { typescript, unsupported } = classifySources(files);
  if (unsupported.length > 0) {
    throw new Error(
      `PMD CPD reads only .ts files, so these would be measured unevenly: ${unsupported.join(', ')}. ` +
        'Extend scripts/duplication.ts before adding such files.',
    );
  }
  if (typescript.length === 0) throw new Error(`no TypeScript files under ${settings.paths.join(', ')} in ${tree}`);
  return typescript;
}

function measureJscpd(tree: string, settings: ScanSettings): Measurement {
  listSources(tree, settings);
  const out = mkdtempSync(join(tmpdir(), 'jscpd-'));
  try {
    run(
      join(BIN, 'jscpd'),
      [
        // The config's paths resolve against the config file, not the tree
        ...settings.paths.map((p) => join(tree, p)),
        '--config',
        JSCPD_CONFIG,
        '--reporters',
        'json',
        '--output',
        out,
        '--silent',
      ],
      tree,
      'jscpd',
    );
    return parseJscpdReport(readJson(join(out, 'jscpd-report.json')), tree);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function measureCpd(tree: string, settings: ScanSettings): Measurement {
  const sources = listSources(tree, settings).map((f) => join(tree, f));
  const pmd = process.env['PMD_BIN'] ?? 'pmd';
  const stage = mkdtempSync(join(tmpdir(), 'cpd-'));
  try {
    const fileList = join(stage, 'files.txt');
    writeFileSync(fileList, `${sources.join('\n')}\n`);
    const xml = run(
      pmd,
      [
        'cpd',
        '--minimum-tokens',
        String(settings.minTokens),
        '--language',
        'typescript',
        '--format',
        'xml',
        // Exit 4 only says that clones exist; a lexical error still exits 5
        '--no-fail-on-violation',
        '--file-list',
        fileList,
      ],
      tree,
      `PMD CPD (${pmd}; set PMD_BIN to PMD's bin/pmd)`,
    );
    const report = parseCpdReport(xml, tree);
    const analyzed = new Set(report.analyzedFiles.map((f) => resolve(tree, f)));
    const skipped = sources.filter((f) => !analyzed.has(f));
    if (skipped.length > 0) throw new Error(`PMD CPD skipped ${skipped.length} files: ${skipped.join(', ')}`);
    const totalLines = sources.reduce((sum, f) => sum + countLines(readFileSync(f, 'utf8')), 0);
    return {
      percentage: percentage(report.duplicatedLines, totalLines),
      duplicatedLines: report.duplicatedLines,
      totalLines,
      clones: report.clones,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function measureFallow(tree: string, settings: ScanSettings): Measurement {
  listSources(tree, settings);
  // fallow may exit non-zero when it finds clones; the report is complete either way
  const result = spawn(
    join(BIN, 'fallow'),
    ['dupes', '--root', tree, '--config', FALLOW_CONFIG, '--format', 'json', '--quiet', '--no-fragments'],
    tree,
    'fallow',
  );
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(`fallow (exit ${result.status ?? 'by signal'}) wrote no JSON report:\n${result.stderr.trimEnd()}`, {
      cause,
    });
  }
  return parseFallowReport(report, tree);
}

function measure(tool: Tool, tree: string, settings: ScanSettings): Measurement {
  switch (tool) {
    case 'jscpd':
      return measureJscpd(tree, settings);
    case 'cpd':
      return measureCpd(tree, settings);
    case 'fallow':
      return measureFallow(tree, settings);
    default: {
      const exhaustive: never = tool;
      throw new Error(`unhandled tool: ${String(exhaustive)}`);
    }
  }
}

/** Checks out `ref` into a temporary worktree and measures it there. */
function measureRef(tool: Tool, ref: string, settings: ScanSettings): Measurement {
  const parent = mkdtempSync(join(tmpdir(), 'duplication-base-'));
  const tree = join(parent, 'tree');
  try {
    run('git', ['worktree', 'add', '--detach', tree, ref], ROOT, `checking out the base ref ${ref}`);
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
  try {
    return measure(tool, tree, settings);
  } finally {
    run('git', ['worktree', 'remove', '--force', tree], ROOT, 'removing the base worktree');
    rmSync(parent, { recursive: true, force: true });
  }
}

/** Measures `tool`, prints its summary and returns whether it passed. */
function check(tool: Tool, baseRef: string | undefined): boolean {
  const settings = parseScanSettings(readJson(JSCPD_CONFIG));
  const max = parseBudget(readJson(BUDGET)).maxPercentage[tool];
  const head = measure(tool, ROOT, settings);
  const base: BaseMeasurement | undefined =
    baseRef === undefined ? undefined : { ref: baseRef, measurement: measureRef(tool, baseRef, settings) };
  const failed = failures(max, head, base);
  const summary = renderSummary(tool, max, head, base, failed);
  console.log(summary);
  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary) appendFileSync(stepSummary, `${summary}\n`);
  for (const f of failed) console.log(`::error title=Duplication (${tool})::${f}`);
  return failed.length === 0;
}

function main(): number {
  let args: Arguments;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let passed = true;
  for (const tool of args.tools) {
    try {
      if (!check(tool, args.base)) passed = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Workflow commands escape line breaks this way
      const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
      console.log(`::error title=Duplication (${tool})::could not measure: ${escaped}`);
      console.error(error);
      passed = false;
    }
  }
  return passed ? 0 : 1;
}

process.exitCode = main();

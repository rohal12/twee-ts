/**
 * Lint mode: compile + inspect story structure without producing output.
 * Surfaces broken links, dead ends, orphans, and compilation diagnostics.
 */
import type { CompileOptions, CompileStats, Diagnostic } from './types.js';
import type { BrokenLink } from './inspect.js';
import { compileForOutputFile } from './compiler.js';
import { formatDiagnostic } from './diagnostic-text.js';
import { storyInspect } from './inspect.js';
import { describeOmission } from './passage-omission.js';
import { startPassageDiagnostics, storyTitleDiagnostics } from './start-passage.js';

export interface LintResult {
  /** Compilation diagnostics (errors and warnings). */
  readonly diagnostics: readonly Diagnostic[];
  /** Compilation statistics. */
  readonly stats: CompileStats;
  /** Story format name from StoryData (e.g. "SugarCube"). */
  readonly formatName: string;
  /** Story format version from StoryData (e.g. "2.37.3"). */
  readonly formatVersion: string;
  /** The configured start passage name. */
  readonly start: string;
  /** Total passage count. */
  readonly passages: number;
  /** Story passage count (excludes StoryData, StoryTitle, scripts, etc.). */
  readonly storyPassages: number;
  /** Info/special passage count. */
  readonly infoPassages: number;
  /**
   * Broken links: link targets that don't exist as passages, or that Twine 2 output leaves out
   * (script, stylesheet and `Twine.private` passages, StoryData, StoryTitle, an empty
   * StorySettings); for those, `omission` says why.
   */
  readonly brokenLinks: readonly BrokenLink[];
  /** Story passages with no outgoing links. */
  readonly deadEnds: readonly string[];
  /**
   * Story passages the player cannot reach: no chain of links leads to them from the start passage or from
   * an info passage (see `StoryMap.orphans`).
   */
  readonly orphans: readonly string[];
}

/**
 * Lint a story: compile without output rendering, then inspect structure.
 * Uses JSON output mode internally to avoid format resolution, so it checks
 * the starting passage itself, against the Twine 2 passage rules. Link
 * destinations are checked against the same rules: a link to a passage that
 * Twine 2 output leaves out is broken, and a passage it leaves out (other than
 * a script passage) gives no links.
 */
export async function lint(options: Omit<CompileOptions, 'outputMode'>): Promise<LintResult> {
  return lintForOutputFile(options, undefined);
}

/**
 * lint() for a project whose builds are written to `outFile`: like a build for that file,
 * it leaves `outFile` out of the sources and modules, so an earlier build inside a source
 * folder is not linted as a source.
 *
 * Internal, for the CLI; not part of the public API.
 */
export async function lintForOutputFile(
  options: Omit<CompileOptions, 'outputMode'>,
  outFile: string | undefined,
): Promise<LintResult> {
  const result = await compileForOutputFile({ ...options, outputMode: 'json' }, outFile);
  const map = storyInspect(result.story, { target: 'twine2' });

  return {
    diagnostics: [
      ...result.diagnostics,
      ...startPassageDiagnostics(result.story, map.start, 'twine2'),
      ...storyTitleDiagnostics(result.story, 'twine2'),
    ],
    stats: result.stats,
    formatName: result.story.twine2.format,
    formatVersion: result.story.twine2.formatVersion,
    start: map.start,
    passages: map.passages.length,
    storyPassages: map.storyPassages.length,
    infoPassages: map.infoPassages.length,
    brokenLinks: map.brokenLinks,
    deadEnds: map.deadEnds,
    orphans: map.orphans,
  };
}

/** `n` and a noun, plural unless `n` is 1: `1 file`, `2 files`, `1,234 words`. */
function counted(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Format a lint result as a human-readable report string.
 */
export function formatLintReport(result: LintResult): string {
  const lines: string[] = [];

  // Header: format and stats
  const formatStr = result.formatName
    ? `${result.formatName}${result.formatVersion ? ' ' + result.formatVersion : ''}`
    : 'unknown';
  lines.push(`Format: ${formatStr}`);
  lines.push(
    `Passages: ${result.passages} total (${result.storyPassages} story, ${result.infoPassages} info), ${counted(result.stats.words, 'word')}, ${counted(result.stats.files.length, 'file')}`,
  );
  lines.push(`Start: ${result.start}`);

  // Broken links (errors)
  if (result.brokenLinks.length > 0) {
    lines.push('');
    lines.push(`Broken links (${result.brokenLinks.length}):`);
    for (const link of result.brokenLinks) {
      const why =
        link.omission === undefined
          ? 'does not exist'
          : `${describeOmission(link.omission)}, so it is left out of the story data`;
      lines.push(`  ${link.from} -> ${link.to} (passage "${link.to}" ${why})`);
    }
  }

  // Dead ends (warnings)
  if (result.deadEnds.length > 0) {
    lines.push('');
    lines.push(`Dead ends (${result.deadEnds.length}): ${result.deadEnds.join(', ')}`);
  }

  // Orphans (warnings)
  if (result.orphans.length > 0) {
    lines.push('');
    lines.push(`Orphans (${result.orphans.length}): ${result.orphans.join(', ')}`);
  }

  // Compilation diagnostics
  const errors = result.diagnostics.filter((d) => d.level === 'error');
  const warnings = result.diagnostics.filter((d) => d.level === 'warning');

  if (errors.length > 0 || warnings.length > 0) {
    lines.push('');
    lines.push(`Diagnostics: ${errors.length} error(s), ${warnings.length} warning(s)`);
    for (const d of errors) {
      lines.push(`  error: ${formatDiagnostic(d)}`);
    }
    for (const d of warnings) {
      lines.push(`  warning: ${formatDiagnostic(d)}`);
    }
  }

  // Summary line
  lines.push('');
  const hasErrors = errors.length > 0 || result.brokenLinks.length > 0;
  if (hasErrors) {
    lines.push('Lint failed.');
  } else {
    lines.push('Lint passed.');
  }

  return lines.join('\n');
}

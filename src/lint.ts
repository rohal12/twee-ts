/**
 * Lint mode: compile + inspect story structure without producing output.
 * Surfaces broken links, dead ends, orphans, and compilation diagnostics.
 */
import type { CompileOptions, CompileStats, Diagnostic } from './types.js';
import type { BrokenLink } from './inspect.js';
import { compile } from './compiler.js';
import { storyInspect } from './inspect.js';

export interface LintResult {
  /** Compilation diagnostics (errors and warnings). */
  diagnostics: Diagnostic[];
  /** Compilation statistics. */
  stats: CompileStats;
  /** Story format name from StoryData (e.g. "SugarCube"). */
  formatName: string;
  /** Story format version from StoryData (e.g. "2.37.3"). */
  formatVersion: string;
  /** The configured start passage name. */
  start: string;
  /** Total passage count. */
  passages: number;
  /** Story passage count (excludes StoryData, StoryTitle, scripts, etc.). */
  storyPassages: number;
  /** Info/special passage count. */
  infoPassages: number;
  /** Broken links: link targets that don't exist as passages. */
  brokenLinks: BrokenLink[];
  /** Story passages with no outgoing links. */
  deadEnds: string[];
  /** Story passages that no other passage links to. */
  orphans: string[];
}

/**
 * Lint a story: compile without output rendering, then inspect structure.
 * Uses JSON output mode internally to avoid format resolution.
 */
export async function lint(options: Omit<CompileOptions, 'outputMode'>): Promise<LintResult> {
  const result = await compile({ ...options, outputMode: 'json' });
  const map = storyInspect(result.story);

  return {
    diagnostics: result.diagnostics,
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
    `Passages: ${result.passages} total (${result.storyPassages} story, ${result.infoPassages} info), ${result.stats.words.toLocaleString()} words, ${result.stats.files.length} files`,
  );
  lines.push(`Start: ${result.start}`);

  // Broken links (errors)
  if (result.brokenLinks.length > 0) {
    lines.push('');
    lines.push(`Broken links (${result.brokenLinks.length}):`);
    for (const link of result.brokenLinks) {
      lines.push(`  ${link.from} -> ${link.to} (passage "${link.to}" does not exist)`);
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
      lines.push(`  error: ${d.message}`);
    }
    for (const d of warnings) {
      lines.push(`  warning: ${d.message}`);
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

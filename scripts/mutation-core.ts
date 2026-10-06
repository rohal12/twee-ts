/**
 * Pure parts of scripts/mutation-summary.ts: reading Stryker's JSON report (the mutation-testing-report-schema),
 * scoring each file as Stryker does, and comparing the scores with mutation-baseline.json.
 */

/** Mutant counts of one file, by what the tests did to the mutant. */
export interface FileCounts {
  /** Killed or timed out: a test noticed the change. */
  readonly detected: number;
  /** Survived, or no test ran the code: nothing noticed. */
  readonly undetected: number;
  /** Not valid code, or ignored: they count for neither. */
  readonly invalid: number;
}

/** Per-file mutation scores in percent (detected / (detected + undetected)), by source path. */
export type Scores = Readonly<Record<string, number>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DETECTED: ReadonlySet<string> = new Set(['Killed', 'Timeout']);
const UNDETECTED: ReadonlySet<string> = new Set(['Survived', 'NoCoverage']);

/** The mutant counts of each file in a Stryker JSON report. Throws when the text is not such a report. */
export function parseMutationReport(text: string): ReadonlyMap<string, FileCounts> {
  const report: unknown = JSON.parse(text);
  const files = isRecord(report) ? report['files'] : undefined;
  if (!isRecord(files)) throw new Error('Not a mutation testing report: it has no "files" object.');
  const counts = new Map<string, FileCounts>();
  for (const [path, file] of Object.entries(files)) {
    const mutants = isRecord(file) ? file['mutants'] : undefined;
    if (!Array.isArray(mutants)) throw new Error(`Not a mutation testing report: "${path}" has no "mutants" array.`);
    let detected = 0;
    let undetected = 0;
    let invalid = 0;
    for (const mutant of mutants) {
      const status: unknown = isRecord(mutant) ? mutant['status'] : undefined;
      if (typeof status !== 'string')
        throw new Error(`Not a mutation testing report: a mutant of "${path}" has no status.`);
      if (DETECTED.has(status)) detected++;
      else if (UNDETECTED.has(status)) undetected++;
      else invalid++;
    }
    counts.set(path, { detected, undetected, invalid });
  }
  return counts;
}

/** A score in percent, to one decimal; 100 for a file without valid mutants, as Stryker reports it. */
export function score({ detected, undetected }: FileCounts): number {
  const total = detected + undetected;
  return total === 0 ? 100 : Math.round((detected / total) * 1000) / 10;
}

/** The scores of every file, and of all of them together under `total`. */
export function scores(counts: ReadonlyMap<string, FileCounts>): Scores {
  const all = [...counts.values()].reduce(
    (sum, c) => ({ detected: sum.detected + c.detected, undetected: sum.undetected + c.undetected, invalid: 0 }),
    { detected: 0, undetected: 0, invalid: 0 },
  );
  return Object.fromEntries([
    ...[...counts].map(([path, c]): [string, number] => [path, score(c)]),
    ['total', score(all)],
  ]);
}

/** Read mutation-baseline.json: an object of numbers. Throws on anything else. */
export function parseBaseline(text: string): Scores {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('mutation-baseline.json must hold an object of scores.');
  for (const [path, s] of Object.entries(value)) {
    if (typeof s !== 'number') throw new Error(`mutation-baseline.json: the score of "${path}" must be a number.`);
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
}

/**
 * How many points a score may differ from the baseline before it counts as changed. A few mutants are killed or
 * not depending on the machine's speed (a mutant that slows a loop past a test's time limit), so a run's score
 * moves by a fraction of a point without any change in the code or the tests.
 */
const SCORE_TOLERANCE = 0.5;

/** Baseline paths first, then new ones, in name order; `total` last. */
function orderedPaths(...sets: readonly Scores[]): string[] {
  return [...new Set(sets.flatMap((set) => Object.keys(set)))].sort((a, b) =>
    a === 'total' ? 1 : b === 'total' ? -1 : a.localeCompare(b),
  );
}

/** The scores as the baseline file holds them: paths in order, `total` last. */
export function formatBaseline(current: Scores): string {
  return `${JSON.stringify(Object.fromEntries(orderedPaths(current).map((path) => [path, current[path]])), null, 2)}\n`;
}

/** A Markdown table of the scores next to the baseline; files that fell below it are marked. */
export function renderComparison(current: Scores, baseline: Scores): string {
  const paths = orderedPaths(baseline, current);
  const cell = (s: number | undefined): string => (s === undefined ? '–' : `${s.toFixed(1)} %`);
  const change = (path: string): 'lower' | 'higher' | undefined => {
    const now = current[path];
    const before = baseline[path];
    if (now === undefined || before === undefined) return undefined;
    if (now < before - SCORE_TOLERANCE) return 'lower';
    return now > before + SCORE_TOLERANCE ? 'higher' : undefined;
  };
  const rows = paths.map((path) => {
    const mark = change(path);
    const note = mark === 'lower' ? ' ⚠️ lower' : mark === 'higher' ? ' (above the baseline)' : '';
    return `| ${path} | ${cell(baseline[path])} | ${cell(current[path])}${note} |`;
  });
  const fell = paths.filter((path) => change(path) === 'lower');
  const verdict =
    fell.length === 0
      ? 'No file scores below the baseline.'
      : `${fell.length} score(s) below the baseline: ${fell.join(', ')}. Add tests that kill the surviving mutants (see the HTML report).`;
  return ['## Mutation score', '', '| File | Baseline | Now |', '| --- | --- | --- |', ...rows, '', verdict, ''].join(
    '\n',
  );
}

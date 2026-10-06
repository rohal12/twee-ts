/**
 * Compares the mutation scores of the last `pnpm run mutation` (reports/mutation/mutation.json) with the
 * committed baseline (mutation-baseline.json), and prints the comparison as Markdown, also to the GitHub job
 * summary. It never fails on a lower score: mutation testing is informational.
 *
 *   pnpm run mutation:summary            # compare
 *   pnpm run mutation:summary --update   # write the current scores as the new baseline
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatBaseline, parseBaseline, parseMutationReport, renderComparison, scores } from './mutation-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = join(root, 'reports/mutation/mutation.json');
const baselinePath = join(root, 'mutation-baseline.json');

if (!existsSync(reportPath)) {
  console.error(`No mutation report at ${reportPath}; run \`pnpm run mutation\` first.`);
  process.exitCode = 1;
} else {
  const current = scores(parseMutationReport(readFileSync(reportPath, 'utf8')));
  if (process.argv.includes('--update')) {
    writeFileSync(baselinePath, formatBaseline(current));
    console.log(`Wrote ${baselinePath}.`);
  } else {
    const baseline = existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, 'utf8')) : {};
    const summary = renderComparison(current, baseline);
    console.log(summary);
    const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
    if (stepSummary !== undefined && stepSummary !== '') appendFileSync(stepSummary, summary);
  }
}

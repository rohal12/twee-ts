// Prints the Vitest coverage totals (coverage/coverage-summary.json) as a Markdown table.
import { existsSync, readFileSync } from 'node:fs';

const file = 'coverage/coverage-summary.json';
if (!existsSync(file)) {
  console.log('## Coverage\n\nNo coverage summary was produced.');
  process.exit(0);
}

const { total } = JSON.parse(readFileSync(file, 'utf8'));
const rows = ['statements', 'branches', 'functions', 'lines'].map(
  (metric) => `| ${metric} | ${total[metric].pct}% | ${total[metric].covered} / ${total[metric].total} |`,
);
console.log(['## Coverage', '', '| Metric | Covered | Count |', '| --- | --- | --- |', ...rows].join('\n'));

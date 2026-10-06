import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assessEvidence } from './review-state.mjs';
import { fingerprint, inventoryBytes, REPO, sha256, validateInventory } from './evidence.mjs';

const { values } = parseArgs({
  options: {
    evidence: { type: 'string', default: 'validation/release-evidence.json' },
    fingerprint: { type: 'boolean' },
  },
});
const inventory = JSON.parse(inventoryBytes());
const context = { fingerprint: fingerprint(), inventorySha256: sha256(inventoryBytes()), inventory };
if (values.fingerprint) {
  console.log(JSON.stringify(context, null, 2));
} else {
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(resolve(REPO, values.evidence), 'utf8'));
  } catch {
    /* Missing or malformed evidence fails closed. */
  }
  const errors = [...validateInventory(inventory), ...assessEvidence(evidence, context)];
  for (const check of evidence?.checks ?? []) {
    try {
      const bytes = readFileSync(resolve(REPO, check.artifact));
      const report = JSON.parse(bytes);
      if (
        sha256(bytes) !== check.sha256 ||
        report.fingerprint !== context.fingerprint ||
        report.id !== check.id ||
        report.environment !== check.environment ||
        report.exitCode !== 0 ||
        JSON.stringify(report.command) !== JSON.stringify(check.command) ||
        (check.id === 'contracts' && !Array.isArray(report.result?.results)) ||
        report.result?.results?.some((item) => item.status !== 'pass')
      )
        errors.push(`invalid or stale check artifact: ${check.artifact}`);
    } catch {
      errors.push(`missing or malformed check artifact: ${check.artifact}`);
    }
  }
  for (const review of (evidence?.reviews ?? []).slice(-3)) {
    try {
      const bytes = readFileSync(resolve(REPO, review.artifact));
      if (sha256(bytes) !== review.sha256) errors.push(`changed review artifact: ${review.artifact}`);
    } catch {
      errors.push(`missing review artifact: ${review.artifact}`);
    }
  }
  console.log(
    errors.length
      ? `RELEASE BLOCKED\n${[...new Set(errors)].map((error) => `- ${error}`).join('\n')}`
      : 'Release evidence complete: checks and three clean open sweeps match the frozen revision.',
  );
  process.exitCode = errors.length ? 1 : 0;
}

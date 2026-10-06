/**
 * Evidence is an auditable record, not a proof of bug freedom. Validate it fail-closed.
 * Ordered findings/incomplete sweeps reset the streak; only its last three sweeps count.
 */
export function assessEvidence(evidence, { fingerprint, inventorySha256, inventory }) {
  if (!evidence || typeof evidence !== 'object') return ['missing evidence'];
  const errors = [];
  if (evidence.schemaVersion !== 1) errors.push('unsupported evidence schema');
  if (evidence.fingerprint !== fingerprint) errors.push('stale product/validation fingerprint');
  if (evidence.inventorySha256 !== inventorySha256) errors.push('stale inventory scope');
  if (!Array.isArray(evidence.openFindings) || evidence.openFindings.length)
    errors.push('open findings or missing findings ledger');
  if (!Array.isArray(evidence.supportGaps) || evidence.supportGaps.length)
    errors.push('support gaps or missing support ledger');
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  for (const check of checks) {
    if (!check || check.exitCode !== 0) errors.push(`failed check: ${check?.id ?? 'malformed'}`);
    if (!check?.command || !check?.artifact) errors.push('check needs command and evidence artifact');
  }
  for (const environment of inventory.requiredEnvironments) {
    for (const id of inventory.requiredChecks) {
      if (!checks.some((c) => c?.id === id && c.environment === environment && c.exitCode === 0))
        errors.push(`missing check ${id} on ${environment}`);
    }
  }
  for (const id of inventory.additionalRequiredChecks ?? []) {
    if (!checks.some((c) => c?.id === id && c.exitCode === 0))
      errors.push(`missing compatibility/integration check ${id}`);
  }
  const reviews = Array.isArray(evidence.reviews) ? evidence.reviews : [];
  let clean = [];
  for (const review of reviews) {
    if (
      !review ||
      review.status !== 'clean' ||
      !Array.isArray(review.findings) ||
      review.findings.length ||
      review.fingerprint !== fingerprint
    )
      clean = [];
    else clean.push(review);
  }
  clean = clean.slice(-3);
  if (clean.length !== 3) errors.push('need three clean full open sweeps after the last finding or incomplete sweep');
  const requiredMethods = ['implementation', 'adversarial-integration', 'compatibility-package'];
  if (
    new Set(clean.map((r) => r.reviewer)).size !== 3 ||
    !requiredMethods.every((method) => clean.some((r) => r.method === method))
  )
    errors.push('need independent reviewers and all three review methods');
  for (const review of clean) {
    if (!review.id || !review.reviewer || !review.artifact) errors.push('review needs identity and evidence artifact');
    if (
      review.inventorySha256 !== inventorySha256 ||
      !Array.isArray(review.coverage) ||
      !inventory.areas.every((area) => review.coverage.includes(area.id))
    )
      errors.push(`incomplete or stale review scope: ${review.id}`);
  }
  return errors;
}

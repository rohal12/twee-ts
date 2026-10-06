import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidence } from './review-state.mjs';

const fingerprint = 'a'.repeat(64);
const inventorySha256 = 'b'.repeat(64);
const inventory = {
  revision: 2,
  areas: [{ id: 'compile' }, { id: 'formats' }],
  requiredChecks: ['unit', 'contracts'],
  requiredEnvironments: ['linux-node22', 'windows-node24'],
};
function evidence() {
  return {
    schemaVersion: 1,
    fingerprint,
    inventorySha256,
    openFindings: [],
    supportGaps: [],
    checks: inventory.requiredEnvironments.flatMap((environment) =>
      inventory.requiredChecks.map((id) => ({
        id,
        environment,
        command: `run ${id}`,
        exitCode: 0,
        artifact: `${environment}-${id}.json`,
      })),
    ),
    reviews: ['implementation', 'adversarial-integration', 'compatibility-package'].map((method, i) => ({
      id: `review-${i}`,
      reviewer: `independent-${i}`,
      method,
      fingerprint,
      inventorySha256,
      status: 'clean',
      findings: [],
      coverage: ['compile', 'formats'],
      artifact: `review-${i}.md`,
    })),
  };
}
const assess = (e) => assessEvidence(e, { fingerprint, inventorySha256, inventory });
test('complete evidence permits release', () => assert.deepEqual(assess(evidence()), []));
test('missing evidence fails closed', () => assert(assess(undefined).includes('missing evidence')));
test('different product revision invalidates every clean review', () => {
  const e = evidence();
  e.fingerprint = 'c'.repeat(64);
  assert(assess(e).some((s) => s.includes('fingerprint')));
});
test('missing platform evidence cannot be represented as a pass', () => {
  const e = evidence();
  e.checks = e.checks.filter((c) => c.environment !== 'windows-node24');
  assert(assess(e).some((s) => s.includes('windows-node24')));
});
test('a failed check cannot be hidden behind a duplicate successful result', () => {
  const e = evidence();
  e.checks.push({ ...e.checks[0], exitCode: 1 });
  assert(assess(e).some((s) => s.includes('failed check')));
});
test('review findings reset the clean streak, even if closed afterwards', () => {
  const e = evidence();
  e.reviews[1] = { ...e.reviews[1], status: 'findings', findings: ['cache identity'] };
  e.reviews.push({ ...e.reviews[0], id: 'after-fix', reviewer: 'fourth' });
  assert(assess(e).some((s) => s.includes('three clean')));
});
test('three fresh clean reviews after a finding allow convergence', () => {
  const e = evidence();
  e.reviews.unshift({
    ...e.reviews[0],
    status: 'findings',
    findings: ['fixed on prior revision'],
    fingerprint: 'c'.repeat(64),
  });
  assert.deepEqual(assess(e), []);
});
test('repeated reviewer or method cannot count as independent sweeps', () => {
  const e = evidence();
  e.reviews[1].reviewer = e.reviews[0].reviewer;
  e.reviews[2].method = e.reviews[0].method;
  assert(assess(e).some((s) => s.includes('independent')));
});
test('incomplete or stale scope invalidates review evidence', () => {
  const e = evidence();
  e.reviews[2].coverage.pop();
  e.reviews[1].inventorySha256 = 'c'.repeat(64);
  assert(assess(e).some((s) => s.includes('scope')));
});
test('known findings and explicit untested support block release', () => {
  const e = evidence();
  e.openFindings.push('#236');
  e.supportGaps.push('Vite 5');
  assert(assess(e).some((s) => s.includes('open findings')));
  assert(assess(e).some((s) => s.includes('support gaps')));
});
test('malformed records return failures instead of accepting empty arrays', () => {
  for (const e of [null, {}, { ...evidence(), reviews: null }, { ...evidence(), checks: [{}] }])
    assert(assess(e).length > 0);
});

test('compatibility and browser checks cannot be omitted from the gate', () => {
  const context = {
    fingerprint,
    inventorySha256,
    inventory: { ...inventory, additionalRequiredChecks: ['browser', 'vite-5'] },
  };
  assert(assessEvidence(evidence(), context).some((s) => s.includes('browser')));
});

test('recording cannot label this machine as a different platform', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    [
      'validation/run-check.mjs',
      '--id',
      'unit',
      '--environment',
      'imaginary-node99',
      '--report',
      '/tmp/should-not-exist-twee-evidence.json',
      '--',
      process.execPath,
      '-e',
      'process.exit(0)',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /environment.*does not match|does not match.*environment/i);
});

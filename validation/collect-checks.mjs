/** Run and capture the reproducible checks for one real Node/OS environment. */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { REPO } from './evidence.mjs';
const { values } = parseArgs({ options: { environment: { type: 'string' } } });
const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform;
const environment = `${os}-node${process.versions.node.split('.')[0]}`;
if (values.environment && values.environment !== environment)
  throw new Error(`Actual environment ${environment} does not match requested label ${values.environment}`);
const output = `validation/reports/${environment}`;
const checks = [
  ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['unit', ['node_modules/vitest/vitest.mjs', 'run']],
  ['build', ['node_modules/tsdown/dist/run.mjs']],
  ['gate-tests', ['--test', 'validation/review-state.test.mjs']],
  ['contracts', ['validation/compiler-contracts.mjs', '--report', `${output}/contracts-result.json`]],
  ['extended', ['validation/extended-contracts.mjs']],
  ['package', ['validation/package-contracts.mjs']],
];
for (const [id, args] of checks) {
  const recorded = [
    'validation/run-check.mjs',
    '--id',
    id,
    '--environment',
    environment,
    '--report',
    `${output}/${id}.json`,
  ];
  if (id === 'contracts') recorded.push('--result', `${output}/contracts-result.json`);
  const result = spawnSync(process.execPath, [...recorded, '--', process.execPath, ...args], {
    cwd: REPO,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
console.log(`Evidence directory: ${join(REPO, output)}`);

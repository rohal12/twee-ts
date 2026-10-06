import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fingerprint, REPO } from './evidence.mjs';

const separator = process.argv.indexOf('--');
const { values } = parseArgs({
  args: process.argv.slice(2, separator === -1 ? undefined : separator),
  options: {
    id: { type: 'string' },
    environment: { type: 'string' },
    report: { type: 'string' },
    result: { type: 'string' },
  },
});
if (separator === -1 || !values.id || !values.environment || !values.report)
  throw new Error('Usage: run-check.mjs --id ID --environment ENV --report FILE [--result JSON] -- COMMAND [ARGS]');
if (values.id === 'contracts' && !values.result)
  throw new Error('contracts checks require --result so known baseline failures cannot be hidden');
const command = process.argv.slice(separator + 1);
const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform;
const environment = `${os}-node${process.versions.node.split('.')[0]}`;
if (values.environment !== environment)
  throw new Error(`Requested environment ${values.environment} does not match actual environment ${environment}`);
const startedAt = new Date().toISOString();
const before = fingerprint();
const run = spawnSync(command[0], command.slice(1), { cwd: REPO, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
let exitCode = run.status ?? 1;
if (before !== fingerprint()) exitCode = 1;
let result;
try {
  if (values.result) {
    result = JSON.parse(readFileSync(resolve(REPO, values.result), 'utf8'));
    if (result.results?.some((item) => item.status !== 'pass') || result.counts?.fail || result.counts?.blocked)
      exitCode = 1;
  }
} catch (error) {
  exitCode = 1;
  result = { error: error.message };
}
const report = {
  schemaVersion: 1,
  fingerprint: before,
  productCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  id: values.id,
  environment: values.environment,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  command,
  startedAt,
  completedAt: new Date().toISOString(),
  exitCode,
  stdout: run.stdout,
  stderr: run.stderr,
  ...(result ? { result } : {}),
};
const path = resolve(REPO, values.report);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
process.exitCode = exitCode;

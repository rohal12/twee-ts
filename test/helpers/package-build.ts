/**
 * The package as it ships, built from the source with tsdown, for the tests that run it as users do: the
 * documentation's examples and the CLI tests. A CLI run from the source through tsx compiles the source again in
 * each process, which the first run of a test file pays in full (seconds on a loaded Windows runner, #436); the
 * built CLI starts as the published one does.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from './docs.js';

/** tsdown needs Node 22.18+ or 24.11+. CI runs the tests on the latest Node 24. */
export const CAN_BUILD = ((): boolean => {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return (major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major >= 26;
})();

/** How long a build may take before its hook fails: a hang guard, not a claim about the build's speed. */
export const BUILD_TIMEOUT_MS = 180_000;

/**
 * Builds the package into the folder `pkg` (made if missing), with its package.json, which the CLI reads its version
 * from, and its schemas; returns the path of the built CLI.
 */
export function buildPackage(pkg: string): string {
  if (!CAN_BUILD) throw new Error(`building the package needs Node 22.18+ or 24.11+, not ${process.versions.node}`);
  mkdirSync(pkg, { recursive: true });
  copyFileSync(join(REPO, 'package.json'), join(pkg, 'package.json'));
  cpSync(join(REPO, 'schemas'), join(pkg, 'schemas'), { recursive: true });
  const build = spawnSync(
    process.execPath,
    [join(REPO, 'node_modules', 'tsdown', 'dist', 'run.mjs'), '--out-dir', join(pkg, 'dist')],
    { cwd: REPO, encoding: 'utf8' },
  );
  if (build.status !== 0) throw new Error(`tsdown failed\n${build.stdout}\n${build.stderr}`);
  return join(pkg, 'dist', 'bin', 'twee-ts.js');
}

/**
 * The Node arguments that start the CLI: the CLI built into `pkg`, or, on a Node too old for tsdown (24.0 to 24.10,
 * which `engines` allows), the source through tsx, which is slower to start but runs the same tests rather than
 * skipping them. CI runs a Node that builds.
 */
export function cliNodeArgs(pkg: string): string[] {
  if (CAN_BUILD) return [buildPackage(pkg)];
  const tsx = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return ['--import', tsx, join(REPO, 'bin', 'twee-ts.ts')];
}

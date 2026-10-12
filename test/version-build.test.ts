/**
 * The version a built package reports does not depend on a global `__dirname` (#447). `node -e`, `node -p` and the
 * REPL define one, and ESM code or a bundler banner may shim it for dependencies written for CommonJS; neither build
 * may take it for the folder of its own module.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_TIMEOUT_MS, CAN_BUILD, buildPackage } from './helpers/package-build.js';
import { removeDir } from './helpers/remove-dir.js';

const RELEASE = '9.8.7';

let pkg = '';
let elsewhere = '';

beforeAll(() => {
  if (!CAN_BUILD) return;
  pkg = mkdtempSync(join(tmpdir(), 'twee-ts-version-build-'));
  elsewhere = mkdtempSync(join(tmpdir(), 'twee-ts-version-elsewhere-'));
  buildPackage(pkg);
  // The release writes its version into the package.json it publishes.
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf-8')) as Record<string, unknown>;
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ ...manifest, version: RELEASE }), 'utf-8');
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  if (pkg !== '') removeDir(pkg);
  if (elsewhere !== '') removeDir(elsewhere);
});

/** The `creator-version` a compile of the built package writes, in a process that has `__dirname` set globally. */
function creatorVersion(format: 'esm' | 'cjs', shim: boolean): string {
  const setup = shim ? `globalThis.__dirname = ${JSON.stringify(elsewhere)};` : '';
  const compile = `{ sources: [{ filename: 'a.tw', content: ':: StoryTitle\\nT\\n\\n:: Start\\nHi\\n' }], outputMode: 'twine2-archive' }`;
  const print = `(r) => console.log(/creator-version="([^"]*)"/.exec(r.output)?.[1])`;
  const code =
    format === 'esm'
      ? `${setup} const m = await import(${JSON.stringify(pathToFileURL(join(pkg, 'dist', 'index.js')).href)}); m.compile(${compile}).then(${print});`
      : `${setup} require(${JSON.stringify(join(pkg, 'dist', 'index.cjs'))}).compile(${compile}).then(${print});`;
  const run = spawnSync(process.execPath, [...(format === 'esm' ? ['--input-type=module'] : []), '-e', code], {
    cwd: elsewhere,
    encoding: 'utf8',
  });
  expect(run.stderr).toBe('');
  return run.stdout.trim();
}

describe.runIf(CAN_BUILD)('the version of the built package', () => {
  it.each([
    ['ESM', 'esm'],
    ['CJS', 'cjs'],
  ] as const)('is the published one in the %s build', (_label, format) => {
    expect(creatorVersion(format, false)).toBe(RELEASE);
  });

  it.each([
    ['ESM', 'esm'],
    ['CJS', 'cjs'],
  ] as const)('is the published one in the %s build when a global __dirname names another folder', (_label, format) => {
    expect(creatorVersion(format, true)).toBe(RELEASE);
  });
});

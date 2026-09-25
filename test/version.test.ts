import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VERSION, findPackageVersion } from '../src/version.js';

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'twee-ts-version-'));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('findPackageVersion', () => {
  it('walks up to the twee-ts package.json', () => {
    const root = tree({ 'package.json': JSON.stringify({ name: '@rohal12/twee-ts', version: '9.9.9' }) });
    mkdirSync(join(root, 'dist', 'bin'), { recursive: true });
    expect(findPackageVersion(join(root, 'dist', 'bin'))).toBe('9.9.9');
  });

  it('skips package.json files of other packages', () => {
    const root = tree({
      'package.json': JSON.stringify({ name: '@rohal12/twee-ts', version: '9.9.9' }),
      'inner/package.json': JSON.stringify({ name: 'something-else', version: '0.0.1' }),
    });
    expect(findPackageVersion(join(root, 'inner'))).toBe('9.9.9');
  });

  it('returns undefined when no twee-ts package.json is found', () => {
    const root = tree({ 'package.json': JSON.stringify({ name: 'something-else', version: '1.0.0' }) });
    expect(findPackageVersion(root)).toBeUndefined();
  });
});

describe('VERSION', () => {
  it('is the version in the repository package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

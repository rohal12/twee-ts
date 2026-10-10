/**
 * The contributor setup works on a fresh machine (#380): the manifest names the Node.js and pnpm it needs, makes
 * the install fail on an older Node.js, and the README and CONTRIBUTING.md state the same prerequisites.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');
const manifest = JSON.parse(read('package.json')) as {
  readonly packageManager: string;
  readonly engines: { readonly node: string };
  readonly devEngines: {
    readonly runtime: { readonly name: string; readonly version: string; readonly onFail: string };
  };
};

describe('contributor prerequisites', () => {
  it('pins pnpm and makes an older Node.js an error', () => {
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(manifest.devEngines.runtime).toEqual({ name: 'node', version: manifest.engines.node, onFail: 'error' });
  });

  it.each(['README.md', 'CONTRIBUTING.md'])('%s names the Node.js and pnpm versions and how to get pnpm', (file) => {
    const text = read(file);
    const node = /^>=(\d+)$/.exec(manifest.engines.node)?.[1];
    const pnpm = /^pnpm@(\d+)\./.exec(manifest.packageManager)?.[1];
    expect(text).toContain(`Node.js ${node ?? ''} or later`);
    expect(text).toContain(`pnpm ${pnpm ?? ''}`);
    expect(text).toContain(`npm install -g pnpm@${pnpm ?? ''}`);
    expect(text).toContain('corepack enable');
    expect(text).toContain('ERR_PNPM_NO_MATCHING_VERSION');
  });
});

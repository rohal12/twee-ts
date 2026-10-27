import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { packageUrl, resolvedDependencies, snapshot } from '../scripts/dependency-snapshot.js';
import type { ListedPackage, ListedProject } from '../scripts/dependency-snapshot.js';

const SCRIPT = join(__dirname, '..', 'scripts', 'dependency-snapshot.ts');

function pkg(from: string, version: string, dependencies?: Record<string, ListedPackage>): ListedPackage {
  return dependencies === undefined ? { from, version } : { from, version, dependencies };
}

const entities8 = pkg('entities', '8.1.0');
/**
 * As `pnpm ls --json` prints a tree: a bundled package (`parse5`) whose dependency (`entities`) a tool uses in
 * another version, an alias (`typescript`), a package listed in full once and `deduped` later, and a link.
 */
const PROJECT: ListedProject = {
  devDependencies: {
    acorn: pkg('acorn', '8.19.0'),
    parse5: pkg('parse5', '8.0.1', { entities: entities8 }),
    vitepress: pkg('vitepress', '1.6.4', {
      '@vue/compiler-core': pkg('@vue/compiler-core', '3.5.43', { entities: pkg('entities', '7.0.1') }),
      'linked-theme': pkg('linked-theme', 'link:../theme'),
    }),
    typescript: pkg('@typescript/typescript6', '6.0.2'),
    tool: pkg('tool', '1.0.0', { parse5: pkg('parse5', '8.0.1') }),
  },
};

const RUN = {
  GITHUB_SHA: 'merge-sha',
  GITHUB_REF: 'refs/pull/7/merge',
  GITHUB_WORKFLOW: 'Dependencies',
  GITHUB_JOB: 'snapshot',
  GITHUB_RUN_ID: '42',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'rohal12/twee-ts',
};

describe('packageUrl', () => {
  it('encodes the scope and the version', () => {
    expect(packageUrl(pkg('@vue/compiler-core', '3.5.43'))).toBe('pkg:npm/%40vue/compiler-core@3.5.43');
    expect(packageUrl(pkg('x', '1.0.0+build.1'))).toBe('pkg:npm/x@1.0.0%2Bbuild.1');
  });

  it('has none for a package that is not from the registry', () => {
    expect(packageUrl(pkg('linked-theme', 'link:../theme'))).toBeUndefined();
    expect(packageUrl(pkg('x', 'file:x.tgz'))).toBeUndefined();
  });
});

describe('resolvedDependencies', () => {
  const resolved = resolvedDependencies(PROJECT, ['parse5', 'entities', 'acorn']);

  it('lists every registry package once, by its registry name', () => {
    expect(Object.keys(resolved).sort()).toEqual([
      'pkg:npm/%40typescript/typescript6@6.0.2',
      'pkg:npm/%40vue/compiler-core@3.5.43',
      'pkg:npm/acorn@8.19.0',
      'pkg:npm/entities@7.0.1',
      'pkg:npm/entities@8.1.0',
      'pkg:npm/parse5@8.0.1',
      'pkg:npm/tool@1.0.0',
      'pkg:npm/vitepress@1.6.4',
    ]);
  });

  it("marks the project's own dependencies direct", () => {
    const direct = Object.values(resolved).filter((r) => r.relationship === 'direct');
    expect(direct.map((r) => r.package_url).sort()).toEqual([
      'pkg:npm/%40typescript/typescript6@6.0.2',
      'pkg:npm/acorn@8.19.0',
      'pkg:npm/parse5@8.0.1',
      'pkg:npm/tool@1.0.0',
      'pkg:npm/vitepress@1.6.4',
    ]);
  });

  it('counts the bundled packages and what they depend on as runtime, and only those versions', () => {
    const runtime = Object.values(resolved).filter((r) => r.scope === 'runtime');
    expect(runtime.map((r) => r.package_url).sort()).toEqual([
      'pkg:npm/acorn@8.19.0',
      'pkg:npm/entities@8.1.0',
      'pkg:npm/parse5@8.0.1',
    ]);
  });

  it('gives a deduped package the dependencies it was listed with elsewhere', () => {
    expect(resolved['pkg:npm/tool@1.0.0']?.dependencies).toEqual(['pkg:npm/parse5@8.0.1']);
    expect(resolved['pkg:npm/parse5@8.0.1']?.dependencies).toEqual(['pkg:npm/entities@8.1.0']);
  });

  it('leaves out a dependency that is not from the registry', () => {
    expect(resolved['pkg:npm/vitepress@1.6.4']?.dependencies).toEqual(['pkg:npm/%40vue/compiler-core@3.5.43']);
  });

  it('finds the bundled dependencies however deep a deduped listing hides them', () => {
    const project: ListedProject = {
      devDependencies: {
        tool: pkg('tool', '1.0.0', { parse5: pkg('parse5', '8.0.1', { entities: entities8 }) }),
        parse5: pkg('parse5', '8.0.1'),
      },
    };
    expect(resolvedDependencies(project, ['parse5'])['pkg:npm/entities@8.1.0']?.scope).toBe('runtime');
  });
});

describe('snapshot', () => {
  const scanned = new Date('2026-10-27T12:00:00Z');

  it('describes the commit and the workflow run', () => {
    const s = snapshot(PROJECT, { ...RUN, SNAPSHOT_SHA: 'head-sha' }, scanned);
    expect(s).toMatchObject({
      version: 0,
      sha: 'head-sha',
      ref: 'refs/pull/7/merge',
      job: { correlator: 'Dependencies snapshot', id: '42' },
      detector: { url: 'https://github.com/rohal12/twee-ts/blob/main/scripts/dependency-snapshot.ts' },
      scanned: '2026-10-27T12:00:00.000Z',
    });
    expect(s.manifests['pnpm-lock.yaml'].file).toEqual({ source_location: 'pnpm-lock.yaml' });
    expect(s.manifests['pnpm-lock.yaml'].resolved['pkg:npm/parse5@8.0.1']?.scope).toBe('runtime');
  });

  it('takes the commit from GITHUB_SHA when SNAPSHOT_SHA is empty, as on a push', () => {
    expect(snapshot(PROJECT, { ...RUN, SNAPSHOT_SHA: '' }, scanned).sha).toBe('merge-sha');
  });

  it.each(Object.keys(RUN))('fails without %s', (name) => {
    expect(() => snapshot(PROJECT, { ...RUN, [name]: '' }, scanned)).toThrow(`${name} is not set`);
  });
});

describe('the script', () => {
  const run = (input: string) =>
    spawnSync(process.execPath, [SCRIPT], { input, env: { ...process.env, ...RUN }, encoding: 'utf8' });

  it('reads `pnpm ls --json` on standard input and writes the snapshot, with Node alone', () => {
    const result = run(JSON.stringify([PROJECT]));
    expect(result.status).toBe(0);
    const written = JSON.parse(result.stdout) as ReturnType<typeof snapshot>;
    expect(Object.keys(written.manifests['pnpm-lock.yaml'].resolved)).toHaveLength(8);
  });

  it('rejects anything but the listing of one project', () => {
    const result = run('[]');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Expected the output of `pnpm ls --json` for one project');
  });
});

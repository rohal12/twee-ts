/**
 * The release gate (validation/release, docs/compiler-validation.md): its decisions, the review
 * areas, the release workflow that runs it, and the command's answer for a push with and without
 * the release annotation.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEW_AREAS } from '../validation/release/areas.js';
import {
  checkProblems,
  countFindings,
  fingerprint,
  parseEvidenceRecord,
  parseLsTree,
  RELEASE_ANNOTATION,
  releaseProblems,
  releaseRequested,
  REQUIRED_CHECKS,
  requiredRunNames,
} from '../validation/release/gate.js';
import type { CheckRun, EvidenceRecord, Finding, GateInput, Review, TreeEntry } from '../validation/release/gate.js';

const REPO = resolve(import.meta.dirname, '..');
const HEAD = 'a'.repeat(64);
const COMMIT = 'c'.repeat(40);

describe('releaseRequested: the release action’s own test', () => {
  it('finds the annotation anywhere in the message, as the action does', () => {
    expect(releaseRequested(`release: v2.0.0 (#300)\n\n${RELEASE_ANNOTATION}\n`)).toBe(true);
    expect(releaseRequested(`chore: bump tobua/${RELEASE_ANNOTATION}-action\n`)).toBe(true);
    expect(releaseRequested(`fix: something${RELEASE_ANNOTATION}`)).toBe(true);
  });

  it('is false for a message without it, case and all', () => {
    expect(releaseRequested('feat: a feature\n\nthe release annotation is not here')).toBe(false);
    expect(releaseRequested(RELEASE_ANNOTATION.toUpperCase())).toBe(false);
    expect(releaseRequested('')).toBe(false);
  });
});

const entry = (path: string, object = 'b'.repeat(40), mode = '100644'): TreeEntry => ({
  mode,
  type: 'blob',
  object,
  path,
});

describe('fingerprint', () => {
  const tree = [entry('src/index.ts'), entry('package.json', 'd'.repeat(40)), entry('docs/api.md', 'e'.repeat(40))];

  it('reads git ls-tree -r -z output, paths with spaces and tabs included', () => {
    const lines = [`100644 blob ${'b'.repeat(40)}\tsrc/index.ts`, `100755 blob ${'d'.repeat(40)}\ta b\tc.sh`];
    const output = lines.map((line) => `${line}\u0000`).join('');
    expect(parseLsTree(output)).toEqual([entry('src/index.ts'), entry('a b\tc.sh', 'd'.repeat(40), '100755')]);
    expect(() => parseLsTree('not a tree line\u0000')).toThrow(/unexpected git ls-tree line/);
  });

  it('leaves out the evidence and the changelog, and nothing else', () => {
    const withEvidence = [...tree, entry('validation/evidence/2.0.0/record.json'), entry('CHANGELOG.md')];
    expect(fingerprint(withEvidence)).toBe(fingerprint(tree));
    for (const path of ['validation/evidence.ts', 'validation/release/gate.ts', 'docs/CHANGELOG.md', 'README.md']) {
      expect(fingerprint([...tree, entry(path)]), path).not.toBe(fingerprint(tree));
    }
  });

  it('changes with any file’s content, mode or name, and not with the listing order', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(tree, { minLength: tree.length }), (shuffled) => {
        expect(fingerprint(shuffled)).toBe(fingerprint(tree));
      }),
    );
    const [first, ...rest] = tree;
    if (first === undefined) throw new Error('empty tree');
    for (const changed of [
      { ...first, object: 'f'.repeat(40) },
      { ...first, mode: '100755' },
      { ...first, path: 'src/main.ts' },
    ]) {
      expect(fingerprint([changed, ...rest])).not.toBe(fingerprint(tree));
    }
  });
});

const ALL_AREAS = REVIEW_AREAS.map((a) => a.id);

function review(overrides: Partial<Review> = {}, n = 1): Review {
  return {
    reviewer: `reviewer-${String(n)}`,
    method: 'implementation',
    fingerprint: HEAD,
    completedAt: '2026-10-06T12:00:00Z',
    areas: ALL_AREAS,
    report: `sweep-${String(n)}.md`,
    reportSha256: String(n).repeat(64),
    findings: [],
    ...overrides,
  };
}

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schemaVersion: 1,
    release: '2.0.0',
    commit: COMMIT,
    fingerprint: HEAD,
    checks: REQUIRED_CHECKS.map((name) => `${name} (x)`),
    reviews: [
      review({ method: 'implementation' }, 1),
      review({ method: 'adversarial-integration' }, 2),
      review({ method: 'compatibility-distribution' }, 3),
    ],
    ...overrides,
  };
}

const passing = (name: string, id = 1): CheckRun => ({ id, name, status: 'completed', conclusion: 'success' });

function input(overrides: Partial<GateInput> = {}): GateInput {
  const evidence = overrides.record ?? record();
  return {
    headFingerprint: HEAD,
    record: evidence,
    commitFingerprint: HEAD,
    checkRuns: REQUIRED_CHECKS.map((name, i) => passing(`${name} (x)`, i + 1)),
    reportHashes: new Map(evidence.reviews.map((r) => [r.report, r.reportSha256])),
    ...overrides,
  };
}

/** An open finding, tracked by `issue` when one is given. */
function finding(severity: Finding['severity'], issue?: string): Finding {
  const open = { id: `F-${severity}`, severity, title: `a ${severity} finding`, status: 'open' } as const;
  return issue === undefined ? open : { ...open, issue };
}

function rejected(severity: Finding['severity']): Finding {
  return { id: `F-${severity}`, severity, title: `a ${severity} finding`, status: 'rejected', reason: 'not a defect' };
}

const ISSUE = 'https://github.com/rohal12/twee-ts/issues/1';

describe('parseEvidenceRecord', () => {
  it('reads a complete record', () => {
    const json: unknown = JSON.parse(JSON.stringify(record({ reviews: [review({ findings: [finding('P3')] })] })));
    expect(parseEvidenceRecord(json)).toEqual({
      ok: true,
      value: record({ reviews: [review({ findings: [finding('P3')] })] }),
    });
  });

  it('names every field that is missing or wrong', () => {
    const parsed = parseEvidenceRecord({
      schemaVersion: 2,
      release: '',
      commit: 'HEAD',
      fingerprint: 'abc',
      checks: [1],
      reviews: [
        { reviewer: 'x', method: 'skimming', fingerprint: HEAD, completedAt: 'now', areas: 'all', report: 'r.md' },
        'not an object',
        { ...review(), findings: [{ id: 'F1', severity: 'P0', title: 't', status: 'fixed' }] },
        { ...review(), findings: [{ id: 'F2', severity: 'P2', title: 't', status: 'rejected' }] },
      ],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems).toEqual([
      'record.schemaVersion must be 1',
      'record.release must be a non-empty string',
      'record.commit must be a string matching /^[0-9a-f]{40}$/',
      'record.fingerprint must be a string matching /^[0-9a-f]{64}$/',
      'record.checks[0] must be a non-empty string',
      'record.reviews[0].method must be one of implementation, adversarial-integration, compatibility-distribution',
      'record.reviews[0].areas must be a list',
      'record.reviews[0].reportSha256 must be a string matching /^[0-9a-f]{64}$/',
      'record.reviews[0].findings must be a list',
      'record.reviews[1] must be an object',
      'record.reviews[2].findings[0].severity must be one of P1, P2, P3, P4',
      'record.reviews[2].findings[0].status must be one of open, rejected',
      'record.reviews[3].findings[0].reason must be a non-empty string',
    ]);
  });

  it('rejects what is not an object', () => {
    for (const json of [null, [], 'record', 1]) {
      expect(parseEvidenceRecord(json)).toEqual({ ok: false, problems: ['the record must be a JSON object'] });
    }
  });
});

describe('checkProblems', () => {
  const listed = REQUIRED_CHECKS.map((name) => `${name} (x)`);
  const runs = REQUIRED_CHECKS.map((name, i) => passing(`${name} (x)`, i + 1));

  it('accepts every required check passed and listed, skipped and neutral runs too', () => {
    expect(checkProblems(runs, listed)).toEqual([]);
    const other = [...runs, { id: 90, name: 'docs', status: 'completed', conclusion: 'skipped' }];
    expect(
      checkProblems([...other, { id: 91, name: 'x', status: 'completed', conclusion: 'neutral' }], listed),
    ).toEqual([]);
  });

  it('matches a required check by its name, or its name and a space', () => {
    const named = ['lint', 'test (macos-latest, Node 24)', 'coverage', 'package / pack', 'plugin peers (Vite 5)'];
    const more = ['contracts (ubuntu-latest)', 'duplication (cpd)'];
    const all = [...named, ...more];
    expect(
      checkProblems(
        all.map((n, i) => passing(n, i + 1)),
        all,
      ),
    ).toEqual([]);
    const lookalikes = ['linting', 'tests', 'packaged'];
    expect(checkProblems([...runs, ...lookalikes.map((n, i) => passing(n, 50 + i))], listed)).toEqual([]);
  });

  it('refuses any run that did not pass, required or not', () => {
    const failed = [
      ...runs,
      { id: 80, name: 'docs build', status: 'completed', conclusion: 'failure' },
      { id: 81, name: 'test (windows-latest, Node 22)', status: 'completed', conclusion: 'cancelled' },
      { id: 82, name: 'contracts (macos-latest)', status: 'in_progress', conclusion: null },
    ];
    expect(checkProblems(failed, [...listed, 'test (windows-latest, Node 22)', 'contracts (macos-latest)'])).toEqual([
      'check "docs build" did not pass (completed, failure)',
      'check "test (windows-latest, Node 22)" did not pass (completed, cancelled)',
      'check "contracts (macos-latest)" did not pass (in_progress)',
    ]);
  });

  it('judges the latest run of a check: a passing re-run replaces a failure, and a failing one a pass', () => {
    const rerun = [...runs, { id: 0, name: 'lint (x)', status: 'completed', conclusion: 'failure' }];
    expect(checkProblems(rerun, listed)).toEqual([]);
    const regressed = [...runs, { id: 99, name: 'lint (x)', status: 'completed', conclusion: 'failure' }];
    expect(checkProblems(regressed, listed)).toEqual(['check "lint (x)" did not pass (completed, failure)']);
  });

  it('needs a run of every required check', () => {
    const withoutContracts = runs.filter((r) => !r.name.startsWith('contracts'));
    expect(
      checkProblems(
        withoutContracts,
        listed.filter((n) => !n.startsWith('contracts')),
      ),
    ).toEqual(['required check "contracts" has no run on the frozen commit']);
    expect(checkProblems([], [])).toHaveLength(REQUIRED_CHECKS.length);
  });

  it('lists the required runs a record names: the latest of each, sorted, nothing else', () => {
    const extra = [passing('docs', 70), passing('lint (x)', 71), passing('contracts (a)', 72)];
    expect(requiredRunNames([...runs, ...extra])).toEqual([...listed, 'contracts (a)'].sort());
  });

  it('needs the record to list exactly the required runs', () => {
    expect(checkProblems(runs, [...listed.slice(1), 'test (imaginary)'])).toEqual([
      'the record does not list the check "lint (x)"',
      'the record lists "test (imaginary)", which is not a required check run',
    ]);
  });
});

describe('releaseProblems', () => {
  it('lets complete evidence through', () => {
    expect(releaseProblems(input())).toEqual([]);
  });

  it('refuses a record for another revision, or a frozen commit that is not that revision', () => {
    expect(releaseProblems(input({ headFingerprint: 'b'.repeat(64) }))).toEqual([
      `the record is for revision ${HEAD}, not this one (${'b'.repeat(64)})`,
    ]);
    expect(releaseProblems(input({ commitFingerprint: 'e'.repeat(64) }))).toEqual([
      `the frozen commit ${COMMIT} has the fingerprint ${'e'.repeat(64)}, not the record's`,
    ]);
    expect(releaseProblems(input({ commitFingerprint: { error: 'not found' } }))).toEqual([
      `the frozen commit ${COMMIT} cannot be read: not found`,
    ]);
  });

  it('refuses when the checks cannot be read or did not pass', () => {
    expect(releaseProblems(input({ checkRuns: { error: 'GITHUB_TOKEN is not set' } }))).toEqual([
      `the checks of ${COMMIT} cannot be read: GITHUB_TOKEN is not set`,
    ]);
    const failing = REQUIRED_CHECKS.map((name, i) => ({ ...passing(`${name} (x)`, i + 1), conclusion: 'failure' }));
    expect(releaseProblems(input({ checkRuns: failing }))).toHaveLength(REQUIRED_CHECKS.length);
  });

  it('needs three sweeps by three reviewers, one by each method', () => {
    const [first, second] = record().reviews;
    if (first === undefined || second === undefined) throw new Error('fixture');
    expect(releaseProblems(input({ record: record({ reviews: [first, second] }) }))).toEqual([
      'three full review sweeps are needed; the record has 2',
      'no sweep used the method compatibility-distribution',
    ]);
    const sameReviewer = record().reviews.map((r) => ({ ...r, reviewer: ' Reviewer-1 ' }));
    expect(releaseProblems(input({ record: record({ reviews: sameReviewer }) }))).toEqual([
      'each sweep needs its own reviewer',
    ]);
    const sameMethod = record().reviews.map((r) => ({ ...r, method: 'implementation' as const }));
    expect(releaseProblems(input({ record: record({ reviews: sameMethod }) }))).toEqual([
      'no sweep used the method adversarial-integration',
      'no sweep used the method compatibility-distribution',
    ]);
  });

  /** The evidence with the first sweep changed by `overrides`. */
  function withFirstReview(overrides: Partial<Review>): GateInput {
    const [first, ...rest] = record().reviews;
    if (first === undefined) throw new Error('fixture');
    return input({ record: record({ reviews: [{ ...first, ...overrides }, ...rest] }) });
  }
  const at = 'review 1 (reviewer-1, implementation)';

  it('needs every sweep to be of this revision, cover every area, and keep its report', () => {
    expect(releaseProblems(withFirstReview({ fingerprint: 'b'.repeat(64) }))).toEqual([
      `${at} reviewed another revision`,
    ]);
    expect(releaseProblems(withFirstReview({ areas: ALL_AREAS.filter((a) => a !== 'plugins') }))).toEqual([
      `${at} is not a full sweep: it does not cover plugins`,
    ]);
    expect(releaseProblems(withFirstReview({ areas: [...ALL_AREAS, 'everything'] }))).toEqual([
      `${at} names unknown areas: everything`,
    ]);
    const evidence = input();
    const missing = new Map(evidence.reportHashes);
    missing.set('sweep-1.md', undefined);
    expect(releaseProblems({ ...evidence, reportHashes: missing })).toEqual([
      `${at}: its report sweep-1.md is missing`,
    ]);
    const changed = new Map(evidence.reportHashes);
    changed.set('sweep-1.md', 'f'.repeat(64));
    expect(releaseProblems({ ...evidence, reportHashes: changed })).toEqual([
      `${at}: its report sweep-1.md changed after it was recorded`,
    ]);
  });

  it('refuses an open P1 or P2 finding, and a P3 or P4 one no issue tracks', () => {
    expect(releaseProblems(withFirstReview({ findings: [finding('P1')] }))).toEqual([
      `${at}: open P1 finding F-P1: a P1 finding`,
    ]);
    expect(releaseProblems(withFirstReview({ findings: [finding('P2')] }))).toEqual([
      `${at}: open P2 finding F-P2: a P2 finding`,
    ]);
    for (const severity of ['P3', 'P4'] as const) {
      expect(releaseProblems(withFirstReview({ findings: [finding(severity)] }))).toEqual([
        `${at}: open ${severity} finding F-${severity} names no issue that tracks it`,
      ]);
      const tracked = finding(severity, ISSUE);
      expect(releaseProblems(withFirstReview({ findings: [tracked] }))).toEqual([]);
    }
  });

  it('accepts a finding rejected with its reason, at any severity', () => {
    const findings = (['P1', 'P2', 'P3', 'P4'] as const).map(rejected);
    expect(releaseProblems(withFirstReview({ findings }))).toEqual([]);
  });

  it('refuses repeated finding IDs within a sweep', () => {
    const tracked = finding('P3', ISSUE);
    expect(releaseProblems(withFirstReview({ findings: [tracked, tracked] }))).toEqual([`${at}: finding IDs repeat`]);
  });

  it('counts a sweep’s findings by severity, and the open ones', () => {
    const findings = [rejected('P2'), finding('P3'), { ...finding('P3'), id: 'other' }];
    expect(countFindings(findings)).toEqual({
      total: { P1: 0, P2: 1, P3: 2, P4: 0 },
      open: { P1: 0, P2: 0, P3: 2, P4: 0 },
    });
  });
});

/** Every file below `dir` (relative to the repository, forward slashes), but VitePress's own folder. */
function filesBelow(dir: string): string[] {
  return readdirSync(join(REPO, dir), { recursive: true, encoding: 'utf8' })
    .map((name) => `${dir}/${name.replaceAll('\\', '/')}`)
    .filter((path) => !path.startsWith('docs/.vitepress/') && statSync(join(REPO, path)).isFile());
}

describe('the review areas', () => {
  const covers = (path: string, area: (typeof REVIEW_AREAS)[number]): boolean =>
    area.paths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

  it('assign every product file and documentation page to exactly one area', () => {
    const files = [...filesBelow('src'), ...filesBelow('bin'), ...filesBelow('schemas'), ...filesBelow('docs')];
    const unassigned = files.filter((f) => !REVIEW_AREAS.some((a) => covers(f, a)));
    const twice = files.filter((f) => REVIEW_AREAS.filter((a) => covers(f, a)).length > 1);
    expect({ unassigned, twice }).toEqual({ unassigned: [], twice: [] });
  });

  it('name only paths that exist, and areas with their own IDs', () => {
    const missing = REVIEW_AREAS.flatMap((a) => a.paths).filter((p) => {
      try {
        statSync(join(REPO, p));
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
    expect(new Set(ALL_AREAS).size).toBe(ALL_AREAS.length);
  });
});

describe('the release workflow', () => {
  // A Windows checkout may end its lines with CRLF.
  const workflow = readFileSync(join(REPO, '.github/workflows/release.yml'), 'utf8').replaceAll('\r\n', '\n');
  /** The text of one job: from its `  name:` line to the next job. */
  const job = (name: string): string => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    if (start === -1) throw new Error(`release.yml has no job ${name}`);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
  };

  it('runs the gate, with read access to checks, before the release job', () => {
    expect(job('gate')).toContain('run: pnpm run release:gate');
    expect(job('gate')).toMatch(/checks: read/);
    expect(job('gate')).toMatch(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    expect(job('release')).toMatch(/needs: \[[^\]]*\bgate\b[^\]]*\]/);
  });

  it('gives the release action no trigger but the commit annotation the gate reads', () => {
    const release = job('release');
    expect(release).toContain('uses: tobua/');
    for (const input of ['MANUAL_TRIGGER', 'DEBUG']) expect(release).not.toContain(input);
  });
});

describe('the release gate command', { timeout: 60_000 }, () => {
  let dir = '';
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the gate in a fresh repository whose one commit has `message`. */
  function gateFor(message: string): { readonly status: number | null; readonly output: string } {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-gate-'));
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir });
    };
    git('init', '-q');
    writeFileSync(join(dir, 'README.md'), 'A project\n');
    git('add', '.');
    git('commit', '-q', '-m', message);
    const tsx = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const gate = join(REPO, 'validation', 'release', 'release-gate.ts');
    const run = spawnSync(process.execPath, [tsx, gate], { cwd: dir, encoding: 'utf8', env: { ...process.env } });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  }

  it('passes a push that asks for no release, whatever evidence there is', () => {
    const run = gateFor('fix: an ordinary change\n\nNothing to release here.');
    expect(run.output).toContain('asks for no release');
    expect(run.status).toBe(0);
  });

  it('refuses a release without an evidence record for the revision', () => {
    const run = gateFor(`release: v9.9.9\n\n${RELEASE_ANNOTATION}\n`);
    expect(run.output).toContain('RELEASE BLOCKED: no evidence record under validation/evidence/ is for this revision');
    expect(run.status).toBe(1);
  });
});

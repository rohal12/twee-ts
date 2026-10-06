/**
 * The release gate (docs/compiler-validation.md), run by the release workflow before the release
 * job: it refuses a release unless a committed evidence record covers the revision being released.
 *
 *   pnpm run release:gate                 the workflow's check: passes when the head commit asks for no release
 *   pnpm run release:gate --always        check the evidence whatever the commit message says
 *   pnpm run release:gate --fingerprint [commit]   print a commit's fingerprint (default HEAD)
 *   pnpm run release:gate --checks <commit>        print the record's `checks` for a commit, and what failed
 *
 * It reads the check runs from the GitHub API with GITHUB_TOKEN, for GITHUB_REPOSITORY (default
 * rohal12/twee-ts). The decisions are in gate.ts; this file only gathers their inputs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkProblems,
  countFindings,
  EVIDENCE_DIR,
  fingerprint,
  parseEvidenceRecord,
  parseLsTree,
  releaseProblems,
  releaseRequested,
  requiredRunNames,
  SEVERITIES,
} from './gate.js';
import type { CheckRun, EvidenceRecord, GateInput } from './gate.js';

/** The repository: the working directory, as in the workflow, which runs from its root. */
const REPO = process.cwd();

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The fingerprint of `commit`, fetching it from origin first when this clone does not have it. */
function commitFingerprint(commit: string): string {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    git(['fetch', '--no-tags', '--depth=1', 'origin', commit]);
  }
  return fingerprint(parseLsTree(git(['ls-tree', '-r', '-z', '--full-tree', commit])));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One check run from the API's JSON, or undefined for anything that is not one. */
function toCheckRun(value: unknown): CheckRun | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, status, conclusion } = value;
  if (typeof id !== 'number' || typeof name !== 'string' || typeof status !== 'string') return undefined;
  if (conclusion !== null && typeof conclusion !== 'string') return undefined;
  return { id, name, status, conclusion };
}

/** Every check run of `commit`, page by page. */
async function checkRuns(commit: string): Promise<CheckRun[]> {
  const token = process.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') throw new Error('GITHUB_TOKEN is not set');
  const repository = process.env['GITHUB_REPOSITORY'] ?? 'rohal12/twee-ts';
  const runs: CheckRun[] = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repository}/commits/${commit}/check-runs?per_page=100&page=${String(page)}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`${url} answered ${String(response.status)} ${response.statusText}`);
    const body: unknown = await response.json();
    const list = isRecord(body) ? body['check_runs'] : undefined;
    if (!Array.isArray(list)) throw new Error(`${url} answered no check_runs list`);
    for (const item of list) {
      const run = toCheckRun(item);
      if (run === undefined) throw new Error(`${url} answered a check run that is not one`);
      runs.push(run);
    }
    if (list.length < 100) return runs;
  }
}

/** The JSON of each record under validation/evidence/<release>/record.json, by its path. */
function readRecords(): { readonly path: string; readonly json: unknown }[] {
  const dir = join(REPO, EVIDENCE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => join(dir, entry.name, 'record.json'))
    .filter((path) => existsSync(path))
    .map((path) => {
      try {
        const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
        return { path, json };
      } catch (e) {
        throw new Error(`${path} is not JSON`, { cause: e });
      }
    });
}

function sha256File(path: string): string | undefined {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined;
}

async function gatherInput(path: string, record: EvidenceRecord, headFingerprint: string): Promise<GateInput> {
  let frozen: GateInput['commitFingerprint'];
  try {
    frozen = commitFingerprint(record.commit);
  } catch (e) {
    frozen = { error: errorText(e) };
  }
  let runs: GateInput['checkRuns'];
  try {
    runs = await checkRuns(record.commit);
  } catch (e) {
    runs = { error: errorText(e) };
  }
  const reportHashes = new Map(record.reviews.map((r) => [r.report, sha256File(join(dirname(path), r.report))]));
  return { headFingerprint, record, commitFingerprint: frozen, checkRuns: runs, reportHashes };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      always: { type: 'boolean', default: false },
      fingerprint: { type: 'boolean', default: false },
      checks: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (values.fingerprint) {
    console.log(commitFingerprint(positionals[0] ?? 'HEAD'));
    return 0;
  }
  if (values.checks !== undefined) {
    const runs = await checkRuns(values.checks);
    const names = requiredRunNames(runs);
    console.log(JSON.stringify(names, null, 2));
    const problems = checkProblems(runs, names);
    if (problems.length > 0) console.error(`Not ready:\n- ${problems.join('\n- ')}`);
    return problems.length > 0 ? 1 : 0;
  }
  if (!values.always && !releaseRequested(git(['log', '-1', '--pretty=%B']))) {
    console.log('The head commit asks for no release: the release gate does not apply.');
    return 0;
  }
  const headFingerprint = commitFingerprint('HEAD');
  const matching = readRecords().filter(({ json }) => isRecord(json) && json['fingerprint'] === headFingerprint);
  const [found, ...others] = matching;
  if (found === undefined || others.length > 0) {
    console.error(
      `RELEASE BLOCKED: ${found === undefined ? 'no' : 'more than one'} evidence record under ${EVIDENCE_DIR} ` +
        `is for this revision (fingerprint ${headFingerprint}). See docs/compiler-validation.md.`,
    );
    return 1;
  }
  const parsed = parseEvidenceRecord(found.json);
  if (!parsed.ok) {
    console.error(`RELEASE BLOCKED: ${found.path} is not a valid evidence record:\n- ${parsed.problems.join('\n- ')}`);
    return 1;
  }
  const record = parsed.value;
  const problems = releaseProblems(await gatherInput(found.path, record, headFingerprint));
  console.log(`Evidence: ${found.path} (release ${record.release}, frozen commit ${record.commit})`);
  for (const review of record.reviews) {
    const { total, open } = countFindings(review.findings);
    const counts = SEVERITIES.map((s) => `${s} ${String(total[s])} (${String(open[s])} open)`);
    console.log(`- ${review.method} sweep by ${review.reviewer}: ${counts.join(', ')}`);
  }
  for (const item of record.informational) {
    console.log(
      `- informational, not judged: ${item.source}: ${item.summary}${item.url === undefined ? '' : ` (${item.url})`}`,
    );
  }

  if (problems.length > 0) {
    console.error(`RELEASE BLOCKED:\n- ${problems.join('\n- ')}`);
    return 1;
  }
  console.log('The evidence covers this revision: the release may go ahead.');
  return 0;
}

process.exitCode = await main();

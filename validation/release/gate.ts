/**
 * The release gate's decisions, as pure functions: whether a push asks for a release, the
 * fingerprint of a revision, reading an evidence record, and whether the evidence for a revision
 * lets it be released. validation/release/release-gate.ts gathers the inputs (git, the GitHub API,
 * the files) and acts on the answer. docs/compiler-validation.md describes the process.
 */
import { createHash } from 'node:crypto';
import { REVIEW_AREAS } from './areas.js';

// --- The release annotation ---

/**
 * The annotation that makes the release action publish. Assembled from its parts so that no file
 * contains it: the action matches it anywhere in a commit message, so text quoting it releases.
 */
export const RELEASE_ANNOTATION = ['release', 'npm'].join('-');

/**
 * Whether the release action will publish for a head commit with this message: exactly the
 * action's own test (the message `git log -1 --pretty=%B` prints includes the annotation:
 * `getRelease` in the action's release.js, v5). The workflow sets neither of the action's other
 * triggers (`MANUAL_TRIGGER`, `DEBUG`), which test/release-gate.test.ts checks.
 */
export function releaseRequested(commitMessage: string): boolean {
  return commitMessage.includes(RELEASE_ANNOTATION);
}

// --- Fingerprints ---

/** One file of a commit's tree, as `git ls-tree -r` lists it. */
export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
  readonly path: string;
}

/** Reads `git ls-tree -r -z --full-tree <commit>` output. */
export function parseLsTree(output: string): TreeEntry[] {
  return output
    .split('\0')
    .filter((line) => line !== '')
    .map((line) => {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(line);
      if (match === null) throw new Error(`unexpected git ls-tree line: ${JSON.stringify(line)}`);
      const [, mode = '', type = '', object = '', path = ''] = match;
      return { mode, type, object, path };
    });
}

/** Where the evidence records and their review reports live. */
export const EVIDENCE_DIR = 'validation/evidence/';

/**
 * Files a fingerprint leaves out: the evidence itself, which is written after the revision it
 * describes was frozen, and the changelog, which is written for the release.
 */
function isOutsideFingerprint(path: string): boolean {
  return path.startsWith(EVIDENCE_DIR) || path === 'CHANGELOG.md';
}

/**
 * The fingerprint of a revision: SHA-256 over every file of its tree (path, mode and blob) except
 * the evidence and the changelog. Two commits with the same product, tests, validation, workflows
 * and documentation have the same fingerprint, so evidence recorded for a frozen commit still
 * describes the commit that adds the evidence, or a squash merge of it.
 */
export function fingerprint(entries: readonly TreeEntry[]): string {
  const hash = createHash('sha256');
  const included = entries.filter((e) => !isOutsideFingerprint(e.path));
  const sorted = [...included].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const e of sorted) hash.update(`${e.mode} ${e.type} ${e.object}\t${e.path}\0`);
  return hash.digest('hex');
}

// --- Evidence records ---

const REVIEW_METHODS = ['implementation', 'adversarial-integration', 'compatibility-distribution'] as const;
type ReviewMethod = (typeof REVIEW_METHODS)[number];

export const SEVERITIES = ['P1', 'P2', 'P3', 'P4'] as const;
type Severity = (typeof SEVERITIES)[number];

/** P1 and P2 findings block a release until they are fixed (in a new revision) or rejected. */
const BLOCKING: ReadonlySet<Severity> = new Set(['P1', 'P2']);

/**
 * A finding of a sweep. `open`: it stands (a P3/P4 needs the issue that tracks it). `rejected`: on
 * inspection not a defect, with the reason. A fixed finding is not on this revision: fixing it
 * makes a new revision, which needs new sweeps.
 */
export type Finding =
  | {
      readonly id: string;
      readonly severity: Severity;
      readonly title: string;
      readonly status: 'open';
      readonly issue?: string;
    }
  | {
      readonly id: string;
      readonly severity: Severity;
      readonly title: string;
      readonly status: 'rejected';
      readonly reason: string;
    };

/** One full review sweep of the frozen revision. */
export interface Review {
  readonly reviewer: string;
  readonly method: ReviewMethod;
  /** The fingerprint of the revision the sweep reviewed. */
  readonly fingerprint: string;
  readonly completedAt: string;
  /** The review areas (validation/release/areas.ts) the sweep covered. */
  readonly areas: readonly string[];
  /** The sweep's report, relative to the record's folder. */
  readonly report: string;
  readonly reportSha256: string;
  readonly findings: readonly Finding[];
}

/** validation/evidence/<release>/record.json. */
export interface EvidenceRecord {
  readonly schemaVersion: 1;
  /** The version this evidence is for, as the release PR names it. */
  readonly release: string;
  /** The frozen commit the checks ran on and the sweeps reviewed. */
  readonly commit: string;
  readonly fingerprint: string;
  /** The names of the required checks that passed on `commit`. */
  readonly checks: readonly string[];
  readonly reviews: readonly Review[];
  /**
   * Evidence the gate shows but never judges, such as the mutation scores of the frozen commit
   * against mutation-baseline.json (`pnpm run mutation:summary`). Optional in the JSON.
   */
  readonly informational: readonly InformationalEvidence[];
}

/** One informational source: what it is, what it said, and where to see it. */
interface InformationalEvidence {
  readonly source: string;
  readonly summary: string;
  readonly url?: string;
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: string[] };

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads fields of an untrusted object, collecting a problem for each one that is missing or wrong. */
class FieldReader {
  constructor(
    private readonly object: Readonly<Record<string, unknown>>,
    private readonly at: string,
    private readonly problems: string[],
  ) {}

  string(key: string, pattern?: RegExp): string {
    const value = this.object[key];
    if (typeof value === 'string' && value.trim() !== '' && (pattern === undefined || pattern.test(value))) {
      return value;
    }
    this.problems.push(
      `${this.at}.${key} must be ${pattern === undefined ? 'a non-empty string' : `a string matching ${String(pattern)}`}`,
    );
    return '';
  }

  optionalString(key: string): string | undefined {
    return this.object[key] === undefined ? undefined : this.string(key);
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T | undefined {
    const value = this.object[key];
    const found = allowed.find((a) => a === value);
    if (found === undefined) this.problems.push(`${this.at}.${key} must be one of ${allowed.join(', ')}`);
    return found;
  }

  list(key: string): readonly unknown[] {
    const value = this.object[key];
    if (Array.isArray(value)) return value;
    this.problems.push(`${this.at}.${key} must be a list`);
    return [];
  }

  strings(key: string): string[] {
    return this.list(key).flatMap((item, i) => {
      if (typeof item === 'string' && item !== '') return [item];
      this.problems.push(`${this.at}.${key}[${String(i)}] must be a non-empty string`);
      return [];
    });
  }

  /** Each item of the list `key`, read as an object by `read`; items that are not objects are problems. */
  objects<T>(key: string, read: (fields: FieldReader) => T | undefined): T[] {
    return this.list(key).flatMap((item, i) => {
      const at = `${this.at}.${key}[${String(i)}]`;
      if (!isRecord(item)) {
        this.problems.push(`${at} must be an object`);
        return [];
      }
      const value = read(new FieldReader(item, at, this.problems));
      return value === undefined ? [] : [value];
    });
  }
}

function readFinding(fields: FieldReader): Finding | undefined {
  const id = fields.string('id');
  const severity = fields.oneOf('severity', SEVERITIES);
  const title = fields.string('title');
  const status = fields.oneOf('status', ['open', 'rejected'] as const);
  if (severity === undefined || status === undefined) return undefined;
  switch (status) {
    case 'open': {
      const issue = fields.optionalString('issue');
      return { id, severity, title, status, ...(issue === undefined ? {} : { issue }) };
    }
    case 'rejected':
      return { id, severity, title, status, reason: fields.string('reason') };
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled finding status: ${_exhaustive}`);
    }
  }
}

function readInformational(fields: FieldReader): InformationalEvidence {
  const source = fields.string('source');
  const summary = fields.string('summary');
  const url = fields.optionalString('url');
  return url === undefined ? { source, summary } : { source, summary, url };
}

function readReview(fields: FieldReader): Review | undefined {
  const reviewer = fields.string('reviewer');
  const method = fields.oneOf('method', REVIEW_METHODS);
  const review = {
    fingerprint: fields.string('fingerprint', SHA256),
    completedAt: fields.string('completedAt'),
    areas: fields.strings('areas'),
    report: fields.string('report'),
    reportSha256: fields.string('reportSha256', SHA256),
    findings: fields.objects('findings', readFinding),
  };
  return method === undefined ? undefined : { reviewer, method, ...review };
}

/** Reads an evidence record from untrusted JSON, or says everything that is wrong with it. */
export function parseEvidenceRecord(json: unknown): Parsed<EvidenceRecord> {
  if (!isRecord(json)) return { ok: false, problems: ['the record must be a JSON object'] };
  const problems: string[] = [];
  if (json['schemaVersion'] !== 1) problems.push('record.schemaVersion must be 1');
  const fields = new FieldReader(json, 'record', problems);
  const record: EvidenceRecord = {
    schemaVersion: 1,
    release: fields.string('release'),
    commit: fields.string('commit', SHA1),
    fingerprint: fields.string('fingerprint', SHA256),
    checks: fields.strings('checks'),
    reviews: fields.objects('reviews', readReview),
    informational: json['informational'] === undefined ? [] : fields.objects('informational', readInformational),
  };
  return problems.length === 0 ? { ok: true, value: record } : { ok: false, problems };
}

// --- Checks ---

/** A check run on the frozen commit, as the GitHub API lists it. */
export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/**
 * The checks a release needs, by name prefix: every check run named so, or so followed by a space
 * (`test (ubuntu-latest, Node 22)`, `package / pack`), must have passed, and there must be one.
 * They are the jobs of ci.yml (with package.yml) and duplication.yml.
 */
export const REQUIRED_CHECKS: readonly string[] = [
  'lint',
  'test',
  'coverage',
  'package',
  'plugin peers',
  'contracts',
  'duplication',
];

const PASSED: ReadonlySet<string | null> = new Set(['success', 'neutral', 'skipped']);

/** Whether the check run `name` is one of the required check `prefix`. */
function isRunOf(name: string, prefix: string): boolean {
  return name === prefix || name.startsWith(`${prefix} `);
}

function isRequired(name: string): boolean {
  return REQUIRED_CHECKS.some((prefix) => isRunOf(name, prefix));
}

/** The latest run of each check name: a re-run replaces the run it repeats. */
function latestRuns(runs: readonly CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const seen = latest.get(run.name);
    if (seen === undefined || run.id > seen.id) latest.set(run.name, run);
  }
  return [...latest.values()];
}

/** The names of the required check runs (the latest of each), sorted: what a record lists. */
export function requiredRunNames(runs: readonly CheckRun[]): string[] {
  return latestRuns(runs)
    .map((run) => run.name)
    .filter(isRequired)
    .sort();
}

/**
 * What is wrong with the checks of the frozen commit: a run that did not pass (required or not), a
 * required check with no run, and a difference between the passing required runs and the record's list.
 */
export function checkProblems(runs: readonly CheckRun[], listed: readonly string[]): string[] {
  const latest = latestRuns(runs);
  const problems = latest
    .filter((run) => run.status !== 'completed' || !PASSED.has(run.conclusion))
    .map(
      (run) =>
        `check "${run.name}" did not pass (${run.status}${run.conclusion === null ? '' : `, ${run.conclusion}`})`,
    );
  for (const prefix of REQUIRED_CHECKS) {
    if (!latest.some((run) => isRunOf(run.name, prefix))) {
      problems.push(`required check "${prefix}" has no run on the frozen commit`);
    }
  }
  const required = new Set(requiredRunNames(runs));
  const recorded = new Set(listed);
  for (const name of required) if (!recorded.has(name)) problems.push(`the record does not list the check "${name}"`);
  for (const name of recorded)
    if (!required.has(name)) problems.push(`the record lists "${name}", which is not a required check run`);
  return problems;
}

// --- The decision ---

/** What the gate knows about the revision being released, gathered by release-gate.ts. */
export interface GateInput {
  /** The fingerprint of the commit the workflow releases. */
  readonly headFingerprint: string;
  readonly record: EvidenceRecord;
  /** The fingerprint of the record's frozen commit, or why it could not be computed. */
  readonly commitFingerprint: string | { readonly error: string };
  /** The check runs of the frozen commit, or why they could not be read. */
  readonly checkRuns: readonly CheckRun[] | { readonly error: string };
  /** The SHA-256 of each review report the record names, by its `report` path; undefined if it is missing. */
  readonly reportHashes: ReadonlyMap<string, string | undefined>;
}

/** A sweep's findings by severity, and how many of them are open. */
export interface FindingCounts {
  readonly total: Readonly<Record<Severity, number>>;
  readonly open: Readonly<Record<Severity, number>>;
}

export function countFindings(findings: readonly Finding[]): FindingCounts {
  const zero = (): Record<Severity, number> => ({ P1: 0, P2: 0, P3: 0, P4: 0 });
  const total = zero();
  const open = zero();
  for (const f of findings) {
    total[f.severity] += 1;
    if (f.status === 'open') open[f.severity] += 1;
  }
  return { total, open };
}

function reviewProblems(review: Review, index: number, input: GateInput): string[] {
  const at = `review ${String(index + 1)} (${review.reviewer}, ${review.method})`;
  const problems: string[] = [];
  if (review.fingerprint !== input.record.fingerprint) problems.push(`${at} reviewed another revision`);
  const missing = REVIEW_AREAS.map((a) => a.id).filter((id) => !review.areas.includes(id));
  if (missing.length > 0) problems.push(`${at} is not a full sweep: it does not cover ${missing.join(', ')}`);
  const unknown = review.areas.filter((id) => !REVIEW_AREAS.some((a) => a.id === id));
  if (unknown.length > 0) problems.push(`${at} names unknown areas: ${unknown.join(', ')}`);
  const hash = input.reportHashes.get(review.report);
  if (hash === undefined) problems.push(`${at}: its report ${review.report} is missing`);
  else if (hash !== review.reportSha256)
    problems.push(`${at}: its report ${review.report} changed after it was recorded`);
  for (const f of review.findings) {
    if (f.status === 'open' && BLOCKING.has(f.severity))
      problems.push(`${at}: open ${f.severity} finding ${f.id}: ${f.title}`);
    if (f.status === 'open' && !BLOCKING.has(f.severity) && f.issue === undefined) {
      problems.push(`${at}: open ${f.severity} finding ${f.id} names no issue that tracks it`);
    }
  }
  const ids = review.findings.map((f) => f.id);
  if (new Set(ids).size !== ids.length) problems.push(`${at}: finding IDs repeat`);
  return problems;
}

/**
 * Whether the evidence lets this revision be released: the record is for this revision and its
 * frozen commit, every check of that commit passed and the record lists the required ones, and at
 * least three full sweeps of the revision by different reviewers, one by each method, left no P1 or
 * P2 finding open. Returns every problem; none means the release may go ahead.
 */
export function releaseProblems(input: GateInput): string[] {
  const { record } = input;
  const problems: string[] = [];
  if (record.fingerprint !== input.headFingerprint) {
    problems.push(`the record is for revision ${record.fingerprint}, not this one (${input.headFingerprint})`);
  }
  if (typeof input.commitFingerprint !== 'string') {
    problems.push(`the frozen commit ${record.commit} cannot be read: ${input.commitFingerprint.error}`);
  } else if (input.commitFingerprint !== record.fingerprint) {
    problems.push(
      `the frozen commit ${record.commit} has the fingerprint ${input.commitFingerprint}, not the record's`,
    );
  }
  if ('error' in input.checkRuns)
    problems.push(`the checks of ${record.commit} cannot be read: ${input.checkRuns.error}`);
  else problems.push(...checkProblems(input.checkRuns, record.checks));

  problems.push(...record.reviews.flatMap((review, i) => reviewProblems(review, i, input)));
  if (record.reviews.length < 3)
    problems.push(`three full review sweeps are needed; the record has ${String(record.reviews.length)}`);
  const reviewers = record.reviews.map((r) => r.reviewer.trim().toLowerCase());
  if (new Set(reviewers).size !== reviewers.length) problems.push('each sweep needs its own reviewer');
  for (const method of REVIEW_METHODS) {
    if (!record.reviews.some((r) => r.method === method)) problems.push(`no sweep used the method ${method}`);
  }
  return problems;
}

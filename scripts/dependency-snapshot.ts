/**
 * The packages pnpm-lock.yaml installs, as a snapshot for GitHub's dependency submission API. pnpm 12 starts
 * pnpm-lock.yaml with a YAML document of its own (the pnpm version it pins), and GitHub's dependency graph reads only
 * that first document: without the snapshot, no npm package gets Dependabot alerts and dependency review does not
 * see them change.
 *
 *   pnpm ls --lockfile-only --json --depth Infinity | node scripts/dependency-snapshot.ts > snapshot.json
 *
 * The snapshot describes the commit SNAPSHOT_SHA (else GITHUB_SHA) and the workflow run in the GITHUB_* variables
 * Actions sets. The packages bundled into dist/ (BUNDLED_PACKAGES) and the packages they depend on are `runtime`,
 * every other package `development`. It runs with Node alone, without installed packages.
 */
import { readFileSync } from 'node:fs';
import { BUNDLED_PACKAGES } from './third-party-notices.mjs';

type ListedDependencies = Readonly<Record<string, ListedPackage>> | undefined;

/**
 * A package in the tree `pnpm ls --json` prints: `from` is its name in the registry (the key may be an alias). A
 * package that appears more than once lists its dependencies only where it first appears (later ones are `deduped`).
 */
export interface ListedPackage {
  readonly from: string;
  readonly version: string;
  readonly dependencies?: ListedDependencies;
  readonly optionalDependencies?: ListedDependencies;
}

/** The project `pnpm ls --json` prints, with the packages it depends on directly. */
export interface ListedProject {
  readonly dependencies?: ListedDependencies;
  readonly devDependencies?: ListedDependencies;
  readonly optionalDependencies?: ListedDependencies;
}

/** A package in a snapshot manifest. */
export interface Resolved {
  readonly package_url: string;
  readonly relationship: 'direct' | 'indirect';
  readonly scope: 'runtime' | 'development';
  readonly dependencies: readonly string[];
}

/** A version from the registry; a `link:`, `file:` or git dependency has none. */
const REGISTRY_VERSION = /^[\w.+-]+$/;

/** The workflow run variables a snapshot needs. */
const RUN_VARIABLES = [
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_WORKFLOW',
  'GITHUB_JOB',
  'GITHUB_RUN_ID',
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
] as const;

/** The package URL of a registry package, or `undefined` for any other. */
export function packageUrl(pkg: ListedPackage): string | undefined {
  if (!REGISTRY_VERSION.test(pkg.version)) return undefined;
  return `pkg:npm/${pkg.from.replace(/^@/, '%40')}@${encodeURIComponent(pkg.version)}`;
}

function listed(...groups: readonly ListedDependencies[]): ListedPackage[] {
  return groups.flatMap((group) => Object.values(group ?? {}));
}

/**
 * Every registry package in the tree of `project`, by package URL. `bundled` names the packages dist/ contains:
 * those and their dependencies are `runtime`.
 */
export function resolvedDependencies(project: ListedProject, bundled: readonly string[]): Record<string, Resolved> {
  // The dependencies of every occurrence, so that a deduped package has those it was listed with elsewhere.
  const graph = new Map<string, { readonly name: string; readonly dependencies: Set<string> }>();
  const visit = (pkg: ListedPackage): string | undefined => {
    const url = packageUrl(pkg);
    if (url === undefined) return undefined;
    const node = graph.get(url) ?? { name: pkg.from, dependencies: new Set<string>() };
    graph.set(url, node);
    for (const dependency of listed(pkg.dependencies, pkg.optionalDependencies)) {
      const dependencyUrl = visit(dependency);
      if (dependencyUrl !== undefined) node.dependencies.add(dependencyUrl);
    }
    return url;
  };
  const direct = new Set(
    listed(project.dependencies, project.devDependencies, project.optionalDependencies).flatMap(
      (pkg) => visit(pkg) ?? [],
    ),
  );
  // The bundle starts at the direct dependencies src/ imports; the rest of it is what they depend on (another
  // version of a bundled package's dependency, used only by a tool, is not in it).
  const runtime = new Set<string>();
  // Grows while it is read: the dependencies of each runtime package found
  const pending = [...direct].filter((url) => bundled.includes(graph.get(url)?.name ?? ''));
  for (const url of pending) {
    if (runtime.has(url)) continue;
    runtime.add(url);
    pending.push(...(graph.get(url)?.dependencies ?? []));
  }
  return Object.fromEntries(
    [...graph].map(([url, node]): [string, Resolved] => [
      url,
      {
        package_url: url,
        relationship: direct.has(url) ? 'direct' : 'indirect',
        scope: runtime.has(url) ? 'runtime' : 'development',
        dependencies: [...node.dependencies].sort(),
      },
    ]),
  );
}

/** The snapshot of `project` to submit from the workflow run `env` describes. */
export function snapshot(project: ListedProject, env: Readonly<Record<string, string | undefined>>, scanned: Date) {
  const run = Object.fromEntries(
    RUN_VARIABLES.map((name) => {
      const value = env[name];
      if (value === undefined || value === '') throw new Error(`${name} is not set: run this in a workflow`);
      return [name, value];
    }),
  ) as Readonly<Record<(typeof RUN_VARIABLES)[number], string>>;
  const sha = env['SNAPSHOT_SHA'];
  return {
    version: 0,
    sha: sha === undefined || sha === '' ? run.GITHUB_SHA : sha,
    ref: run.GITHUB_REF,
    job: { correlator: `${run.GITHUB_WORKFLOW} ${run.GITHUB_JOB}`, id: run.GITHUB_RUN_ID },
    detector: {
      name: 'twee-ts pnpm-lock.yaml',
      version: '1',
      url: `${run.GITHUB_SERVER_URL}/${run.GITHUB_REPOSITORY}/blob/main/scripts/dependency-snapshot.ts`,
    },
    scanned: scanned.toISOString(),
    manifests: {
      'pnpm-lock.yaml': {
        name: 'pnpm-lock.yaml',
        file: { source_location: 'pnpm-lock.yaml' },
        resolved: resolvedDependencies(project, BUNDLED_PACKAGES),
      },
    },
  };
}

if (import.meta.main) {
  const projects: unknown = JSON.parse(readFileSync(0, 'utf8'));
  const project: unknown = Array.isArray(projects) && projects.length === 1 ? projects[0] : undefined;
  if (typeof project !== 'object' || project === null) {
    throw new Error('Expected the output of `pnpm ls --json` for one project on standard input');
  }
  process.stdout.write(JSON.stringify(snapshot(project, process.env, new Date())));
}

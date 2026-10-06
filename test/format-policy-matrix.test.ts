/**
 * The documented format selection policy (docs/story-formats.md, "How a Format Is Chosen"), checked
 * over the cross product of request kind × candidate version relation × source kind × mode
 * (online, noRemote, network down) × cache state × failure mode, through the public API with
 * loopback servers and temporary caches.
 *
 * The expected answer comes from a small reference model of the policy written here, which does not
 * import the selection code: versions come from a fixed table whose precedence is spelled out.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { resolveRemoteFormat } from '../src/format-resolution.js';
import { clearIndexCache } from '../src/remote-formats.js';
import type { CompileOptions, Diagnostic, FormatRequest } from '../src/types.js';
import type { FormatServer, Route } from './helpers/format-server.js';
import {
  isolateFormatEnvironment,
  entryPath,
  formatJs,
  guardNetwork,
  indexEntry,
  indexJson,
  markerOf,
  SFA_OFFICIAL,
  SFA_OFFICIAL_BASE,
  startFormatServer,
  storySource,
} from './helpers/format-server.js';

// --- The reference model ---

/** Every version the matrix uses, in ascending precedence; versions in one group are equal. */
const PRECEDENCE: readonly (readonly string[])[] = [
  ['1.9.0'],
  ['2.0.0'],
  ['2.0.5'],
  ['2.1.0-rc.1'],
  ['2.1.0', 'v2.1.0', '2.1.0+b7'],
  ['2.2.0-rc.1'],
  ['2.3.0'],
  ['3.0.0'],
];

function precedenceOf(version: string): number {
  const rank = PRECEDENCE.findIndex((group) => group.includes(version));
  if (rank === -1) throw new Error(`the model does not know version ${version}`);
  return rank;
}

const majorOf = (version: string): string => version.replace(/^v/, '').split('.')[0] ?? '';

/** The source kinds, in the order the policy consults them (their rank). */
const SOURCES = ['local', 'url', 'index', 'sfa'] as const;
type SourceKind = (typeof SOURCES)[number];

interface ModelCandidate {
  readonly source: SourceKind;
  readonly name: string;
  readonly version: string;
  readonly marker: string;
}

interface ModelAnswer {
  readonly marker: string;
  readonly older: boolean;
}

type Tier = 'exact' | 'newer' | 'any' | 'id' | 'older';
const TIERS: readonly Tier[] = ['exact', 'newer', 'any', 'id', 'older'];

/** The tier a candidate answers a request in, by the documented rules, or undefined. */
function modelTier(request: FormatRequest, c: ModelCandidate): Tier | undefined {
  if (request.kind === 'id') {
    return `${c.name.toLowerCase()}-${majorOf(c.version)}` === request.id.toLowerCase() ? 'id' : undefined;
  }
  if (c.name.toLowerCase() !== request.name.toLowerCase()) return undefined;
  if (!PRECEDENCE.flat().includes(request.version)) return 'any';
  if (majorOf(c.version) !== majorOf(request.version)) return undefined;
  const order = precedenceOf(c.version) - precedenceOf(request.version);
  return order === 0 ? 'exact' : order > 0 ? 'newer' : 'older';
}

/**
 * The policy: among candidates that answer in a tier other than `older`, the earliest source wins,
 * then the better tier, then the greater version; only when there is none, an `older` one, by the
 * same order, with a warning.
 */
function model(request: FormatRequest, candidates: readonly ModelCandidate[]): ModelAnswer | undefined {
  const judged = candidates.flatMap((c) => {
    const tier = modelTier(request, c);
    return tier ? [{ c, tier }] : [];
  });
  const order = (a: (typeof judged)[number], b: (typeof judged)[number]): number =>
    SOURCES.indexOf(a.c.source) - SOURCES.indexOf(b.c.source) ||
    TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) ||
    precedenceOf(b.c.version) - precedenceOf(a.c.version);
  const best = judged.filter((j) => j.tier !== 'older').sort(order)[0] ?? judged.sort(order)[0];
  return best && { marker: best.c.marker, older: best.tier === 'older' };
}

// --- Running a row through the real implementation ---

const tempRoot = isolateFormatEnvironment('format-matrix');

/** A world of sources holding the given candidates, with knobs for failures. */
interface World {
  readonly server: FormatServer;
  readonly options: Partial<CompileOptions>;
  /** The candidates' format files, by source, for tests that break them. */
  readonly urlPath: string;
  readonly indexPath: string;
  /** The SFA stand-in's table, for the network guard. */
  readonly sfa: Record<string, string>;
  /** Non-loopback requests made. */
  external: string[];
}

const NAME = 'SugarCube';

async function buildWorld(candidates: readonly ModelCandidate[], prefix = ''): Promise<World> {
  const routes: Record<string, Route> = {};
  const sfa: Record<string, string> = {};
  const options: { formatPaths: string[]; formatUrls: string[]; formatIndices: string[] } = {
    formatPaths: [],
    formatUrls: [],
    formatIndices: [],
  };
  const indexEntries: unknown[] = [];
  const sfaEntries: unknown[] = [];
  const urlPath = `/${prefix}u/format.js`;
  const indexPath = `/${prefix}i/index.json`;
  const server = await startFormatServer();
  for (const c of candidates) {
    const text = formatJs(c.name, c.version, c.marker);
    switch (c.source) {
      case 'local': {
        const dir = join(tempRoot(), `${prefix}formats`);
        mkdirSync(join(dir, `fmt-${c.marker}`), { recursive: true });
        writeFileSync(join(dir, `fmt-${c.marker}`, 'format.js'), text);
        options.formatPaths = [dir];
        break;
      }
      case 'url':
        routes[urlPath] = text;
        options.formatUrls = [`${server.origin}${urlPath}`];
        break;
      case 'index':
        indexEntries.push(indexEntry(c.name, c.version, text));
        routes[`/${prefix}i/${entryPath(c.name, c.version)}`] = text;
        options.formatIndices = [`${server.origin}${indexPath}`];
        break;
      case 'sfa':
        sfaEntries.push(indexEntry(c.name, c.version, text));
        sfa[`${SFA_OFFICIAL_BASE}/${entryPath(c.name, c.version)}`] = text;
        break;
      default: {
        const _exhaustive: never = c.source;
        throw new Error(`unhandled source ${String(_exhaustive)}`);
      }
    }
  }
  if (indexEntries.length > 0) routes[indexPath] = indexJson(indexEntries);
  if (sfaEntries.length > 0) sfa[SFA_OFFICIAL] = indexJson(sfaEntries);
  for (const [path, route] of Object.entries(routes)) server.routes.set(path, route);
  const external = guardNetwork(sfa);
  return { server, options, urlPath, indexPath, sfa, external };
}

interface Outcome {
  readonly marker: string | undefined;
  readonly older: boolean;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

const requestOptions = (request: FormatRequest): Pick<CompileOptions, 'sources' | 'formatId'> =>
  request.kind === 'id'
    ? { formatId: request.id, sources: storySource() }
    : { sources: storySource(request.name, request.version) };

async function run(request: FormatRequest, options: Partial<CompileOptions>): Promise<Outcome> {
  clearIndexCache();
  const summarise = (diagnostics: readonly Diagnostic[], marker: string | undefined): Outcome => ({
    marker,
    older: diagnostics.some((d) => d.message.includes('is not available; using')),
    warnings: diagnostics.filter((d) => d.level === 'warning').map((d) => d.message),
    errors: diagnostics.filter((d) => d.level === 'error').map((d) => d.message),
  });
  try {
    const result = await compile({ useTweegoPath: false, ...requestOptions(request), ...options });
    return summarise(result.diagnostics, markerOf(result.output));
  } catch (e) {
    const diagnostics: readonly Diagnostic[] =
      typeof e === 'object' && e !== null && 'diagnostics' in e && Array.isArray(e.diagnostics) ? e.diagnostics : [];
    if (diagnostics.length === 0) throw e;
    return summarise(diagnostics, undefined);
  }
}

function expectOutcome(outcome: Outcome, expected: ModelAnswer | undefined): void {
  expect(outcome.marker).toBe(expected?.marker);
  expect(outcome.older).toBe(expected?.older ?? false);
  if (!expected) expect(outcome.errors.join('\n')).toMatch(/is not available/);
}

// --- Table A: one candidate, every source kind, mode and cache state ---

const RELATIONS: readonly (readonly [string, string])[] = [
  ['exact', '2.1.0'],
  ['exact with v', 'v2.1.0'],
  ['exact with build metadata', '2.1.0+b7'],
  ['newer', '2.3.0'],
  ['newer prerelease', '2.2.0-rc.1'],
  ['prerelease of the requested', '2.1.0-rc.1'],
  ['older', '2.0.0'],
  ['next major', '3.0.0'],
  ['previous major', '1.9.0'],
];
const MODES = ['online', 'noRemote', 'network down'] as const;
const CACHES = ['empty', 'primed', 'primed by another origin'] as const;
const WANTED: FormatRequest = { kind: 'name', name: NAME, version: '2.1.0' };

describe('table A: one candidate × source × mode × cache state', () => {
  const rows = SOURCES.flatMap((source) =>
    RELATIONS.flatMap(([relation, version]) =>
      MODES.flatMap((mode) => CACHES.map((cache) => ({ source, relation, version, mode, cache }))),
    ),
  );

  it.each(rows)('$source $relation ($version), $mode, cache $cache', async ({ source, version, mode, cache }) => {
    const candidate: ModelCandidate = { source, name: NAME, version, marker: 'C' };
    if (cache === 'primed by another origin' && source !== 'local' && source !== 'sfa') {
      // Another project's index or URL with the same name and version, downloaded earlier.
      const other = await buildWorld([{ ...candidate, marker: 'OTHER' }], 'other-');
      await run(WANTED, other.options);
      await other.server.close();
    }
    const world = await buildWorld([candidate]);
    if (cache === 'primed') await run(WANTED, world.options);
    world.server.log.length = 0;
    world.external.length = 0;

    if (mode === 'network down') {
      await world.server.close();
      world.external = guardNetwork({}, { offline: true });
    }
    const outcome = await run(WANTED, { ...world.options, noRemote: mode === 'noRemote' });

    // Online, the answer never depends on the cache; offline, a source answers only from its own cache.
    const reachable = source === 'local' || mode === 'online' || cache === 'primed';
    const expected = reachable ? model(WANTED, [candidate]) : undefined;
    expectOutcome(outcome, expected);
    // No request at all with remote fetching off, or when a local format answers.
    const requests = [...world.server.log, ...world.external];
    const quiet = mode === 'noRemote' || (source === 'local' && expected !== undefined && !expected.older);
    expect(quiet ? requests : []).toEqual([]);
    // A source that cannot be reached is reported, even when its cached copy answers.
    const reported = outcome.warnings.some((w) => w.includes('Remote format fetch failed'));
    expect(reported || !(mode === 'network down' && source !== 'local' && expected !== undefined)).toBe(true);
    // An index entry already downloaded from the same index is not downloaded again.
    const cachedEntry = mode === 'online' && source === 'index' && cache === 'primed' && expected !== undefined;
    expect(cachedEntry ? world.server.log : [world.indexPath]).toEqual([world.indexPath]);
  });
});

// --- Table B: every request kind, online, empty cache ---

describe('table B: request kind × relation × source', () => {
  const requests: readonly (readonly [string, FormatRequest])[] = [
    ['name in other letter case', { kind: 'name', name: 'sugarcube', version: '2.1.0' }],
    ['ID', { kind: 'id', id: 'sugarcube-2' }],
    ['ID in other letter case', { kind: 'id', id: 'SugarCube-2' }],
    ['unparseable version', { kind: 'name', name: NAME, version: '2.x' }],
    ['no version', { kind: 'name', name: NAME, version: '' }],
  ];
  const rows = requests.flatMap(([label, request]) =>
    RELATIONS.flatMap(([relation, version]) =>
      SOURCES.map((source) => ({ label, request, relation, version, source })),
    ),
  );

  it.each(rows)('$label: $source $relation ($version)', async ({ request, version, source }) => {
    const candidate: ModelCandidate = { source, name: NAME, version, marker: 'C' };
    const world = await buildWorld([candidate]);
    const outcome = await run(request, world.options);
    expectOutcome(outcome, model(request, [candidate]));
    const unversioned = request.kind === 'name' && !PRECEDENCE.flat().includes(request.version);
    expect(outcome.warnings.some((w) => w.includes('Auto-selecting greatest version'))).toBe(unversioned);
  });

  const remoteRows = requests.flatMap(([label, request]) =>
    request.kind === 'name'
      ? RELATIONS.flatMap(([relation, version]) =>
          (['url', 'index', 'sfa'] as const).map((source) => ({ label, request, relation, version, source })),
        )
      : [],
  );

  it.each(remoteRows)(
    'resolveRemoteFormat agrees with a compile (I6) — $label: $source $relation ($version)',
    async ({ request, version, source }) => {
      const candidate: ModelCandidate = { source, name: NAME, version, marker: 'C' };
      const world = await buildWorld([candidate]);
      const compiled = await run(request, world.options);
      clearIndexCache();
      const remote = await resolveRemoteFormat(
        request.name,
        request.version,
        world.options.formatIndices,
        world.options.formatUrls,
      );
      expect(remote?.version).toBe(compiled.marker === undefined ? undefined : version);
    },
  );
});

// --- Table C: failures, with and without a primed cache ---

type Failure = 'format 404' | 'index 500' | 'unreachable' | 'checksum changed' | 'identity' | 'html' | 'timeout';

/** For each source and failure: whether a cache primed from the same source still answers. */
const FAILURES: readonly (readonly [Exclude<SourceKind, 'local' | 'sfa'>, Failure, boolean])[] = [
  ['url', 'format 404', true],
  ['url', 'unreachable', true],
  ['url', 'html', true],
  ['url', 'timeout', true],
  ['index', 'format 404', true],
  ['index', 'index 500', true],
  ['index', 'unreachable', true],
  ['index', 'html', true],
  ['index', 'timeout', true],
  ['index', 'checksum changed', false],
  ['index', 'identity', false],
];

describe('table C: failure × source × cache state', () => {
  const rows = FAILURES.flatMap(([source, failure, primedAnswers]) =>
    (['empty', 'primed'] as const).flatMap((cache) =>
      (['2.1.0', '2.0.0'] as const).map((version) => ({ source, failure, primedAnswers, cache, version })),
    ),
  );

  it.each(rows)('$source $failure, cache $cache, candidate $version', async (row) => {
    const { source, failure, cache, version } = row;
    const candidate: ModelCandidate = { source, name: NAME, version, marker: 'C' };
    const world = await buildWorld([candidate]);
    if (cache === 'primed') await run(WANTED, world.options);
    const formatPath = source === 'url' ? world.urlPath : `/i/${entryPath(NAME, version)}`;
    const hang: Route = () => {
      // Never answers; the request times out.
    };
    switch (failure) {
      case 'format 404':
        world.server.routes.delete(formatPath);
        break;
      case 'index 500':
        world.server.routes.set(world.indexPath, (_req, res) => {
          res.statusCode = 500;
          res.end('broken');
        });
        break;
      case 'unreachable':
        await world.server.close();
        break;
      case 'html':
        world.server.routes.set(source === 'url' ? world.urlPath : world.indexPath, '<!doctype html><p>moved');
        break;
      case 'timeout':
        world.server.routes.set(source === 'url' ? world.urlPath : world.indexPath, hang);
        break;
      case 'checksum changed':
        world.server.routes.set(
          world.indexPath,
          indexJson([indexEntry(NAME, version, formatJs(NAME, version, 'SOMETHING ELSE'))]),
        );
        break;
      case 'identity': {
        const impostor = formatJs('Impostor', version, 'IMPOSTOR');
        world.server.routes.set(world.indexPath, indexJson([indexEntry(NAME, version, impostor)]));
        world.server.routes.set(formatPath, impostor);
        break;
      }
      default: {
        const _exhaustive: never = failure;
        throw new Error(`unhandled failure ${String(_exhaustive)}`);
      }
    }
    const outcome = await run(WANTED, { ...world.options, formatFetchTimeout: 100 });
    const answers = cache === 'primed' && row.primedAnswers;
    expectOutcome(outcome, answers ? model(WANTED, [candidate]) : undefined);
    // Every failure is reported, naming the source's URL, whether or not something answered —
    // except a primed index entry whose file is gone: it is never downloaded again.
    const reported = outcome.warnings.some(
      (w) => w.startsWith('Remote format fetch failed') && w.includes(world.server.origin),
    );
    expect(reported).toBe(!(source === 'index' && failure === 'format 404' && cache === 'primed'));
  });
});

// --- Table D: two candidates in two sources ---

describe('table D: precedence between two sources', () => {
  const versions = ['2.1.0', '2.3.0', '2.0.0', '2.0.5', '3.0.0'] as const;
  const pairs = SOURCES.flatMap((a, i) => SOURCES.slice(i + 1).map((b) => [a, b] as const));
  const rows = pairs.flatMap(([a, b]) => versions.flatMap((va) => versions.map((vb) => ({ a, b, va, vb }))));

  it.each(rows)('$a $va and $b $vb', async ({ a, b, va, vb }) => {
    const candidates: ModelCandidate[] = [
      { source: a, name: NAME, version: va, marker: 'A' },
      { source: b, name: NAME, version: vb, marker: 'B' },
    ];
    const world = await buildWorld(candidates);
    expectOutcome(await run(WANTED, world.options), model(WANTED, candidates));
  });

  it('prefers an exact version to a newer one within one index, but the earlier source across sources', async () => {
    const within: ModelCandidate[] = [
      { source: 'index', name: NAME, version: '2.3.0', marker: 'NEWER' },
      { source: 'index', name: NAME, version: '2.1.0', marker: 'EXACT' },
    ];
    expectOutcome(await run(WANTED, (await buildWorld(within)).options), { marker: 'EXACT', older: false });
    const across: ModelCandidate[] = [
      { source: 'url', name: NAME, version: '2.3.0', marker: 'URL' },
      { source: 'index', name: NAME, version: '2.1.0', marker: 'INDEX' },
    ];
    expectOutcome(await run(WANTED, (await buildWorld(across, 'x-')).options), model(WANTED, across));
    expect(model(WANTED, across)?.marker).toBe('URL');
  });
});

/**
 * Story format selection for a compile: gather candidates, select one, then obtain it.
 *
 * The request comes from the explicit `formatId` option, else the StoryData format name and
 * version, else the default ID. Sources are gathered in their documented order (local folders,
 * then each format URL, then each format index), every source yielding {@link FormatCandidate}s;
 * {@link selectFormat} alone picks one, and only the chosen candidate is downloaded. When obtaining
 * it fails, the failure is reported and the selection runs again without it. A request no source
 * can answer is reported as an error rather than swapped for a different story format.
 * docs/story-formats.md ("How a format is chosen") states the same policy.
 */
import type { Diagnostic, FormatRequest, RemoteFetchOptions, RemoteResolveOptions, StoryFormatInfo } from './types.js';
import type { FormatCandidate, MatchTier } from './formats.js';
import {
  describeFormatRequest,
  discoverAllFormats,
  errorText,
  formatNameKey,
  getFormatSearchDirs,
  judgeCandidate,
  localCandidates,
  pruneFormats,
  selectFormat,
} from './formats.js';
import type { CacheRecord } from './format-cache.js';
import { listRecords } from './format-cache.js';
import type { FormatIndex, Obtained } from './remote-formats.js';
import {
  cachedUrlRecord,
  checkRemoteUrl,
  clearIndexCache,
  DEFAULT_SFA_INDICES,
  fetchIndex,
  MAX_TIMER_DELAY,
  obtainIndexEntry,
  obtainUrlFormat,
  requestTimeout,
  resolutionTimeout,
  useCachedRecord,
} from './remote-formats.js';
import { parseVersion } from './semver.js';
import { TweeTsError } from './compiler.js';

/** Where to look for story formats. */
export interface FormatResolutionOptions {
  readonly formatPaths?: readonly string[] | undefined;
  readonly useTweegoPath?: boolean | undefined;
  readonly noRemote?: boolean | undefined;
  readonly formatIndices?: readonly string[] | undefined;
  readonly formatUrls?: readonly string[] | undefined;
  /** Aborts the format requests; resolution then rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /** Milliseconds each format request may take. */
  readonly formatFetchTimeout?: number | undefined;
  /** Milliseconds the whole search may take (0: no limit). */
  readonly formatResolutionTimeout?: number | undefined;
  /** Whether the Story Formats Archive indices are asked after `formatIndices` (default true). */
  readonly useDefaultFormatIndices?: boolean | undefined;
}

/** Choose the format request: explicit format ID > StoryData format > default ID. */
export function formatRequestFor(
  formatId: string | undefined,
  storyFormat: string,
  storyFormatVersion: string,
  defaultId: string,
): FormatRequest {
  if (formatId) return { kind: 'id', id: formatId };
  if (storyFormat) return { kind: 'name', name: storyFormat, version: storyFormatVersion };
  return { kind: 'id', id: defaultId };
}

/** A candidate with how to describe it and how to obtain the format it stands for. */
interface SourcedCandidate extends FormatCandidate {
  /** Where the candidate comes from, for diagnostics. */
  readonly label: string;
  readonly obtain: () => Promise<Obtained>;
}

/** The sources one resolution consults, already checked. */
interface Sources {
  /** The local search directories, or undefined to consult no local folders. */
  readonly searchDirs: readonly string[] | undefined;
  readonly urls: readonly string[];
  readonly indices: readonly string[];
  /** Whether the network may be used; offline, URLs and indices answer from their cached copies. */
  readonly online: boolean;
}

/** An index entry that could not be a candidate, with the index it is in. */
interface Skipped {
  readonly label: string;
  readonly name: string | undefined;
  readonly reason: string;
}

/** What a resolution found, and every failure it met on the way. */
interface Resolution {
  readonly info: StoryFormatInfo | undefined;
  readonly failures: readonly string[];
}

/** Rethrow the abort reason when the signal has aborted; failures after an abort are not failures of a source. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

/**
 * The overall time limit of one search: `signal` aborts the requests when either the caller's signal
 * aborts or the limit passes (with `message` as the reason); `expired` tells whether the limit
 * passed. `dispose` stops the timer, and must be called when the search ends.
 */
interface Deadline {
  readonly signal: AbortSignal | undefined;
  readonly caller: AbortSignal | undefined;
  readonly expired: () => boolean;
  readonly message: string;
  readonly dispose: () => void;
}

/** Start the time limit of a search: `ms` milliseconds (0, or more than a timer takes: none), named `option` in messages. */
function startDeadline(caller: AbortSignal | undefined, ms: number, option: string): Deadline {
  const message =
    `the search stopped after ${ms} ms, the limit ${option} sets for finding the story format; ` +
    'the format URLs and indices not asked by then were read from the download cache only';
  if (ms === 0 || ms > MAX_TIMER_DELAY) {
    return { signal: caller, caller, expired: () => false, message, dispose: () => undefined };
  }
  const limit = new AbortController();
  const timer = setTimeout(() => {
    limit.abort(new Error(message));
  }, ms);
  return {
    signal: caller === undefined ? limit.signal : AbortSignal.any([caller, limit.signal]),
    caller,
    expired: () => limit.signal.aborted,
    message,
    dispose: () => {
      clearTimeout(timer);
    },
  };
}

/** A cached download as a candidate: it answers as the index entry or URL it was downloaded for. */
function cachedCandidate(record: CacheRecord, rank: number, label: string): SourcedCandidate {
  const identity = record.origin.kind === 'index' ? record.origin : record;
  return {
    name: identity.name,
    version: identity.version,
    isTwine2: record.isTwine2,
    source: record.origin.kind,
    rank,
    label,
    obtain: () => Promise.resolve({ info: useCachedRecord(record), warnings: [] }),
  };
}

/** The candidates of a format index, from the index itself (online) or from what was downloaded from it. */
function indexCandidates(index: FormatIndex, rank: number, options: RemoteFetchOptions): SourcedCandidate[] {
  return index.entries.map((entry) => ({
    name: entry.name,
    version: entry.version,
    isTwine2: entry.twine === 'twine2',
    source: 'index',
    rank,
    label: `${entry.twine} entry ${entry.name} ${entry.version} of format index ${index.url}`,
    obtain: () => obtainIndexEntry(index, entry, options),
  }));
}

/** Describe the candidates related to the request and why none answered, for the "not available" error. */
function describeUnusable(
  request: FormatRequest,
  seen: readonly SourcedCandidate[],
  skipped: readonly Skipped[],
): string[] {
  const wantedName =
    request.kind === 'name' ? formatNameKey(request.name) : formatNameKey(request.id).replace(/-\d+$/, '');
  const related = (name: string): boolean =>
    request.kind === 'name'
      ? formatNameKey(name) === wantedName
      : formatNameKey(name).replace(/\s+/g, '-') === wantedName;
  const candidates = seen
    .filter((c) => related(c.name))
    .map((c) => {
      // Nothing answered, so a candidate that matches was chosen once and could not be obtained.
      const judgement = judgeCandidate(request, c);
      const why = judgement.kind === 'rejected' ? judgement.reason : 'could not be obtained (see the warning)';
      return `${c.label} (${c.name} ${c.version || 'without a version'}): ${why}`;
    });
  const entries = skipped.filter((s) => s.name !== undefined && related(s.name)).map((s) => `${s.label}: ${s.reason}`);
  return [...candidates, ...entries];
}

const MAX_LISTED = 10;

/**
 * Resolve a request against the sources: gather each source in order, and after each one select
 * among everything gathered so far. Because {@link selectFormat} ranks sources first, stopping at
 * the first source that answers gives the same result as gathering every source. When nothing
 * answers, a same-major older candidate is taken with a warning. Diagnostics go to `diagnostics`.
 */
async function resolveWith(
  request: FormatRequest,
  sources: Sources,
  options: RemoteFetchOptions,
  deadline: Deadline,
  diagnostics: Diagnostic[],
): Promise<Resolution> {
  const wanted = describeFormatRequest(request);
  const failures: string[] = [];
  const fail = (message: string): void => {
    const text = `Remote format fetch failed for ${wanted}: ${message}`;
    if (failures.includes(text)) return;
    failures.push(text);
    diagnostics.push({ level: 'warning', message: text });
  };
  /** Whether the network may be used now: not offline, and the time limit has not passed. */
  const online = (): boolean => {
    if (!sources.online) return false;
    if (!deadline.expired()) return true;
    fail(deadline.message);
    return false;
  };
  /** Rethrow a caller's abort; otherwise describe why a request failed (the time limit, when it passed). */
  const failure = (e: unknown): string => {
    throwIfAborted(deadline.caller);
    return deadline.expired() ? deadline.message : errorText(e);
  };
  const notes: string[] = [];
  const skipped: Skipped[] = [];
  const localIds: string[] = [];
  let records: readonly CacheRecord[] | undefined;
  const cachedFrom = (indexUrl: string, rank: number): SourcedCandidate[] => {
    records ??= listRecords();
    return records
      .filter((r) => r.origin.kind === 'index' && r.origin.index === indexUrl)
      .map((r) =>
        cachedCandidate(r, rank, `the cached download of ${r.name} ${r.version} from format index ${indexUrl}`),
      );
  };

  if (request.kind === 'name' && !parseVersion(request.version)) {
    diagnostics.push({
      level: 'warning',
      message:
        request.version === ''
          ? `format "${request.name}": Auto-selecting greatest version; StoryData gives no format-version.`
          : `format "${request.name}": Auto-selecting greatest version; Could not parse version "${request.version}".`,
    });
  }

  const gatherLocal = (searchDirs: readonly string[]): SourcedCandidate[] => {
    const all = discoverAllFormats(searchDirs, diagnostics);
    localIds.push(...all.keys());
    // As in Tweego, a name request selects among the greatest version of each name and major.
    const formats = request.kind === 'name' ? pruneFormats(all) : all;
    return localCandidates(formats).map((c) => ({
      ...c,
      label: `local format ${c.folder} (${c.info.filename})`,
      obtain: () => Promise.resolve({ info: c.info, warnings: [] }),
    }));
  };

  const gatherUrl = async (url: string, rank: number): Promise<SourcedCandidate[]> => {
    const label = `the cached copy of format URL ${url}`;
    if (!online()) {
      const record = cachedUrlRecord(url);
      if (!record) notes.push(`format URL ${url} has no cached copy`);
      return record ? [cachedCandidate(record, rank, label)] : [];
    }
    try {
      const obtained = await obtainUrlFormat(url, options);
      const { info } = obtained;
      return [
        {
          name: info.name,
          version: info.version,
          isTwine2: info.isTwine2,
          source: 'url',
          rank,
          label: `format URL ${url}`,
          obtain: () => Promise.resolve(obtained),
        },
      ];
    } catch (e) {
      const why = failure(e);
      const record = cachedUrlRecord(url);
      fail(`${why}${record ? `; using the copy downloaded on ${record.fetchedAt}` : ''}`);
      return record ? [cachedCandidate(record, rank, label)] : [];
    }
  };

  const gatherIndex = async (indexUrl: string, rank: number): Promise<SourcedCandidate[]> => {
    if (!online()) return cachedFrom(indexUrl, rank);
    let index: FormatIndex;
    try {
      index = await fetchIndex(indexUrl, options);
    } catch (e) {
      const why = failure(e);
      const fallback = cachedFrom(indexUrl, rank);
      fail(`${why}${fallback.length > 0 ? '; using the formats downloaded from it before' : ''}`);
      return fallback;
    }
    skipped.push(
      ...index.skipped.map((s) => ({
        label: `${s.twine} entry ${s.position} of format index ${indexUrl}`,
        name: s.name,
        reason: s.reason,
      })),
    );
    return indexCandidates(index, rank, options);
  };

  const { searchDirs } = sources;
  const groups: (() => Promise<SourcedCandidate[]> | SourcedCandidate[])[] = [
    ...(searchDirs ? [() => gatherLocal(searchDirs)] : []),
    ...sources.urls.map((url, i) => () => gatherUrl(url, 1 + i)),
    ...sources.indices.map((url, j) => () => gatherIndex(url, 1 + sources.urls.length + j)),
  ];

  const gathered: SourcedCandidate[] = [];
  const seen: SourcedCandidate[] = [];
  const choose = async (
    allowOlder: boolean,
  ): Promise<{ readonly info: StoryFormatInfo; readonly tier: MatchTier; readonly label: string } | undefined> => {
    for (;;) {
      const selection = selectFormat(request, gathered, { allowOlder });
      if (!selection) return undefined;
      try {
        const obtained = await selection.choice.obtain();
        diagnostics.push(...obtained.warnings.map((message) => ({ level: 'warning' as const, message })));
        return { info: obtained.info, tier: selection.tier, label: selection.choice.label };
      } catch (e) {
        fail(failure(e));
        gathered.splice(gathered.indexOf(selection.choice), 1);
      }
    }
  };

  let found: Awaited<ReturnType<typeof choose>>;
  for (const gather of groups) {
    const candidates = await gather();
    gathered.push(...candidates);
    seen.push(...candidates);
    found = await choose(false);
    if (found) break;
  }
  found ??= await choose(true);

  if (found) {
    const { info, tier, label } = found;
    if (tier === 'older') {
      diagnostics.push({
        level: 'warning',
        message: `Story format ${wanted} is not available; using ${info.name} ${info.version} instead.`,
      });
    }
    if (tier === 'id') {
      const names = new Set(
        seen
          .filter((c) => {
            const judgement = judgeCandidate(request, c);
            return judgement.kind === 'match' && judgement.tier === 'id';
          })
          .map((c) => c.name),
      );
      if (new Set([...names].map(formatNameKey)).size > 1) {
        diagnostics.push({
          level: 'warning',
          message:
            `Story format ID ${wanted} matches formats with different names (${[...names].join(', ')}); ` +
            `using ${info.name} ${info.version} from ${label}.`,
        });
      }
    }
    return { info, failures };
  }

  const reason = sources.online ? '' : ' (remote fetching disabled)';
  const unusable = [...describeUnusable(request, seen, skipped), ...notes];
  const listed = unusable.slice(0, MAX_LISTED);
  const more = unusable.length > MAX_LISTED ? `; and ${unusable.length - MAX_LISTED} more` : '';
  const details = listed.length > 0 ? ` Not usable: ${listed.join('; ')}${more}.` : '';
  diagnostics.push({
    level: 'error',
    message: `Story format ${wanted} is not available${reason}. Found: ${localIds.join(', ') || 'none'}.${details}`,
  });
  return { info: undefined, failures };
}

/** Check configured URLs; each one that is not usable is an error diagnostic and is left out. */
function checkedUrls(urls: readonly string[] | undefined, option: string, diagnostics: Diagnostic[]): string[] {
  return (urls ?? []).flatMap((text) => {
    const checked = checkRemoteUrl(text);
    if (checked.ok) return [checked.url];
    diagnostics.push({ level: 'error', message: `${option}: ${checked.reason}` });
    return [];
  });
}

/**
 * Resolve a format request to a story format, as docs/story-formats.md ("How a format is chosen")
 * describes. Local formats that cannot be used, sources that fail, and an older version used
 * instead of the one asked for are reported as warnings; configured URLs that are not usable,
 * and a request nothing answers, as errors (the result is then `undefined`).
 */
export async function resolveStoryFormat(
  request: FormatRequest,
  options: FormatResolutionOptions,
  diagnostics: Diagnostic[],
): Promise<StoryFormatInfo | undefined> {
  requestTimeout({ timeout: options.formatFetchTimeout });
  // compile() has checked both time limits (validateOptions()).
  const limit = resolutionTimeout(options.formatResolutionTimeout);
  const sources: Sources = {
    searchDirs: getFormatSearchDirs(options.formatPaths, options.useTweegoPath ?? true),
    urls: checkedUrls(options.formatUrls, 'formatUrls', diagnostics),
    indices: [
      ...checkedUrls(options.formatIndices, 'formatIndices', diagnostics),
      ...((options.useDefaultFormatIndices ?? true) ? DEFAULT_SFA_INDICES : []),
    ],
    online: !(options.noRemote ?? false),
  };
  const deadline = startDeadline(options.signal, limit, 'formatResolutionTimeout');
  try {
    const fetchOptions: RemoteFetchOptions = { signal: deadline.signal, timeout: options.formatFetchTimeout };
    return (await resolveWith(request, sources, fetchOptions, deadline, diagnostics)).info;
  } finally {
    deadline.dispose();
  }
}

/** The time limit of a lookup; a TweeTsError (`INVALID_OPTIONS`) names a time limit that is not 0 or more. */
function lookupLimit(options: RemoteResolveOptions): number {
  const limits = [
    ['timeout', options.timeout],
    ['resolutionTimeout', options.resolutionTimeout],
  ] as const;
  for (const [option, value] of limits) {
    if (value !== undefined && !(value >= 0)) {
      throw new TweeTsError(`${option} must be 0 or more milliseconds, not ${value}`, [], { code: 'INVALID_OPTIONS' });
    }
  }
  return resolutionTimeout(options.resolutionTimeout);
}

/**
 * Resolve a story format by name and version from format URLs and format indices only (no local
 * folders), by the same policy as a compile: `options.urls` first, then `options.indices`, then the
 * Story Formats Archive. Returns undefined when no source has the format.
 *
 * `options.signal` aborts the lookup, which then rejects with the signal's reason;
 * `options.timeout` limits each request (default 30000 ms), and `options.resolutionTimeout` the
 * whole lookup (default 120000 ms); `options.useDefaultIndices: false` leaves the Story Formats
 * Archive out.
 *
 * @throws A TweeTsError: `INVALID_OPTIONS` for a URL or time limit that cannot be used, before any
 *   request; `FORMAT_UNAVAILABLE`, listing every failure (also in its `diagnostics`), when no source
 *   has the format and some source failed.
 */
export async function resolveRemoteFormat(
  name: string,
  version: string,
  options: RemoteResolveOptions = {},
): Promise<StoryFormatInfo | undefined> {
  options.signal?.throwIfAborted();
  const limit = lookupLimit(options);
  // As each compile does: an index is fetched afresh for each lookup, then shared within it.
  clearIndexCache();
  const diagnostics: Diagnostic[] = [];
  const sources: Sources = {
    searchDirs: undefined,
    urls: checkedUrls(options.urls, 'urls', diagnostics),
    indices: [
      ...checkedUrls(options.indices, 'indices', diagnostics),
      ...((options.useDefaultIndices ?? true) ? DEFAULT_SFA_INDICES : []),
    ],
    online: true,
  };
  const invalid = diagnostics.filter((d) => d.level === 'error');
  if (invalid.length > 0) {
    throw new TweeTsError(invalid.map((d) => d.message).join('\n'), invalid, { code: 'INVALID_OPTIONS' });
  }
  const deadline = startDeadline(options.signal, limit, 'resolutionTimeout');
  try {
    const fetchOptions: RemoteFetchOptions = { signal: deadline.signal, timeout: options.timeout };
    const request: FormatRequest = { kind: 'name', name, version };
    const { info, failures } = await resolveWith(request, sources, fetchOptions, deadline, diagnostics);
    if (info === undefined && failures.length > 0) {
      throw new TweeTsError(failures.join('\n'), diagnostics, { code: 'FORMAT_UNAVAILABLE' });
    }
    return info;
  } finally {
    deadline.dispose();
  }
}

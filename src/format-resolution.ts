/**
 * Story format selection for a compile.
 *
 * The request comes from the explicit `formatId` option, else the StoryData format name and
 * version, else the default ID. That one request is then looked up in the local format
 * directories, the download cache, and (unless disabled) remote sources. A request that none of
 * them can answer is reported as an error rather than swapped for a different story format.
 */
import type { Diagnostic, FormatRequest, RemoteFetchOptions, StoryFormatInfo } from './types.js';
import {
  describeFormatRequest,
  discoverAllFormats,
  findFormatById,
  getFormatSearchDirs,
  pruneFormats,
  rankedTwine2Formats,
  selectFormatCandidate,
} from './formats.js';
import {
  findCachedFormat,
  findCachedUrlFormat,
  resolveFormatUrls,
  resolveRemoteFormatRequest,
} from './remote-formats.js';

/** Where to look for story formats. */
export interface FormatResolutionOptions {
  readonly formatPaths?: readonly string[];
  readonly useTweegoPath?: boolean;
  readonly noRemote?: boolean;
  readonly formatIndices?: readonly string[];
  readonly formatUrls?: readonly string[];
  /** Aborts the format requests; resolution then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** Milliseconds each format request may take. */
  readonly formatFetchTimeout?: number;
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

/**
 * Look a request up among the formats found in local format directories. An ID names a folder, so
 * it is looked up among all of them; a name request selects by SemVer among the pruned formats.
 */
function findLocalFormat(
  all: ReadonlyMap<string, StoryFormatInfo>,
  pruned: ReadonlyMap<string, StoryFormatInfo>,
  request: FormatRequest,
): StoryFormatInfo | undefined {
  switch (request.kind) {
    case 'id':
      return findFormatById(all, request.id);
    case 'name':
      return selectFormatCandidate(request, rankedTwine2Formats(pruned), (f) => f);
    default: {
      const _exhaustive: never = request;
      throw new Error(`unhandled format request: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Resolve a format request to a story format.
 *
 * Order: local format directories, then the project's direct format URLs (each one's cached
 * copy, else a download unless `noRemote`), then the download cache shared by name and version,
 * then format indices (unless `noRemote`). Names and IDs match the same way in each (see
 * `selectFormatCandidate`), so a request that a local format answers never reaches the cache or the
 * network. Local formats that cannot be used are reported as warnings. When a StoryData request
 * names a version that none of them has, an older version of the same format and major version
 * is used with a warning, from local formats, the project's cached format URLs, or the shared cache. Anything else is an error diagnostic,
 * and the result is `undefined`.
 */
export async function resolveStoryFormat(
  request: FormatRequest,
  options: FormatResolutionOptions,
  diagnostics: Diagnostic[],
): Promise<StoryFormatInfo | undefined> {
  const noRemote = options.noRemote ?? false;
  const searchDirs = getFormatSearchDirs(options.formatPaths, options.useTweegoPath ?? true);
  const all = discoverAllFormats(searchDirs, diagnostics);
  const pruned = pruneFormats(all);
  const wanted = describeFormatRequest(request);

  const local = findLocalFormat(all, pruned, request);
  if (local) return local;

  const fetchOptions: RemoteFetchOptions = { signal: options.signal, timeout: options.formatFetchTimeout };
  const warnOnFailure = async (
    lookup: () => Promise<StoryFormatInfo | undefined>,
  ): Promise<StoryFormatInfo | undefined> => {
    try {
      return await lookup();
    } catch (e) {
      if (options.signal?.aborted) throw options.signal.reason;
      diagnostics.push({
        level: 'warning',
        message: `Remote format fetch failed for ${wanted}: ${e instanceof Error ? e.message : String(e)}`,
      });
      return undefined;
    }
  };

  // The project's own format URLs come before the downloads shared by name and version, so
  // another project's download of the same name and version never stands in for them.
  const direct = await warnOnFailure(() =>
    resolveFormatUrls(request, options.formatUrls ?? [], { ...fetchOptions, offline: noRemote }),
  );
  if (direct) return direct;

  const cached = findCachedFormat(request);
  if (cached) return cached;

  if (!noRemote) {
    const remote = await warnOnFailure(() =>
      resolveRemoteFormatRequest(request, options.formatIndices, [], fetchOptions),
    );
    if (remote) return remote;
  }

  // A same-major older version keeps the story in its own format; it never crosses majors.
  if (request.kind === 'name') {
    const older =
      selectFormatCandidate(request, rankedTwine2Formats(pruned), (f) => f, { allowOlder: true }) ??
      // Every configured URL was downloaded above unless remote fetching is off or it failed, so
      // its cached copy is the whole answer here.
      findCachedUrlFormat(request, options.formatUrls ?? [], { allowOlder: true }) ??
      findCachedFormat(request, { allowOlder: true });
    if (older) {
      diagnostics.push({
        level: 'warning',
        message: `Story format ${wanted} is not available; using ${older.name} ${older.version} instead.`,
      });
      return older;
    }
  }

  const reason = noRemote ? ' (remote fetching disabled)' : '';
  diagnostics.push({
    level: 'error',
    message: `Story format ${wanted} is not available${reason}. Found: ${[...all.keys()].join(', ') || 'none'}`,
  });
  return undefined;
}

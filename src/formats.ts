/**
 * Story format discovery, loading, and SemVer matching.
 * Ported from formats.go + config.go.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { StoryFormatInfo, Twine2FormatJSON } from './types.js';
import { readUTF8 } from './util.js';

/**
 * Attempt to fix non-strict JSON (trailing commas, single quotes, unquoted keys).
 */
function relaxedJSONParse(json: string): unknown {
  // First try standard parse
  try {
    return JSON.parse(json);
  } catch {
    // fall through to relaxed parsing
  }

  let fixed = json;

  // Replace single-quoted string values with double-quoted
  // Match single-quoted strings: 'value' -> "value"
  fixed = fixed.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');

  // Add quotes around unquoted property names
  // Match word chars before a colon that aren't already quoted
  fixed = fixed.replace(/(?<=^|[{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gm, '"$1":');

  // Remove trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  return JSON.parse(fixed);
}

/**
 * Parse the Twine 2 format.js JSON chunk.
 * Handles Harlowe's malformed JSON by stripping the "setup" function property.
 * Per spec, the name key is Optional.
 */
export function parseFormatJSON(source: string, formatId: string): Twine2FormatJSON | null {
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first === -1 || last === -1) return null;

  let chunk = source.slice(first, last + 1);

  const parse = (json: string): Twine2FormatJSON | null => {
    const raw: unknown = relaxedJSONParse(json);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    // version and source are required; name is optional per spec
    if (typeof obj.version !== 'string' || typeof obj.source !== 'string') return null;
    // Validate version is semver
    if (!parseSemver(obj.version)) return null;
    const name = typeof obj.name === 'string' ? obj.name : 'Untitled Story Format';
    const result: Twine2FormatJSON = {
      name,
      version: obj.version,
      source: obj.source,
      proofing: obj.proofing === true,
    };
    if (typeof obj.author === 'string') result.author = obj.author;
    if (typeof obj.description === 'string') result.description = obj.description;
    if (typeof obj.image === 'string') result.image = obj.image;
    if (typeof obj.url === 'string') result.url = obj.url;
    if (typeof obj.license === 'string') result.license = obj.license;
    return result;
  };

  try {
    return parse(chunk);
  } catch {
    // Harlowe workaround: strip the "setup" function property
    if (formatId.toLowerCase().startsWith('harlowe')) {
      const setupIdx = chunk.lastIndexOf(',"setup": function');
      if (setupIdx !== -1) {
        chunk = chunk.slice(0, setupIdx) + '}';
        try {
          return parse(chunk);
        } catch {
          // fall through
        }
      }
    }
    return null;
  }
}

/**
 * Discover all story formats in the given search directories.
 * Implements SemVer-based version pruning: within each (name, major) group,
 * only the highest minor.patch survives.
 */
export function discoverFormats(searchDirs: string[]): Map<string, StoryFormatInfo> {
  const formats = new Map<string, StoryFormatInfo>();
  const baseFilenames = ['format.js', 'header.html'];

  for (const searchDir of searchDirs) {
    try {
      const stat = statSync(searchDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    let entries;
    try {
      entries = readdirSync(searchDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const formatDir = join(searchDir, entry);
      try {
        if (!statSync(formatDir).isDirectory()) continue;
      } catch {
        continue;
      }

      for (const baseFilename of baseFilenames) {
        const formatFilename = join(formatDir, baseFilename);
        try {
          const stat = statSync(formatFilename);
          if (!stat.isFile()) continue;
        } catch {
          continue;
        }

        const isTwine2 = baseFilename === 'format.js';
        const format: StoryFormatInfo = {
          id: entry,
          filename: formatFilename,
          isTwine2,
          name: '',
          version: '',
          proofing: false,
        };

        if (isTwine2) {
          try {
            const source = readUTF8(formatFilename);
            const data = parseFormatJSON(source, entry);
            if (!data) continue;
            format.name = data.name;
            format.version = data.version;
            format.proofing = data.proofing ?? false;
            if (data.author) format.author = data.author;
            if (data.description) format.description = data.description;
            if (data.image) format.image = data.image;
            if (data.url) format.url = data.url;
            if (data.license) format.license = data.license;
          } catch {
            continue;
          }
        } else {
          // Twine 1 format: use folder name as default name
          format.name = entry;
        }

        formats.set(entry, format);
        break; // Found format file for this directory
      }
    }
  }

  // SemVer pruning: for formats with the same name, within each major version
  // keep only the highest minor.patch. Also, same name+version from different
  // directories: keep the first one found.
  pruneFormats(formats);

  return formats;
}

/**
 * Prune formats by SemVer: within each (name, major) group,
 * keep only the highest version. First-found wins for same name+version.
 */
function pruneFormats(formats: Map<string, StoryFormatInfo>): void {
  // Group by (name, major) -> best entry
  const bestByNameMajor = new Map<string, { id: string; version: [number, number, number] }>();
  // Track seen name+version combos (first wins)
  const seenNameVersion = new Set<string>();

  for (const [id, f] of formats) {
    if (!f.isTwine2 || !f.name || !f.version) continue;
    const v = parseSemver(f.version);
    if (!v) continue;

    const nameVersionKey = `${f.name}@${f.version}`;
    if (seenNameVersion.has(nameVersionKey)) {
      // Duplicate name+version: remove the later one
      formats.delete(id);
      continue;
    }
    seenNameVersion.add(nameVersionKey);

    const groupKey = `${f.name}@${v[0]}`;
    const existing = bestByNameMajor.get(groupKey);
    if (!existing || semverCompare(v, existing.version) > 0) {
      bestByNameMajor.set(groupKey, { id, version: v });
    }
  }

  // Remove all non-best entries within each group
  for (const [id, f] of [...formats]) {
    if (!f.isTwine2 || !f.name || !f.version) continue;
    const v = parseSemver(f.version);
    if (!v) continue;

    const groupKey = `${f.name}@${v[0]}`;
    const best = bestByNameMajor.get(groupKey);
    if (best && best.id !== id) {
      formats.delete(id);
    }
  }
}

/**
 * Get the default format search directories.
 */
export function getFormatSearchDirs(extraPaths: string[] = [], useTweegoPath = true): string[] {
  const subdirNames = ['storyformats', '.storyformats', 'story-formats', 'storyFormats', 'targets'];
  const basePaths = new Set<string>();

  // Home directory
  try {
    basePaths.add(homedir());
  } catch {
    // ignore
  }

  // Working directory
  basePaths.add(process.cwd());

  const dirs: string[] = [];
  for (const base of basePaths) {
    for (const sub of subdirNames) {
      const dir = join(base, sub);
      try {
        if (statSync(dir).isDirectory()) {
          dirs.push(dir);
        }
      } catch {
        // skip
      }
    }
  }

  // Extra user-provided paths
  dirs.push(...extraPaths);

  // TWEEGO_PATH environment variable
  if (useTweegoPath) {
    const tweegoPath = process.env.TWEEGO_PATH;
    if (tweegoPath) {
      dirs.push(...tweegoPath.split(process.platform === 'win32' ? ';' : ':'));
    }
  }

  return dirs;
}

/** Parse a simple semver string into [major, minor, patch]. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function semverCompare(a: [number, number, number], b: [number, number, number]): number {
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  if (aPatch !== bPatch) return aPatch - bPatch;
  return 0;
}

/** Get format ID from Twine 2 name, picking the greatest version. */
export function getFormatIdByName(formats: Map<string, StoryFormatInfo>, name: string): string | undefined {
  let bestVersion: [number, number, number] | null = null;
  let bestId: string | undefined;

  for (const [id, f] of formats) {
    if (!f.isTwine2 || f.name !== name) continue;
    const v = parseSemver(f.version);
    if (!v) continue;
    if (!bestVersion || semverCompare(v, bestVersion) > 0) {
      bestVersion = v;
      bestId = id;
    }
  }

  return bestId;
}

/** Get format ID from Twine 2 name and version, using SemVer major matching. */
export function getFormatIdByNameAndVersion(
  formats: Map<string, StoryFormatInfo>,
  name: string,
  version: string,
): string | undefined {
  const wanted = parseSemver(version);
  let bestVersion: [number, number, number] | null = null;
  let bestId: string | undefined;

  for (const [id, f] of formats) {
    if (!f.isTwine2 || f.name !== name) continue;
    const have = parseSemver(f.version);
    if (!have) continue;

    if (wanted === null || (have[0] === wanted[0] && semverCompare(have, wanted) >= 0)) {
      if (!bestVersion || semverCompare(have, bestVersion) > 0) {
        bestVersion = have;
        bestId = id;
      }
    }
  }

  return bestId;
}

/** Read the story format source (for Twine 2, extract the `source` property from JSON). */
export function readFormatSource(format: StoryFormatInfo): string {
  const source = readUTF8(format.filename);
  if (format.isTwine2) {
    const data = parseFormatJSON(source, format.id);
    if (!data) throw new Error(`Cannot parse format ${format.id} JSON`);
    return data.source;
  }
  return source;
}

/** Read a file as UTF-8 (re-exported for loader use). */
export { readUTF8 as readFileUTF8 } from './util.js';

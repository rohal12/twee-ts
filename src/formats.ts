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
 * Parse the Twine 2 format.js JSON chunk.
 * Handles Harlowe's malformed JSON by stripping the "setup" function property.
 */
export function parseFormatJSON(source: string, formatId: string): Twine2FormatJSON | null {
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first === -1 || last === -1) return null;

  let chunk = source.slice(first, last + 1);

  const parse = (json: string): Twine2FormatJSON | null => {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name !== 'string' || typeof obj.version !== 'string' || typeof obj.source !== 'string') return null;
    return { name: obj.name, version: obj.version, source: obj.source, proofing: obj.proofing === true };
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
          } catch {
            continue;
          }
        }

        formats.set(entry, format);
        break; // Found format file for this directory
      }
    }
  }

  return formats;
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

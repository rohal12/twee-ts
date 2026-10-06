/**
 * Canonical path identity: one answer to "is this the same file?" for every part of twee-ts that
 * compares paths (source discovery, exclude globs, the incremental cache, the watchers, the
 * output-overlap checks, the bundler plugins and the paths reported to users).
 *
 * A path is identified by {@link identify}, which gives a {@link PathIdentity}:
 *
 * - `authored`: the path exactly as the caller wrote it.
 * - `absolute`: `authored` resolved lexically against the working directory. Links are not followed.
 * - `canonical`: the real path. The deepest ancestor that exists is resolved with every symbolic
 *   link in it followed (`realpath`), and the components below it that don't exist yet are
 *   appended as written. A dangling link is followed to where its target would be, link by link,
 *   so the output named through a dangling link has the identity of the file a write would create.
 *   On Windows the drive letter is upper-cased and the `\\?\` and `\\?\UNC\` prefixes are dropped.
 *   It is a path that can be opened.
 * - `key`: the comparison key. It is `canonical`, with letter case folded when the volume that
 *   holds the path compares names without case (see below), and with a UNC server and share name
 *   folded on Windows. Two paths name the same file exactly when their keys are equal. A key is
 *   not meant to be opened or shown.
 * - `display`: the form for messages and for exclude globs. It is the path relative to the working
 *   directory when the file is inside it, comparing the written paths first and the real paths
 *   second (so a working directory reached through a link, such as macOS's `/var` and
 *   `/private/var`, still gives a relative path; a link to a file keeps its own name there when
 *   its folder is inside, else it is shown by its target). A file outside the working directory keeps the
 *   lexical relative path (`../other/a.tw`), or an absolute path when no relative one exists (another
 *   Windows drive). It uses the platform's separators.
 * - `caseInsensitive`: whether the volume compares names without case.
 *
 * Case-insensitive volumes are detected per volume, not assumed per operating system: macOS and
 * Windows volumes can be case-sensitive, and Linux can mount case-insensitive ones (vfat, exFAT,
 * ext4 with casefold, SMB shares). A volume is probed once, by looking up an existing name of a
 * folder on it with its letter case flipped and checking whether the same file answers. When no
 * name on the volume has a letter to flip, the platform's usual answer is used (insensitive on
 * Windows and macOS). The answer is cached per volume (`stat().dev`). Limits: a volume whose
 * folders differ in case sensitivity (ext4 casefold set per folder, Windows per-folder case
 * sensitivity) gets the answer of the first folder probed on it; and names are not compared
 * after Unicode normalization (macOS volumes are normalization-insensitive), which only matters
 * for path components that don't exist yet, since `realpath` returns the stored form of the rest.
 *
 * Exclude globs ({@link matchesExclude}) are matched against `display` (and the real path relative
 * to the working directory when that differs), and an absolute glob against `absolute` and
 * `canonical`, with Node's `path.matchesGlob`. On a case-insensitive volume the whole match ignores
 * case. Elsewhere only the file extension does, as the loader reads `Photo.PNG` as a PNG image: the
 * extension of the glob's last segment (the text after its last `.`, a plain run of characters or one
 * `{…}` group) is compared without case.
 *
 * Everything that touches the file system goes through an {@link IdentityFileSystem}, and the path
 * flavour (POSIX or Windows) is a parameter, so {@link createPathIdentifier} can be tested with a fake
 * file system for either platform. The module-level functions use the real file system, the
 * platform's own path flavour and `process.cwd()` at the time of each call.
 */
import { lstatSync, opendirSync, readlinkSync, realpathSync } from 'node:fs';
import * as nodePath from 'node:path';
/** A path flavour: `path.posix` or `path.win32`. */
export type PathFlavour = typeof nodePath.posix;

/** What {@link identify} says about a path. See the module comment for each field. */
export interface PathIdentity {
  readonly authored: string;
  readonly absolute: string;
  readonly canonical: string;
  readonly key: string;
  readonly display: string;
  readonly caseInsensitive: boolean;
}

/** The facts about a directory entry the identity needs: no throw for a missing or unreadable entry. */
export interface IdentityStat {
  readonly dev: bigint;
  readonly ino: bigint;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

/** The file-system queries path identity makes. The real one wraps `node:fs`; tests pass a fake. */
export interface IdentityFileSystem {
  /** The real path of an existing path, every link resolved. Throws when it can't be resolved. */
  realpath(path: string): string;
  /** The entry at `path` itself (a link is not followed), or undefined when it can't be read. */
  lstat(path: string): IdentityStat | undefined;
  /** The target a symbolic link holds, as written in it. Throws when it is no readable link. */
  readlink(path: string): string;
  /** Up to `limit` names in the folder `dir`, or none when it can't be read. */
  readdir(dir: string, limit: number): readonly string[];
}

/** How a {@link PathIdentifier} is set up. Every field has a default for the running process. */
export interface PathIdentifierOptions {
  /** The path flavour: `path.posix` or `path.win32`. Default: the platform's. */
  readonly path?: PathFlavour;
  /** Default: the real file system. */
  readonly fs?: IdentityFileSystem;
  /** The working directory, read on each call. Default: `process.cwd()`. */
  readonly cwd?: () => string;
  /**
   * The answer for a volume with no name to probe (no letter in any name on it). Default: true on
   * Windows and macOS, false elsewhere.
   */
  readonly defaultCaseInsensitive?: boolean;
}

/** Path identity bound to one file system, path flavour and working directory. */
export interface PathIdentifier {
  /** The identity of `path`, a path written by a user or found on disk. */
  identify(path: string): PathIdentity;
  /** Whether `a` and `b` name the same file: their keys are equal. */
  sameFile(a: string, b: string): boolean;
  /** Whether `inner` is `outer` or inside it, comparing keys. */
  isSameOrInside(inner: string, outer: string): boolean;
  /** Whether the file is matched by one of the exclude globs. See the module comment. */
  matchesExclude(identity: PathIdentity, globs: readonly string[]): boolean;
  /** Forgets which volumes were found case-insensitive (a volume may have been remounted). */
  clearCache(): void;
}

/** Links followed before a path counts as a cycle (Linux stops at 40 as well). */
const MAX_LINK_DEPTH = 40;

/** Names read from a folder to find one to probe with: enough to find a letter, few enough to be cheap. */
const PROBE_ENTRIES = 64;

/** Case-folds a string per code point, keeping a code point whose lower case has another length. */
export function foldCase(text: string): string {
  let folded = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    // Simple folding only: a lower case of another length (İ to i̇) is not used.
    folded += lower.length === ch.length ? lower : ch;
  }
  return folded;
}

/** `name` with the case of every cased letter swapped, to probe a volume with. */
export function flipCase(name: string): string {
  let flipped = '';
  for (const ch of name) {
    const upper = ch.toUpperCase();
    flipped += upper === ch ? ch.toLowerCase() : upper;
  }
  return flipped;
}

/**
 * A Windows path in one spelling: no `\\?\` or `\\?\UNC\` prefix, backslashes, an upper-case drive
 * letter. `path` must be absolute.
 */
export function normalizeWindowsPath(path: string): string {
  let p = path.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(p)) p = `\\\\${p.slice(8)}`;
  else if (/^\\\\\?\\[a-z]:/i.test(p)) p = p.slice(4);
  return p.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());
}

/** A Windows key: the UNC server and share names compare without case, whatever the volume. */
function foldUncRoot(path: string): string {
  return path.replace(/^\\\\[^\\]+\\[^\\]+/, (root) => foldCase(root));
}

/** Whether the key `inner` is the key `outer` or below it, for keys in the flavour with separator `sep`. */
export function isKeyInside(inner: string, outer: string, sep: string): boolean {
  if (inner === outer) return true;
  return inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/** Whether a relative path stays inside the folder it is relative to. */
function isInsideRelative(rel: string, path: PathFlavour): boolean {
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The glob with the extension of its last segment lower-cased, for matching a path whose extension
 * is lower-cased too; undefined when the last segment has no extension in a form this understands
 * (a plain run of characters, or a single `{…}` group, after the last `.`).
 */
export function lowerGlobExtension(pattern: string): string | undefined {
  const lastSep = Math.max(pattern.lastIndexOf('/'), pattern.lastIndexOf('\\'));
  const dot = pattern.lastIndexOf('.');
  if (dot <= lastSep) return undefined;
  const tail = pattern.slice(dot + 1);
  if (!/^(?:\{[^{}/\\]*\}|[^{},/\\]*)$/.test(tail)) return undefined;
  return pattern.slice(0, dot + 1) + tail.toLowerCase();
}

/** `path` with the extension of its last component lower-cased. */
function lowerPathExtension(path: string, flavour: PathFlavour): string {
  const ext = flavour.extname(path);
  return ext === '' ? path : path.slice(0, path.length - ext.length) + ext.toLowerCase();
}

/** Node's `matchesGlob` for the flavour, which Node added in 22.5. */
function globMatcher(flavour: PathFlavour): (path: string, pattern: string) => boolean {
  // Read from the object, not imported by name: a named import would stop this module from loading
  // on Node 22.0 to 22.4.
  const { matchesGlob } = flavour;
  if (typeof matchesGlob !== 'function') {
    throw new Error(`Exclude globs need Node.js 22.5 or newer (found ${process.version}).`);
  }
  return matchesGlob;
}

/**
 * Throws when this Node.js can't match exclude globs, so a build checks it once before it starts
 * rather than failing on the first file.
 */
export function assertGlobSupport(flavour: PathFlavour = nodePath): void {
  globMatcher(flavour);
}

/** The real file system, as path identity queries it. */
export const nodeIdentityFileSystem: IdentityFileSystem = {
  realpath: (path) => realpathSync.native(path),
  lstat(path) {
    try {
      return lstatSync(path, { bigint: true, throwIfNoEntry: false });
    } catch {
      // Unreadable (a folder above it can't be searched): treated as missing.
      return undefined;
    }
  },
  readlink: (path) => readlinkSync(path),
  readdir(dir, limit) {
    const names: string[] = [];
    try {
      const handle = opendirSync(dir);
      try {
        for (let entry = handle.readSync(); entry !== null && names.length < limit; entry = handle.readSync()) {
          names.push(entry.name);
        }
      } finally {
        handle.closeSync();
      }
    } catch {
      // An unreadable folder has no name to probe with.
    }
    return names;
  },
};

/** The result of resolving a path: its real path, and the deepest part of it that exists. */
interface Resolved {
  readonly canonical: string;
  /** The real path of the deepest ancestor (or the path itself) that exists; '' when none does. */
  readonly existing: string;
}

/** Creates path identity for one file system, path flavour and working directory. */
export function createPathIdentifier(options: PathIdentifierOptions = {}): PathIdentifier {
  const flavour = options.path ?? nodePath;
  const fs = options.fs ?? nodeIdentityFileSystem;
  const cwd = options.cwd ?? (() => process.cwd());
  const windows = flavour.sep === '\\';
  const defaultInsensitive =
    options.defaultCaseInsensitive ??
    (windows || (flavour === nodePath && (process.platform === 'darwin' || process.platform === 'win32')));
  const byVolume = new Map<bigint, boolean>();

  const tidy = (path: string): string => (windows ? normalizeWindowsPath(path) : path);

  function realpathOrUndefined(path: string): string | undefined {
    try {
      return tidy(fs.realpath(path));
    } catch {
      return undefined;
    }
  }

  function readlinkOrUndefined(path: string): string | undefined {
    try {
      return fs.readlink(path);
    } catch {
      // Replaced by something else since it was found to be a link.
      return undefined;
    }
  }

  /** `abs` resolved: followed through every link that exists, dangling ones included. */
  function resolvePath(abs: string, depth: number): Resolved {
    const real = realpathOrUndefined(abs);
    if (real !== undefined) return { canonical: real, existing: real };
    const parent = flavour.dirname(abs);
    if (parent === abs) return { canonical: abs, existing: '' };
    const above = resolvePath(parent, depth);
    const here = flavour.join(above.canonical, flavour.basename(abs));
    const stat = fs.lstat(here);
    if (stat?.isSymbolicLink() && depth < MAX_LINK_DEPTH) {
      // A link whose target is missing: follow it to where the target would be. A relative target is
      // relative to the folder that really holds the link, not to the path written.
      const target = readlinkOrUndefined(here);
      if (target !== undefined) {
        const next = resolvePath(tidy(flavour.resolve(above.canonical, target)), depth + 1);
        return { canonical: next.canonical, existing: next.existing === '' ? above.existing : next.existing };
      }
    }
    // Missing (or a link cycle, or unreadable): the rest of the path is kept as written.
    return { canonical: here, existing: stat === undefined ? above.existing : here };
  }

  /** Whether lookups of `name` in the folder `dir` ignore case; undefined when `name` can't tell. */
  function probeName(dir: string, name: string): boolean | undefined {
    const flipped = flipCase(name);
    if (flipped === name) return undefined;
    const original = fs.lstat(flavour.join(dir, name));
    if (original === undefined) return undefined;
    const other = fs.lstat(flavour.join(dir, flipped));
    return other?.dev === original.dev && other.ino === original.ino;
  }

  /** Whether the volume holding the existing folder `dir` compares names without case. */
  function volumeIsInsensitive(dir: string): boolean {
    const stat = fs.lstat(dir);
    if (stat === undefined) return defaultInsensitive;
    const cached = byVolume.get(stat.dev);
    if (cached !== undefined) return cached;
    let answer: boolean | undefined;
    // A name in the folder itself, else the folder's own name in the folder above, while that is on
    // the same volume, and so on up.
    for (const name of fs.readdir(dir, PROBE_ENTRIES)) {
      answer = probeName(dir, name);
      if (answer !== undefined) break;
    }
    for (let below = dir, above = flavour.dirname(dir); answer === undefined && above !== below;) {
      if (fs.lstat(above)?.dev !== stat.dev) break;
      answer = probeName(above, flavour.basename(below));
      below = above;
      above = flavour.dirname(above);
    }
    const result = answer ?? defaultInsensitive;
    byVolume.set(stat.dev, result);
    return result;
  }

  function caseInsensitiveAt(existing: string): boolean {
    if (existing === '') return defaultInsensitive;
    const stat = fs.lstat(existing);
    return volumeIsInsensitive(stat?.isDirectory() === true ? existing : flavour.dirname(existing));
  }

  function keyOf(canonical: string, insensitive: boolean): string {
    const key = insensitive ? foldCase(canonical) : canonical;
    return windows ? foldUncRoot(key) : key;
  }

  function displayOf(absolute: string, canonical: string, canonicalCwd: () => string): string {
    const rel = flavour.relative(tidy(cwd()), absolute);
    if (isInsideRelative(rel, flavour)) return rel === '' ? '.' : rel;
    // Outside the working directory as written: try again between the real paths, first keeping the
    // file's own name (a link to a file is reported by its name, not its target's), then the target.
    const located = flavour.join(resolvePath(flavour.dirname(absolute), 0).canonical, flavour.basename(absolute));
    for (const candidate of [located, canonical]) {
      const realRel = flavour.relative(canonicalCwd(), candidate);
      if (isInsideRelative(realRel, flavour)) return realRel === '' ? '.' : realRel;
    }
    return rel;
  }

  function identify(authored: string): PathIdentity {
    const absolute = tidy(flavour.resolve(tidy(cwd()), authored));
    const resolved = resolvePath(absolute, 0);
    const caseInsensitive = caseInsensitiveAt(resolved.existing);
    let realCwd: string | undefined;
    const canonicalCwd = (): string => (realCwd ??= resolvePath(tidy(cwd()), 0).canonical);
    return {
      authored,
      absolute,
      canonical: resolved.canonical,
      key: keyOf(resolved.canonical, caseInsensitive),
      display: displayOf(absolute, resolved.canonical, canonicalCwd),
      caseInsensitive,
    };
  }

  function matchesExclude(identity: PathIdentity, globs: readonly string[]): boolean {
    if (globs.length === 0) return false;
    const matchesGlob = globMatcher(flavour);
    const realRel = flavour.relative(resolvePath(tidy(cwd()), 0).canonical, identity.canonical);
    const relative = [identity.display, ...(isInsideRelative(realRel, flavour) ? [realRel] : [])];
    const absolute = [identity.absolute, identity.canonical];
    return globs.some((glob) => {
      const pattern = glob.replace(/^\.[/\\]/, '');
      const candidates = flavour.isAbsolute(pattern) ? absolute : relative;
      if (identity.caseInsensitive) {
        const folded = foldCase(pattern);
        return candidates.some((candidate) => matchesGlob(foldCase(candidate), folded));
      }
      const lowered = lowerGlobExtension(pattern);
      return candidates.some(
        (candidate) =>
          matchesGlob(candidate, pattern) ||
          (lowered !== undefined && matchesGlob(lowerPathExtension(candidate, flavour), lowered)),
      );
    });
  }

  return {
    identify,
    sameFile: (a, b) => identify(a).key === identify(b).key,
    isSameOrInside: (inner, outer) => isKeyInside(identify(inner).key, identify(outer).key, flavour.sep),
    matchesExclude,
    clearCache: () => {
      byVolume.clear();
    },
  };
}

/** Path identity on the real file system, for the running platform and working directory. */
const defaultIdentifier = createPathIdentifier();

/** The identity of `path` on the real file system. See {@link PathIdentifier.identify}. */
export function identify(path: string): PathIdentity {
  return defaultIdentifier.identify(path);
}

/** Whether `a` and `b` name the same file on the real file system. */
export function sameFile(a: string, b: string): boolean {
  return defaultIdentifier.sameFile(a, b);
}

/** Whether `inner` is `outer` or inside it on the real file system. */
export function isSameOrInside(inner: string, outer: string): boolean {
  return defaultIdentifier.isSameOrInside(inner, outer);
}

/** Whether one of `globs` excludes the file. See the module comment. */
export function matchesExclude(identity: PathIdentity, globs: readonly string[]): boolean {
  return defaultIdentifier.matchesExclude(identity, globs);
}

/** Forgets the volumes probed so far. */
export function clearPathIdentityCache(): void {
  defaultIdentifier.clearCache();
}

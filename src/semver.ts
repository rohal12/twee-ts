/**
 * SemVer parsing and precedence, shared by every story format lookup (local folders, the download
 * cache and remote indices).
 *
 * Parsing follows Tweego's `semver.NewVersion` (Masterminds/semver): a leading `v` is allowed, and
 * `x` or `x.y` stand for `x.0.0` and `x.y.0`. Comparison follows SemVer 2.0.0 §11: a prerelease
 * ranks below its release, prerelease identifiers compare field by field, and build metadata is
 * ignored.
 */
import type { SemVer } from './types.js';

const IDENTIFIERS = String.raw`[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*`;
const VERSION = new RegExp(String.raw`^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(${IDENTIFIERS}))?(?:\+${IDENTIFIERS})?$`);
const NUMERIC = /^\d+$/;

/** Parse a version string, or return null when it is not a version. */
export function parseVersion(text: string): SemVer | null {
  const m = VERSION.exec(text);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
  };
}

/** Compare two prerelease identifiers: numeric ones numerically and below alphanumeric ones, which compare as ASCII. */
function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare prerelease identifier lists. An empty list (a release) ranks above any prerelease. */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const order = compareIdentifiers(a[i] ?? '', b[i] ?? '');
    if (order !== 0) return order;
  }
  return Math.sign(a.length - b.length);
}

/** Compare two versions by SemVer precedence: negative when `a` ranks lower, 0 when equal, positive when higher. */
export function compareVersions(a: SemVer, b: SemVer): number {
  return (
    Math.sign(a.major - b.major) ||
    Math.sign(a.minor - b.minor) ||
    Math.sign(a.patch - b.patch) ||
    comparePrerelease(a.prerelease, b.prerelease)
  );
}

/** Whether two version strings name the same version (prerelease included, build metadata ignored). */
export function sameVersion(a: string, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left !== null && right !== null && compareVersions(left, right) === 0;
}

/**
 * SemVer parsing and precedence, shared by every story format lookup (local folders, format URLs
 * and format indices).
 *
 * Parsing follows SemVer 2.0.0 with two of Tweego's `semver.NewVersion` (Masterminds/semver)
 * extensions: a leading `v` or `V` is allowed, and `x` or `x.y` stand for `x.0.0` and `x.y.0`.
 * As SemVer 2.0.0 §2 and §9 require, a numeric identifier (major, minor, patch, or a numeric
 * prerelease identifier) has no leading zero: `01.2.3` and `1.2.3-01` are not versions.
 * Major, minor and patch must not exceed `Number.MAX_SAFE_INTEGER`, so that they compare exactly;
 * a larger number is not accepted as a version. Numeric prerelease identifiers have no size limit.
 *
 * Comparison follows SemVer 2.0.0 §11: a prerelease ranks below its release, prerelease
 * identifiers compare field by field (numeric ones by value and below alphanumeric ones, which
 * compare in ASCII order), and build metadata is ignored.
 */
import type { SemVer } from './types.js';

const NUMBER = String.raw`0|[1-9]\d*`;
/** A prerelease identifier: a number without leading zeros, or an alphanumeric one with at least one non-digit. */
const PRERELEASE_ID = String.raw`(?:${NUMBER}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD_ID = String.raw`[0-9A-Za-z-]+`;
const VERSION = new RegExp(
  String.raw`^[vV]?(${NUMBER})(?:\.(${NUMBER}))?(?:\.(${NUMBER}))?` +
    String.raw`(?:-(${PRERELEASE_ID}(?:\.${PRERELEASE_ID})*))?(?:\+${BUILD_ID}(?:\.${BUILD_ID})*)?$`,
);
const NUMERIC = /^\d+$/;

/** A version number part, or undefined when it is too large to compare exactly. */
function versionNumber(digits: string | undefined): number | undefined {
  const value = Number(digits ?? '0');
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Parse a version string, or return null when it is not a version (see the module comment). */
export function parseVersion(text: string): SemVer | null {
  const m = VERSION.exec(text);
  if (!m) return null;
  const major = versionNumber(m[1]);
  const minor = versionNumber(m[2]);
  const patch = versionNumber(m[3]);
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major, minor, patch, prerelease: m[4] === undefined ? [] : m[4].split('.') };
}

/** Compare two digit strings without leading zeros by value, whatever their size. */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return Math.sign(a.length - b.length);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two prerelease identifiers: numeric ones by value and below alphanumeric ones, which compare as ASCII. */
function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return compareDigits(a, b);
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

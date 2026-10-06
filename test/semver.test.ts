import { describe, it, expect } from 'vitest';
import { compareVersions, parseVersion, sameVersion } from '../src/semver.js';

/** Parse a version the test knows is valid. */
function v(text: string) {
  const parsed = parseVersion(text);
  if (!parsed) throw new Error(`expected ${JSON.stringify(text)} to parse`);
  return parsed;
}

describe('parseVersion', () => {
  it('parses major.minor.patch with prerelease and build metadata', () => {
    expect(parseVersion('2.37.3')).toEqual({ major: 2, minor: 37, patch: 3, prerelease: [] });
    expect(parseVersion('2.0.0-beta.1+build.5')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: ['beta', '1'] });
  });

  it('accepts a leading v and coerces x and x.y, as Tweego does (#164)', () => {
    expect(parseVersion('v1.0.0')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] });
    expect(parseVersion('V1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('1.0')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] });
    expect(parseVersion('3')).toEqual({ major: 3, minor: 0, patch: 0, prerelease: [] });
    expect(parseVersion('1.2-rc.1')).toEqual({ major: 1, minor: 2, patch: 0, prerelease: ['rc', '1'] });
  });

  it('rejects text that is not a version', () => {
    for (const text of [
      '',
      'not-a-version',
      'v',
      '1.',
      '1..2',
      '1.2.3.4',
      '1.2.3-',
      '1.2.3+',
      '1.2.3-a..b',
      ' 1.2.3',
    ]) {
      expect(parseVersion(text), text).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders by SemVer precedence, prerelease identifiers included (#162)', () => {
    // The precedence example from SemVer 2.0.0 §11.
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    for (let i = 0; i + 1 < ordered.length; i++) {
      const lower = ordered[i] ?? '';
      const higher = ordered[i + 1] ?? '';
      expect(compareVersions(v(lower), v(higher)), `${lower} < ${higher}`).toBeLessThan(0);
      expect(compareVersions(v(higher), v(lower)), `${higher} > ${lower}`).toBeGreaterThan(0);
    }
  });

  it('ranks a release above its prerelease whichever side it is on, and compares numeric identifiers numerically', () => {
    expect(compareVersions(v('1.0.0'), v('1.0.0-rc.1'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0-rc.1'), v('1.0.0'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0-rc.1'), v('1.0.0-rc.1'))).toBe(0);
    expect(compareVersions(v('1.0.0-rc.1'), v('1.0.0-rc'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0-1'), v('1.0.0-a'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0-a'), v('1.0.0-1'))).toBeGreaterThan(0);
  });

  it('ignores build metadata and the v prefix', () => {
    expect(compareVersions(v('1.0.0+a'), v('1.0.0+b'))).toBe(0);
    expect(compareVersions(v('v1.0'), v('1.0.0'))).toBe(0);
  });
});

describe('sameVersion', () => {
  it('treats a prerelease as a different version from its release (#162)', () => {
    expect(sameVersion('2.0.0', '2.0.0')).toBe(true);
    expect(sameVersion('v2.0', '2.0.0+build')).toBe(true);
    expect(sameVersion('2.0.0-beta.1', '2.0.0')).toBe(false);
    expect(sameVersion('2.0.0', 'latest')).toBe(false);
  });
});

/**
 * SemVer parsing and precedence against the SemVer 2.0.0 specification's own examples, and
 * property-based checks over generated versions against an independent BigInt-based comparator.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { compareVersions, parseVersion, sameVersion } from '../src/semver.js';
import type { SemVer } from '../src/types.js';

function parsed(text: string): SemVer {
  const version = parseVersion(text);
  if (!version) throw new Error(`${text} should be a version`);
  return version;
}

const compare = (a: string, b: string): number => compareVersions(parsed(a), parsed(b));

describe('the SemVer 2.0.0 specification examples', () => {
  it('orders the §11 precedence chain', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '2.0.0',
      '2.1.0',
      '2.1.1',
    ];
    for (let i = 0; i < chain.length; i++) {
      for (let j = 0; j < chain.length; j++) {
        expect(Math.sign(compare(chain[i] ?? '', chain[j] ?? ''))).toBe(Math.sign(i - j));
      }
    }
  });

  it.each([
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0.3.7',
    '1.0.0-x.7.z.92',
    '1.0.0-x-y-z.--',
    '1.0.0-alpha+001',
    '1.0.0+20130313144700',
    '1.0.0-beta+exp.sha.5114f85',
    '1.0.0+21AF26D3----117B344092BD',
    '0.0.0',
    '1.0.0-0A.is.legal',
  ])('accepts %s (§9, §10)', (text) => {
    expect(parseVersion(text)).not.toBeNull();
  });

  it.each([
    ['a leading zero in the major version', '01.0.0'],
    ['a leading zero in the minor version', '1.01.0'],
    ['a leading zero in the patch version', '1.0.01'],
    ['a numeric prerelease identifier with a leading zero', '1.0.0-01'],
    ['a later numeric prerelease identifier with a leading zero', '1.0.0-alpha.01'],
    ['an empty prerelease', '1.0.0-'],
    ['an empty prerelease identifier', '1.0.0-a..b'],
    ['empty build metadata', '1.0.0+'],
    ['an empty build identifier', '1.0.0+a..b'],
    ['a character outside [0-9A-Za-z-]', '1.0.0-α'],
    ['a fourth number', '1.2.3.4'],
    ['surrounding space', ' 1.2.3'],
    ['nothing', ''],
  ])('rejects %s (%s) (F18)', (_label, text) => {
    expect(parseVersion(text)).toBeNull();
  });

  it('ignores build metadata (§10)', () => {
    expect(sameVersion('1.0.0+20130313144700', '1.0.0')).toBe(true);
    expect(sameVersion('1.0.0-beta+exp.sha.5114f85', '1.0.0-beta')).toBe(true);
  });
});

describe('Tweego’s extensions', () => {
  it.each([
    ['v1.2.3', '1.2.3'],
    ['V1.2.3', '1.2.3'],
    ['1', '1.0.0'],
    ['1.2', '1.2.0'],
    ['v2-beta', '2.0.0-beta'],
  ])('reads %s as %s', (loose, strict) => {
    expect(sameVersion(loose, strict)).toBe(true);
  });
});

describe('numbers beyond floating-point precision (F18)', () => {
  it('accepts major, minor and patch up to 2^53 − 1 and rejects larger ones', () => {
    expect(parseVersion('9007199254740991.0.0')?.major).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseVersion('9007199254740992.0.0')).toBeNull();
    expect(parseVersion('1.99999999999999999999.0')).toBeNull();
  });

  it('compares numeric prerelease identifiers of any size exactly', () => {
    expect(compare('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBe(1);
    expect(compare('1.0.0-123456789012345678901234567890', '1.0.0-123456789012345678901234567891')).toBe(-1);
    expect(sameVersion('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBe(false);
  });
});

// --- Generated versions ---

const numeric = fc.oneof(fc.nat({ max: 20 }), fc.bigInt({ min: 0n, max: 2n ** 53n - 1n }).map(Number));
const prereleaseId = fc.oneof(
  fc.bigInt({ min: 0n, max: 10n ** 25n }).map(String),
  fc.stringMatching(/^[0-9A-Za-z-]{0,6}[A-Za-z-][0-9A-Za-z-]{0,6}$/),
);
const buildId = fc.stringMatching(/^[0-9A-Za-z-]{1,8}$/);

interface Generated {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly build: readonly string[];
}

const generated: fc.Arbitrary<Generated> = fc.record({
  major: numeric,
  minor: numeric,
  patch: numeric,
  prerelease: fc.array(prereleaseId, { maxLength: 4 }),
  build: fc.array(buildId, { maxLength: 3 }),
});

function format(v: Generated): string {
  const pre = v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : '';
  const build = v.build.length > 0 ? `+${v.build.join('.')}` : '';
  return `${v.major}.${v.minor}.${v.patch}${pre}${build}`;
}

/** SemVer §11 precedence, written independently with BigInt numbers. */
function referenceCompare(a: Generated, b: Generated): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const order = BigInt(a[key]) - BigInt(b[key]);
    if (order !== 0n) return order < 0n ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i] ?? '';
    const y = b.prerelease[i] ?? '';
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const order = BigInt(x) - BigInt(y);
      if (order !== 0n) return order < 0n ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

describe('generated versions', () => {
  it('parse back to their parts', () => {
    fc.assert(
      fc.property(generated, (v) => {
        expect(parseVersion(format(v))).toEqual({
          major: v.major,
          minor: v.minor,
          patch: v.patch,
          prerelease: v.prerelease,
        });
      }),
    );
  });

  it('compare as the reference comparator does', () => {
    fc.assert(
      fc.property(generated, generated, (a, b) => {
        expect(compare(format(a), format(b))).toBe(referenceCompare(a, b));
      }),
    );
  });

  it('compare antisymmetrically and transitively', () => {
    fc.assert(
      fc.property(generated, generated, generated, (a, b, c) => {
        const [x, y, z] = [format(a), format(b), format(c)];
        expect(compare(x, y)).toBe(-compare(y, x) || 0);
        fc.pre(compare(x, y) <= 0 && compare(y, z) <= 0);
        expect(compare(x, z)).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('ignore build metadata', () => {
    fc.assert(
      fc.property(generated, fc.array(buildId, { minLength: 1, maxLength: 3 }), (v, build) => {
        expect(sameVersion(format(v), format({ ...v, build }))).toBe(true);
      }),
    );
  });

  it('stop being versions when major, minor or patch gets a leading zero', () => {
    fc.assert(
      fc.property(generated, fc.nat({ max: 2 }), (v, part) => {
        const text = format(v).replace(new RegExp(String.raw`^((?:\d+\.){${part}})`), '$10');
        expect(parseVersion(text)).toBeNull();
      }),
    );
  });

  it('stop being versions when a numeric prerelease identifier gets a leading zero', () => {
    fc.assert(
      fc.property(generated, (v) => {
        const digits = v.prerelease.findIndex((id) => /^\d+$/.test(id));
        fc.pre(digits !== -1);
        const prerelease = v.prerelease.map((id, i) => (i === digits ? `0${id}` : id));
        expect(parseVersion(format({ ...v, prerelease }))).toBeNull();
      }),
    );
  });
});

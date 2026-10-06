/**
 * Properties of the one selection function over generated candidate sets: it agrees with a
 * reference model of the documented policy, a candidate's source kind never changes the choice
 * (#224, F03), gathering sources one at a time gives the same choice as gathering all of them
 * (which format resolution relies on), and a name request never crosses major versions.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { selectFormat } from '../src/formats.js';
import type { FormatCandidate, FormatSourceKind } from '../src/formats.js';
import { compareVersions, parseVersion } from '../src/semver.js';
import type { FormatRequest, SemVer } from '../src/types.js';

const versions = [
  '1.0.0',
  '1.5.0',
  '2.0.0',
  '2.0.0-rc.1',
  '2.1.0',
  'v2.1.0',
  '2.1.0+b',
  '2.2.0-beta',
  '2.4.1',
  '3.0.0',
];
const names = ['SugarCube', 'sugarcube', 'Harlowe'];

const candidate: fc.Arbitrary<FormatCandidate> = fc.record({
  name: fc.constantFrom(...names),
  version: fc.constantFrom(...versions),
  isTwine2: fc.constant(true),
  source: fc.constantFrom<FormatSourceKind>('local', 'url', 'index'),
  rank: fc.nat({ max: 3 }),
});

const request: fc.Arbitrary<FormatRequest> = fc.oneof(
  fc.record({
    kind: fc.constant('name' as const),
    name: fc.constantFrom(...names),
    version: fc.constantFrom(...versions, '', '2.x'),
  }),
  fc.record({ kind: fc.constant('id' as const), id: fc.constantFrom('sugarcube-2', 'SugarCube-1', 'harlowe-3') }),
);

const versionedNameRequest = fc.record({
  kind: fc.constant('name' as const),
  name: fc.constantFrom(...names),
  version: fc.constantFrom(...versions),
});

function version(text: string): SemVer {
  const parsed = parseVersion(text);
  if (!parsed) throw new Error(`not a version: ${text}`);
  return parsed;
}

/** The documented policy, written out directly: tiers, then source rank, tier, version, case, order. */
function model(req: FormatRequest, candidates: readonly FormatCandidate[]): FormatCandidate | undefined {
  const tierOf = (c: FormatCandidate): number | undefined => {
    const v = version(c.version);
    if (req.kind === 'id') {
      return `${c.name.toLowerCase()}-${v.major}` === req.id.toLowerCase() ? 4 : undefined;
    }
    if (c.name.toLowerCase() !== req.name.toLowerCase()) return undefined;
    const wanted = parseVersion(req.version);
    if (!wanted) return 3;
    if (v.major !== wanted.major) return undefined;
    const order = compareVersions(v, wanted);
    return order === 0 ? 1 : order > 0 ? 2 : 5;
  };
  const exactCase = (c: FormatCandidate): number => Number(req.kind === 'name' && c.name === req.name);
  const ranked = candidates
    .map((c, index) => ({ c, index, tier: tierOf(c) }))
    .filter((j): j is { c: FormatCandidate; index: number; tier: number } => j.tier !== undefined)
    .sort(
      (a, b) =>
        Number(a.tier === 5) - Number(b.tier === 5) ||
        a.c.rank - b.c.rank ||
        a.tier - b.tier ||
        compareVersions(version(b.c.version), version(a.c.version)) ||
        exactCase(b.c) - exactCase(a.c) ||
        a.index - b.index,
    );
  return ranked[0]?.c;
}

describe('selectFormat', () => {
  it('chooses what the reference model of the policy chooses', () => {
    fc.assert(
      fc.property(request, fc.array(candidate, { maxLength: 8 }), (req, candidates) => {
        expect(selectFormat(req, candidates, { allowOlder: true })?.choice).toBe(model(req, candidates));
      }),
      { numRuns: 2000 },
    );
  });

  it('chooses the same whatever source kind holds each candidate (I2)', () => {
    fc.assert(
      fc.property(
        request,
        fc.array(candidate, { maxLength: 8 }),
        fc.array(fc.constantFrom<FormatSourceKind>('local', 'url', 'index'), { minLength: 8, maxLength: 8 }),
        (req, candidates, kinds) => {
          const moved = candidates.map((c, i) => ({ ...c, source: kinds[i] ?? c.source }));
          const before = selectFormat(req, candidates, { allowOlder: true });
          const after = selectFormat(req, moved, { allowOlder: true });
          expect(after && candidates[moved.indexOf(after.choice)]).toBe(before?.choice);
        },
      ),
    );
  });

  it('chooses the same when sources are gathered one at a time, stopping at the first answer', () => {
    fc.assert(
      fc.property(request, fc.array(candidate, { maxLength: 8 }), (req, candidates) => {
        const lazy = (): FormatCandidate | undefined => {
          for (let rank = 0; rank <= 3; rank++) {
            const found = selectFormat(
              req,
              candidates.filter((c) => c.rank <= rank),
            );
            if (found) return found.choice;
          }
          return selectFormat(req, candidates, { allowOlder: true })?.choice;
        };
        expect(lazy()).toBe(selectFormat(req, candidates, { allowOlder: true })?.choice);
      }),
      { numRuns: 2000 },
    );
  });

  it('never crosses major versions for a name request with a version, and warns (tier older) only below it', () => {
    fc.assert(
      fc.property(versionedNameRequest, fc.array(candidate, { maxLength: 8 }), (req, candidates) => {
        const wanted = version(req.version);
        const selection = selectFormat(req, candidates, { allowOlder: true });
        fc.pre(selection !== undefined);
        const chosen = version(selection.choice.version);
        expect(chosen.major).toBe(wanted.major);
        expect(selection.tier === 'older').toBe(compareVersions(chosen, wanted) < 0);
      }),
    );
  });
});

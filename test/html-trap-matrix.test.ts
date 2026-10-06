/**
 * The spec-derived trap matrix (see `helpers/trap-matrix.ts`): every tokenizer state that holds a look-alike of a
 * target or hides a real one, in each tree-construction context, before each target, judged for every insertion by
 * the parse5 oracle (`helpers/insertion-judges.ts`). Issue #244 (RC1, RC2, RC3).
 */
import { describe, it, expect } from 'vitest';
import { STATES, trapCases } from './helpers/trap-matrix.js';
import { failures } from './helpers/insertion-judges.js';

const cases = trapCases();

describe('HTML trap matrix', { timeout: 120_000 }, () => {
  it('has a case for every state, context, target, direction and position', () => {
    expect(cases.length).toBeGreaterThan(3000);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  for (const state of Object.keys(STATES)) {
    it(`places every insertion right around ${state}`, () => {
      const found = cases.filter((c) => c.id.startsWith(`${state}/`)).flatMap((c) => failures(c.id, c.template));
      expect(found).toEqual([]);
    });
  }
});

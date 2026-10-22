import { describe, expect, it } from 'vitest';
import { decompileHTML } from '../src/html-parser.js';
import { growth, LINEAR_GROWTH } from './helpers/growth.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

describe('decimal zoom parsing (#498)', () => {
  // An invalid suffix after an integer mantissa used to retry every split between two digit repetitions.
  // The timeout only ends a hang; growth compares the work at two input sizes on the same machine.
  it.each(['x', 'e', 'e+', 'E-'])(
    'rejects long mantissas ending in %j with linear growth',
    { timeout: 120_000 },
    (suffix) => {
      const html = (n: number): string =>
        `<tw-storydata ifid="${IFID}" zoom="${'0'.repeat(n)}${suffix}"></tw-storydata>`;
      const result = decompileHTML(html(100));
      expect(result.story.twine2.zoom).toBe(1);
      expect(result.diagnostics).toEqual([
        {
          level: 'warning',
          message: `Cannot parse "tw-storydata" content attribute "zoom" as a float; value "${'0'.repeat(100)}${suffix}".`,
        },
      ]);
      expect(growth(html, decompileHTML, 2000)).toBeLessThan(LINEAR_GROWTH);
    },
  );
});

/**
 * The growth-ratio helper the linear-time tests share (helpers/growth.ts). The size a test gives is where it starts:
 * a runner fast enough to finish that size under the shortest time it can measure must not fail the test (#436, the
 * word-count failure of release run 38136948270), and the ratio is still measured, never skipped.
 */
import { describe, it, expect } from 'vitest';
import { growth, LINEAR_GROWTH } from './helpers/growth.js';

/** Blocks for `ms` milliseconds: work whose time is the size of its input, on any machine. */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe('growth', () => {
  it('doubles a size whose smaller input runs too fast to time, and measures the ratio', () => {
    const sizes: number[] = [];
    const ratio = growth(
      (n) => {
        sizes.push(n);
        return n;
      },
      (n) => {
        blockFor(n / 100);
      },
      1,
    );
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(LINEAR_GROWTH);
    // Size 1 takes 0.01 ms, far under the 5 ms minimum: larger sizes were tried.
    expect(sizes.slice(0, 2)).toEqual([1, 4]);
    expect(Math.max(...sizes)).toBeGreaterThan(4);
  });

  it('keeps the size it was given when that is long enough to time', () => {
    const sizes: number[] = [];
    growth(
      (n) => {
        sizes.push(n);
        return n;
      },
      (n) => {
        blockFor(n);
      },
      6,
    );
    expect(sizes).toEqual([6, 24]);
  });

  it('gives up, saying so, when no size it tries takes long enough', () => {
    expect(() =>
      growth(
        (n) => n,
        () => undefined,
        1,
      ),
    ).toThrow('the input of size 4096 (1 doubled 12 times) takes under 5 ms');
  });
});

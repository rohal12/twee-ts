/**
 * The growth-ratio helper the linear-time tests share (helpers/growth.ts). The size a test gives is where it starts:
 * a runner fast enough to finish that size under the shortest time it can measure must not fail the test (#436, the
 * word-count failure of release run 38136948270), and the ratio is still measured, never skipped.
 */
import { describe, it, expect } from 'vitest';
import { growth, LINEAR_GROWTH, now, TIMES_CPU } from './helpers/growth.js';

/**
 * Runs for `ms` milliseconds on the clock growth() times with: work whose time is the size of its input, on any
 * machine. It spins on the clock rather than sleeping, because a sleep on Windows lasts a whole timer tick (about
 * 15 ms) whatever was asked for.
 */
function blockFor(ms: number): number {
  const end = now() + ms;
  let spins = 0;
  while (now() < end) spins++;
  return spins;
}

/** Blocks this thread for `ms` milliseconds without running, as when it waits for a core. */
function waitFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A type string with a run of `n` spaces before a character that is not one (#496). */
const spacedType = (n: number): string => `text/javascript${' '.repeat(n)}x`;

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

  it('times the smaller input over as long a window as the larger one, after a run of each', () => {
    const runs = new Map<number, number>();
    growth(
      (n) => n,
      (n) => {
        runs.set(n, (runs.get(n) ?? 0) + 1);
        blockFor(n);
      },
      6,
    );
    // One untimed run each, then three rounds: the smaller input four times in a row, the larger once.
    expect([...runs]).toEqual([
      [6, 13],
      [24, 4],
    ]);
  });

  // A loaded machine (other test workers) keeps the thread off a core for part of a longer window more often than
  // for all of a shorter one: on the wall clock that counted as the larger input's work (#436, 2026-10-27).
  it.skipIf(!TIMES_CPU)('leaves out time the thread spends waiting rather than running', () => {
    const ratio = growth(
      (n) => n,
      (n) => {
        blockFor(n);
        if (n > 6) waitFor(100);
      },
      6,
    );
    expect(ratio).toBeLessThan(LINEAR_GROWTH);
  });

  it('tells quadratic work from linear work', () => {
    // The trailing-whitespace pattern #496 replaced: it retries every suffix of the run, quadratic in its length.
    expect(growth(spacedType, (type) => /[\t\n\f\r ]+$/.test(type), 1000)).toBeGreaterThan(LINEAR_GROWTH);
    // One pass over the same strings: linear.
    const spaces = (type: string): number => {
      let count = 0;
      for (const c of type) if (c === ' ') count++;
      return count;
    };
    expect(growth(spacedType, spaces, 1000)).toBeLessThan(LINEAR_GROWTH);
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

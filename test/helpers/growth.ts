/**
 * Linear-time checks that hold on a loaded machine (#436). A bound on how long one input takes measures the machine
 * as much as the code: under load a linear reader misses it, and on a fast machine a quadratic one meets it. How the
 * time grows with the size of the input does not depend on the machine.
 */

/** Input `SCALE` times as large: linear work takes about `SCALE` times as long, quadratic work `SCALE` squared. */
const SCALE = 4;

/**
 * The growth below which work counts as linear: halfway, on a log scale, between linear (`SCALE`) and quadratic
 * (`SCALE` squared). An n log n reader stays well under it.
 */
export const LINEAR_GROWTH = SCALE ** 1.5;

/** How many times each size is timed; the fastest counts. */
const ROUNDS = 3;

/** The shortest time the smaller input may take: a timer's resolution, or a fixed cost, would decide a shorter one. */
const MIN_TIMED_MS = 5;

function timed<T>(run: (input: T) => unknown, input: T): number {
  const started = performance.now();
  run(input);
  return performance.now() - started;
}

/**
 * How many times as long `run` takes on `make(n * SCALE)` as on `make(n)`. The inputs are made before anything is
 * timed. Each size is timed ROUNDS times, the two sizes in turn, and the fastest time of each counts: load on the
 * machine slows both sizes alike, and a pause in one timing (garbage collection, another process) drops out.
 */
export function growth<T>(make: (n: number) => T, run: (input: T) => unknown, n: number): number {
  const inputs = [make(n), make(n * SCALE)] as const;
  const fastest = [Infinity, Infinity];
  for (let round = 0; round < ROUNDS; round++) {
    for (const [i, input] of inputs.entries()) fastest[i] = Math.min(fastest[i] ?? Infinity, timed(run, input));
  }
  const [small = Infinity, large = Infinity] = fastest;
  if (small < MIN_TIMED_MS) throw new Error(`the input of size ${String(n)} takes under ${String(MIN_TIMED_MS)} ms`);
  return large / small;
}

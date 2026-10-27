/**
 * Linear-time checks that hold on a loaded machine (#436). A bound on how long one input takes measures the machine
 * as much as the code: under load a linear reader misses it, and on a fast machine a quadratic one meets it. How the
 * time grows with the size of the input does not depend on the machine, as long as both sizes are timed alike:
 *
 * - The clock is the CPU time of this process (Vitest runs each test file in a process of its own), so the time it
 *   waits for a core while the other test workers run does not count. Where the platform counts that time in timer
 *   ticks (Windows: about 15 ms, too coarse for timings of a few milliseconds), or test files share a process, the
 *   clock is the wall clock. A thread's own CPU time would not do: Linux counts it in scheduler ticks.
 * - The smaller input is timed SCALE times in a row, so both timings span windows of the same length. Timed once each,
 *   the short window escaped a loaded machine's interruptions more often than the long one, and the fastest timings
 *   of linear code grew by over 8 (CI, 2026-10-27).
 * - Each input runs once before it is timed, so compiling and warming up the code is not timed.
 *
 * A larger input is no remedy: at sizes that take tens of milliseconds, garbage collection and memory make even linear
 * code grow by more than SCALE.
 */
import { isMainThread } from 'node:worker_threads';

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

/** The CPU time of this process, in milliseconds. */
function processCpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/** The smallest step the process CPU clock was seen to take: it is spun on until it moves, three times. */
function processCpuStep(): number {
  let step = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = processCpuMs();
    const deadline = performance.now() + 100;
    let now = start;
    while (now === start && performance.now() < deadline) now = processCpuMs();
    if (now > start) step = Math.min(step, now - start);
  }
  return step;
}

/** Whether growth() times with the CPU time of this process; otherwise with the wall clock. */
export const TIMES_CPU = isMainThread && processCpuStep() < 0.1;

/** The clock growth() times with, in milliseconds. */
export const now: () => number = TIMES_CPU ? processCpuMs : () => performance.now();

/** How long `run` takes on `input`, per run, over `times` runs in a row. */
function timed<T>(run: (input: T) => unknown, input: T, times: number): number {
  const started = now();
  for (let i = 0; i < times; i++) run(input);
  return (now() - started) / times;
}

/** How many times `growth` may double the size it was given before it gives up on reaching MIN_TIMED_MS. */
const MAX_DOUBLINGS = 12;

/**
 * The fastest of ROUNDS timings of `run` on `make(n)` and on `make(n * SCALE)`, per run. The inputs are made and run
 * once before anything is timed, and the two sizes are timed in turn: load on the machine slows both sizes alike, and
 * a pause in one timing (garbage collection, another process) drops out.
 */
function fastestPair<T>(make: (n: number) => T, run: (input: T) => unknown, n: number): readonly [number, number] {
  const small = make(n);
  const large = make(n * SCALE);
  run(small);
  run(large);
  let fastestSmall = Infinity;
  let fastestLarge = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    fastestSmall = Math.min(fastestSmall, timed(run, small, SCALE));
    fastestLarge = Math.min(fastestLarge, timed(run, large, 1));
  }
  return [fastestSmall, fastestLarge];
}

/**
 * How many times as long `run` takes on `make(n * SCALE)` as on `make(n)`, `n` starting at the size given. How fast
 * a size runs depends on the machine, so while the smaller input takes under MIN_TIMED_MS, `n` is doubled (at most
 * MAX_DOUBLINGS times) and both sizes are timed again: the ratio is always measured on inputs long enough to time.
 */
export function growth<T>(make: (n: number) => T, run: (input: T) => unknown, n: number): number {
  for (let doublings = 0, size = n; doublings <= MAX_DOUBLINGS; doublings++, size *= 2) {
    const [small, large] = fastestPair(make, run, size);
    if (small >= MIN_TIMED_MS) return large / small;
  }
  throw new Error(
    `the input of size ${String(n * 2 ** MAX_DOUBLINGS)} (${String(n)} doubled ${String(MAX_DOUBLINGS)} times) takes under ${String(MIN_TIMED_MS)} ms`,
  );
}

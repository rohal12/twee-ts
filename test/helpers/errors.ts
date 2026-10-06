/**
 * What `run` throws. Fails, by throwing an error of its own, when `run` returns instead, so a test
 * can assert on the thrown value without an expect() inside a catch block that might never run.
 */
export function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw, but it returned');
}

/**
 * JavaScript itself as the oracle: tests that check escaping, literal parsing or generated code
 * compare twee-ts's answer with what the language makes of the same text.
 */

type CompiledFunction = (...args: unknown[]) => unknown;

/** Compiles `body` as a function body with the given parameter names; throws a SyntaxError if it is not valid. */
function compileFunction(parameters: readonly string[], body: string): CompiledFunction {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the text as JavaScript is the point of the oracle.
  const compiled = new Function(...parameters, body);
  // The Function constructor is typed as returning `Function`, which has no call signature to check against.
  return compiled as CompiledFunction;
}

/**
 * Runs `body` as a function body, with each key of `parameters` bound to its value, and returns
 * what the body returns.
 */
export function evaluateJavaScript(body: string, parameters: Readonly<Record<string, unknown>> = {}): unknown {
  return compileFunction(Object.keys(parameters), body)(...Object.values(parameters));
}

/** Checks that `body` is valid as a function body without running it; throws a SyntaxError if it is not. */
export function compileJavaScript(body: string): void {
  compileFunction([], body);
}

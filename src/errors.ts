/**
 * The errors twee-ts throws. Each module that can stop a build throws a `TweeTsError` with a code (see
 * `TweeTsErrorCode`); this module depends on nothing else in twee-ts, so every module can import it.
 */
import type { Diagnostic, TweeTsErrorCode } from './types.js';

/**
 * A build that could not run: nothing was built or written. `code` says why (see TweeTsErrorCode),
 * `diagnostics` holds what the build reported before it stopped, and `cause` the error behind it, if any.
 */
export class TweeTsError extends Error {
  readonly code: TweeTsErrorCode;

  constructor(
    message: string,
    readonly diagnostics: readonly Diagnostic[] = [],
    options: { readonly code?: TweeTsErrorCode; readonly cause?: unknown } = {},
  ) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'TweeTsError';
    this.code = options.code ?? 'BUILD_FAILED';
  }
}

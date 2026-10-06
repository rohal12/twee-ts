/**
 * The one way twee-ts reads JavaScript: acorn, bundled into the package. Nothing is ever executed.
 *
 * Story formats and story scripts run as classic scripts, so source is read with the Script goal
 * and its Annex B additions (HTML-like comments `<!--` and line-leading `-->`) plus a leading
 * hashbang, at the latest ECMAScript version acorn knows.
 */
import { Parser } from 'acorn';
import type { Options, Program } from 'acorn';

/** Options for a classic script, read as a browser reads one (sloppy mode unless it says otherwise). */
export const SCRIPT_OPTIONS: Readonly<Options> = { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true };

/** A syntax error acorn found: its message, where it is reported, and how far acorn had read. */
export class JsSyntaxError extends Error {
  constructor(
    message: string,
    /** The offset the error is reported at. */
    readonly pos: number,
    /** The offset the scanner had reached when it gave up (at least `pos`). */
    readonly raisedAt: number,
  ) {
    super(message);
  }
}

/**
 * Acorn's parser, reporting syntax errors as {@link JsSyntaxError}. Acorn's own `raise` works out a
 * line and column for its message by reading the input from the start, which callers that recover
 * from many errors cannot afford; positions are reported by offset, and the caller describes them.
 * Acorn reports every syntax error through these two methods, code nested too deeply for its
 * recursion included ("Not enough stack space to parse input").
 */
export class AcornParser extends Parser {
  /** Acorn's current scanning position, which its type declarations leave out. */
  declare pos: number;

  raise(pos: number, message: string): never {
    throw new JsSyntaxError(message, pos, this.pos);
  }

  raiseRecoverable(pos: number, message: string): never {
    this.raise(pos, message);
  }
}

/** What reading with acorn gave: a value, or the syntax error that stopped it. */
export type SyntaxRead<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: JsSyntaxError };

/** Run a read with {@link AcornParser}, turning its syntax error into a result; other errors propagate. */
export function trySyntax<T>(read: () => T): SyntaxRead<T> {
  try {
    return { ok: true, value: read() };
  } catch (e) {
    if (e instanceof JsSyntaxError) return { ok: false, error: e };
    throw e;
  }
}

/** Parse `source` as a classic script. */
export function parseScript(source: string, options: Readonly<Options> = SCRIPT_OPTIONS): SyntaxRead<Program> {
  return trySyntax(() => AcornParser.parse(source, options));
}

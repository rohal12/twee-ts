/**
 * The one way twee-ts reads JavaScript: acorn, bundled into the package. Nothing is ever executed.
 *
 * Story formats and story scripts run as classic scripts, so source is read with the Script goal
 * and its Annex B additions (HTML-like comments `<!--` and line-leading `-->`) plus a leading
 * hashbang, at the latest ECMAScript version acorn knows.
 */
import { Parser } from 'acorn';
import type { Options, Program } from 'acorn';
import { escapeLoneSurrogates, quotableCharacterAt } from './source-text.js';

/** How acorn's message for a character no token can start with begins. */
const UNEXPECTED_CHARACTER = 'Unexpected character ';

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
    /** Whether the code may be valid, but nests too deeply for the parser: the call stack ran out. */
    readonly tooDeep = false,
  ) {
    super(message);
  }
}

/**
 * Acorn's parser, reporting syntax errors as {@link JsSyntaxError}. Acorn's own `raise` works out a
 * line and column for its message by reading the input from the start, which callers that recover
 * from many errors cannot afford; positions are reported by offset, and the caller describes them.
 * Acorn reports every syntax error through these two methods. It also turns most stack overflows
 * into a syntax error ("Not enough stack space to parse input"), which is reported as nesting too deep
 * (`tooDeep`), since the code may well be valid; where the stack runs out in a part of acorn it does not
 * guard, or in `raise` itself, the engine's `RangeError` comes through, which {@link trySyntax} reports the
 * same way.
 */
export class AcornParser extends Parser {
  /** Acorn's current scanning position, which its type declarations leave out. */
  declare pos: number;

  raise(pos: number, message: string): never {
    if (message === ACORN_STACK_OVERFLOW) throw tooDeep(pos, this.pos);
    // Diagnostics quote this message. Acorn quotes an unexpected character as it reads it: a lone surrogate as it
    // is, and a high surrogate at the end of the input as U+10000; so that character is quoted from the input.
    const quoted = message.startsWith(UNEXPECTED_CHARACTER)
      ? `${UNEXPECTED_CHARACTER}'${quotableCharacterAt(this.input, pos)}'`
      : escapeLoneSurrogates(message);
    throw new JsSyntaxError(quoted, pos, this.pos);
  }

  raiseRecoverable(pos: number, message: string): never {
    this.raise(pos, message);
  }
}

/** What reading with acorn gave: a value, or the syntax error that stopped it. */
export type SyntaxRead<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: JsSyntaxError };

/** The message of acorn's own stack overflow guard. */
const ACORN_STACK_OVERFLOW = 'Not enough stack space to parse input';

/** The error for code nested too deeply to read: the call stack ran out, which says nothing of its syntax. */
function tooDeep(pos: number, raisedAt: number): JsSyntaxError {
  return new JsSyntaxError('Nested too deeply to read: the parser ran out of stack space', pos, raisedAt, true);
}

/** The engine's messages for a stack overflow (V8, SpiderMonkey), as acorn recognises them. */
const STACK_OVERFLOW = /\bstack\b.*\b(?:exceeded|overflow)\b|\btoo much recursion\b/i;

/**
 * Run a read with {@link AcornParser}, turning its syntax error, or a stack overflow on input nested
 * too deeply, into a result; other errors propagate.
 */
export function trySyntax<T>(read: () => T): SyntaxRead<T> {
  try {
    return { ok: true, value: read() };
  } catch (e) {
    if (e instanceof JsSyntaxError) return { ok: false, error: e };
    if (e instanceof RangeError && STACK_OVERFLOW.test(e.message)) {
      return { ok: false, error: tooDeep(0, 0) };
    }
    throw e;
  }
}

/** Parse `source` as a classic script. */
export function parseScript(source: string, options: Readonly<Options> = SCRIPT_OPTIONS): SyntaxRead<Program> {
  return trySyntax(() => AcornParser.parse(source, options));
}

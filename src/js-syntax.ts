/**
 * The one way twee-ts reads JavaScript: acorn, bundled into the package. Nothing is ever executed.
 *
 * Story formats and story scripts run as classic scripts, so source is read with the Script goal
 * and its Annex B additions (HTML-like comments `<!--` and line-leading `-->`) plus a leading
 * hashbang, at the latest ECMAScript version acorn knows.
 */
import { Parser } from 'acorn';
import type { AnyNode, Comment, Options, Program } from 'acorn';
import { escapeLoneSurrogates, quotableCharacterAt } from './source-text.js';
import { isRecord, pushAll } from './util.js';

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
 * Acorn 8's scope lists use only push(name), indexOf(name) as a membership test, and lexical[0] for a simple
 * catch binding. Keep that interface indexed, leaving all declaration and export rules in Acorn itself.
 * Names are append-only for the lifetime of a scope; duplicate var/function declarations are ordinary members.
 */
class ScopeNames {
  private readonly names = new Set<string>();
  0: string | undefined;

  push(name: string): void {
    this[0] ??= name;
    this.names.add(name);
  }

  indexOf(name: string): number {
    return this.names.has(name) ? 0 : -1;
  }
}

/** The fields of Acorn 8's regexp validation state needed before its duplicate-name comparison loop. */
interface RegExpBranch {
  readonly parent: RegExpBranch | null;
}

interface RegExpState {
  readonly start: number;
  readonly pos: number;
  readonly lastStringValue: string;
  readonly groupNames: Readonly<Record<string, boolean | readonly RegExpBranch[] | undefined>>;
  readonly branchID: RegExpBranch;
}

declare module 'acorn' {
  interface Parser {
    regexp_groupSpecifier(state: RegExpState): void;
    regexp_eatGroupName(state: RegExpState): boolean;
  }
}

/** Bound both Acorn's pairwise branch comparisons and the engine's later RegExp construction per name. */
const MAX_SAME_NAME_CAPTURES = 128;
const MAX_REGEXP_BRANCH_WORK = 1_000_000;

function branchDepth(branch: RegExpBranch): number {
  let depth = 0;
  for (let current: RegExpBranch | null = branch; current !== null; current = current.parent) depth++;
  return depth;
}

/** A lexically complete regexp token that cannot be validated within the work limit; raisedAt is its end. */
export class JsRegExpLimitError extends JsSyntaxError {}

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
  private readingGroupSpecifier = false;
  // Acorn makes a fresh group-name table per literal and per validation pass, which also resets this budget.
  private readonly regexpBranchWork = new WeakMap<object, number>();
  /** Acorn's current scanning position, which its type declarations leave out. */
  declare pos: number;

  /** Acorn's internal scope shape; its constructor calls enterScope before reading any bindings. */
  declare scopeStack: { flags: number; var: ScopeNames; lexical: ScopeNames; functions: ScopeNames }[];

  enterScope(flags: number): void {
    this.scopeStack.push({ flags, var: new ScopeNames(), lexical: new ScopeNames(), functions: new ScopeNames() });
  }

  override regexp_groupSpecifier(state: RegExpState): void {
    this.readingGroupSpecifier = true;
    try {
      super.regexp_groupSpecifier(state);
    } finally {
      this.readingGroupSpecifier = false;
    }
  }

  override regexp_eatGroupName(state: RegExpState): boolean {
    const read = super.regexp_eatGroupName(state);
    // Acorn also reads GroupName in backreferences: only declarations add comparison work. Let Acorn decode
    // escaped names and reject invalid grammar; its per-pattern lists reset for each literal and reparse pass.
    if (read && this.readingGroupSpecifier) {
      const known = state.groupNames[state.lastStringValue];
      if (known !== undefined && typeof known !== 'boolean') {
        if (known.length >= MAX_SAME_NAME_CAPTURES) {
          throw new JsRegExpLimitError(
            `Regular expression exceeds the parser limit of ${MAX_SAME_NAME_CAPTURES} captures with the same name`,
            state.start + state.pos,
            this.pos,
          );
        }
        // separatedFrom() walks two ancestor chains. Charge their full product before Acorn enters that loop,
        // including comparisons across nested disjoint alternatives that a count of captures alone cannot bound.
        const previousDepth = known.reduce((sum, branch) => sum + branchDepth(branch), 0);
        const work = (this.regexpBranchWork.get(state.groupNames) ?? 0) + previousDepth * branchDepth(state.branchID);
        if (work > MAX_REGEXP_BRANCH_WORK) {
          throw new JsRegExpLimitError(
            'Regular expression exceeds the parser validation work limit',
            state.start + state.pos,
            this.pos,
          );
        }
        this.regexpBranchWork.set(state.groupNames, work);
      }
    }
    return read;
  }

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

/**
 * A source that can follow generated headers or another script. Acorn's constructor consumes a leading hashbang
 * as a comment before reading any tokens. Replace just its two-character marker, keeping every source offset and
 * line terminator intact; no other comment, string or template is read or changed.
 */
export function scriptForJoin(source: string): string {
  const comments: Comment[] = [];
  AcornParser.tokenizer(source, {
    ...SCRIPT_OPTIONS,
    onComment: comments,
  });
  return comments[0]?.start === 0 ? `//${source.slice(2)}` : source;
}

/** Whether a value from an acorn tree is a syntax node. */
function isNode(value: unknown): value is AnyNode {
  return isRecord(value) && typeof value['type'] === 'string';
}

/** Every node below `root`, `root` first, in source order, without recursing on the JavaScript call stack. */
export function* javaScriptNodes(root: AnyNode): Generator<AnyNode> {
  const stack: unknown[] = [root];
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    if (isNode(value)) yield value;
    const children: readonly unknown[] = Array.isArray(value) ? value : isNode(value) ? Object.values(value) : [];
    pushAll(stack, children.toReversed());
  }
}

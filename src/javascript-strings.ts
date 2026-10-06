/**
 * Reads the strings in JavaScript source, as the link check needs them: SugarCube evaluates
 * quoted macro arguments as strict-mode JavaScript, and stories build macro calls in the strings
 * of their scripts (`$.wiki('<<goto "Room">>')`).
 *
 * Source is read with acorn (see `js-syntax.ts`), so comments, regular expression literals,
 * template literals and their nesting are told apart exactly as ECMAScript tells them apart.
 */
import { tokTypes } from 'acorn';
import type { Options, Token, TokenType } from 'acorn';
import { lineEnd } from './js-chars.js';
import { isRecord } from './util.js';
import { AcornParser, SCRIPT_OPTIONS, parseScript, trySyntax } from './js-syntax.js';
import type { JsSyntaxError } from './js-syntax.js';

/**
 * Stands in for each `${…}` substitution in a template literal's value: a Unicode noncharacter,
 * which text doesn't contain. A passage name that includes it is known only in play.
 */
export const SUBSTITUTION = '\ufdd0';

/**
 * How code is evaluated: Story JavaScript, `<<script>>` bodies and macro arguments in strict mode
 * (SugarCube evaluates them from its strict-mode code), a `<script>` element in sloppy mode (the
 * browser runs it as a classic script), or as a module (a `<script type="module">` element). Strict
 * and sloppy mode differ in their strings only in legacy octal escapes (`\101`) and `\8`/`\9`, which
 * strict mode rejects; a module is strict, and has no HTML-like comments (`<!--`, line-leading `-->`).
 */
export type ScriptMode = 'strict' | 'sloppy' | 'module';

const STRICT_OPTIONS: Readonly<Options> = { ...SCRIPT_OPTIONS, strict: true };

/**
 * The value of a quoted JavaScript string literal (quotes included, and nothing around it), as
 * JavaScript evaluates it in the given mode; `undefined` if the text is not exactly one string
 * literal, or the mode rejects it (strict mode rejects legacy octal escapes such as `\1`, and `\8`).
 */
export function evalStringLiteral(literal: string, mode: ScriptMode = 'strict'): string | undefined {
  const quote = literal[0];
  if (quote !== '"' && quote !== "'") return undefined;
  const read = trySyntax(() =>
    AcornParser.parseExpressionAt(literal, 0, mode === 'sloppy' ? SCRIPT_OPTIONS : STRICT_OPTIONS),
  );
  const node = read.ok ? read.value : undefined;
  return node?.type === 'Literal' && typeof node.value === 'string' && node.end === literal.length
    ? node.value
    : undefined;
}

/**
 * Options for reading a story's code: a classic script, with what only the surrounding code could
 * make valid (a `return` or `await` at the top level, `super`, `import`) allowed, as it changes no
 * token.
 */
const STORY_CODE_OPTIONS: Readonly<Options> = {
  ...SCRIPT_OPTIONS,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
  allowImportExportEverywhere: true,
  checkPrivateFields: false,
};

/** Options for reading story code in `mode`: a module is read with the Module goal. */
function storyCodeOptions(mode: ScriptMode): Readonly<Options> {
  return mode === 'module' ? STORY_MODULE_OPTIONS : STORY_CODE_OPTIONS;
}

const STORY_MODULE_OPTIONS: Readonly<Options> = { ...STORY_CODE_OPTIONS, sourceType: 'module' };

/** The parts of an acorn token the strings are read from; `start` and `end` index the whole source. */
interface SourceToken {
  readonly type: TokenType;
  readonly value: unknown;
  readonly start: number;
  readonly end: number;
}

function tokenValue(token: Token): unknown {
  return Reflect.get(token, 'value');
}

function sourceToken(token: Token): SourceToken {
  return {
    type: token.type,
    // Acorn's tokens carry their value, which its type declarations leave out.
    value: tokenValue(token),
    start: token.start,
    end: token.end,
  };
}

/**
 * The values of the string and template literals in JavaScript source, in the order they end. A
 * template literal's value keeps its text and has `SUBSTITUTION` where each `${…}` was; the
 * strings inside a substitution are values of their own, and come before it. A string or
 * template literal that the mode rejects is left out.
 *
 * Source that parses as a script is read exactly. Story code often doesn't (TwineScript such as
 * `$x to "y"`, or a syntax error): up to the point where the parse failed, it is read exactly; from
 * there on, by acorn's tokenizer (see {@link tokenRuns}), which tells a regular expression from a
 * division by the tokens before it and keeps track of template literals however the code is
 * written.
 */
export function javaScriptStrings(source: string, mode: ScriptMode = 'strict'): string[] {
  const tokens: Token[] = [];
  const options = storyCodeOptions(mode);
  const parsed = parseScript(source, { ...options, onToken: tokens });
  const exact = tokens.map(sourceToken);
  const runs = parsed.ok
    ? [exact]
    : joinAt(exact, tokenRuns(source, options), Math.max(parsed.error.pos, exact.at(-1)?.end ?? 0));
  return runs.flatMap((run) => literalValues(source, run, mode));
}

/** Tokens the tokenizer read in one go, from `start`, with nothing open there. */
interface TokenRun {
  readonly start: number;
  readonly tokens: SourceToken[];
}

/**
 * The exact tokens before `at`, then the tokenizer's from `at` on. The tokenizer's run that
 * reaches over `at` goes on from the exact tokens, as one run, so a template literal open there
 * stays open.
 */
function joinAt(exact: readonly SourceToken[], runs: readonly TokenRun[], at: number): SourceToken[][] {
  const joined: SourceToken[][] = [];
  let head: SourceToken[] | undefined = [...exact];
  for (const run of runs) {
    const after = run.tokens.filter((token) => token.start >= at);
    if (head !== undefined && run.start < at) {
      // One at a time: spreading a long run as arguments (`push(...after)`) overflows the stack.
      for (const token of after) head.push(token);
    } else if (after.length > 0) {
      if (head !== undefined) joined.push(head);
      head = undefined;
      joined.push(after);
    }
  }
  if (head !== undefined) joined.push(head);
  return joined;
}

declare module 'acorn' {
  // Acorn's own tokenizer methods, which its type declarations leave out; TolerantTokenizer refines them.
  interface Parser {
    /** Updates the token context and `exprAllowed` after the token just read; `prevType` is the one before. */
    updateContext(prevType: TokenType): void;
    /** Whether a `{` after a token of `prevType` opens a block (rather than an object literal). */
    braceIsBlock(prevType: TokenType): boolean;
  }
}

/** Whether one of acorn's token contexts is a brace that opened a block (acorn's `b_stat`). */
function isBlockBrace(context: unknown): boolean {
  return isRecord(context) && context['token'] === '{' && context['isExpr'] === false;
}

/**
 * Acorn's tokenizer, made to read on after an error as acorn-loose does: a syntax error ends the
 * current token with a {@link JsSyntaxError}, and {@link restartAt} reads on from a later position
 * with nothing open. The members declared here are acorn's own, which its type declarations leave
 * out.
 *
 * Without a parse, acorn tells a regular expression from a division by the tokens before it. Two of
 * its rules are refined here, where they read valid code wrongly:
 * - a `{` right after a `}` that closed a block (of a statement, a function, a class or an arrow
 *   function) opens a block, not an object literal: such a `}` ends a statement, so what follows
 *   starts one (acorn decided by whether an expression may follow, which it may);
 * - an expression may follow `await` (except as a property name, `o.await`), so `await /re/` reads
 *   a regular expression. Acorn took `await` for a name. Story code may use `await` at the top
 *   level, and `await` as a variable name, the one case read wrongly now (`await / 2`), is valid
 *   only in sloppy code outside async functions and practically unused.
 */
class TolerantTokenizer extends AcornParser {
  declare context: unknown[];
  declare exprAllowed: boolean;
  declare containsEsc: boolean;
  declare type: TokenType;
  declare value: unknown;
  declare getToken: () => Token;
  declare initialContext: () => unknown[];

  /** Whether the last token was a `}` that closed a block. */
  private closedBlock = false;

  constructor(input: string, options: Readonly<Options>) {
    super(options, input);
  }

  override updateContext(prevType: TokenType): void {
    const closing = this.type === tokTypes.braceR ? this.context.at(-1) : undefined;
    super.updateContext(prevType);
    this.closedBlock = closing !== undefined && isBlockBrace(closing);
    if (this.type === tokTypes.name && this.value === 'await' && prevType !== tokTypes.dot) {
      this.exprAllowed = true;
    }
  }

  override braceIsBlock(prevType: TokenType): boolean {
    return (prevType === tokTypes.braceR && this.closedBlock) || super.braceIsBlock(prevType);
  }

  /** Read on from `pos` as at the start of a script. */
  restartAt(pos: number): void {
    this.pos = pos;
    this.context = this.initialContext();
    this.exprAllowed = true;
    this.containsEsc = false;
    this.closedBlock = false;
  }
}

/**
 * The tokens of source that does not parse, in runs read by acorn's tokenizer. Where the
 * tokenizer stops at an error, the next run starts:
 * - after an unexpected character, just past it;
 * - after an unterminated block comment or template literal, nowhere: what follows is all inside it;
 * - after any other error (an unterminated string or regular expression, a bad escape or number),
 *   at the start of the next line, so a string that does not close is not read again from inside.
 * Each run starts with nothing open, as at the start of a script. A run starts where the last one
 * stopped reading, or later, so this takes linear time.
 */
function tokenRuns(source: string, options: Readonly<Options>): TokenRun[] {
  let run: TokenRun = { start: 0, tokens: [] };
  const runs = [run];
  const stream = new TolerantTokenizer(source, options);
  for (;;) {
    const read = trySyntax(() => stream.getToken());
    if (read.ok) {
      if (read.value.type === tokTypes.eof) break;
      run.tokens.push(sourceToken(read.value));
    } else {
      const next = resumeAfter(source, read.error);
      if (next === undefined) break;
      stream.restartAt(next);
      run = { start: next, tokens: [] };
      runs.push(run);
    }
  }
  return runs;
}

/**
 * Where to read on after a tokenizer error, or `undefined` if nothing after it can be read. The
 * kind of error is told by acorn's message; the tests pin each message this relies on.
 */
function resumeAfter(source: string, stop: JsSyntaxError): number | undefined {
  const { message } = stop;
  if (message.startsWith('Unterminated comment') || message.startsWith('Unterminated template')) return undefined;
  const next = message.startsWith('Unexpected character')
    ? stop.pos + (isSurrogatePair(source, stop.pos) ? 2 : 1)
    : nextLineStart(source, Math.max(stop.pos, stop.raisedAt));
  return next < source.length ? next : undefined;
}

/** Whether a character outside the Basic Multilingual Plane, written as two code units, starts at `pos`. */
function isSurrogatePair(source: string, pos: number): boolean {
  return /^[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(source.slice(pos, pos + 2));
}

/** The start of the line after the one holding `pos`. */
function nextLineStart(source: string, pos: number): number {
  const end = lineEnd(source, pos);
  return source.startsWith('\r\n', end) ? end + 2 : end + 1;
}

/** A template literal being read: its value so far, and whether every piece of it is valid. */
interface TemplateFrame {
  value: string;
  valid: boolean;
}

const LEGACY_ESCAPE_CANDIDATE = /\\[0-9]/;

/** The values of the string and template literals among `tokens`, in the order they end. */
function literalValues(source: string, tokens: readonly SourceToken[], mode: ScriptMode): string[] {
  const values: string[] = [];
  const templates: TemplateFrame[] = [];
  let previous: TokenType | undefined;
  for (const token of tokens) {
    const top = templates[templates.length - 1];
    switch (token.type) {
      case tokTypes.string: {
        const raw = source.slice(token.start, token.end);
        // Acorn's tokenizer cooks strings as sloppy mode does; only an escape of a digit can differ in strict mode.
        const value =
          mode !== 'sloppy' && LEGACY_ESCAPE_CANDIDATE.test(raw) ? evalStringLiteral(raw, 'strict') : token.value;
        if (typeof value === 'string') values.push(value);
        break;
      }
      case tokTypes.backQuote:
        if (previous === tokTypes.template || previous === tokTypes.invalidTemplate) {
          // The closing quote: a template piece always comes just before it.
          const done = templates.pop();
          if (done?.valid === true) values.push(done.value);
        } else {
          templates.push({ value: '', valid: true });
        }
        break;
      case tokTypes.template:
        if (top !== undefined) top.value += typeof token.value === 'string' ? token.value : '';
        break;
      case tokTypes.invalidTemplate:
        // A tagged template's piece with an escape no template may hold as a string.
        if (top !== undefined) top.valid = false;
        break;
      case tokTypes.dollarBraceL:
        if (top !== undefined) top.value += SUBSTITUTION;
        break;
      default:
        break;
    }
    previous = token.type;
  }
  return values;
}

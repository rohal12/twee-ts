/**
 * What a build does when an input can't be used: one table for every input role and failure kind,
 * so that sources, modules, the head file and the config file fail the same way for the same cause
 * (and a source or module given twice is skipped with the same warning, see `duplicateInput()`),
 * and Tweego's choices are kept where Tweego makes one. docs/cli.md shows the same table.
 *
 * Levels:
 * - `ignore`: skipped without a word (Tweego skips these too).
 * - `warning`: skipped, with a warning.
 * - `error`: an error diagnostic. The build goes on, so every such problem is reported at once, but
 *   the CLI writes nothing and exits with status 1.
 * - `fatal`: a TweeTsError before anything is built; nothing is written by any entry point.
 *
 * Every message names the role and the path and gives the cause: `load head file h.html: ENOENT: …`, or for
 * what source discovery finds while walking, as Tweego words it, `path a.tw: …` (`module path m.js: …`).
 */
import { lstatSync } from 'node:fs';
import type { Diagnostic } from './types.js';

/** What an input is for. */
export type InputRole = 'source' | 'module' | 'head' | 'config';

/** How an input was found: named by the user (CLI, config, options), or found walking a named folder. */
export type InputDiscovery = 'named' | 'found';

/** Why an input can't be used. */
export type InputFailure =
  /** Nothing at the path (for a file found in a folder: it went away between the walk and the read). */
  | 'missing'
  /** The file can't be opened or read (permissions, I/O error). */
  | 'unreadable'
  /** A folder inside a source or module folder can't be listed. */
  | 'unreadable-folder'
  /** A folder where a file is needed. */
  | 'directory'
  /** A symbolic link whose target doesn't exist (an editor's lock file, say). */
  | 'dangling-link'
  /** A file whose extension the role doesn't load. */
  | 'unsupported-type'
  /** A FIFO, device or socket where a file of the role's types is needed. */
  | 'not-a-file'
  /** Bytes that can't be decoded (invalid UTF-16 after a UTF-16 byte order mark, or UTF-32). */
  | 'undecodable';

export type PolicyLevel = 'ignore' | 'warning' | 'error' | 'fatal';

/** Every failure kind, in the order the docs list them. */
export const INPUT_FAILURES: readonly InputFailure[] = [
  'missing',
  'unreadable',
  'unreadable-folder',
  'directory',
  'dangling-link',
  'unsupported-type',
  'not-a-file',
  'undecodable',
];

type FailurePolicy = Readonly<Record<InputFailure, PolicyLevel>>;

/**
 * A named source or module folder is walked, not read: `directory` here is a file that was replaced by a
 * folder after the walk found it. The head and config files are read whatever their type and kind
 * (`--head <(…)` is a pipe), so their `unsupported-type` and `not-a-file` cells are `ignore`.
 */
const NAMED_LIST_INPUT: FailurePolicy = {
  missing: 'warning',
  unreadable: 'error',
  'unreadable-folder': 'warning',
  directory: 'error',
  'dangling-link': 'warning',
  'unsupported-type': 'warning',
  'not-a-file': 'warning',
  undecodable: 'error',
};

const FOUND_LIST_INPUT: FailurePolicy = {
  missing: 'warning',
  unreadable: 'error',
  'unreadable-folder': 'warning',
  directory: 'error',
  'dangling-link': 'ignore',
  'unsupported-type': 'ignore',
  'not-a-file': 'ignore',
  undecodable: 'error',
};

const SINGLE_FILE_INPUT: FailurePolicy = {
  missing: 'fatal',
  unreadable: 'fatal',
  'unreadable-folder': 'fatal',
  directory: 'fatal',
  'dangling-link': 'fatal',
  'unsupported-type': 'ignore',
  'not-a-file': 'ignore',
  undecodable: 'fatal',
};

/** The policy table: role × discovery × failure kind → level. */
export const INPUT_POLICY: Readonly<Record<InputRole, Readonly<Record<InputDiscovery, FailurePolicy>>>> = {
  source: { named: NAMED_LIST_INPUT, found: FOUND_LIST_INPUT },
  module: { named: NAMED_LIST_INPUT, found: FOUND_LIST_INPUT },
  // Tweego's modifyHead() stops on any head file it can't read.
  head: { named: SINGLE_FILE_INPUT, found: SINGLE_FILE_INPUT },
  // A config file that is found (twee-ts.config.json in the working directory) and missing is no config.
  config: { named: SINGLE_FILE_INPUT, found: { ...SINGLE_FILE_INPUT, missing: 'ignore' } },
};

/** How a role is named in messages: a source by its path alone, as Tweego names it. */
const ROLE_NOUN: Readonly<Record<InputRole, string>> = {
  source: '',
  module: 'module ',
  head: 'head file ',
  config: 'config file ',
};

/** Failures source discovery finds while walking, rather than while reading a file. */
const WALK_FAILURES: ReadonlySet<InputFailure> = new Set([
  'missing',
  'dangling-link',
  'unreadable-folder',
  'not-a-file',
]);

/** One input that can't be used, with the policy's verdict. */
export interface InputProblem {
  readonly role: InputRole;
  readonly discovery: InputDiscovery;
  readonly failure: InputFailure;
  /** The path as reported (relative to the working directory when inside it). */
  readonly path: string;
  readonly level: PolicyLevel;
  /** Why it can't be used: the cause's message, or a sentence for a failure without an error. */
  readonly reason: string;
  /** `load <role> <path>: <reason>`. */
  readonly message: string;
  readonly cause: unknown;
}

/** The reason text for a failure: the cause's message, or a sentence for failures that have no error. */
function reasonOf(failure: InputFailure, role: InputRole, path: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message.replace(/^read \S+: /, '') : undefined;
  switch (failure) {
    case 'missing':
    case 'unreadable':
    case 'unreadable-folder':
    case 'undecodable':
      return message ?? String(cause);
    case 'directory':
      return message ?? 'Is a folder, not a file.';
    case 'dangling-link':
      return `Symbolic link to a missing target${typeof cause === 'string' ? ` (${cause})` : ''}.`;
    case 'unsupported-type': {
      const dot = path.lastIndexOf('.');
      const ext = dot > path.lastIndexOf('/') && dot > path.lastIndexOf('\\') ? path.slice(dot) : '(none)';
      return `Not a supported ${role} file type (extension ${ext}); skipped.`;
    }
    case 'not-a-file':
      return 'Not a regular file; skipped.';
    default: {
      const _exhaustive: never = failure;
      throw new Error(`unhandled input failure: ${String(_exhaustive)}`);
    }
  }
}

/** The policy's verdict on one failed input. */
export function inputProblem(
  role: InputRole,
  discovery: InputDiscovery,
  failure: InputFailure,
  path: string,
  cause: unknown,
): InputProblem {
  const level = INPUT_POLICY[role][discovery][failure];
  const reason = reasonOf(failure, role, path, cause);
  // What source discovery finds while walking is reported as Tweego's walk reports it: `path a.tw: …`.
  const walk =
    (role === 'source' || role === 'module') &&
    WALK_FAILURES.has(failure) &&
    !(failure === 'missing' && discovery === 'found');
  const message = walk ? `${ROLE_NOUN[role]}path ${path}: ${reason}` : `load ${ROLE_NOUN[role]}${path}: ${reason}`;
  return { role, discovery, failure, path, level, reason, message, cause };
}

/** The diagnostic for a problem at the `warning` or `error` level; undefined for `ignore` (and `fatal`, thrown instead). */
export function problemDiagnostic(problem: InputProblem): Diagnostic | undefined {
  switch (problem.level) {
    case 'ignore':
    case 'fatal':
      return undefined;
    case 'warning':
    case 'error':
      return { level: problem.level, message: problem.message, file: problem.path };
    default: {
      const _exhaustive: never = problem.level;
      throw new Error(`unhandled policy level: ${String(_exhaustive)}`);
    }
  }
}

/**
 * The failure kind of an error thrown while opening or reading the file at `path`, telling a dangling symbolic
 * link (which reads as ENOENT) from a missing file.
 */
export function failureOfRead(path: string, e: unknown): InputFailure {
  const failure = failureOfError(e);
  if (failure !== 'missing') return failure;
  try {
    return lstatSync(path).isSymbolicLink() ? 'dangling-link' : 'missing';
  } catch {
    // Nothing to look at (it is missing, or below a file): missing.
    return 'missing';
  }
}

/** The warning for an input given again, under this or another spelling (`earlier`), which is skipped. */
export function duplicateInput(role: InputRole, path: string, earlier: string): Diagnostic {
  const same = earlier === path ? '' : ` (the same file as ${earlier})`;
  return { level: 'warning', message: `load ${ROLE_NOUN[role]}${path}: Skipping duplicate${same}.` };
}

/** The failure kind of an error thrown while opening or reading a file. */
export function failureOfError(e: unknown): InputFailure {
  if (e instanceof Error && e.name === 'TextDecodeError') return 'undecodable';
  const code = e instanceof Error && 'code' in e ? e.code : undefined;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'missing';
    case 'EISDIR':
      return 'directory';
    default:
      return 'unreadable';
  }
}

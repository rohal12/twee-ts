/**
 * How the build plugins turn compile results into bundler errors and warnings.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CompileOptions, CompileResult, Diagnostic, FileCacheEntry } from '../types.js';
import { isOwnOutput } from '../atomic-write.js';
import { checkNamedInputs, compileForOutputFile } from '../compiler.js';
import { escapeTerminalControls, formatDiagnostic } from '../diagnostic-text.js';
import { TweeTsError } from '../errors.js';
import type { BuildOutputs } from '../filesystem.js';
import { isPreviousBuild, outputPaths } from '../filesystem.js';
import { identify } from '../path-identity.js';

/** An error carrying the file and line the bundler reports (and Vite shows in its overlay). */
export interface LocatedError extends Error {
  id?: string;
  loc?: { file: string; line: number; column: number };
}

/** Text assembled here is already escaped; its diagnostic separators must survive outer reporters. */
class ReportedError extends Error {}

/** Returns the warnings; throws a LocatedError when the compile reported errors. */
export function splitDiagnostics(result: Readonly<CompileResult>): Diagnostic[] {
  const errors = result.diagnostics.filter((d) => d.level === 'error');
  if (errors.length === 0) return result.diagnostics.filter((d) => d.level === 'warning');
  const error: LocatedError = new ReportedError(errors.map(formatDiagnostic).join('\n'));
  const [first] = errors;
  if (first?.file) {
    const file = escapeTerminalControls(first.file);
    error.id = file;
    error.loc = { file, line: first.line ?? 1, column: 1 };
  }
  throw error;
}

/** An error thrown by the compiler or bundler, with a TweeTsError's error diagnostics folded into its message. */
export function fatalError(e: unknown): LocatedError {
  if (e instanceof ReportedError) return e;
  if (e instanceof TweeTsError) {
    const errors = e.diagnostics.filter((d) => d.level === 'error').map(formatDiagnostic);
    return new ReportedError([...errors, escapeTerminalControls(e.message)].join('\n'));
  }
  const message = escapeTerminalControls(e instanceof Error ? e.message : String(e));
  const located: LocatedError | undefined = e instanceof Error ? e : undefined;
  const id = typeof located?.id === 'string' ? escapeTerminalControls(located.id) : undefined;
  const loc = located?.loc;
  const file = typeof loc?.file === 'string' ? escapeTerminalControls(loc.file) : undefined;
  if (message === located?.message && id === located.id && file === loc?.file) return located;
  const error: LocatedError = new ReportedError(message);
  if (id !== undefined) error.id = id;
  if (loc !== undefined && file !== undefined) error.loc = { ...loc, file };
  return error;
}

/** A compiled story: its HTML, and its warnings as the plugins report them. */
export interface CompiledStory {
  readonly output: string;
  readonly warnings: readonly string[];
}

/** Files covered by directory-only entry watches, including directory links, without following cycles. */
function* entryFolderFiles(paths: Iterable<string>): Generator<string> {
  const visited = new Set<string>();
  function* walk(path: string, root: boolean): Generator<string> {
    let names: string[];
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) {
        if (!root && stat.isFile()) yield path;
        return;
      }
      const key = identify(path).key;
      if (visited.has(key)) return;
      visited.add(key);
      names = readdirSync(path);
    } catch {
      // Unreachable paths could not supply a directory's input bytes.
      return;
    }
    for (const name of names) yield* walk(join(path, name), false);
  }
  for (const path of paths) yield* walk(path, true);
}

/**
 * Compiles the story for a plugin, leaving out what a build writes (`outputs`).
 * `writesStory` is whether the story goes to a file (a build, not the dev server): a story path in `outputs`
 * that holds an authored file of a source folder then fails the compile (`OUTPUT_IS_INPUT`), as a named output
 * does. `entryFiles` are physical inputs (files or watched directories) the story must also never replace.
 * Throws a LocatedError when the compile fails or reports errors.
 */
export async function compileStory(
  options: CompileOptions,
  outputs: BuildOutputs,
  cache?: Map<string, FileCacheEntry>,
  writesStory = false,
  entryFiles: Iterable<string> = [],
): Promise<CompiledStory> {
  const inputs = [...entryFiles].map((path) => ({ role: 'entry' as const, path }));
  // Only the story is protected here; overwriting bundler chunks and assets follows the bundler's policy.
  // Re-read identities after compilation too: awaiting a format may let an output link change targets.
  const checkEntry = (): void => {
    if (!writesStory) return;
    const output = outputPaths({ files: outputs.stories ?? [], dirs: [] }, 'snapshot');
    checkNamedInputs(inputs, output, []);
    for (const path of entryFolderFiles(inputs.map((input) => input.path))) {
      // A watched directory includes prior generated stories too; they remain replaceable, as in source folders.
      if (!output.isFile(path) || isOwnOutput(path) || isPreviousBuild(path)) continue;
      checkNamedInputs([{ role: 'entry', path }], output, []);
    }
  };
  let result: CompileResult;
  try {
    checkEntry();
    result = await compileForOutputFile(
      options,
      writesStory ? outputs : { files: outputs.files, dirs: outputs.dirs },
      cache,
    );
    checkEntry();
  } catch (e) {
    throw fatalError(e);
  }
  return { output: result.output, warnings: splitDiagnostics(result).map(formatDiagnostic) };
}

/**
 * How the build plugins turn compile results into bundler errors and warnings.
 */
import type { CompileOptions, CompileResult, Diagnostic, FileCacheEntry } from '../types.js';
import { compileForOutputFile } from '../compiler.js';
import { formatDiagnostic } from '../diagnostic-text.js';
import { TweeTsError } from '../errors.js';
import type { BuildOutputs } from '../filesystem.js';

/** An error carrying the file and line the bundler reports (and Vite shows in its overlay). */
export interface LocatedError extends Error {
  id?: string;
  loc?: { file: string; line: number; column: number };
}

/** Returns the warnings; throws a LocatedError when the compile reported errors. */
export function splitDiagnostics(result: Readonly<CompileResult>): Diagnostic[] {
  const errors = result.diagnostics.filter((d) => d.level === 'error');
  if (errors.length === 0) return result.diagnostics.filter((d) => d.level === 'warning');
  const error: LocatedError = new Error(errors.map(formatDiagnostic).join('\n'));
  const [first] = errors;
  if (first?.file) {
    error.id = first.file;
    error.loc = { file: first.file, line: first.line ?? 1, column: 1 };
  }
  throw error;
}

/** An error thrown by the compiler or bundler, with a TweeTsError's error diagnostics folded into its message. */
export function fatalError(e: unknown): LocatedError {
  if (e instanceof TweeTsError) {
    const errors = e.diagnostics.filter((d) => d.level === 'error').map(formatDiagnostic);
    return new Error([...errors, e.message].join('\n'));
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** A compiled story: its HTML, and its warnings as the plugins report them. */
export interface CompiledStory {
  readonly output: string;
  readonly warnings: readonly string[];
}

/**
 * Compiles the story for a plugin, leaving out what a build writes (`outputs`).
 * `writesStory` is whether the story goes to a file (a build, not the dev server): a story path in `outputs`
 * that holds an authored file of a source folder then fails the compile (`OUTPUT_IS_INPUT`), as a named output
 * does. Throws a LocatedError when the compile fails or reports errors.
 */
export async function compileStory(
  options: CompileOptions,
  outputs: BuildOutputs,
  cache?: Map<string, FileCacheEntry>,
  writesStory = false,
): Promise<CompiledStory> {
  let result: CompileResult;
  try {
    result = await compileForOutputFile(
      options,
      writesStory ? outputs : { files: outputs.files, dirs: outputs.dirs },
      cache,
    );
  } catch (e) {
    throw fatalError(e);
  }
  return { output: result.output, warnings: splitDiagnostics(result).map(formatDiagnostic) };
}

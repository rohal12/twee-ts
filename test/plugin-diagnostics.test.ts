import { describe, it, expect } from 'vitest';
import { TweeTsError } from '../src/compiler.js';
import { fatalError, formatDiagnostic, splitDiagnostics } from '../src/plugins/diagnostics.js';
import type { CompileResult, Diagnostic } from '../src/types.js';
import { thrownBy } from './helpers/errors.js';

function resultWith(diagnostics: Diagnostic[]): CompileResult {
  return { output: '<html></html>', diagnostics } as unknown as CompileResult;
}

describe('formatDiagnostic', () => {
  it('names the file and line, and drops the parser\'s own "line N:" prefix', () => {
    expect(formatDiagnostic({ level: 'error', message: 'line 4: bad header', file: 'a.tw', line: 4 })).toBe(
      'a.tw:4: bad header',
    );
  });

  it('names a file without a line, keeping the message as it is', () => {
    expect(formatDiagnostic({ level: 'warning', message: 'line 4: odd', file: 'a.tw' })).toBe('a.tw: line 4: odd');
  });

  it('gives a message with no file as it is', () => {
    expect(formatDiagnostic({ level: 'warning', message: 'no start passage' })).toBe('no start passage');
  });
});

describe('splitDiagnostics', () => {
  it('returns the warnings when there are no errors', () => {
    const warning: Diagnostic = { level: 'warning', message: 'careful' };
    const other: Diagnostic = { level: 'warning', message: 'also careful', file: 'a.tw', line: 2 };
    expect(splitDiagnostics(resultWith([warning, other]))).toEqual([warning, other]);
  });

  it("throws an error with the first error's file and line as its location", () => {
    const run = (): unknown =>
      splitDiagnostics(
        resultWith([
          { level: 'error', message: 'line 9: broken', file: 'b.tw', line: 9 },
          { level: 'error', message: 'second' },
        ]),
      );
    expect(run).toThrow('b.tw:9: broken\nsecond');
    expect(thrownBy(run)).toMatchObject({ id: 'b.tw', loc: { file: 'b.tw', line: 9, column: 1 } });
  });

  it('puts the location at line 1 when the error names a file but no line', () => {
    const error = thrownBy(() =>
      splitDiagnostics(resultWith([{ level: 'error', message: 'unreadable', file: 'c.tw' }])),
    );
    expect(error).toMatchObject({ id: 'c.tw', loc: { file: 'c.tw', line: 1, column: 1 } });
  });

  it('gives no location when the first error names no file', () => {
    const error = thrownBy(() => splitDiagnostics(resultWith([{ level: 'error', message: 'no format' }])));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('id');
    expect(error).not.toHaveProperty('loc');
  });
});

describe('fatalError', () => {
  it("folds a TweeTsError's error diagnostics into the message", () => {
    const error = new TweeTsError('compile failed', [
      { level: 'error', message: 'line 2: oops', file: 'a.tw', line: 2 },
      { level: 'warning', message: 'ignored' },
    ]);
    expect(fatalError(error).message).toBe('a.tw:2: oops\ncompile failed');
  });

  it('returns any other Error as it is', () => {
    const error = new Error('disk full');
    expect(fatalError(error)).toBe(error);
  });

  it('wraps a thrown value that is not an Error', () => {
    const wrapped = fatalError('just a string');
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('just a string');
  });
});

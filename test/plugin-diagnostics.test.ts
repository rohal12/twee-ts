import { describe, it, expect } from 'vitest';
import { buildErrorMessage } from 'vite';
import { TweeTsError } from '../src/compiler.js';
import { fatalError, splitDiagnostics } from '../src/plugins/diagnostics.js';
import type { CompileResult, Diagnostic } from '../src/types.js';
import { thrownBy } from './helpers/errors.js';

function resultWith(diagnostics: Diagnostic[]): CompileResult {
  return { output: '<html></html>', diagnostics } as unknown as CompileResult;
}

describe('splitDiagnostics', () => {
  it('renders controls safely without changing structured diagnostics', () => {
    const diagnostic: Diagnostic = { level: 'error', message: 'bad\u001b[2J\u0007', file: 'a\u001b[2J.tw', line: 3 };
    const error = thrownBy(() => splitDiagnostics(resultWith([diagnostic])));
    if (!(error instanceof Error)) throw new Error('expected a plugin Error');
    expect(error).toMatchObject({
      message: 'a\\u001b[2J.tw:3: bad\\u001b[2J\\u0007',
      id: 'a\\u001b[2J.tw',
      loc: { file: 'a\\u001b[2J.tw', line: 3, column: 1 },
    });
    expect(diagnostic.message).toBe('bad\u001b[2J\u0007');
    expect(diagnostic.file).toBe('a\u001b[2J.tw');
    const rendered = buildErrorMessage(error, [error.message], false);
    expect(rendered).toContain('a\\u001b[2J.tw');
    expect(rendered).not.toContain('\u001b[2J');
  });
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
  it('keeps its own report separators when a compiler error is reported again', () => {
    const once = fatalError(new TweeTsError('failed', [{ level: 'error', message: 'bad\u001b[2J' }]));
    expect(fatalError(once)).toBe(once);
    expect(once.message).toBe('bad\\u001b[2J\nfailed');
  });

  it('keeps separate diagnostics when a split error is reported again', () => {
    const split = thrownBy(() =>
      splitDiagnostics(
        resultWith([
          { level: 'error', message: 'first' },
          { level: 'error', message: 'second' },
        ]),
      ),
    );
    expect(fatalError(split).message).toBe('first\nsecond');
  });

  it('escapes a bundler error location even when its message is safe', () => {
    const error = Object.assign(new Error('failed'), {
      id: 'a\u001b[2J.tw',
      loc: { file: 'a\u001b[2J.tw', line: 3, column: 4 },
    });
    expect(fatalError(error)).toMatchObject({
      message: 'failed',
      id: 'a\\u001b[2J.tw',
      loc: { file: 'a\\u001b[2J.tw', line: 3, column: 4 },
    });
    expect(error.id).toBe('a\u001b[2J.tw');
  });
  it.each([new Error('bad\u001b[2J\u0007'), 'bad\u001b[2J\u0007'])('escapes other failures: %o', (error) => {
    expect(fatalError(error).message).toBe('bad\\u001b[2J\\u0007');
  });
  it('escapes terminal controls in a fatal compiler message, keeping the authored report separators', () => {
    const error = new TweeTsError('failed\u001b]52;x\u0007', [{ level: 'error', message: 'bad\u009b2J' }]);
    expect(fatalError(error).message).toBe('bad\\u009b2J\nfailed\\u001b]52;x\\u0007');
  });
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

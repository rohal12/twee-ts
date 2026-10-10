import { describe, it, expect } from 'vitest';
import { formatDiagnostic } from '../src/diagnostic-text.js';

describe('formatDiagnostic', () => {
  it('names the file and line, and drops the parser\'s own "line N:" prefix', () => {
    expect(formatDiagnostic({ level: 'error', message: 'line 4: bad header', file: 'a.tw', line: 4 })).toBe(
      'a.tw:4: bad header',
    );
  });

  it('names the file and line of a message that has no line of its own', () => {
    expect(
      formatDiagnostic({ level: 'warning', message: 'Replacing existing passage "A".', file: 'a.tw', line: 9 }),
    ).toBe('a.tw:9: Replacing existing passage "A".');
  });

  it('adds the location to a message that mentions the file only in passing', () => {
    const message = 'Replacing existing passage "A" with duplicate. It replaces the one from a.tw (line 7).';
    expect(formatDiagnostic({ level: 'warning', message, file: 'a.tw', line: 9 })).toBe(`a.tw:9: ${message}`);
  });

  it('names a file without a line, keeping the message as it is', () => {
    expect(formatDiagnostic({ level: 'warning', message: 'line 4: odd', file: 'a.tw' })).toBe('a.tw: line 4: odd');
  });

  it('gives a message with no file as it is', () => {
    expect(formatDiagnostic({ level: 'warning', message: 'no start passage' })).toBe('no start passage');
  });

  it.each([
    'load src/a.tw: line 3: Passage metadata: unknown key.',
    'read src/a.tw: Invalid UTF-8; assuming charset is windows-1252.',
    'src/a.tw: unknown key "x"',
  ])('does not name a file twice: %s', (message) => {
    expect(formatDiagnostic({ level: 'warning', message, file: 'src/a.tw', line: 3 })).toBe(message);
  });
});

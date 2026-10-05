import { describe, it, expect } from 'vitest';
import { parseTwee } from '../src/parser.js';

describe('parseTwee: malformed optional blocks', () => {
  it('rejects a second metadata block, keeping the passages read so far', () => {
    const { passages, diagnostics } = parseTwee(':: Ok\nfine\n\n:: Bad {"a":"b"} {"c":"d"}\nbody');
    expect(passages.map((p) => p.name)).toEqual(['Ok']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'error', line: 4 });
    expect(diagnostics[0]!.message).toContain('metadata block must immediately follow the passage name or tags block');
  });

  it('rejects a tags block that follows the metadata block', () => {
    const { diagnostics } = parseTwee(':: Bad {"a":"b"} [tag]\nbody');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('tags block must immediately follow the passage name');
  });

  it('rejects a passage with a blank name', () => {
    const { passages, diagnostics } = parseTwee(':: Ok\nfine\n:: \nbody');
    expect(passages.map((p) => p.name)).toEqual(['Ok']);
    expect(diagnostics[0]!.message).toContain('passage with no name');
  });

  it('reports a lexer error as a fatal diagnostic', () => {
    const { diagnostics } = parseTwee(':: Bad ]\nbody', { filename: 'bad.tw' });
    expect(diagnostics[0]).toMatchObject({ level: 'error', file: 'bad.tw' });
  });

  it('warns about metadata that is not valid JSON and still keeps the passage', () => {
    const { passages, diagnostics } = parseTwee(':: A {oops}\nbody');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warning' });
    expect(diagnostics[0]!.message).toContain('could not decode metadata');
    expect(passages[0]).toMatchObject({ name: 'A', text: 'body' });
    expect(passages[0]!.metadata).toBeUndefined();
  });

  it('keeps only string metadata values', () => {
    const { passages } = parseTwee(':: A {"position":"1,2","size":3,"x":null}\nbody');
    expect(passages[0]!.metadata).toEqual({ position: '1,2' });
  });

  it('ignores text before the first passage header', () => {
    const { passages, diagnostics } = parseTwee('preamble\n:: A\nbody');
    expect(diagnostics).toEqual([]);
    expect(passages.map((p) => p.name)).toEqual(['A']);
  });

  it('returns no passages for source without a header', () => {
    expect(parseTwee('just text')).toEqual({ passages: [], diagnostics: [] });
  });

  it('keeps a header-only passage at the end of the file', () => {
    const { passages } = parseTwee(':: A\nx\n\n:: B');
    expect(passages.map((p) => [p.name, p.text])).toEqual([
      ['A', 'x'],
      ['B', ''],
    ]);
  });

  it('strips trailing blank lines but keeps indentation when trim is off', () => {
    const { passages } = parseTwee(':: A\n  indented\n\n\n:: B\nx', { trim: false });
    expect(passages[0]!.text).toBe('  indented');
  });
});

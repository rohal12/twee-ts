import { describe, it, expect } from 'vitest';
import { parseTwee } from '../src/parser.js';

describe('parseTwee', () => {
  it('parses a single passage', () => {
    const { passages, diagnostics } = parseTwee(':: Start\nHello world!');
    expect(diagnostics).toHaveLength(0);
    expect(passages).toHaveLength(1);
    expect(passages[0]!.name).toBe('Start');
    expect(passages[0]!.text).toBe('Hello world!');
    expect(passages[0]!.tags).toEqual([]);
  });

  it('parses multiple passages', () => {
    const input = ':: First\nContent 1\n\n:: Second\nContent 2';
    const { passages } = parseTwee(input);
    expect(passages).toHaveLength(2);
    expect(passages[0]!.name).toBe('First');
    expect(passages[1]!.name).toBe('Second');
  });

  it('parses tags', () => {
    const { passages } = parseTwee(':: Room [location hidden]\nContent');
    expect(passages[0]!.tags).toEqual(['location', 'hidden']);
  });

  it('parses metadata', () => {
    const { passages } = parseTwee(':: Room {"position":"100,100","size":"200,100"}\nContent');
    expect(passages[0]!.metadata).toEqual({ position: '100,100', size: '200,100' });
  });

  it('trims passage content by default', () => {
    const { passages } = parseTwee(':: Start\n  Hello world!  \n\n');
    expect(passages[0]!.text).toBe('Hello world!');
  });

  it('preserves whitespace when trim is false', () => {
    const { passages } = parseTwee(':: Start\n  Hello world!  ', { trim: false });
    expect(passages[0]!.text).toBe('  Hello world!  ');
  });

  it('handles twee2 compat', () => {
    const input = ':: Room [tag] <100,200>\nContent';
    const { passages } = parseTwee(input, { twee2Compat: true });
    expect(passages[0]!.name).toBe('Room');
    expect(passages[0]!.metadata?.position).toBe('100,200');
  });

  it('unescapes passage names', () => {
    const { passages } = parseTwee(':: Name\\[1\\]\nContent');
    expect(passages[0]!.name).toBe('Name[1]');
  });

  it('reports error for passage with no name', () => {
    const { diagnostics } = parseTwee(':: \nContent');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.level).toBe('error');
    expect(diagnostics[0]!.message).toContain('no name');
  });

  it('reports error from lexer errors', () => {
    const { diagnostics } = parseTwee(':: Test [unclosed\nContent');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.level).toBe('error');
  });

  it('handles empty file', () => {
    const { passages, diagnostics } = parseTwee('');
    expect(passages).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('handles file with only prolog', () => {
    const { passages } = parseTwee('Some text without any passage headers');
    expect(passages).toHaveLength(0);
  });
});

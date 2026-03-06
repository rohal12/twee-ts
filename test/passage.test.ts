import { describe, it, expect } from 'vitest';
import { applyTagAliases, countWords } from '../src/passage.js';
import type { Passage } from '../src/types.js';

function mkPassage(name: string, tags: string[], text = ''): Passage {
  return { name, tags: [...tags], text };
}

describe('applyTagAliases', () => {
  it('adds canonical tag when alias is present', () => {
    const passages = [mkPassage('Lib', ['library'])];
    const result = applyTagAliases(passages, { library: 'script' });
    expect(result[0].tags).toEqual(['library', 'script']);
  });

  it('handles multiple aliases', () => {
    const passages = [mkPassage('A', ['library']), mkPassage('B', ['theme']), mkPassage('C', ['other'])];
    const result = applyTagAliases(passages, { library: 'script', theme: 'stylesheet' });
    expect(result[0].tags).toEqual(['library', 'script']);
    expect(result[1].tags).toEqual(['theme', 'stylesheet']);
    expect(result[2].tags).toEqual(['other']);
  });

  it('does not duplicate canonical tag if already present', () => {
    const passages = [mkPassage('Lib', ['library', 'script'])];
    const result = applyTagAliases(passages, { library: 'script' });
    expect(result[0].tags).toEqual(['library', 'script']);
  });

  it('is idempotent', () => {
    const passages = [mkPassage('Lib', ['library'])];
    const aliases = { library: 'script' };
    const first = applyTagAliases(passages, aliases);
    const second = applyTagAliases(first, aliases);
    expect(second[0].tags).toEqual(['library', 'script']);
  });

  it('does not mutate original passages', () => {
    const passages = [mkPassage('Lib', ['library'])];
    const result = applyTagAliases(passages, { library: 'script' });
    expect(passages[0].tags).toEqual(['library']);
    expect(result[0].tags).toEqual(['library', 'script']);
  });

  it('no-op on empty alias map', () => {
    const passages = [mkPassage('A', ['foo', 'bar'])];
    const result = applyTagAliases(passages, {});
    expect(result[0].tags).toEqual(['foo', 'bar']);
  });

  it('no-op when no passages match', () => {
    const passages = [mkPassage('A', ['foo'])];
    const result = applyTagAliases(passages, { library: 'script' });
    expect(result[0].tags).toEqual(['foo']);
  });

  it('handles passage with no tags', () => {
    const passages = [mkPassage('A', [])];
    const result = applyTagAliases(passages, { library: 'script' });
    expect(result[0].tags).toEqual([]);
  });
});

describe('countWords', () => {
  describe('tweego method (default)', () => {
    it('counts characters divided by 5', () => {
      const p = mkPassage('A', [], 'Hello world');
      // "Hello world" with newlines stripped = 11 chars → ceil(11/5) = 3
      expect(countWords(p)).toBe(3);
      expect(countWords(p, 'tweego')).toBe(3);
    });

    it('returns 0 for empty text', () => {
      expect(countWords(mkPassage('A', [], ''))).toBe(0);
    });

    it('strips comments', () => {
      const p = mkPassage('A', [], 'Hello/* comment */world');
      // "Helloworld" = 10 chars → 10/5 = 2
      expect(countWords(p, 'tweego')).toBe(2);
    });

    it('strips newlines before counting', () => {
      const p = mkPassage('A', [], 'Hello\nworld');
      // "Helloworld" = 10 chars → 10/5 = 2
      expect(countWords(p, 'tweego')).toBe(2);
    });
  });

  describe('whitespace method', () => {
    it('counts words split by whitespace', () => {
      const p = mkPassage('A', [], 'Hello world foo');
      expect(countWords(p, 'whitespace')).toBe(3);
    });

    it('returns 0 for empty text', () => {
      expect(countWords(mkPassage('A', [], ''), 'whitespace')).toBe(0);
    });

    it('strips comments', () => {
      const p = mkPassage('A', [], 'Hello /* comment */ world');
      expect(countWords(p, 'whitespace')).toBe(2);
    });

    it('strips HTML comments', () => {
      const p = mkPassage('A', [], 'Hello <!-- comment --> world');
      expect(countWords(p, 'whitespace')).toBe(2);
    });

    it('strips Twine macros', () => {
      const p = mkPassage('A', [], 'Hello <<if $x>> world <<endif>>');
      expect(countWords(p, 'whitespace')).toBe(2);
    });

    it('strips HTML tags', () => {
      const p = mkPassage('A', [], '<b>Hello</b> <em>world</em>');
      expect(countWords(p, 'whitespace')).toBe(2);
    });

    it('keeps display text from links', () => {
      const p = mkPassage('A', [], 'Go to [[the garden|Garden]]');
      expect(countWords(p, 'whitespace')).toBe(4); // "Go to the garden"
    });

    it('keeps text from simple links', () => {
      const p = mkPassage('A', [], 'Visit [[Garden]]');
      expect(countWords(p, 'whitespace')).toBe(2); // "Visit Garden"
    });

    it('handles SugarCube comments', () => {
      const p = mkPassage('A', [], 'Hello /% inline comment %/ world');
      expect(countWords(p, 'whitespace')).toBe(2);
    });

    it('handles multiple whitespace', () => {
      const p = mkPassage('A', [], '  Hello   world  \n  foo  ');
      expect(countWords(p, 'whitespace')).toBe(3);
    });
  });
});

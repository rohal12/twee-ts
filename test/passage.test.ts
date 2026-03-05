import { describe, it, expect } from 'vitest';
import { applyTagAliases } from '../src/passage.js';
import type { Passage } from '../src/types.js';

function mkPassage(name: string, tags: string[]): Passage {
  return { name, tags: [...tags], text: '' };
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

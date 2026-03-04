import { describe, it, expect } from 'vitest';
import { applyTagAliases } from '../src/passage.js';
import type { Passage } from '../src/types.js';

function mkPassage(name: string, tags: string[]): Passage {
  return { name, tags: [...tags], text: '' };
}

describe('applyTagAliases', () => {
  it('adds canonical tag when alias is present', () => {
    const passages = [mkPassage('Lib', ['library'])];
    applyTagAliases(passages, { library: 'script' });
    expect(passages[0].tags).toEqual(['library', 'script']);
  });

  it('handles multiple aliases', () => {
    const passages = [
      mkPassage('A', ['library']),
      mkPassage('B', ['theme']),
      mkPassage('C', ['other']),
    ];
    applyTagAliases(passages, { library: 'script', theme: 'stylesheet' });
    expect(passages[0].tags).toEqual(['library', 'script']);
    expect(passages[1].tags).toEqual(['theme', 'stylesheet']);
    expect(passages[2].tags).toEqual(['other']);
  });

  it('does not duplicate canonical tag if already present', () => {
    const passages = [mkPassage('Lib', ['library', 'script'])];
    applyTagAliases(passages, { library: 'script' });
    expect(passages[0].tags).toEqual(['library', 'script']);
  });

  it('is idempotent', () => {
    const passages = [mkPassage('Lib', ['library'])];
    const aliases = { library: 'script' };
    applyTagAliases(passages, aliases);
    applyTagAliases(passages, aliases);
    expect(passages[0].tags).toEqual(['library', 'script']);
  });

  it('no-op on empty alias map', () => {
    const passages = [mkPassage('A', ['foo', 'bar'])];
    applyTagAliases(passages, {});
    expect(passages[0].tags).toEqual(['foo', 'bar']);
  });

  it('no-op when no passages match', () => {
    const passages = [mkPassage('A', ['foo'])];
    applyTagAliases(passages, { library: 'script' });
    expect(passages[0].tags).toEqual(['foo']);
  });

  it('handles passage with no tags', () => {
    const passages = [mkPassage('A', [])];
    applyTagAliases(passages, { library: 'script' });
    expect(passages[0].tags).toEqual([]);
  });
});

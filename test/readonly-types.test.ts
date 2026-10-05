/**
 * Compile-time contract of the read-only result types. `pnpm run typecheck` checks this
 * file: every `@ts-expect-error` must still be consumed by a type error, so a write that
 * becomes accepted again fails the build. The probes sit in a function that is never called.
 */
import { describe, it, expect } from 'vitest';
import type { CompileResult, Passage, ReadonlyPassage, ReadonlyStory } from '../src/types.js';

function rejectedWrites(result: CompileResult, passage: ReadonlyPassage, story: ReadonlyStory): void {
  // @ts-expect-error tags cannot be appended to
  passage.tags.push('x');
  // @ts-expect-error tags cannot be assigned by index
  passage.tags[0] = 'x';
  // @ts-expect-error tags cannot be sorted in place
  passage.tags.sort();
  // @ts-expect-error tags cannot be replaced
  passage.tags = [];
  // @ts-expect-error metadata properties cannot be assigned
  if (passage.metadata) passage.metadata.position = '0,0';
  // @ts-expect-error metadata entries cannot be assigned by key
  if (passage.metadata) passage.metadata['custom'] = 'x';
  // @ts-expect-error metadata cannot be replaced
  passage.metadata = {};
  // @ts-expect-error name cannot be assigned
  passage.name = 'x';
  // @ts-expect-error text cannot be assigned
  passage.text = 'x';
  // @ts-expect-error source cannot be edited
  if (passage.source) passage.source.line = 1;
  // @ts-expect-error passages cannot be appended to
  story.passages.push(passage);
  // @ts-expect-error passages of the compile result cannot be edited
  result.story.passages[0]?.tags.push('x');
  // @ts-expect-error a read-only passage is not a mutable Passage
  const mutable: Passage = passage;
  void mutable;
}
void rejectedWrites;

describe('read-only passage types', () => {
  it('still allows reading tags and metadata', () => {
    const passage: ReadonlyPassage = { name: 'Start', tags: ['a', 'b'], text: 'Hi', metadata: { position: '1,2' } };
    const tags: readonly string[] = passage.tags;
    const copy: string[] = [...passage.tags].sort();
    const position: string | undefined = passage.metadata?.position;
    const custom: string | undefined = passage.metadata?.['custom'];
    expect(tags.includes('a')).toBe(true);
    expect(passage.tags.map((t) => t.toUpperCase())).toEqual(['A', 'B']);
    expect(copy).toEqual(['a', 'b']);
    expect(position).toBe('1,2');
    expect(custom).toBeUndefined();
    expect(Object.entries(passage.metadata ?? {})).toEqual([['position', '1,2']]);
  });

  it('accepts a mutable Passage wherever a read-only one is expected', () => {
    const passage: Passage = { name: 'Start', tags: ['a'], text: '', metadata: { size: '100,100' } };
    const readonly: ReadonlyPassage = passage;
    expect(readonly.tags).toEqual(['a']);
  });
});

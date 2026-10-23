import { describe, expect, it, vi } from 'vitest';
import { decodeStoryData } from '../src/story.js';
import { LINEAR_GROWTH } from './helpers/growth.js';

describe('StoryData tag-color merging work (#502)', () => {
  it.each(['singleton', 'empty', 'single object'] as const)('bounds map iteration for %s fields', (kind) => {
    let entries = 0;
    const iterate: (this: Map<unknown, unknown>) => MapIterator<[unknown, unknown]> = Map.prototype[Symbol.iterator];
    const spy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
      const iterator = iterate.call(this);
      const next = iterator.next.bind(iterator);
      iterator.next = (...args) => {
        const item = next(...args);
        if (!item.done) entries += 1;
        return item;
      };
      return iterator;
    });
    const work = (n: number): number => {
      const colors = Array.from({ length: n }, (_, i) => `"t${String(i)}":"red"`);
      const fields =
        kind === 'singleton'
          ? colors.map((color) => `"tag-colors":{${color}}`).join(',')
          : `"tag-colors":{${colors.join(',')}}` + (kind === 'empty' ? ',"TAG-COLORS":{}'.repeat(n) : '');
      entries = 0;
      const result = decodeStoryData(`{${fields}}`);
      const counted = entries;
      expect(result.ok && result.twine2.tagColors.size).toBe(n);
      expect(result.ok && result.twine2.tagColors.get(`t${String(n - 1)}`)).toBe('red');
      expect(result.ok && result.issues.filter((issue) => issue.kind === 'duplicate-key')).toHaveLength(
        kind === 'singleton' ? n - 1 : kind === 'empty' ? n : 0,
      );
      return counted;
    };
    try {
      const small = work(100);
      const large = work(400);
      expect(small).toBeGreaterThan(0);
      expect(large).toBeLessThan(small * LINEAR_GROWTH);
    } finally {
      spy.mockRestore();
    }
  });
});

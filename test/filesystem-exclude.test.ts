import { describe, it, expect } from 'vitest';
import { isExcluded } from '../src/filesystem.js';

describe('isExcluded for the working directory itself', () => {
  it('matches the path as given when it is relative to nothing', () => {
    expect(isExcluded('.', ['.'])).toBe(true);
    expect(isExcluded('.', ['*.png'])).toBe(false);
  });
});

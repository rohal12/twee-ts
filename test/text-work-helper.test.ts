import { describe, expect, it } from 'vitest';
import { measureTextWork } from './helpers/text-work.js';

describe('text work measurement', () => {
  it('distinguishes a forward search from repeatedly scanning the remaining suffix', () => {
    const scan = (n: number, repeated: boolean): number => {
      const text = '<'.repeat(n);
      return measureTextWork(() => {
        for (let i = 0; i < text.length; i++) text.indexOf('>', repeated ? i : text.length);
      }).work;
    };
    expect(scan(400, false)).toBeLessThan(scan(100, false) * 8);
    expect(scan(400, true)).toBeGreaterThan(scan(100, true) * 8);
  });

  it('preserves regex results and positions, including a failed search', () => {
    const re = /b/g;
    const measured = measureTextWork(() => [re.exec('abc')?.index, re.lastIndex, re.exec('abc'), re.lastIndex]);
    expect(measured.value).toEqual([1, 2, null, 0]);
    expect(measured.work).toBeGreaterThan(0);
  });

  it('restores the built-ins when the measured operation throws', () => {
    const strings = ['indexOf', 'slice', 'endsWith'].map(
      (name) => [name, Object.getOwnPropertyDescriptor(String.prototype, name)] as const,
    );
    const exec = Object.getOwnPropertyDescriptor(RegExp.prototype, 'exec');
    expect(() =>
      measureTextWork(() => {
        throw new Error('probe');
      }),
    ).toThrow('probe');
    for (const [name, descriptor] of strings) {
      expect(Object.getOwnPropertyDescriptor(String.prototype, name)).toEqual(descriptor);
    }
    expect(Object.getOwnPropertyDescriptor(RegExp.prototype, 'exec')).toEqual(exec);
  });
});

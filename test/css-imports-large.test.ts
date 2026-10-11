/**
 * Very large stylesheets (#414, #352): the scan for `@import` rules that browsers ignore reads the stylesheet token by
 * token, so the memory it takes does not grow with the input. Each case is a stylesheet of 12 million characters read
 * in a process of its own with a heap of 256 MB, which a scan that kept the tokens or the preludes of the rules
 * (several gigabytes for this input) runs out of.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./helpers/css-imports-large.ts', import.meta.url));

describe('a very large stylesheet', () => {
  it.each([
    ['semicolons', 0],
    ['layer names', 0],
    ['nested parentheses', 0],
    ['nested blocks', 0],
    ['imports', 0],
    ['rules', 0],
    ['one identifier', 0],
    ['one comment', 0],
    ['one url', 0],
    // The semicolons make a rule that has no end, which swallows the import of the next source.
    ['two sources', 1],
  ])('is read within a small heap: %s', { timeout: 120_000 }, (name, warnings) => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--max-old-space-size=256', HELPER, name], {
      encoding: 'utf8',
      timeout: 110_000,
    });

    expect(output.trim()).toBe(`ok ${String(warnings)}`);
  });
});

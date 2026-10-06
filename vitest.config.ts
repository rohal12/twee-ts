import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'specs/**/*.test.ts'],
    // A test that makes no assertion fails, so a check that never runs cannot pass unnoticed.
    expect: { requireAssertions: true },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
      reporter: ['text', 'html', 'lcov', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
      // Floors just under the current numbers: coverage may rise but must not fall.
      thresholds: { statements: 98.5, branches: 96, functions: 100, lines: 98.5 },
    },
  },
});

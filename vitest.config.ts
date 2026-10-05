import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'specs/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
      reporter: ['text', 'html', 'lcov', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
      // Floors just under the current numbers: coverage may rise but must not fall.
      thresholds: { statements: 97, branches: 93, functions: 99, lines: 98 },
    },
  },
});

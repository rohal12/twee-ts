/**
 * Mutation testing of the pure core modules (`pnpm run mutation`). Line coverage says a line ran; a mutation
 * score says a test noticed when the line was wrong. The run is informational: it never fails (`break: null`),
 * and .github/workflows/mutation.yml compares its scores with mutation-baseline.json once a week.
 */
export default {
  testRunner: 'vitest',
  // Named explicitly: pnpm keeps the runner out of the folder where Stryker looks for its plugins.
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: {
    configFile: 'vitest.mutation.config.ts',
    // The config lists exactly the tests to run; `related` would pull in every test that imports these modules
    // through the compiler.
    related: false,
  },
  mutate: [
    'src/lexer.ts',
    'src/parser.ts',
    'src/twee-syntax.ts',
    'src/story.ts',
    'src/semver.ts',
    'src/link-markup.ts',
    'src/json-decode.ts',
  ],
  // Keeps the results of mutants whose code and tests did not change; CI caches the file between runs.
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
  timeoutMS: 10000,
};

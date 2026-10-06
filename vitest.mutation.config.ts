/**
 * The tests mutation testing runs (`pnpm run mutation`, stryker.config.mjs): the unit, property and spec tests of
 * the pure modules Stryker mutates. They take seconds; the rest of the suite (processes, watchers, servers, Vite)
 * would make every mutant cost minutes without testing these modules any better.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/lexer.test.ts',
      'test/lexer-edges.test.ts',
      'test/twee-syntax.test.ts',
      'specs/twee3-spec.test.ts',
      'test/parser.test.ts',
      'test/parser-malformed.test.ts',
      'test/twee2-compat.test.ts',
      'test/tweego-differences.test.ts',
      'test/output-twee.test.ts',
      'test/twee-model.test.ts',
      'test/twee-roundtrip.property.test.ts',
      'test/source-info.test.ts',
      'test/story.test.ts',
      'test/story-builder.model.test.ts',
      'test/story-edges.test.ts',
      'test/story-storydata-fields.test.ts',
      'test/inspect-duplicates.test.ts',
      'test/semver.test.ts',
      'test/semver-properties.test.ts',
      'test/format-selection-properties.test.ts',
      'test/link-markup.test.ts',
      'test/link-markup-components.test.ts',
      'test/json-decode.test.ts',
    ],
    expect: { requireAssertions: true },
  },
});

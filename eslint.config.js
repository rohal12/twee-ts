// @ts-check
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';
import { HTML_STRUCTURE_RESTRICTIONS } from './scripts/html-structure-restrictions.mjs';

/**
 * Objects built from untrusted keys must keep `__proto__` as an ordinary key (see CLAUDE.md), so
 * code never names it: neither as an object literal key, which sets the prototype instead of
 * adding a key, nor as a property access, which reads or replaces the prototype.
 */
const PROTO_RESTRICTIONS = [
  {
    selector: "Property[computed=false][key.name='__proto__'], Property[computed=false][key.value='__proto__']",
    message: 'An object literal `__proto__` key sets the prototype. Use Object.defineProperty or a Map.',
  },
  {
    selector: "MemberExpression[computed=false][property.name='__proto__']",
    message: 'Use Object.getPrototypeOf/Object.setPrototypeOf instead of `__proto__`.',
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'docs/.vitepress/dist/**',
      'docs/.vitepress/cache/**',
      'test/fixtures/**',
      '.claude/**',
      '.scratch/**',
      'reports/**',
      '.stryker-tmp/**',
      '.agents/**',
      'tweego/**',
      'examples/**',
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.cjs', 'docs/.vitepress/config.ts', 'scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A switch over a union lists every member or has a default (CLAUDE.md asks for a `never` check there);
      // a switch over a wider type, such as a character, always has a default.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true, requireDefaultForNonUnion: true },
      ],
      // Numbers have one obvious string form, and `never` is the CLAUDE.md exhaustive-switch pattern
      // (`unhandled case: ${_exhaustive}`); objects, nullish values and the like are still rejected.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowNever: true }],
      // Matches tsc's noUnusedParameters, which leaves `_`-prefixed names alone (the `_exhaustive` pattern,
      // and parameters kept for compatibility).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Passing on a caught error or an abort signal's reason unchanged is allowed (both are `unknown`);
      // only-throw-error allows the same for `throw` by default.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }],
      'no-restricted-syntax': ['error', ...PROTO_RESTRICTIONS],
    },
  },
  {
    // No type assertions in the package's code (CLAUDE.md): a value gets its type from a check (a type guard,
    // `in`, `typeof`) or a declaration, so a wrong type is a compile error rather than a silent lie. `as const`
    // is not an assertion of a type and stays allowed.
    files: ['src/**/*.ts', 'bin/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/html-structure.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...PROTO_RESTRICTIONS, ...HTML_STRUCTURE_RESTRICTIONS],
    },
  },
  {
    // Plain JavaScript tooling files are outside tsconfig.json; lint them without type information.
    files: ['**/*.js', '**/*.cjs', '**/*.mjs', 'docs/.vitepress/config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['test/**/*.ts', 'specs/**/*.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/no-conditional-expect': 'error',
      // Shared assertion helpers are named expect…/assert….
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*', 'assert*'] }],
      // Vitest's expect() takes an optional message as its second argument.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      // Relaxed for tests: a wrong `!` throws a TypeError there, which fails the test, while `?.` would
      // let an undefined value reach the assertion (and pass `toBeUndefined()`).
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Relaxed for tests: test doubles and ignored callbacks are often deliberate no-ops.
      '@typescript-eslint/no-empty-function': 'off',
      // Relaxed for tests: Vitest types its asymmetric matchers (expect.stringContaining() and the like)
      // as `any`, so that they fit any property of an expected object. Reading a member of an `any`
      // value (no-unsafe-member-access) is still an error.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);

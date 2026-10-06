'use strict';

/**
 * typescript-eslint needs the TypeScript JS compiler API, which TypeScript 7 (the native compiler
 * this project builds and typechecks with) does not have: typescript-eslint 8 refuses to load on
 * TS >= 7. Microsoft publishes TypeScript 6 side by side as `@typescript/typescript6` for tools
 * like this. The packages below take `typescript` as a peer dependency, which pnpm would satisfy
 * with the project's TypeScript 7, so this hook turns that peer into their own dependency on
 * TypeScript 6. Only ESLint uses it; `tsc` and the build keep using TypeScript 7.
 *
 * Remove this file once typescript-eslint supports TypeScript 7
 * (https://github.com/typescript-eslint/typescript-eslint/issues/10940).
 */
const TYPESCRIPT_6 = 'npm:@typescript/typescript6@6.0.2';

/** @param {string} name */
function usesTypeScriptAPI(name) {
  return (
    name === 'typescript-eslint' ||
    name.startsWith('@typescript-eslint/') ||
    name === 'ts-api-utils' ||
    name === '@vitest/eslint-plugin'
  );
}

/**
 * @param {{ name?: string, dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, unknown> }} pkg
 */
function readPackage(pkg) {
  if (pkg.name && usesTypeScriptAPI(pkg.name) && pkg.peerDependencies?.typescript) {
    delete pkg.peerDependencies.typescript;
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: TYPESCRIPT_6 };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };

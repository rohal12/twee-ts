/**
 * The compiler contract matrix (validation/contracts, docs/compiler-validation.md): public behaviour
 * checked against the build in dist/, as a user's project imports it. Run `pnpm run build` first;
 * `pnpm run test:contracts` does both.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const dist = resolve(import.meta.dirname, 'dist');
// validation/contracts/setup.ts stops the run when the build is missing.
const entries = { '': 'index.js', '/vite': 'plugins/vite.js' };

export default defineConfig({
  resolve: {
    alias: Object.entries(entries).map(([subpath, file]) => ({
      find: new RegExp(`^@rohal12/twee-ts${subpath}$`),
      replacement: resolve(dist, file),
    })),
  },
  test: {
    include: ['validation/contracts/**/*.contract.ts'],
    setupFiles: ['validation/contracts/setup.ts'],
    expect: { requireAssertions: true },
    // The cases share process.env (the format cache) and start servers: one file at a time.
    fileParallelism: false,
  },
});

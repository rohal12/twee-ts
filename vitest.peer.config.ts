/**
 * Runs the bundler plugin tests against another Vite (and Rollup) than the one
 * the repository installs: the peer versions installed in the folder that
 * TWEE_TS_PEER_DIR names (its node_modules/vite, node_modules/rollup). Vitest
 * itself keeps the repository's Vite; only the tests and the plugin sources
 * import the peer versions. The CI job "plugin peers" sets this up per version.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Unset, the tests run against the repository's own versions (as tools that load every config do).
const peerDir = process.env['TWEE_TS_PEER_DIR'] ?? '';
const modules = resolve(peerDir === '' ? '.' : peerDir, 'node_modules');
const vite = join(modules, 'vite', 'dist', 'node', 'index.js');
const rollup = join(modules, 'rollup', 'dist', 'es', 'rollup.js');
if (!existsSync(vite)) throw new Error(`vitest.peer.config.ts: no Vite in ${modules}.`);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^vite$/, replacement: vite },
      // Vite 8 brings no Rollup; the Rollup plugin is then tested with the repository's.
      ...(existsSync(rollup) ? [{ find: /^rollup$/, replacement: rollup }] : []),
    ],
  },
  test: {
    include: ['test/plugin-*.test.ts', 'test/vite-*.test.ts', 'test/rollup-*.test.ts'],
    expect: { requireAssertions: true },
  },
});

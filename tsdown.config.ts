import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'tsdown';
import type { TsdownHooks, UserConfig } from 'tsdown';

const RE_DTS = /\.d\.c?ts$/;
const RE_SOURCE_MAPPING_URL = /\n\/\/# sourceMappingURL=\S+\s*$/;

// The JS sourcemaps make rolldown map the .d.ts chunks too. rolldown-plugin-dts deletes
// those maps but leaves each .d.ts ending in a sourceMappingURL comment that points nowhere.
const stripDtsSourceMappingUrl: TsdownHooks['build:done'] = async ({ chunks }) => {
  const dtsChunks = chunks.flatMap((chunk) => (chunk.type === 'chunk' && RE_DTS.test(chunk.fileName) ? [chunk] : []));
  await Promise.all(
    dtsChunks
      .filter((chunk) => RE_SOURCE_MAPPING_URL.test(chunk.code))
      .map((chunk) => writeFile(join(chunk.outDir, chunk.fileName), chunk.code.replace(RE_SOURCE_MAPPING_URL, '\n'))),
  );
};

const shared = {
  sourcemap: true,
  // Keep .js/.d.ts for ESM and .cjs/.d.cts for CJS (tsdown defaults to .mjs/.d.mts),
  // so the file names in the package.json exports map stay valid.
  fixedExtension: false,
  // twee-ts has no runtime dependencies: htmlparser2 and its own dependencies are
  // bundled on purpose, and bundling anything else from node_modules fails the build.
  deps: { onlyBundle: ['htmlparser2', 'domhandler', 'domelementtype', 'entities'] },
} satisfies UserConfig;

// tsconfig.json asks for declaration maps, but they would point at src/, which is not published.
const dts = { compilerOptions: { declarationMap: false } } satisfies UserConfig['dts'];
const dtsHooks = { 'build:done': stripDtsSourceMappingUrl } satisfies UserConfig['hooks'];

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts,
    hooks: dtsHooks,
  },
  {
    ...shared,
    entry: {
      'plugins/vite': 'src/plugins/vite.ts',
      'plugins/rollup': 'src/plugins/rollup.ts',
    },
    format: 'esm',
    dts,
    hooks: dtsHooks,
  },
  {
    ...shared,
    entry: { 'bin/twee-ts': 'bin/twee-ts.ts' },
    format: 'esm',
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);

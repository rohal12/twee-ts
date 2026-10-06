import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'tsdown';
import type { TsdownHooks, UserConfig } from 'tsdown';
import { NOTICES_FILE, updateThirdPartyNotices } from './scripts/third-party-notices.mjs';

const RE_DTS = /\.d\.c?ts$/;
const RE_SOURCE_MAPPING_URL = /\n\/\/# sourceMappingURL=\S+\s*$/;

/**
 * The only packages from node_modules that may be bundled into dist/. twee-ts has no runtime
 * dependencies: these are bundled on purpose, and bundling anything else fails the build.
 * The build regenerates THIRD_PARTY_NOTICES from the packages it actually bundled and fails
 * when that set differs from this list.
 */
const BUNDLED_PACKAGES = ['htmlparser2', 'domhandler', 'domelementtype', 'entities', 'acorn'];

const BIN_CHUNK = 'bin/twee-ts.js';
const LEGAL_BANNER =
  '/*! @rohal12/twee-ts (Unlicense). Bundles third-party code under its own licence: see THIRD_PARTY_NOTICES. */';

/**
 * Packages whose type declarations exist only for ESM consumers (Vite 7 and later ship no CJS
 * types). The CJS declarations import their types in import mode; otherwise a CommonJS
 * TypeScript consumer gets TS1479 ("cannot be imported with 'require'").
 */
const ESM_ONLY_TYPE_PACKAGES = ['vite'];
const RE_ESM_ONLY_TYPE_IMPORT = new RegExp(
  String.raw`^import (?:type )?(\{[^}]*\}) from "(${ESM_ONLY_TYPE_PACKAGES.join('|')})";$`,
  'gm',
);

/**
 * The final text of an emitted declaration file:
 * - The JS sourcemaps make rolldown map the .d.ts chunks too. rolldown-plugin-dts deletes those
 *   maps but leaves each .d.ts ending in a sourceMappingURL comment that points nowhere.
 * - In .d.cts files, type imports from ESM-only packages get `resolution-mode: "import"`.
 */
function fixDeclaration(fileName: string, code: string): string {
  const stripped = code.replace(RE_SOURCE_MAPPING_URL, '\n');
  return fileName.endsWith('.d.cts')
    ? stripped.replace(RE_ESM_ONLY_TYPE_IMPORT, 'import type $1 from "$2" with { "resolution-mode": "import" };')
    : stripped;
}

const fixDeclarations: TsdownHooks['build:done'] = async ({ chunks }) => {
  const dtsChunks = chunks.flatMap((chunk) => (chunk.type === 'chunk' && RE_DTS.test(chunk.fileName) ? [chunk] : []));
  await Promise.all(
    dtsChunks.flatMap((chunk) => {
      const fixed = fixDeclaration(chunk.fileName, chunk.code);
      return fixed === chunk.code ? [] : [writeFile(join(chunk.outDir, chunk.fileName), fixed)];
    }),
  );
};

// Runs once per format. tsdown builds the CJS declarations in a separate pass without JS chunks;
// that pass is skipped (and is why tsdown logs the deps.onlyBundle entries as unused there).
const writeThirdPartyNotices: TsdownHooks['build:done'] = ({ chunks }) => {
  const jsChunks = chunks.flatMap((chunk) => (chunk.type === 'chunk' && !RE_DTS.test(chunk.fileName) ? [chunk] : []));
  if (jsChunks.length === 0) return;
  const changed = updateThirdPartyNotices({
    moduleIds: jsChunks.flatMap((chunk) => chunk.moduleIds),
    allowed: BUNDLED_PACKAGES,
    file: NOTICES_FILE,
  });
  if (changed) console.log(`Updated ${NOTICES_FILE}; commit it with this change.`);
};

const shared = {
  sourcemap: true,
  // Keep .js/.d.ts for ESM and .cjs/.d.cts for CJS (tsdown defaults to .mjs/.d.mts),
  // so the file names in the package.json exports map stay valid.
  fixedExtension: false,
  deps: { onlyBundle: BUNDLED_PACKAGES },
  // tsconfig.json asks for declaration maps, but they would point at src/, which is not published.
  dts: { compilerOptions: { declarationMap: false } },
  hooks: {
    'build:done': async (ctx) => {
      await fixDeclarations(ctx);
      await writeThirdPartyNotices(ctx);
    },
  },
} satisfies UserConfig;

// One rolldown graph per format: every entry shares the same chunks, so the compiler (and
// TweeTsError, and module state such as the format caches) exists once per format, whichever
// entry point loads it. The entries are written out literally: knip reads them from this file.
export default defineConfig([
  {
    ...shared,
    entry: {
      index: 'src/index.ts',
      'plugins/vite': 'src/plugins/vite.ts',
      'plugins/rollup': 'src/plugins/rollup.ts',
      'bin/twee-ts': 'bin/twee-ts.ts',
    },
    format: 'esm',
    banner: ({ fileName }) => ({
      js: fileName === BIN_CHUNK ? `#!/usr/bin/env node\n${LEGAL_BANNER}` : LEGAL_BANNER,
    }),
  },
  {
    ...shared,
    entry: {
      index: 'src/index.ts',
      'plugins/vite': 'src/plugins/vite.ts',
      'plugins/rollup': 'src/plugins/rollup.ts',
    },
    format: 'cjs',
    banner: { js: LEGAL_BANNER },
  },
]);

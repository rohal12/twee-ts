/**
 * The twee-ts version, read at runtime from the package's own package.json.
 *
 * The release workflow (semantic-release) writes the new version into the
 * published package.json only; git keeps the old one. Reading it at runtime
 * is the only way the CLI and `creator-version` report the published version.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './util.js';

const PACKAGE_NAME = '@rohal12/twee-ts';

/** Walks up from `startDir` to the nearest package.json named @rohal12/twee-ts and returns its version. */
export function findPackageVersion(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (isRecord(pkg) && pkg['name'] === PACKAGE_NAME && typeof pkg['version'] === 'string') return pkg['version'];
    } catch {
      // No readable package.json here; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The version of the package this module belongs to. The folder is found from `import.meta.url` in every format
 * (the CJS build turns it into the module's own `__filename`): a bare `__dirname` would be a global in the ESM build,
 * which `node -e`, the REPL and shims for CommonJS code define (#447).
 */
export const VERSION: string = findPackageVersion(dirname(fileURLToPath(import.meta.url))) ?? '0.0.0';

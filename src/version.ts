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

const PACKAGE_NAME = '@rohal12/twee-ts';

/** Walks up from `startDir` to the nearest package.json named @rohal12/twee-ts and returns its version. */
export function findPackageVersion(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown; version?: unknown };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // No readable package.json here; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** This module's directory: `__dirname` in the CJS build, `import.meta.url` in ESM and in source. */
function moduleDir(): string {
  return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

export const VERSION: string = findPackageVersion(moduleDir()) ?? '0.0.0';

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const inventoryBytes = () => readFileSync(resolve(REPO, 'validation/contract-inventory.json'));

/** Bind compiler, dependencies, test harness, support claims and automation; exclude evidence. */
export function fingerprint() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const payload = [...new Set(files)]
    .filter(
      (path) =>
        /^(?:src\/|bin\/|schemas\/|test\/|specs\/|scripts\/|\.github\/|validation\/|docs\/(?!compiler-validation\.md$|superpowers\/).*\.md$)/.test(
          path,
        ) || /^(?:package\.json|pnpm-lock\.yaml|.*\.config\.ts|AGENTS\.md)$/.test(path),
    )
    .filter((path) => !path.startsWith('validation/reports/') && path !== 'validation/release-evidence.json')
    .sort();
  const hash = createHash('sha256');
  for (const path of payload)
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(resolve(REPO, path)))
      .update('\0');
  return hash.digest('hex');
}
export function validateInventory(inventory) {
  const errors = [];
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'bin', 'schemas'],
    { cwd: REPO, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const file of new Set(files))
    if (!inventory.areas.some((area) => area.paths.includes(file))) errors.push(`unassigned contract surface: ${file}`);
  if (new Set(inventory.areas.map((area) => area.id)).size !== inventory.areas.length)
    errors.push('duplicate inventory area');
  for (const area of inventory.areas) {
    for (const path of [...area.paths, ...area.tests]) {
      try {
        readFileSync(resolve(REPO, path));
      } catch {
        errors.push(`inventory references missing file: ${path}`);
      }
    }
  }
  return errors;
}

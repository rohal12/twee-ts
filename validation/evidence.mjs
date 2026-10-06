import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const inventoryBytes = () => readFileSync(resolve(REPO, 'validation/contract-inventory.json'));

/** Bind compiler, dependencies, test harness, support claims and automation; exclude evidence. */
export function fingerprint(repo = REPO) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repo,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const payload = [...new Set(files)]
    .filter(
      (path) =>
        !path.startsWith('validation/reports/') &&
        path !== 'validation/release-evidence.json' &&
        !path.startsWith('docs/superpowers/') &&
        path !== 'CHANGELOG.md',
    )
    .sort();
  // Git's clean filters canonicalize line endings just as the committed blob does.
  // One batch avoids spawning a Git process per file, especially on Windows.
  const objects = execFileSync('git', ['hash-object', '--stdin-paths'], {
    cwd: repo,
    encoding: 'utf8',
    input: payload.map((path) => JSON.stringify(path)).join('\n') + '\n',
  })
    .trim()
    .split('\n');
  const hash = createHash('sha256');
  for (let i = 0; i < payload.length; i++) hash.update(payload[i]).update('\0').update(objects[i]).update('\0');
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

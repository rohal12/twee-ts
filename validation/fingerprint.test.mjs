import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, REPO } from './evidence.mjs';

test('compiler settings and standing review/support claims invalidate evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'twee-fingerprint-'));
  try {
    const clone = join(root, 'repo');
    execFileSync('git', ['clone', '-q', '--shared', REPO, clone]);
    const original = fingerprint(clone);
    for (const path of ['tsconfig.json', 'README.md', 'docs/compiler-validation.md']) {
      const file = join(clone, path);
      const bytes = readFileSync(file);
      writeFileSync(file, Buffer.concat([bytes, Buffer.from('\n ')]));
      assert.notEqual(fingerprint(clone), original, `changes to ${path} were silently ignored`);
      writeFileSync(file, bytes);
    }
    const file = join(clone, 'src/index.ts');
    const bytes = readFileSync(file, 'utf8');
    execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: clone });
    writeFileSync(file, bytes.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    assert.equal(fingerprint(clone), original, 'equivalent CRLF checkout invalidated cross-platform evidence');
    writeFileSync(file, bytes + '\nexport const changedBehavior = 1;\n');
    assert.notEqual(fingerprint(clone), original, 'canonicalization hid an actual implementation change');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

it('applies a CLI alias whose name is an ordinary object property name', () => {
  const root = mkdtempSync(join(tmpdir(), 'twee-cli-keys-'));
  try {
    const source = join(root, 'story.tw');
    writeFileSync(
      source,
      ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nHello\n:: Library [__proto__]\nwindow.ALIAS_WORKS=true;',
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
        resolve('bin/twee-ts.ts'),
        '--json',
        '--tag-alias',
        '__proto__=script',
        source,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { script: string; passages: { name: string }[] };
    expect(output.script).toContain('ALIAS_WORKS');
    expect(output.passages.some((p) => p.name === 'Library')).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

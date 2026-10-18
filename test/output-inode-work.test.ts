import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeFs from 'node:fs';
import { getFilenames } from '../src/filesystem.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFs>();
  return { ...fs, statSync: vi.fn(fs.statSync) };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('output inode work (#482)', () => {
  it.each([false, true])('indexes outputs once per discovery, including hard-linked inputs: %s', (hardLinks) => {
    const root = mkdtempSync(join(tmpdir(), 'twee-inode-work-'));
    dirs.push(root);
    const source = join(root, 'source');
    mkdirSync(source);
    const count = 100;
    const files = Array.from({ length: count }, (_, i) => join(root, `out-${i}.html`));
    for (let i = 0; i < count; i++) {
      const file = join(source, `p-${i}.tw`);
      writeFileSync(file, `:: P${i}\nHi`);
      if (hardLinks) linkSync(file, join(root, `link-${i}.tw`));
    }
    vi.mocked(statSync).mockClear();
    const result = getFilenames([source], { files, dirs: [] });
    const calls = vi.mocked(statSync).mock.calls.length;
    expect(result.filenames).toHaveLength(count);
    expect(calls).toBeLessThan(count * 10);
    // A later discovery must observe an output created since the earlier snapshot.
    rmSync(files[0]!, { force: true });
    linkSync(join(source, 'p-0.tw'), files[0]!);
    expect(getFilenames([source], { files, dirs: [] }).filenames).toHaveLength(count - 1);
  });
});

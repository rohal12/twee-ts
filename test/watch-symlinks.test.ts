import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { watch } from '../src/compiler.js';
import type { CompileResult } from '../src/types.js';

let root: string;
let controller: AbortController | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'twee-watch-links-'));
  mkdirSync(join(root, 'links'));
  mkdirSync(join(root, 'actual'));
});
afterEach(() => {
  controller?.abort();
  controller = undefined;
  rmSync(root, { recursive: true, force: true });
});
const story = (text: string): string =>
  `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\n${text}`;

it.each(['absolute', 'relative', 'same directory'] as const)(
  'watches a named %s source symlink through edits, replacement and retargeting (#239)',
  async (kind) => {
    const target = join(root, kind === 'same directory' ? 'links' : 'actual', 'actual.tw');
    const link = join(root, 'links', 'story.tw');
    writeFileSync(target, story('BEFORE'));
    symlinkSync(kind === 'absolute' ? target : relative(join(root, 'links'), target), link);
    const builds: CompileResult[] = [];
    controller = await watch({
      sources: [link],
      outputMode: 'json',
      outFile: join(root, 'output.json'),
      onBuild: (r) => builds.push(r),
      onError: (e) => {
        throw e;
      },
    });
    async function built(text: string): Promise<void> {
      await expect.poll(() => builds.at(-1)?.output, { timeout: 4000, interval: 30 }).toContain(text);
    }
    await built('BEFORE');
    writeFileSync(target, story('EDITED'));
    await built('EDITED');
    const replacement = join(root, 'actual', 'replacement.tw');
    writeFileSync(replacement, story('REPLACED'));
    renameSync(replacement, target);
    await built('REPLACED');
    rmSync(target);
    // Wait past the debounce so deleting and recreating are separate observed transitions.
    await new Promise((done) => setTimeout(done, 700));
    writeFileSync(target, story('RECREATED'));
    await built('RECREATED');
    const otherDir = join(root, 'other');
    mkdirSync(otherDir);
    const other = join(otherDir, 'story.tw');
    writeFileSync(other, story('RETARGETED'));
    rmSync(link);
    symlinkSync(other, link);
    await built('RETARGETED');
    writeFileSync(other, story('RETARGET_EDIT'));
    await built('RETARGET_EDIT');
    controller.abort();
    const count = builds.length;
    writeFileSync(other, story('CLOSED'));
    await new Promise((done) => setTimeout(done, 650));
    expect(builds).toHaveLength(count);
  },
  15000,
);

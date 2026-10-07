/**
 * A watched source whose parent folder is moved away and replaced by a regular file (ENOTDIR on every lookup
 * below it) is an unavailable input, not an uncaught exception; restoring the folder rebuilds (#281).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from '../src/compiler.js';

const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello.';
let root = '';
let uncaught: unknown[] = [];
const collect = (error: unknown): void => {
  uncaught.push(error);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'twee-ts-watch-parent-'));
  uncaught = [];
  process.on('uncaughtException', collect);
});
afterEach(() => {
  process.off('uncaughtException', collect);
  rmSync(root, { recursive: true, force: true });
});

describe('watch()', () => {
  // ENOTDIR is a POSIX lookup failure, and Windows does not let a watched folder be renamed away.
  it.skipIf(process.platform === 'win32')(
    'survives the parent of a named source becoming a file, and rebuilds when it is restored',
    async () => {
      const folder = join(root, 'project');
      mkdirSync(folder);
      const source = join(folder, 'story.tw');
      writeFileSync(source, STORY);
      let builds = 0;
      const controller = await watch({
        sources: [source],
        outputMode: 'json',
        outFile: join(root, 'story.json'),
        onBuild: () => {
          builds++;
        },
        onError: () => {},
      });
      try {
        await vi.waitFor(
          () => {
            expect(builds).toBe(1);
          },
          { timeout: 5000 },
        );

        renameSync(folder, join(root, 'project-old'));
        writeFileSync(folder, 'now an ordinary file');
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(uncaught).toEqual([]);
        expect(controller.signal.aborted).toBe(false);

        unlinkSync(folder);
        mkdirSync(folder);
        writeFileSync(source, STORY);
        await vi.waitFor(
          () => {
            expect(builds).toBeGreaterThan(1);
          },
          { timeout: 8000 },
        );
        expect(uncaught).toEqual([]);
      } finally {
        controller.abort();
      }
    },
    20_000,
  );
});

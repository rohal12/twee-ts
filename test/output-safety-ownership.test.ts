/**
 * An output this process wrote may be written over again only while it is what was written (#285): an
 * edit in place that keeps the size, inode and modification time (a timestamp-preserving copy or restore) makes
 * it the author's file, which a build refuses to overwrite (`OUTPUT_IS_INPUT`) and leaves as it was.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileToFile } from '../src/compiler.js';
import { isOwnOutput } from '../src/atomic-write.js';

const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\noriginal\n';

let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-ownership-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Replaces `file` with `text` of the same size, and gives it the modification time it had (`touch -r`). */
function replaceKeepingMtime(file: string, text: string): void {
  const reference = join(dir, 'timestamp.reference');
  execFileSync('cp', ['-p', file, reference]);
  writeFileSync(file, text.padEnd(statSync(reference).size, ' '));
  execFileSync('touch', ['-r', reference, file]);
  rmSync(reference);
}

describe.skipIf(process.platform === 'win32')('an owned output edited in place with its timestamps kept', () => {
  const AUTHORED = ':: UserContent\nDo not overwrite this authored source.\n';

  it.each([
    ['a source folder', 'output.tw', (folder: string, story: string) => ({ sources: [folder, story] })],
    ['a module folder', 'style.css', (folder: string, story: string) => ({ sources: [story], modules: [folder] })],
  ] as const)('is refused and left as it was in %s', async (_name, file, options) => {
    const folder = join(dir, 'folder');
    mkdirSync(folder);
    const story = join(dir, 'input.tw');
    writeFileSync(story, STORY);
    const outFile = join(folder, file);
    const build = { ...options(folder, story), outputMode: 'twee3' as const, outFile };
    await compileToFile(build);
    expect(isOwnOutput(outFile)).toBe(true);
    replaceKeepingMtime(outFile, AUTHORED);
    const authored = readFileSync(outFile, 'utf-8');
    expect(isOwnOutput(outFile)).toBe(false);
    await expect(compileToFile(build)).rejects.toMatchObject({ code: 'OUTPUT_IS_INPUT' });
    expect(readFileSync(outFile, 'utf-8')).toBe(authored);
  });

  it('is refused when the edit is in place on a hard-linked output', async () => {
    const folder = join(dir, 'folder');
    mkdirSync(folder);
    const story = join(dir, 'input.tw');
    writeFileSync(story, STORY);
    const outFile = join(folder, 'output.tw');
    const build = { sources: [folder, story], outputMode: 'twee3' as const, outFile };
    await compileToFile(build);
    replaceKeepingMtime(outFile, AUTHORED);
    linkSync(outFile, join(dir, 'alias.tw'));
    await expect(compileToFile(build)).rejects.toMatchObject({ code: 'OUTPUT_IS_INPUT' });
    expect(readFileSync(outFile, 'utf-8')).toContain('UserContent');
  });
});

describe('an unchanged earlier build', () => {
  it('stays rebuildable, also after its mode or links change without changing its content', async () => {
    const folder = join(dir, 'folder');
    mkdirSync(folder);
    const story = join(dir, 'input.tw');
    writeFileSync(story, STORY);
    const outFile = join(folder, 'output.tw');
    const build = { sources: [folder, story], outputMode: 'twee3' as const, outFile };
    await compileToFile(build);
    expect(isOwnOutput(outFile)).toBe(true);
    chmodSync(outFile, 0o644);
    expect(isOwnOutput(outFile)).toBe(true);
    const second = await compileToFile(build);
    expect(second.diagnostics).toEqual([]);
  });

  it('is not owned once it is edited without keeping the timestamp', async () => {
    const folder = join(dir, 'folder');
    mkdirSync(folder);
    const story = join(dir, 'input.tw');
    writeFileSync(story, STORY);
    const outFile = join(folder, 'output.tw');
    const build = { sources: [folder, story], outputMode: 'twee3' as const, outFile };
    await compileToFile(build);
    writeFileSync(outFile, `${readFileSync(outFile, 'utf-8')}x`);
    await expect(compileToFile(build)).rejects.toMatchObject({ code: 'OUTPUT_IS_INPUT' });
  });
});

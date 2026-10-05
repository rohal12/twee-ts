import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileToFile } from '../src/compiler.js';
import type { CompileToFileOptions } from '../src/types.js';

const STORY = {
  filename: 'story.tw',
  content: ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nHello',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-outlink-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function build(outFile: string): Promise<unknown> {
  const options: CompileToFileOptions = { sources: [STORY], outFile, outputMode: 'json' };
  return compileToFile(options);
}

describe.skipIf(process.platform === 'win32')('compileToFile with a dangling output symlink', () => {
  it('creates the target of an absolute dangling link and keeps the link', async () => {
    const link = join(dir, 'output.json');
    const target = join(dir, 'served.json');
    symlinkSync(target, link);
    await build(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('Hello');
  });

  it('creates the target of a relative dangling link and keeps the link', async () => {
    const link = join(dir, 'output.json');
    symlinkSync('served.json', link);
    await build(link);
    expect(readlinkSync(link)).toBe('served.json');
    expect(readFileSync(join(dir, 'served.json'), 'utf-8')).toContain('Hello');
  });

  it('writes through a chain of dangling links to the final target', async () => {
    mkdirSync(join(dir, 'deploy'));
    symlinkSync(join('deploy', 'final.json'), join(dir, 'b.json'));
    symlinkSync('b.json', join(dir, 'a.json'));
    await build(join(dir, 'a.json'));
    expect(lstatSync(join(dir, 'a.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'b.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, 'deploy', 'final.json'), 'utf-8')).toContain('Hello');
  });

  it('rejects and leaves the link intact when the target folder is missing', async () => {
    const link = join(dir, 'output.json');
    symlinkSync(join('missing', 'served.json'), link);
    await expect(build(link)).rejects.toThrow();
    expect(readlinkSync(link)).toBe(join('missing', 'served.json'));
    expect(readdirSync(dir)).toEqual(['output.json']);
  });
});

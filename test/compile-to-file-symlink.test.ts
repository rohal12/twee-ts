import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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
  it.each(['plain', 'link path', 'relative target', 'absolute target', 'chain'])(
    'rejects directory-required %s without creating another destination (#219)',
    async (variant) => {
      const target = join(dir, 'missing');
      const endpoint = join(dir, 'endpoint');
      const linkTarget =
        variant === 'absolute target' ? `${target}/` : variant === 'link path' ? 'missing' : 'missing/';
      if (variant !== 'plain') symlinkSync(linkTarget, endpoint);
      if (variant === 'chain') symlinkSync('endpoint', join(dir, 'output'));
      const output = variant === 'plain' ? `${target}/` : variant === 'chain' ? join(dir, 'output') : endpoint;
      const outFile = variant === 'link path' ? `${output}/` : output;
      const before = readdirSync(dir).sort();
      await expect(build(outFile)).rejects.toThrow();
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(dir).sort()).toEqual(before);
      expect(variant === 'plain' ? undefined : readlinkSync(endpoint)).toBe(
        variant === 'plain' ? undefined : linkTarget,
      );
    },
  );

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

describe.skipIf(process.platform === 'win32')('stream destination aliases (#219)', () => {
  const api = pathToFileURL(join(import.meta.dirname, '../src/compiler.ts')).href;
  function child(outFile: string) {
    return spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { compileToFile } from ${JSON.stringify(api)};
       await compileToFile(${JSON.stringify({ sources: [STORY], outFile, outputMode: 'json' })});`,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
  }

  it('updates the regular file when lexical dot-dot removal would name stdout', () => {
    mkdirSync(join(dir, 'actual/a/b'), { recursive: true });
    mkdirSync(join(dir, 'dev'));
    const target = join(dir, 'dev/stdout');
    writeFileSync(target, 'ORIGINAL');
    symlinkSync(join(dir, 'actual/a/b'), join(dir, 'pivot'));
    // Do not use path.join: the kernel must follow pivot before resolving its parent components.
    const result = child(`${dir}/pivot/../../../dev/stdout`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readFileSync(target, 'utf8')).toContain('Hello');
  });

  it.each(
    process.platform === 'linux' ? ['/dev/stdout', '/dev/fd/1', '/proc/self/fd/1'] : ['/dev/stdout', '/dev/fd/1'],
  )('writes through a link chain to %s with piped stdout', (descriptor) => {
    symlinkSync(descriptor, join(dir, 'endpoint'));
    symlinkSync('endpoint', join(dir, 'out'));
    const result = child(join(dir, 'out'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('passages');
    expect(readlinkSync(join(dir, 'out'))).toBe('endpoint');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'twee-ts.ts');
// The CLI runs from a temporary directory, where a bare `tsx` would not resolve.
const TSX_LOADER = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const NODE_ARGS = ['--import', TSX_LOADER, BIN];

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(cwd: string, args: readonly string[]): CliResult {
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...args], { cwd, encoding: 'utf-8', timeout: 30_000 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const STORY_DATA = ':: StoryData\n{\n\t"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC"\n}\n';
const VALID_STORY = `:: StoryTitle\nTest\n\n${STORY_DATA}\n:: Start\nHello.\n`;
const BROKEN_STORY = `${VALID_STORY}\n:: Broken [unterminated\nText.\n`;
// A duplicate passage is a warning, not an error.
const WARNING_STORY = `${VALID_STORY}\n:: Start\nHello again.\n`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CLI --init', () => {
  const storyDataPath = (): string => join(dir, 'src', 'StoryData.tw');
  const startPath = (): string => join(dir, 'src', 'Start.tw');
  const configPath = (): string => join(dir, 'twee-ts.config.json');

  it('scaffolds the config and both story files in an empty directory', () => {
    const r = runCli(dir, ['--init']);
    expect(r.status).toBe(0);
    expect(existsSync(configPath())).toBe(true);
    expect(readFileSync(storyDataPath(), 'utf-8')).toMatch(/"ifid": "[0-9A-F-]{36}"/);
    expect(readFileSync(startPath(), 'utf-8')).toMatch(/^:: Start\n/);
    expect(r.stdout).toContain('src/StoryData.tw');
    expect(r.stdout).toContain('src/Start.tw');
    expect(r.stdout).not.toContain('Skipped');
  });

  it('keeps every file when run a second time', () => {
    expect(runCli(dir, ['--init']).status).toBe(0);
    const before = [configPath(), storyDataPath(), startPath()].map((p) => readFileSync(p, 'utf-8'));

    const r = runCli(dir, ['--init']);
    expect(r.status).toBe(0);
    const after = [configPath(), storyDataPath(), startPath()].map((p) => readFileSync(p, 'utf-8'));
    expect(after).toEqual(before);
    expect(r.stdout).toContain('Skipped (already exists): twee-ts.config.json');
    expect(r.stdout).toContain('Skipped (already exists): src/StoryData.tw');
    expect(r.stdout).toContain('Skipped (already exists): src/Start.tw');
    expect(r.stdout).not.toContain('Created');
  });

  it('keeps an existing Start.tw and creates the missing StoryData.tw', () => {
    mkdirSync(join(dir, 'src'));
    const authored = ':: Start\nMy authored opening.\n';
    writeFileSync(startPath(), authored);

    const r = runCli(dir, ['--init']);
    expect(r.status).toBe(0);
    expect(readFileSync(startPath(), 'utf-8')).toBe(authored);
    expect(readFileSync(storyDataPath(), 'utf-8')).toMatch(/^:: StoryData\n/);
    expect(r.stdout).toContain('Skipped (already exists): src/Start.tw');
  });

  it('keeps an existing StoryData.tw (and its IFID) and creates the missing Start.tw', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(storyDataPath(), STORY_DATA);

    const r = runCli(dir, ['--init']);
    expect(r.status).toBe(0);
    expect(readFileSync(storyDataPath(), 'utf-8')).toBe(STORY_DATA);
    expect(readFileSync(startPath(), 'utf-8')).toMatch(/^:: Start\n/);
    expect(r.stdout).toContain('Skipped (already exists): src/StoryData.tw');
  });
});

describe('CLI exit status', () => {
  const write = (name: string, content: string): string => {
    writeFileSync(join(dir, name), content);
    return name;
  };
  const baseArgs = ['--no-config', '--no-remote', '-a'];

  it('exits 0 and writes the file for a valid story', () => {
    const src = write('story.tw', VALID_STORY);
    const r = runCli(dir, [...baseArgs, src, '-o', 'out.html']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'out.html'), 'utf-8')).toContain('<tw-storydata');
  });

  it('exits 0 and writes stdout for a valid story', () => {
    const src = write('story.tw', VALID_STORY);
    const r = runCli(dir, [...baseArgs, src]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('<tw-storydata');
  });

  it('exits 0 when there are only warnings', () => {
    const src = write('story.tw', WARNING_STORY);
    const toFile = runCli(dir, [...baseArgs, src, '-o', 'out.html']);
    expect(toFile.stderr).toContain('warning:');
    expect(toFile.status).toBe(0);
    expect(existsSync(join(dir, 'out.html'))).toBe(true);

    const toStdout = runCli(dir, [...baseArgs, src]);
    expect(toStdout.status).toBe(0);
    expect(toStdout.stdout).toContain('<tw-storydata');
  });

  it('exits 1 and writes no file when compiling to a file reports errors', () => {
    const src = write('broken.tw', BROKEN_STORY);
    const r = runCli(dir, [...baseArgs, src, '-o', 'out.html']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/error: line \d+: Malformed twee source; unterminated tag block\./);
    expect(r.stderr).toContain('output not written');
    expect(existsSync(join(dir, 'out.html'))).toBe(false);
  });

  it('leaves an existing output file alone when the build reports errors', () => {
    const src = write('broken.tw', BROKEN_STORY);
    write('out.html', 'previous build');
    const r = runCli(dir, [...baseArgs, src, '-o', 'out.html']);
    expect(r.status).toBe(1);
    expect(readFileSync(join(dir, 'out.html'), 'utf-8')).toBe('previous build');
  });

  it('exits 1 and writes nothing to stdout when compiling to stdout reports errors', () => {
    const src = write('broken.tw', BROKEN_STORY);
    const r = runCli(dir, [...baseArgs, src]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/error: line \d+: Malformed twee source; unterminated tag block\./);
  });

  it('exits 1 for a missing IFID in Twee output mode', () => {
    const src = write('noifid.tw', ':: Start\nHello.\n');
    const r = runCli(dir, ['--no-config', '--no-remote', '-d', src]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: Story IFID not found.');
  });

  it('keeps watching after a build that reports errors', async () => {
    const src = write('broken.tw', BROKEN_STORY);
    const child = spawn(process.execPath, [...NODE_ARGS, ...baseArgs, '-w', src, '-o', 'out.html'], { cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      const deadline = Date.now() + 20_000;
      while (!stdout.includes('Built:') && child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stdout).toContain('Built:');
      expect(stderr).toMatch(/error: line \d+: Malformed twee source/);
      // Give a would-be process.exit() time to land.
      await new Promise((r) => setTimeout(r, 500));
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
    }
  }, 30_000);
});

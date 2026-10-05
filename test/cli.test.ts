import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
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

function runCli(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): CliResult {
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...args], { cwd, env, encoding: 'utf-8', timeout: 30_000 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A CLI process left running (watch mode), with what it has printed so far. */
interface RunningCli {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function startCli(cwd: string, args: readonly string[]): RunningCli {
  const child = spawn(process.execPath, [...NODE_ARGS, ...args], { cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

/** Polls `condition` until it holds; fails, naming `what`, if it hasn't after `timeoutMs`. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

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

describe('CLI --list-formats (#174)', () => {
  /** An environment with an empty home, a cache inside the test directory, and no TWEEGO_PATH. */
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: join(dir, 'home'),
    USERPROFILE: join(dir, 'home'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    TWEEGO_PATH: '',
  });
  const writeFormat = (formatDir: string, name: string, version: string): void => {
    mkdirSync(formatDir, { recursive: true });
    const source = `<html><head></head><body>${name}-${version} {{STORY_DATA}}</body></html>`;
    writeFileSync(join(formatDir, 'format.js'), `window.storyFormat(${JSON.stringify({ name, version, source })});`);
  };

  it('lists cached formats under IDs that --format accepts', () => {
    writeFormat(join(dir, 'cache', 'twee-ts', 'storyformats', 'Fixture', '1.0.0'), 'Fixture', '1.0.0');
    writeFormat(join(dir, 'cache', 'twee-ts', 'storyformats', 'Fixture', '1.1.0'), 'Fixture', '1.1.0');
    const list = runCli(dir, ['--no-config', '--list-formats'], env());
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('Cached remote formats:\n  fixture-1: Fixture 1.1.0 (also cached: 1.0.0)\n');

    const id = /Cached remote formats:\n {2}(\S+):/.exec(list.stdout)?.[1];
    expect(id).toBe('fixture-1');
    writeFileSync(join(dir, 'story.tw'), VALID_STORY);
    const build = runCli(dir, ['--no-config', '--no-remote', '-f', id ?? '', '-o', 'out.html', 'story.tw'], env());
    expect(build.stderr).toBe('');
    expect(build.status).toBe(0);
    expect(readFileSync(join(dir, 'out.html'), 'utf-8')).toContain('Fixture-1.1.0');
  });

  it('lists the formatPaths from the config file, and warns about formats it skips', () => {
    writeFormat(join(dir, 'formats', 'mine-1'), 'Mine', '1.0.0');
    mkdirSync(join(dir, 'formats', 'broken-1'));
    writeFileSync(join(dir, 'formats', 'broken-1', 'format.js'), 'window.storyFormat({name: "B", source: nope});');
    writeFileSync(join(dir, 'twee-ts.config.json'), JSON.stringify({ formatPaths: ['formats'] }));
    const list = runCli(dir, ['--list-formats'], env());
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('  mine-1: Mine 1.0.0 (Twine 2)\n');
    expect(list.stderr).toMatch(/^warning: format broken-1: Skipping format; /m);
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
    const cli = startCli(dir, [...baseArgs, '-w', src, '-o', 'out.html']);
    try {
      // stdout and stderr arrive separately: wait for the build line and its report.
      await waitFor(
        () => (cli.stdout().includes('Built:') && /still watching/i.test(cli.stderr())) || cli.child.exitCode !== null,
        'the first build',
      );
      expect(cli.stdout()).toContain('Built:');
      expect(cli.stderr()).toMatch(/error: line \d+: Malformed twee source/);
      expect(cli.stderr()).toContain('output not written');
      expect(existsSync(join(dir, 'out.html'))).toBe(false);
      // A process that exited after the failed build cannot build a good save.
      write('broken.tw', VALID_STORY);
      await waitFor(
        () =>
          (existsSync(join(dir, 'out.html')) && countOf(cli.stdout(), 'Built:') >= 2) || cli.child.exitCode !== null,
        'the rebuild of the corrected save',
      );
      expect(cli.child.exitCode).toBeNull();
      expect(readFileSync(join(dir, 'out.html'), 'utf-8')).toContain('<tw-storydata');
    } finally {
      cli.child.kill();
    }
  }, 30_000);

  it('waits in watch mode for a source folder that does not exist yet, and builds it once it does', async () => {
    const out = join(dir, 'out.html');
    const cli = startCli(dir, [...baseArgs, '-w', 'later', '-o', 'out.html']);
    try {
      await waitFor(
        () => (cli.stdout().includes('Built:') && /still watching/i.test(cli.stderr())) || cli.child.exitCode !== null,
        'the first build',
      );
      expect(cli.stderr()).toMatch(/warning: path later: ENOENT/);

      mkdirSync(join(dir, 'later'));
      write(join('later', 'story.tw'), VALID_STORY.replace('Hello.', 'ARRIVED_CONTENT'));
      await waitFor(() => existsSync(out) || cli.child.exitCode !== null, 'the build of the new folder');
      expect(cli.child.exitCode).toBeNull();
      expect(readFileSync(out, 'utf-8')).toContain('ARRIVED_CONTENT');
    } finally {
      cli.child.kill();
    }
  }, 30_000);

  // A folder its owner can't read; root reads it anyway, and Windows has no such mode bits.
  const canMakeUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.runIf(canMakeUnreadable)(
    'reports a source folder it cannot watch in watch mode, and builds it once it can',
    async () => {
      const out = join(dir, 'out.html');
      mkdirSync(join(dir, 'locked'));
      write(join('locked', 'story.tw'), VALID_STORY.replace('Hello.', 'UNLOCKED_CONTENT'));
      chmodSync(join(dir, 'locked'), 0o000);
      const cli = startCli(dir, [...baseArgs, '-w', 'locked', '-o', 'out.html']);
      try {
        await waitFor(
          () =>
            (cli.stdout().includes('Built:') && /still watching/i.test(cli.stderr())) || cli.child.exitCode !== null,
          'the first build',
        );
        expect(cli.stderr()).toMatch(/error: Cannot watch locked: EACCES/);

        chmodSync(join(dir, 'locked'), 0o755);
        await waitFor(() => existsSync(out) || cli.child.exitCode !== null, 'the build of the readable folder');
        expect(cli.child.exitCode).toBeNull();
        expect(readFileSync(out, 'utf-8')).toContain('UNLOCKED_CONTENT');
      } finally {
        cli.child.kill();
        chmodSync(join(dir, 'locked'), 0o755);
      }
    },
    30_000,
  );

  it('keeps the last good output in watch mode when a rebuild reports errors, and recovers on a good save', async () => {
    const out = join(dir, 'out.html');
    const src = write('story.tw', VALID_STORY.replace('Hello.', 'KNOWN_GOOD'));
    const cli = startCli(dir, [...baseArgs, '-w', src, '-o', 'out.html']);
    const builds = (): number => countOf(cli.stdout(), 'Built:');
    try {
      await waitFor(() => builds() >= 1, 'the first build');
      const good = readFileSync(out);
      expect(good.toString('utf-8')).toContain('KNOWN_GOOD');

      write('story.tw', VALID_STORY.replace(':: Start\nHello.', ':: Start [unterminated\nBROKEN_CONTENT'));
      // stdout and stderr arrive separately: wait for the build line and its report.
      await waitFor(() => builds() >= 2 && /still watching/i.test(cli.stderr()), 'the rebuild of the malformed save');
      expect(readFileSync(out).equals(good)).toBe(true);
      expect(cli.stderr()).toMatch(/error: line \d+: Malformed twee source/);
      expect(cli.stderr()).toContain('output not written');
      expect(cli.child.exitCode).toBeNull();

      write('story.tw', VALID_STORY.replace('Hello.', 'RECOVERED_CONTENT'));
      await waitFor(() => builds() >= 3, 'the rebuild of the corrected save');
      const recovered = readFileSync(out, 'utf-8');
      expect(recovered).toContain('RECOVERED_CONTENT');
      expect(recovered).not.toContain('KNOWN_GOOD');
      expect(cli.child.exitCode).toBeNull();
    } finally {
      cli.child.kill();
    }
  }, 60_000);

  it('prints the file list and statistics after every build in watch mode with --log-files and --log-stats', async () => {
    const src = write('story.tw', VALID_STORY);
    const cli = startCli(dir, [...baseArgs, '-w', '--log-files', '--log-stats', src, '-o', 'out.html']);
    // The statistics end each build's report.
    const reports = (): number => countOf(cli.stdout(), '\nStatistics:\n');
    const complete = (n: number): boolean => reports() >= n && cli.stdout().trimEnd().endsWith('Files: 1');
    try {
      await waitFor(() => complete(1) || cli.child.exitCode !== null, 'the first build');
      expect(cli.stdout()).toContain('\nFiles: story.tw\n');
      expect(cli.stdout()).toContain('\nStatistics:\n  Passages: 3\n  Words: 2\n  Files: 1\n');

      write('story.tw', `${VALID_STORY}\n:: Second\nTwo more.\n`);
      await waitFor(() => complete(2) || cli.child.exitCode !== null, 'the rebuild');
      expect(countOf(cli.stdout(), '\nFiles: story.tw\n')).toBe(2);
      expect(cli.stdout()).toContain('\nStatistics:\n  Passages: 4\n  Words: 4\n  Files: 1\n');
      expect(cli.child.exitCode).toBeNull();
    } finally {
      cli.child.kill();
    }
  }, 60_000);
});

describe('CLI output inside a source folder', () => {
  const ORIGINAL = `${STORY_DATA}\n:: Start\nORIGINAL_CONTENT [[Deleted]]\n\n:: Deleted\nSOON_DELETED\n`;
  // Start still links to Deleted, which the edit removes.
  const EDITED = `${STORY_DATA}\n:: Start\nUPDATED_CONTENT [[Deleted]]\n`;
  const source = join('story', 'a.tw');
  const output = join('story', 'z-output.html');

  beforeEach(() => {
    mkdirSync(join(dir, 'story'));
    writeFileSync(join(dir, source), ORIGINAL);
  });

  it('leaves its earlier output out of the sources when it builds again', () => {
    const args = ['--no-config', '--no-remote', '-a', '--log-files', '-o', output, 'story'];
    expect(runCli(dir, args).status).toBe(0);

    writeFileSync(join(dir, source), EDITED);
    const r = runCli(dir, args);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const html = readFileSync(join(dir, output), 'utf-8');
    expect(html).toContain('UPDATED_CONTENT');
    expect(html).not.toContain('ORIGINAL_CONTENT');
    expect(html).not.toContain('SOON_DELETED');
    expect(r.stdout).toContain(`Files: ${source}\n`);
  });

  it('--lint leaves the configured output file out of the sources', () => {
    writeFileSync(
      join(dir, 'twee-ts.config.json'),
      JSON.stringify({ sources: ['story'], output: output, outputMode: 'twine2-archive', noRemote: true }),
    );
    expect(runCli(dir, []).status).toBe(0);
    expect(readFileSync(join(dir, output), 'utf-8')).toContain('SOON_DELETED');

    writeFileSync(join(dir, source), EDITED);
    const r = runCli(dir, ['--lint']);
    expect(r.stdout).toContain(', 1 files');
    expect(r.stdout).not.toContain('warning');
    // The link to the deleted passage is broken; the earlier output must not stand in for it.
    expect(r.stdout).toContain('Broken links (1):');
    expect(r.status).toBe(1);
  });
});

describe('CLI config file', () => {
  it('warns about an unknown config key and still builds', () => {
    writeFileSync(join(dir, 'story.tw'), VALID_STORY);
    writeFileSync(
      join(dir, 'twee-ts.config.json'),
      JSON.stringify({ sources: ['story.tw'], OutputMode: 'twee3', outputMode: 'twine2-archive', noRemote: true }),
    );
    const r = runCli(dir, []);
    expect(r.stderr).toBe(
      `warning: ${join(dir, 'twee-ts.config.json')}: Unknown config key "OutputMode" (did you mean "outputMode"?); it is ignored.\n`,
    );
    expect(r.stdout).toContain('<tw-storydata');
    expect(r.status).toBe(0);
  });

  it('reads a config file -c names that starts with a BOM', () => {
    writeFileSync(join(dir, 'story.tw'), VALID_STORY);
    writeFileSync(join(dir, 'custom.json'), '\uFEFF{\r\n  "sources": ["story.tw"],\r\n  "noRemote": true\r\n}\r\n');
    const r = runCli(dir, ['-c', 'custom.json', '-a']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('<tw-storydata');
    expect(r.status).toBe(0);
  });
});

describe('CLI --lint', () => {
  const lintStory = (content: string): CliResult => {
    writeFileSync(join(dir, 'story.tw'), content);
    return runCli(dir, ['--no-config', '--lint', 'story.tw']);
  };

  it('fails on links to passages that Twine 2 output leaves out, and says why', () => {
    const r = lintStory(
      `${STORY_DATA}\n:: Start\n[[Secret]] [[Logic]]\n\n:: Secret [Twine.private]\nHidden\n\n:: Logic [script]\nwindow.x = 1;\n`,
    );
    expect(r.stdout).toContain('Start -> Secret (passage "Secret" is tagged "Twine.private"');
    expect(r.stdout).toContain('Start -> Logic (passage "Logic" is tagged "script"');
    expect(r.stdout).toContain('Lint failed.');
    expect(r.status).toBe(1);
  });

  it('passes when the only broken link is in a Twine.private passage', () => {
    const r = lintStory(
      `${STORY_DATA}\n:: Start\n[[Next]]\n\n:: Next\nThe end.\n\n:: Notes [Twine.private]\nTODO: write [[Epilogue]] later.\n`,
    );
    expect(r.stdout).not.toContain('Broken links');
    expect(r.stdout).toContain('Lint passed.');
    expect(r.status).toBe(0);
  });

  it('passes when the only bracketed text is in a stylesheet', () => {
    const r = lintStory(
      `${STORY_DATA}\n:: Start\nHello\n\n:: Theme [stylesheet]\nbody::before { content: "[[Decorative]]"; }\n`,
    );
    expect(r.stdout).toContain('Lint passed.');
    expect(r.status).toBe(0);
  });
});

describe('CLI with a story format that is not available', () => {
  const args = ['--no-config', '--no-remote', '-f', 'nosuch-9'];

  beforeEach(() => {
    writeFileSync(join(dir, 'story.tw'), VALID_STORY);
  });

  it('prints why, naming the format', () => {
    const r = runCli(dir, [...args, 'story.tw', '-o', 'out.html']);
    expect(r.stderr).toContain('error: Story format "nosuch-9" is not available (remote fetching disabled).');
    expect(r.stderr).toContain('No story format available for HTML output.');
    expect(r.stderr.indexOf('nosuch-9')).toBeLessThan(r.stderr.indexOf('No story format available'));
    expect(r.status).toBe(1);
    expect(existsSync(join(dir, 'out.html'))).toBe(false);
  });

  it('prints why in watch mode, naming the format, and keeps watching', async () => {
    const cli = startCli(dir, [...args, '-w', 'story.tw', '-o', 'out.html']);
    try {
      await waitFor(
        () => cli.stderr().includes('Build error: No story format available') || cli.child.exitCode !== null,
        'the failed build',
      );
      expect(cli.stderr()).toContain('error: Story format "nosuch-9" is not available (remote fetching disabled).');
      expect(cli.stderr().indexOf('nosuch-9')).toBeLessThan(cli.stderr().indexOf('Build error:'));
      expect(cli.child.exitCode).toBeNull();
    } finally {
      cli.child.kill();
    }
  }, 30_000);
});

describe('CLI formatFetchTimeout config key', () => {
  let silent: Server | undefined;

  afterEach(() => {
    silent?.close();
    silent = undefined;
  });

  it('limits each story format request', async () => {
    // Accepts connections and never answers, like a stalled proxy.
    const server = createServer(() => {});
    silent = server;
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/format.js`;

    // After the URL times out, the format is found in the download cache, so nothing else goes to the network.
    const cache = join(dir, 'cache');
    const cached = join(cache, 'twee-ts', 'storyformats', 'Stalled', '1.0.0');
    mkdirSync(cached, { recursive: true });
    writeFileSync(
      join(cached, 'format.js'),
      'window.storyFormat({"name":"Stalled","version":"1.0.0","source":"<html><head></head><body>{{STORY_DATA}}</body></html>"});',
    );
    writeFileSync(join(dir, 'story.tw'), VALID_STORY);
    writeFileSync(
      join(dir, 'twee-ts.config.json'),
      JSON.stringify({ sources: ['story.tw'], output: 'out.html', formatUrls: [url], formatFetchTimeout: 200 }),
    );

    const r = runCli(dir, ['-f', 'stalled-1'], { ...process.env, XDG_CACHE_HOME: cache, TWEEGO_PATH: '' });
    expect(r.stderr).toContain(
      `warning: Remote format fetch failed for "stalled-1": Failed to download format from ${url}: timed out after 200 ms`,
    );
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'out.html'), 'utf-8')).toContain('Hello.');
  }, 30_000);
});

describe('CLI with a named source that is the output (#157)', () => {
  it('fails, naming the path, and leaves the file unchanged', () => {
    writeFileSync(join(dir, 'a.tw'), VALID_STORY);
    const r = runCli(dir, ['--no-config', '-d', '-o', 'a.tw', 'a.tw']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('path a.tw: Output file cannot be an input source.');
    expect(readFileSync(join(dir, 'a.tw'), 'utf-8')).toBe(VALID_STORY);
  });
});

// Symbolic links need privileges on Windows.
describe.skipIf(process.platform === 'win32')('CLI in a symlinked project folder (#152)', () => {
  it('leaves the output out when the sources are named through the link', () => {
    const base = realpathSync(dir);
    mkdirSync(join(base, 'real', 'story'), { recursive: true });
    symlinkSync('real', join(base, 'link'));
    const link = join(base, 'link');
    const start = join(link, 'story', 'a.tw');
    // As from a shell in the link: $PWD/story names the sources; the working directory is the real path.
    const build = (): CliResult =>
      runCli(link, ['--no-config', '--archive-twine2', '--log-files', '-o', 'story/z.html', join(link, 'story')]);
    writeFileSync(start, `${VALID_STORY}\n:: Gone\nSOON_DELETED\n`);
    expect(build().status).toBe(0);
    writeFileSync(start, VALID_STORY.replace('Hello.', 'UPDATED_CONTENT'));
    const second = build();
    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
    expect(second.stdout).toContain(`Files: ${join('..', 'link', 'story', 'a.tw')}\n`);
    const html = readFileSync(join(base, 'real', 'story', 'z.html'), 'utf-8');
    expect(html).toContain('UPDATED_CONTENT');
    expect(html).not.toContain('SOON_DELETED');
  });
});

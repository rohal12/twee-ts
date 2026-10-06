/**
 * The CLI golden table: argv → exit status, standard output bytes and standard error, run as a process.
 * Standard output carries only the story (or a query's answer); everything else goes to standard error.
 * Usage errors exit with 2, build errors with 1. Compared with Tweego's documented behaviour (usage.go,
 * config.go) where it has one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'twee-ts.ts');
const TSX_LOADER = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const FORMAT_DIR = join(ROOT, 'test', 'fixtures', 'storyformats');
const ENV = { ...process.env, TWEEGO_PATH: FORMAT_DIR };

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = ENV): Run {
  const r = spawnSync(process.execPath, ['--import', TSX_LOADER, BIN, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const STORY_DATA = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n';
const STORY = `:: StoryTitle\nGolden\n\n${STORY_DATA}\n:: Start\nHello [[Next]].\n\n:: Next\nThe end.\n`;
// A duplicate passage: a warning, so the build still succeeds and writes.
const WARNING_STORY = `${STORY}\n:: Next\nThe real end.\n`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-golden-'));
  writeFileSync(join(dir, 'a.tw'), STORY);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** No Node.js stack trace in what the CLI printed. */
function expectNoStack(text: string): void {
  expect(text).not.toMatch(/\n\s+at /);
  expect(text).not.toMatch(/TypeError|ERR_PARSE_ARGS|Unhandled/);
}

describe('standard output carries only the story (FS-01)', () => {
  const MODE_FLAGS: readonly (readonly string[])[] = [
    ['-f', 'test-format-1'],
    ['-d'],
    ['--decompile-twee1'],
    ['-a'],
    ['--archive-twine1'],
    ['--json'],
  ];

  for (const mode of MODE_FLAGS) {
    it(`gives the same bytes on stdout as in -o's file, with -l, --log-files and a warning (${mode.join(' ')})`, () => {
      writeFileSync(join(dir, 'a.tw'), WARNING_STORY);
      const flags = ['--no-config', '--no-remote', '-l', '--log-files', ...mode];
      const toStdout = cli(dir, [...flags, 'a.tw']);
      const toFile = cli(dir, [...flags, '-o', 'out', 'a.tw']);
      expect(toStdout.status).toBe(0);
      expect(toFile.status).toBe(0);
      expect(toStdout.stdout.length).toBeGreaterThan(0);
      expect(toStdout.stdout).toBe(readFileSync(join(dir, 'out'), 'utf-8'));
      expect(toFile.stdout).toBe('');
      for (const run of [toStdout, toFile]) {
        expect(run.stderr).toContain('warning: Replacing existing passage "Next"');
        expect(run.stderr).toContain('\nFiles: a.tw\n');
        expect(run.stderr).toContain('\nStatistics:\n  Passages: ');
      }
    });
  }

  it('writes nothing to stdout when the build fails, -l included', () => {
    writeFileSync(join(dir, 'noifid.tw'), ':: Start\nx\n');
    const r = cli(dir, ['--no-config', '-d', '-l', 'noifid.tw']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('error: Story IFID not found');
    expect(r.stderr).toContain('Compilation failed with 1 error; output not written.');
    expect(r.stderr).toContain('Statistics:');
  });

  it('lists the modules and head file as external files, as Tweego does', () => {
    writeFileSync(join(dir, 'm.css'), 'body{}');
    writeFileSync(join(dir, 'h.html'), '<meta name="x">');
    const r = cli(dir, [
      '--no-config',
      '-f',
      'test-format-1',
      '--log-files',
      '-m',
      'm.css',
      '--head',
      'h.html',
      'a.tw',
    ]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('\nFiles: a.tw\nExternal files: m.css, h.html\n');
  });

  it('writes query answers to stdout', () => {
    expect(cli(dir, ['--version'])).toMatchObject({
      status: 0,
      stderr: '',
      stdout: expect.stringMatching(/^twee-ts v/),
    });
    expect(cli(dir, ['--help'])).toMatchObject({ status: 0, stderr: '', stdout: expect.stringContaining('Usage:') });
    expect(cli(dir, ['cache'])).toMatchObject({
      status: 0,
      stderr: '',
      stdout: expect.stringContaining('Usage: twee-ts cache'),
    });
  });

  it('lints to stdout, exit 0 for a clean story', () => {
    const r = cli(dir, ['--no-config', '--lint', 'a.tw']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Passages: 4 total');
    expect(r.stderr).toBe('');
  });
});

describe('usage errors exit with 2 and a one-line message (FS-08, FS-10, FS-16, FS-19)', () => {
  it.each([
    [['--bogus', 'a.tw'], 'unknown option --bogus'],
    [['a.tw', '-o'], 'option -o, --output <value> argument missing'],
    [['--no-trim=false', 'a.tw'], 'option --no-trim does not take an argument'],
    [['--decompile-twee3', '--archive-twine2', 'a.tw'], 'conflict: choose one output mode'],
    [['--lint', '-w', 'a.tw'], "--lint can't be combined with -w, --watch"],
    [['-o', '', 'a.tw'], '-o, --output needs a non-empty value'],
    [['--tag-alias', 'lib=', 'a.tw'], 'the target "" of alias "lib" must be a non-empty tag name without whitespace'],
    [['--tag-alias', 'lib=a b', 'a.tw'], 'must be a non-empty tag name without whitespace'],
    [['--charset', 'windows-1252', 'a.tw'], 'twee-ts has no --charset'],
    [['-w', 'a.tw'], 'watch mode needs an output file'],
    [[], 'no input sources'],
    [['cache', 'clear', 'a', 'b'], 'cache clear takes at most one name'],
  ])('%j', (args, message) => {
    const r = cli(
      dir,
      ['--no-config', ...args].filter((_arg, i) => !(i === 0 && args[0] === 'cache')),
    );
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^error: /);
    expect(r.stderr).toContain(message);
    expect(r.stderr).toMatch(/\nRun "twee-ts --help" for usage\.\n$/);
    expectNoStack(r.stderr);
  });
});

describe('a folder named cache is a source (FS-02)', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'cache'));
    writeFileSync(join(dir, 'cache', 'a.tw'), STORY);
  });

  it.each([
    [['--no-config', '-d', '-o', 'out.tw', 'cache']],
    [['--no-config', '-d', '-o', 'out.tw', '--', 'cache']],
    [['--no-config', '-d', '-o', 'out.tw', './cache']],
  ])('%j builds it', (args) => {
    const r = cli(dir, args);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'out.tw'), 'utf-8')).toContain('Hello');
  });

  it('refuses "cache" first with build options instead of exiting 0 without building', () => {
    const r = cli(dir, ['cache', '-d', '-o', 'out.tw']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('write ./cache');
    expect(existsSync(join(dir, 'out.tw'))).toBe(false);
  });
});

describe('the CLI and its inputs', () => {
  it('resolves config paths against the config file (FS-11)', () => {
    mkdirSync(join(dir, 'proj', 'src'), { recursive: true });
    writeFileSync(join(dir, 'proj', 'src', 'a.tw'), STORY);
    writeFileSync(join(dir, 'proj', 'src', 'skip.css'), 'body{color:red}');
    writeFileSync(
      join(dir, 'proj', 'twee-ts.config.json'),
      JSON.stringify({ sources: ['src/'], output: 'out.tw', outputMode: 'twee3', exclude: ['src/*.css'] }),
    );
    const r = cli(dir, ['-c', join('proj', 'twee-ts.config.json'), '--log-files']);
    expect(r.stderr).toBe(`\nFiles: ${join('proj', 'src', 'a.tw')}\n`);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'proj', 'out.tw'), 'utf-8')).toContain('Hello');
  });

  it("notes that -c is --config when it is given a charset, as Tweego's -c takes", () => {
    const r = cli(dir, ['-c', 'windows-1252', 'a.tw']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Cannot read config file windows-1252: ENOENT');
    expect(r.stderr).toContain("note: -c is --config in twee-ts, not Tweego's --charset");
    expectNoStack(r.stderr);
  });

  it('refuses a config file with an empty output path (FS-19)', () => {
    writeFileSync(join(dir, 'twee-ts.config.json'), JSON.stringify({ sources: ['a.tw'], output: '' }));
    const r = cli(dir, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"output" must not be empty.');
  });

  it('refuses an output that is its own config file', () => {
    const config = JSON.stringify({ sources: ['a.tw'], output: 'twee-ts.config.json', outputMode: 'twee3' });
    writeFileSync(join(dir, 'twee-ts.config.json'), config);
    const r = cli(dir, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Output file cannot be an input source (the config).');
    expect(readFileSync(join(dir, 'twee-ts.config.json'), 'utf-8')).toBe(config);
  });

  it('refuses a head file named as the output in Twee mode, leaving it (#157)', () => {
    writeFileSync(join(dir, 'head.html'), '<meta name="kept">');
    const r = cli(dir, ['--no-config', '-d', '-o', 'head.html', '--head', 'head.html', 'a.tw']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('path head.html: Output file cannot be an input source (the head file).');
    expect(readFileSync(join(dir, 'head.html'), 'utf-8')).toBe('<meta name="kept">');
  });

  it('fails on a missing head file, as Tweego does, and writes nothing (FS-05)', () => {
    const r = cli(dir, ['--no-config', '-f', 'test-format-1', '--head', 'nosuch.html', '-o', 'out.html', 'a.tw']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: load head file nosuch.html: ENOENT');
    expect(existsSync(join(dir, 'out.html'))).toBe(false);
  });

  it('keeps a __proto__ tag alias (#241)', () => {
    writeFileSync(join(dir, 'lib.tw'), `${STORY_DATA}\n:: Start\nx\n\n:: Library [__proto__]\nwindow.LIB = 1;\n`);
    const r = cli(dir, ['--no-config', '--json', '--tag-alias', '__proto__=script', 'lib.tw']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ script: 'window.LIB = 1;' });
  });
});

describe('output targets through the CLI (FS-03)', () => {
  it.skipIf(process.platform === 'win32')('writes to /dev/null', () => {
    const r = cli(dir, ['--no-config', '-d', '-o', '/dev/null', 'a.tw']);
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it.skipIf(process.platform === 'win32')('writes to /dev/stdout as -o - would', () => {
    const viaDevice = cli(dir, ['--no-config', '-d', '-o', '/dev/stdout', 'a.tw']);
    const viaDash = cli(dir, ['--no-config', '-d', '-o', '-', 'a.tw']);
    expect(viaDevice.status).toBe(0);
    expect(viaDevice.stdout).toBe(viaDash.stdout);
  });

  it.skipIf(process.platform !== 'win32')('writes to NUL', () => {
    expect(cli(dir, ['--no-config', '-d', '-o', 'NUL', 'a.tw']).status).toBe(0);
  });
});

describe('a reader that closes the pipe early (FS-09)', () => {
  it('ends quietly instead of with an unhandled EPIPE', async () => {
    const big = Array.from({ length: 30_000 }, (_, i) => `:: P${i}\n${'x'.repeat(80)}\n`).join('\n');
    writeFileSync(join(dir, 'big.tw'), `${STORY_DATA}\n:: Start\nx\n\n${big}`);
    const child = spawn(process.execPath, ['--import', TSX_LOADER, BIN, '--no-config', '-d', 'big.tw'], {
      cwd: dir,
      env: ENV,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.once('data', () => {
      child.stdout.destroy();
    });
    const status = await new Promise<number | null>((done) => {
      child.on('close', (code) => {
        done(code);
      });
    });
    expect(stderr).toBe('');
    expect(status).toBe(0);
  }, 30_000);
});

describe('watch mode stops on an error no edit can fix (FS-13)', () => {
  it('exits with 1 when the output is a source, instead of watching on', async () => {
    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER, BIN, '--no-config', '-d', '-w', '-o', 'a.tw', 'a.tw'],
      {
        cwd: dir,
        env: ENV,
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 20_000);
    const status = await new Promise<number | null>((done) => {
      child.on('close', (code) => {
        done(code);
      });
    });
    clearTimeout(timer);
    expect(status).toBe(1);
    expect(stderr).toContain('path a.tw: Output file cannot be an input source.');
    expect(readFileSync(join(dir, 'a.tw'), 'utf-8')).toBe(STORY);
  }, 30_000);
});

describe('--list-formats lists the cached downloads a build would consider', () => {
  it('leaves out downloads from format URLs and indices the project does not configure', () => {
    const cache = join(dir, 'cache');
    const env = { ...ENV, XDG_CACHE_HOME: cache };
    // Written in a child process, so the cache path comes from XDG_CACHE_HOME as the CLI reads it.
    const write = (record: object): void => {
      const module = pathToFileURL(join(ROOT, 'src', 'format-cache.ts')).href;
      const script = `import(${JSON.stringify(module)}).then((m) => m.writeEntry(${JSON.stringify(record)}, new Map([['format.js', Buffer.from('window.storyFormat({})')]])))`;
      const r = spawnSync(process.execPath, ['--import', TSX_LOADER, '-e', script], { env, encoding: 'utf-8' });
      expect(r.stderr).toBe('');
    };
    const base = {
      isTwine2: true,
      metadata: { proofing: false },
      main: 'format.js',
      fetchedAt: '2026-10-06T00:00:00Z',
    };
    const sfa = 'https://videlais.github.io/story-formats-archive/official/index.json';
    write({
      ...base,
      origin: { kind: 'index', index: sfa, twine: 'twine2', name: 'Alpha', version: '1.2.0' },
      name: 'Alpha',
      version: '1.2.0',
      downloadUrl: 'https://x/a.js',
    });
    write({
      ...base,
      origin: { kind: 'url', url: 'https://example.com/beta/format.js' },
      name: 'Beta',
      version: '2.0.0',
      downloadUrl: 'https://example.com/beta/format.js',
    });
    write({
      ...base,
      origin: {
        kind: 'index',
        index: 'https://other.example/index.json',
        twine: 'twine2',
        name: 'Gamma',
        version: '3.0.0',
      },
      name: 'Gamma',
      version: '3.0.0',
      downloadUrl: 'https://x/g.js',
    });

    const plain = cli(dir, ['--list-formats', '--no-config'], env);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('alpha-1: Alpha 1.2.0');
    expect(plain.stdout).not.toContain('Beta');
    expect(plain.stdout).not.toContain('Gamma');

    writeFileSync(
      join(dir, 'twee-ts.config.json'),
      JSON.stringify({
        formatUrls: ['https://example.com/beta/format.js'],
        formatIndices: ['https://other.example/index.json'],
      }),
    );
    const configured = cli(dir, ['--list-formats'], env);
    expect(configured.stdout).toContain('beta-2: Beta 2.0.0');
    expect(configured.stdout).toContain('gamma-3: Gamma 3.0.0');
    // Every download is still in the cache listing.
    const listed = cli(dir, ['cache', 'list'], env).stdout;
    expect(['Alpha', 'Beta', 'Gamma'].filter((name) => listed.includes(name))).toEqual(['Alpha', 'Beta', 'Gamma']);
  }, 60_000);
});

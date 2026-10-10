/**
 * The command line, parsed into a request before anything runs (src/cli-request.ts). Table-driven: each
 * argv either gives the request shown or a usage error with the message shown.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CliUsageError, looksLikeCharset, OPTIONS, parseCliArgs, resolveBuild, usageText } from '../src/cli-request.js';
import type { BuildRequest, CliRequest } from '../src/cli-request.js';

function request(argv: readonly string[]): CliRequest {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) throw new Error(`expected a request for ${JSON.stringify(argv)}, got: ${parsed.error.message}`);
  return parsed.request;
}

function usage(argv: readonly string[]): string {
  const parsed = parseCliArgs(argv);
  if (parsed.ok) throw new Error(`expected a usage error for ${JSON.stringify(argv)}`);
  expect(parsed.error).toBeInstanceOf(CliUsageError);
  return parsed.error.message;
}

function build(argv: readonly string[]): BuildRequest {
  const r = request(argv);
  if (r.kind !== 'build') throw new Error(`expected a build for ${JSON.stringify(argv)}`);
  return r;
}

describe('subcommands are only the first word (FS-02)', () => {
  it.each([
    [['cache'], { kind: 'cache-help' }],
    [['cache', 'list'], { kind: 'cache', action: 'list' }],
    [['cache', 'size'], { kind: 'cache', action: 'size' }],
    [['cache', 'path'], { kind: 'cache', action: 'path' }],
    [['cache', 'clear'], { kind: 'cache-clear' }],
    [['cache', 'clear', 'harlowe'], { kind: 'cache-clear', name: 'harlowe' }],
  ])('%j', (argv, expected) => {
    expect(request(argv)).toEqual(expected);
  });

  it.each([
    [['-o', 'out.tw', 'cache'], ['cache']],
    [['-d', '--', 'cache'], ['cache']],
    [
      ['--', 'cache', 'clear'],
      ['cache', 'clear'],
    ],
    [['./cache'], ['./cache']],
    [
      ['story', 'cache', 'clear'],
      ['story', 'cache', 'clear'],
    ],
  ])('%j builds the folders %j', (argv, sources) => {
    expect(build(argv).sources).toEqual(sources);
  });

  it.each([
    [['cache', 'bogus'], 'unknown cache subcommand "bogus"; expected list, clear, size or path'],
    [['cache', 'list', 'x'], 'cache list takes no arguments'],
    [['cache', 'clear', 'a', 'b'], 'cache clear takes at most one name'],
    [['cache', '-o', 'out.tw'], /takes no options; to build a folder named "cache", write \.\/cache/],
    // An empty name (an unset variable) is not "everything" (#366).
    [['cache', 'clear', ''], /^cache clear needs a non-empty name/],
  ])('%j is a usage error', (argv, message) => {
    expect(usage(argv)).toMatch(message);
  });
});

describe('usage errors carry a one-line message, never a stack trace (FS-08)', () => {
  it.each([
    [['--bogus', 'a.tw'], 'unknown option --bogus'],
    [['-x', 'a.tw'], 'unknown option -x'],
    [['a.tw', '-o'], 'option -o, --output <value> argument missing'],
    [['--no-trim=false', 'a.tw'], 'option --no-trim does not take an argument'],
    [['-o', '-d', 'a.tw'], 'option -o argument is ambiguous.'],
    [['--charset', 'windows-1252', 'a.tw'], /twee-ts has no --charset/],
    [['--list-charsets'], /twee-ts has no --charset/],
  ])('%j → %s', (argv, message) => {
    expect(usage(argv)).toMatch(message);
  });
});

// Tweego reads `-o=file` as `-o file` (internal/option/option.go: the name is what comes before the first `=`) (#385).
describe('-<letter>=<value> means -<letter> <value>', () => {
  const shorts = Object.entries(OPTIONS).flatMap(([name, option]) =>
    'short' in option ? [{ name, short: option.short, type: option.type }] : [],
  );

  it.each(shorts.filter((o) => o.type === 'string'))('-$short=v is --$name=v and -$short v', ({ name, short }) => {
    const argv = (...options: string[]): readonly string[] => [...options, 'a.tw'];
    const expected = parseCliArgs(argv(`--${name}=v`));
    expect(parseCliArgs(argv(`-${short}=v`))).toEqual(expected);
    expect(parseCliArgs(argv(`-${short}`, 'v'))).toEqual(expected);
  });

  it.each(shorts.filter((o) => o.type === 'boolean' && o.name !== 'help'))(
    '-$short=v is refused: --$name takes no value',
    ({ short }) => {
      expect(usage([`-${short}=v`, 'a.tw'])).toMatch(/^option -.*, --.* does not take an argument$/);
    },
  );

  it.each([
    [['-o=a=b', 's.tw'], 'a=b'],
    [['-o=-', 's.tw'], '-'],
    [['-o=C:\\out\\story.html', 's.tw'], 'C:\\out\\story.html'],
    [['-do=x.tw', 's.tw'], 'x.tw'],
  ])('%j sets the output to %s', (argv, output) => {
    expect(build(argv).flags.output).toBe(output);
  });

  it('keeps the other bundled letters', () => {
    expect(build(['-do=x.tw', 's.tw']).flags).toEqual({ output: 'x.tw', outputMode: 'twee3' });
  });

  it.each([
    [['-o=', 's.tw'], '-o, --output needs a non-empty value'],
    [['-o=a', '-o', 'b', 's.tw'], '-o, --output given more than once'],
    [['-x=1', 's.tw'], 'unknown option -x'],
  ])('%j is a usage error', (argv, message) => {
    expect(usage(argv)).toBe(message);
  });

  it('leaves a source after -- alone', () => {
    expect(build(['--', '-o=x']).sources).toEqual(['-o=x']);
  });
});

describe('repeated and conflicting options are errors (FS-10)', () => {
  it.each([
    [['-o', 'a.html', '-o', 'b.html', 'a.tw'], '-o, --output given more than once'],
    [['-d', '-d', 'a.tw'], '-d, --decompile-twee3 given more than once'],
    [['-dd', 'a.tw'], '-d, --decompile-twee3 given more than once'],
    [['-f', 'x', '--format=y', 'a.tw'], '-f, --format given more than once'],
    [['-d', '-a', 'a.tw'], '-d, --decompile-twee3 and -a, --archive-twine2 conflict: choose one output mode'],
    [['-a', '-d', 'a.tw'], '-a, --archive-twine2 and -d, --decompile-twee3 conflict: choose one output mode'],
    [['--json', '--decompile-twee1', 'a.tw'], '--json and --decompile-twee1 conflict: choose one output mode'],
    [['--decompile', '-d', 'a.tw'], '--decompile and -d, --decompile-twee3 conflict: choose one output mode'],
    [['--lint', '-w', 'a.tw'], "--lint can't be combined with -w, --watch"],
    [['--lint', '-d', 'a.tw'], "--lint can't be combined with -d, --decompile-twee3"],
    [['--lint', '-l', 'a.tw'], "--lint can't be combined with -l, --log-stats"],
    [['-c', 'x.json', '--no-config', 'a.tw'], '-c, --config and --no-config conflict'],
    [['--version', 'a.tw'], '--version takes no sources'],
    [['--version', '-d'], "--version can't be combined with -d, --decompile-twee3"],
    [['--init', '-o', 'x'], "--init can't be combined with -o, --output"],
    [['--list-formats', '-d'], "--list-formats can't be combined with -d, --decompile-twee3"],
    [['-w', '-o', '-', 'a.tw'], 'watch mode needs an output file: standard output is not supported'],
  ])('%j → %s', (argv, message) => {
    expect(usage(argv)).toBe(message);
  });

  it('lets options that list things repeat', () => {
    const r = build(['-m', 'a.js', '-m', 'b.css', '--exclude', 'x', '--exclude', 'y', 'a.tw']);
    expect(r.flags.modules).toEqual(['a.js', 'b.css']);
    expect(r.flags.exclude).toEqual(['x', 'y']);
  });
});

describe('values are checked at the boundary', () => {
  it.each([
    [['-o', '', 'a.tw'], '-o, --output needs a non-empty value'],
    [['--output=', 'a.tw'], '-o, --output needs a non-empty value'],
    [['--head', '', 'a.tw'], '--head needs a non-empty value'],
    [['-m', '', 'a.tw'], '-m, --module needs a non-empty value'],
    [['--exclude=', 'a.tw'], '--exclude needs a non-empty value'],
    [['--word-count-method', 'chars', 'a.tw'], 'invalid --word-count-method "chars": expected tweego or whitespace'],
  ])('%j → %s (FS-19)', (argv, message) => {
    expect(usage(argv)).toBe(message);
  });

  it.each([
    [['--tag-alias', 'lib', 'a.tw'], 'invalid --tag-alias "lib": expected alias=target'],
    [
      ['--tag-alias', '=script', 'a.tw'],
      'invalid --tag-alias "=script": the alias "" must be a non-empty tag name without whitespace',
    ],
    [
      ['--tag-alias', 'lib=', 'a.tw'],
      'invalid --tag-alias "lib=": the target "" of alias "lib" must be a non-empty tag name without whitespace',
    ],
    [['--tag-alias', 'lib=a b', 'a.tw'], /the target "a b" of alias "lib" must be/],
    [['--tag-alias', 'my lib=script', 'a.tw'], /the alias "my lib" must be/],
    [['--tag-alias', 'lib=\tx', 'a.tw'], /the target/],
  ])('%j → %s (FS-16)', (argv, message) => {
    expect(usage(argv)).toMatch(message);
  });

  it('keeps every alias as an own key, __proto__ and constructor included (#241)', () => {
    const r = build(['--tag-alias', '__proto__=script', '--tag-alias', 'constructor=stylesheet', 'a.tw']);
    const resolved = resolveBuild(r, null);
    const aliases = resolved.options.tagAliases ?? {};
    expect(Object.keys(aliases)).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(aliases, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(aliases)).toBe(Object.prototype);
  });

  it('keeps alias values that look like option names', () => {
    expect(build(['--tag-alias=lib=script', 'a.tw']).flags.tagAliases).toEqual([['lib', 'script']]);
    expect(build(['--tag-alias', 'a=b=c', 'a.tw']).flags.tagAliases).toEqual([['a', 'b=c']]);
  });
});

describe('a build request', () => {
  it('records only what was given, so the config decides the rest', () => {
    expect(build(['a.tw'])).toEqual({
      kind: 'build',
      action: 'once',
      sources: ['a.tw'],
      flags: {},
      config: { kind: 'auto' },
      log: { files: false, stats: false },
    });
  });

  it('reads every option', () => {
    const r = build([
      '-o',
      'out.html',
      '-f',
      'harlowe-3',
      '-s',
      'Begin',
      '-m',
      'm.js',
      '--head',
      'h.html',
      '--json',
      '--twee2-compat',
      '--no-trim',
      '-t',
      '-l',
      '--log-files',
      '--format-index',
      'https://i',
      '--format-url',
      'https://u',
      '--no-remote',
      '--tag-alias',
      'lib=script',
      '--exclude',
      '**/*.png',
      '--source-info',
      '--word-count-method',
      'whitespace',
      '-c',
      'cfg.json',
      'src',
    ]);
    expect(r).toEqual({
      kind: 'build',
      action: 'once',
      sources: ['src'],
      config: { kind: 'file', path: 'cfg.json' },
      log: { files: true, stats: true },
      flags: {
        output: 'out.html',
        outputMode: 'json',
        formatId: 'harlowe-3',
        startPassage: 'Begin',
        modules: ['m.js'],
        headFile: 'h.html',
        exclude: ['**/*.png'],
        formatIndices: ['https://i'],
        formatUrls: ['https://u'],
        tagAliases: [['lib', 'script']],
        wordCountMethod: 'whitespace',
        trim: false,
        twee2Compat: true,
        testMode: true,
        noRemote: true,
        sourceInfo: true,
      },
    });
  });

  it.each([
    [['-d', 'a.tw'], 'twee3'],
    [['--decompile', 'a.tw'], 'twee3'],
    [['--decompile-twee1', 'a.tw'], 'twee1'],
    [['-a', 'a.tw'], 'twine2-archive'],
    [['--archive-twine1', 'a.tw'], 'twine1-archive'],
    [['--json', 'a.tw'], 'json'],
  ])('%j selects %s', (argv, mode) => {
    expect(build(argv).flags.outputMode).toBe(mode);
  });

  it.each([
    [['-w', '-o', 'x', 'a.tw'], 'watch'],
    [['--lint', 'a.tw'], 'lint'],
    [['--lint', '-o', 'out.html', 'a.tw'], 'lint'],
  ])('%j is a %s build', (argv, action) => {
    expect(build(argv).action).toBe(action);
  });

  it('treats everything after -- as sources', () => {
    expect(build(['--', '-d', '--help']).sources).toEqual(['-d', '--help']);
    expect(build(['-d', '--', '-x.tw']).sources).toEqual(['-x.tw']);
  });

  it.each([
    [['--help'], 'help'],
    [['-d', '-h', 'a.tw'], 'help'],
    [['-v'], 'version'],
    [['--init'], 'init'],
    [['--list-formats'], 'list-formats'],
  ])('%j → %s', (argv, kind) => {
    expect(request(argv).kind).toBe(kind);
  });

  // docs/cli.md: --help wins over every other option, valid or not (#382).
  it.each([
    [['--help', '--bogus']],
    [['--bogus', '--help']],
    [['-h', '-o']],
    [['-o', 'a', '-o', 'b', '-h']],
    [['--help', '--help']],
    [['-dh']],
    [['-h', '--version', '--init']],
    [['-h', '-d=x']],
    [['-h', '--charset', 'x']],
    [['--tag-alias', 'bad', '-h']],
    [['-h', '--', '-d']],
  ])('%j asks for the help', (argv) => {
    expect(request(argv)).toEqual({ kind: 'help' });
  });

  it('does not read --help after -- as a request for help', () => {
    expect(usage(['--bogus', '--', '--help'])).toBe('unknown option --bogus');
  });

  it('lets --list-formats choose the config', () => {
    expect(request(['--list-formats', '-c', 'x.json'])).toEqual({
      kind: 'list-formats',
      config: { kind: 'file', path: 'x.json' },
    });
    expect(request(['--list-formats', '--no-config'])).toEqual({ kind: 'list-formats', config: { kind: 'none' } });
  });
});

describe('merging with the config', () => {
  const config = {
    sources: ['src'],
    output: 'story.html',
    outputMode: 'twee3' as const,
    tagAliases: { lib: 'script', old: 'stylesheet' },
    trim: false,
    exclude: ['**/*.png'],
  };

  it("lets the command line win, and adds its tag aliases to the config's", () => {
    const r = resolveBuild(build(['--json', '--tag-alias', 'lib=widget', '--tag-alias', 'new=script', 'a.tw']), config);
    expect(r.sources).toEqual(['a.tw']);
    expect(r.output).toBe('story.html');
    expect(r.options.outputMode).toBe('json');
    expect(r.options.trim).toBe(false);
    expect(r.options.tagAliases).toEqual({ lib: 'widget', old: 'stylesheet', new: 'script' });
    expect(r.options.exclude).toEqual(['**/*.png']);
  });

  it('takes the sources from the config, and stdout without an output', () => {
    const r = resolveBuild(build([]), { sources: ['src'] });
    expect(r.sources).toEqual(['src']);
    expect(r.output).toBe('-');
    expect(r.options).toMatchObject({ outputMode: 'html', trim: true, twee2Compat: false, testMode: false });
    expect(r.options.tagAliases).toBeUndefined();
  });

  it('needs sources somewhere', () => {
    expect(() => resolveBuild(build([]), null)).toThrow('no input sources: name them, or set "sources" in the config');
    expect(() => resolveBuild(build([]), { sources: [] })).toThrow(CliUsageError);
  });

  it('needs an output file for watch mode', () => {
    expect(() => resolveBuild(build(['-w', 'a.tw']), null)).toThrow(
      'watch mode needs an output file (-o, or "output" in the config)',
    );
    expect(() => resolveBuild(build(['-w', 'a.tw']), { output: '-' })).toThrow(CliUsageError);
    expect(resolveBuild(build(['-w', 'a.tw']), { output: 'x.html' }).output).toBe('x.html');
  });

  it("keeps the config's empty alias map", () => {
    expect(resolveBuild(build(['a.tw']), { tagAliases: {} }).options.tagAliases).toEqual({});
  });
});

describe('Tweego users', () => {
  it.each(['windows-1252', 'UTF-8', 'utf8', 'iso-8859-1', 'cp1252', 'latin1', 'us-ascii', 'shift_jis', 'utf-16le'])(
    '-c %s looks like a charset',
    (value) => {
      expect(looksLikeCharset(value)).toBe(true);
    },
  );

  it.each(['twee-ts.config.json', 'configs/prod.json', 'utf8.json'])('-c %s does not', (value) => {
    expect(looksLikeCharset(value)).toBe(false);
  });
});

it('documents every option and the exit statuses in the help text', () => {
  const text = usageText('9.9.9', 'twee-ts.config.json');
  expect(text).toContain('twee-ts v9.9.9');
  expect(text).toContain('Exit status: 0 success, 1 build or lint errors, 2 usage errors.');
  for (const option of ['--output', '--decompile-twee3', '--archive-twine1', '--tag-alias', '--no-config']) {
    expect(text).toContain(option);
  }
});

describe('properties', () => {
  const words = fc.stringMatching(/^[a-z][a-z0-9._/-]{0,8}$/).filter((w) => w !== 'cache');

  it('never throws on any argv: a request or a usage error', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string(), fc.constantFrom('-o', '-d', '--', 'cache', '-a', '--tag-alias')), {
          maxLength: 8,
        }),
        (argv) => {
          const parsed = parseCliArgs(argv);
          expect(typeof parsed.ok).toBe('boolean');
        },
      ),
    );
  });

  it('builds any sources after --, in order', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 6 }), (sources) => {
        expect(build(['--', ...sources]).sources).toEqual(sources);
      }),
    );
  });

  it('builds any plain words as sources, a first word "cache" aside', () => {
    fc.assert(
      fc.property(fc.array(words, { minLength: 1, maxLength: 5 }), (sources) => {
        expect(build(sources).sources).toEqual(sources);
      }),
    );
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INPUT_FAILURES, INPUT_POLICY, failureOfError, inputProblem, problemDiagnostic } from '../src/input-policy.js';
import type { InputDiscovery, InputFailure, InputRole, PolicyLevel } from '../src/input-policy.js';
import { compile, TweeTsError } from '../src/compiler.js';
import { loadConfigFile } from '../src/config.js';
import { decodeText, TextDecodeError } from '../src/util.js';
import { identify } from '../src/path-identity.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

const ROLES: readonly InputRole[] = ['source', 'module', 'head', 'config'];
const DISCOVERIES: readonly InputDiscovery[] = ['named', 'found'];
/** What each role's messages say about it; a source is named by its path alone, as in Tweego. */
const ROLE_WORDS: Readonly<Record<InputRole, string>> = {
  source: '',
  module: 'module ',
  head: 'head file ',
  config: 'config file ',
};

describe('the input policy table', () => {
  // Generated from the table the code uses, so a new role or failure kind can't go untested.
  for (const role of ROLES) {
    for (const discovery of DISCOVERIES) {
      for (const failure of INPUT_FAILURES) {
        const level: PolicyLevel = INPUT_POLICY[role][discovery][failure];
        it(`${role} (${discovery}) × ${failure} → ${level}, with a message naming role, path and cause`, () => {
          const cause = Object.assign(new Error('ECAUSE: the cause'), { code: 'ECAUSE' });
          const problem = inputProblem(role, discovery, failure, 'dir/file.tw', cause);
          expect(problem.level).toBe(level);
          expect(problem.message).toMatch(/^(?:load |(?:module )?path )/);
          expect(problem.message).toContain('dir/file.tw: ');
          expect(problem.message).toContain(ROLE_WORDS[role]);
          const fromCause = ['missing', 'unreadable', 'unreadable-folder', 'undecodable', 'directory'].includes(
            failure,
          );
          expect(problem.reason === 'ECAUSE: the cause').toBe(fromCause);
          expect(problem.cause).toBe(cause);
          const reported = level === 'warning' || level === 'error';
          expect(problemDiagnostic(problem)).toEqual(
            reported ? { level, message: problem.message, file: 'dir/file.tw' } : undefined,
          );
        });
      }
    }
  }

  it('mirrors Tweego where Tweego decides', () => {
    // Tweego's getFilenames warns about a path it can't walk; its walk skips links (Lstat) and unknown types.
    expect(INPUT_POLICY.source.named.missing).toBe('warning');
    expect(INPUT_POLICY.source.found['dangling-link']).toBe('ignore');
    expect(INPUT_POLICY.source.found['unsupported-type']).toBe('ignore');
    // Tweego's modifyHead stops on a head file it can't read (FS-05).
    for (const failure of ['missing', 'unreadable', 'directory', 'dangling-link', 'undecodable'] as const) {
      expect(INPUT_POLICY.head.named[failure]).toBe('fatal');
    }
    // A file named directly that would be skipped says so (FS-17).
    expect(INPUT_POLICY.source.named['unsupported-type']).toBe('warning');
    expect(INPUT_POLICY.config.found.missing).toBe('ignore');
  });

  it('describes failures without an error by themselves', () => {
    expect(inputProblem('source', 'named', 'dangling-link', 'a.tw', 'target.tw').reason).toBe(
      'Symbolic link to a missing target (target.tw).',
    );
    expect(inputProblem('source', 'named', 'dangling-link', 'a.tw', undefined).reason).toBe(
      'Symbolic link to a missing target.',
    );
    expect(inputProblem('source', 'named', 'unsupported-type', 'story.twe', undefined).reason).toBe(
      'Not a supported source file type (extension .twe); skipped.',
    );
    expect(inputProblem('module', 'named', 'unsupported-type', 'dir.d/README', undefined).reason).toBe(
      'Not a supported module file type (extension (none)); skipped.',
    );
    expect(inputProblem('source', 'named', 'not-a-file', 'fifo.tw', undefined).reason).toBe(
      'Not a regular file; skipped.',
    );
    expect(inputProblem('head', 'named', 'directory', 'h', undefined).reason).toBe('Is a folder, not a file.');
    expect(inputProblem('source', 'named', 'missing', 'a.tw', 'gone').reason).toBe('gone');
    // The `read <file>: ` prefix of a decoding error is not repeated.
    expect(inputProblem('source', 'named', 'undecodable', 'a.tw', new TextDecodeError('read a.tw: Bad.')).reason).toBe(
      'Bad.',
    );
  });

  it('classifies thrown errors', () => {
    const coded = (code: string): Error => Object.assign(new Error(code), { code });
    expect(failureOfError(coded('ENOENT'))).toBe<InputFailure>('missing');
    expect(failureOfError(coded('ENOTDIR'))).toBe<InputFailure>('missing');
    expect(failureOfError(coded('EISDIR'))).toBe<InputFailure>('directory');
    expect(failureOfError(coded('EACCES'))).toBe<InputFailure>('unreadable');
    expect(failureOfError(new TextDecodeError('x'))).toBe<InputFailure>('undecodable');
    expect(failureOfError('a string')).toBe<InputFailure>('unreadable');
  });
});

describe('the input policy applied', () => {
  let dir: string;
  const options = { formatId: 'test-format-1', formatPaths: [FORMAT_DIR], useTweegoPath: false, noRemote: true };
  const story = join(FIXTURES_DIR, 'minimal.tw');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-policy-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the head file is fatal for every failure, as in Tweego (FS-05)', () => {
    const cases: readonly [string, (path: string) => void, RegExp][] = [
      ['missing', () => {}, /^load head file .*nope\.html: ENOENT/],
      [
        'a folder',
        (path) => {
          mkdirSync(path);
        },
        /^load head file .*nope\.html: EISDIR/,
      ],
      [
        'a dangling link',
        (path) => {
          symlinkSync('gone.html', path);
        },
        /^load head file .*nope\.html: Symbolic link/,
      ],
      [
        'invalid UTF-16',
        (path) => {
          writeFileSync(path, Buffer.from([0xff, 0xfe, 0x41]));
        },
        /Invalid UTF-16LE/,
      ],
    ];
    for (const [what, make, message] of cases) {
      it(`a head file that is ${what}`, async () => {
        const head = join(dir, 'nope.html');
        make(head);
        const build = compile({ ...options, sources: [story], headFile: head });
        await expect(build).rejects.toThrow(message);
        await expect(build).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
      });
    }

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable head file', async () => {
      const head = join(dir, 'h.html');
      writeFileSync(head, '<meta>');
      chmodSync(head, 0o000);
      await expect(compile({ ...options, sources: [story], headFile: head })).rejects.toThrow(
        /^load head file .*h\.html: EACCES/,
      );
    });

    it('is only read for HTML output', async () => {
      const result = await compile({ ...options, sources: [story], outputMode: 'twee3', headFile: join(dir, 'x') });
      expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    });
  });

  describe('modules', () => {
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'an unreadable module is an error naming it, not a bare exception (FS-05)',
      async () => {
        const module = join(dir, 'secret.js');
        writeFileSync(module, 'x');
        chmodSync(module, 0o000);
        const result = await compile({ ...options, sources: [story], modules: [module] });
        expect(result.diagnostics).toContainEqual({
          level: 'error',
          message: expect.stringMatching(/^load module .*secret\.js: EACCES/),
          file: identify(module).display,
        });
      },
    );

    it('a module named directly of a type modules do not load is a warning; one in a folder is skipped', async () => {
      const named = join(dir, 'notes.tw');
      writeFileSync(named, ':: X\n');
      mkdirSync(join(dir, 'mods'));
      writeFileSync(join(dir, 'mods', 'a.js'), 'window.a = 1;');
      writeFileSync(join(dir, 'mods', 'readme.txt'), 'hi');
      const result = await compile({ ...options, sources: [story], modules: [named, join(dir, 'mods')] });
      const shown = identify(named).display;
      expect(result.diagnostics).toEqual([
        {
          level: 'warning',
          message: `load module ${shown}: Not a supported module file type (extension .tw); skipped.`,
          file: shown,
        },
      ]);
      expect(result.output).toContain('window.a = 1;');
      expect(result.stats.externalFiles).toEqual(
        [named, join(dir, 'mods', 'a.js'), join(dir, 'mods', 'readme.txt')].map((p) => identify(p).display),
      );
    });

    it('loads a module named twice once', async () => {
      const module = join(dir, 'a.css');
      writeFileSync(module, 'body{}');
      const result = await compile({ ...options, sources: [story], modules: [module, join(dir, '.', 'a.css')] });
      expect(result.output.split('body{}')).toHaveLength(2);
    });
  });

  describe('sources', () => {
    it('a source named directly of an unsupported type is a warning (FS-17)', async () => {
      const twe = join(dir, 'story.twe');
      writeFileSync(twe, ':: Start\nx\n');
      const result = await compile({ ...options, sources: [story, twe] });
      const shown = identify(twe).display;
      expect(result.diagnostics).toContainEqual({
        level: 'warning',
        message: `load ${shown}: Not a supported source file type (extension .twe); skipped.`,
        file: shown,
      });
    });

    it('one of an unsupported type found in a folder is skipped without a word', async () => {
      writeFileSync(join(dir, 'a.tw'), ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nx\n');
      writeFileSync(join(dir, 'notes.txt'), 'x');
      const result = await compile({ ...options, sources: [dir], outputMode: 'twee3' });
      expect(result.diagnostics).toEqual([]);
    });

    it('an editor lock link in a source folder gives no warning on any build (FS-15)', async () => {
      writeFileSync(join(dir, 'a.tw'), ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nx\n');
      symlinkSync('user@host.1234:1700000000', join(dir, '.#a.tw'));
      const result = await compile({ ...options, sources: [dir], outputMode: 'twee3' });
      expect(result.diagnostics).toEqual([]);
    });

    // Windows has no device path that stat() can see.
    it.skipIf(process.platform === 'win32')('a named FIFO or device is skipped with a warning', async () => {
      const result = await compile({ ...options, sources: [story, '/dev/null'] });
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ level: 'warning', message: expect.stringMatching(/Not a regular file; skipped\./) }),
      );
    });

    it('"-" (standard input) is not supported, as in Tweego', async () => {
      const result = await compile({ ...options, sources: [story, '-'] });
      expect(result.diagnostics).toContainEqual({
        level: 'warning',
        message: 'path -: Reading from standard input is unsupported.',
      });
    });

    it('the same file named in two spellings is loaded once', async () => {
      symlinkSync(story, join(dir, 'alias.tw'));
      const result = await compile({ ...options, sources: [story, join(dir, 'alias.tw')] });
      expect(result.stats.files).toHaveLength(1);
      expect(result.diagnostics).toContainEqual({
        level: 'warning',
        message: expect.stringMatching(/minimal\.tw: Skipping duplicate/),
      });
    });
  });

  describe('the config file', () => {
    it('a named config file that is missing, a folder or undecodable is fatal, naming it', () => {
      const missing = join(dir, 'nope.json');
      expect(() => loadConfigFile(missing)).toThrow(TweeTsError);
      expect(() => loadConfigFile(missing)).toThrow(`Cannot read config file ${missing}: ENOENT`);
      expect(() => loadConfigFile(dir)).toThrow(`Cannot read config file ${dir}: EISDIR`);
      const utf32 = join(dir, 'c.json');
      writeFileSync(utf32, Buffer.from([0xff, 0xfe, 0, 0, 0x7b, 0, 0, 0]));
      expect(() => loadConfigFile(utf32)).toThrow(/UTF-32 text is not supported/);
    });
  });
});

describe('text decoding (FS-18)', () => {
  const utf16le = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const utf16be = (text: string): Buffer => {
    const le = Buffer.from(text, 'utf16le');
    return Buffer.concat([Buffer.from([0xfe, 0xff]), le.swap16()]);
  };

  it('decodes UTF-16 after its byte order mark, little- and big-endian, keeping the mark', () => {
    for (const encode of [utf16le, utf16be]) {
      expect(decodeText(encode(':: Start\r\nCafé 😀'), 'a.tw')).toEqual({
        text: '﻿:: Start\r\nCafé 😀',
        diagnostics: [],
      });
    }
  });

  it('rejects invalid UTF-16 and UTF-32, naming the file', () => {
    expect(() => decodeText(Buffer.from([0xff, 0xfe, 0x41]), 'odd.tw')).toThrow(
      'read odd.tw: Invalid UTF-16LE: an odd number of bytes.',
    );
    expect(() => decodeText(Buffer.from([0xfe, 0xff, 0xd8, 0x00]), 'lone.tw')).toThrow(
      'read lone.tw: Invalid UTF-16BE: an unpaired surrogate.',
    );
    expect(() => decodeText(Buffer.from([0x00, 0x00, 0xfe, 0xff]), 'x.tw')).toThrow(TextDecodeError);
  });

  it('compiles a UTF-16 source and reads a UTF-16 config, as PowerShell 5 writes them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-ts-utf16-'));
    try {
      const source = join(dir, 'a.tw');
      writeFileSync(
        source,
        utf16le(':: StoryData\r\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\r\n\r\n:: Start\r\nCafé\r\n'),
      );
      const result = await compile({ sources: [source], outputMode: 'twee3' });
      expect(result.diagnostics).toEqual([]);
      expect(result.output).toContain(':: Start\nCafé\n');
      const config = join(dir, 'c.json');
      writeFileSync(config, utf16be('{"outputMode":"json"}'));
      expect(loadConfigFile(config)).toEqual({ outputMode: 'json' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an undecodable source as an error and an undecodable in-memory source too', async () => {
    const result = await compile({
      sources: [{ filename: 'bad.tw', content: Buffer.from([0xff, 0xfe, 0x41]) }],
      outputMode: 'twee3',
    });
    expect(result.diagnostics).toContainEqual({
      level: 'error',
      message: 'load bad.tw: Invalid UTF-16LE: an odd number of bytes.',
      file: 'bad.tw',
    });
  });
});

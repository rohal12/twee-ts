import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSystemErrorMap } from 'node:util';
import { checkWritable, writeFileAtomic } from '../src/atomic-write.js';
import type * as NodeFs from 'node:fs';

// writeFileSync and renameSync pass through to the real ones unless a test makes them fail.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});

const { writeFileSync: realWriteFileSync, renameSync: realRenameSync } =
  await vi.importActual<typeof NodeFs>('node:fs');
import { textOf } from './helpers/text.js';
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
const mockedRenameSync = vi.mocked(fs.renameSync);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-atomic-'));
});

afterEach(() => {
  mockedWriteFileSync.mockReset();
  mockedWriteFileSync.mockImplementation(realWriteFileSync);
  mockedRenameSync.mockReset();
  mockedRenameSync.mockImplementation(realRenameSync);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Makes the next write go wrong after part of `data` reached the file, as a full disk would.
 * `during` runs at that moment, while the partial file is on disk.
 */
function failNextWritePartWay(during: () => void = () => {}): void {
  mockedWriteFileSync.mockImplementationOnce((file, data) => {
    realWriteFileSync(file, textOf(data).slice(0, 10));
    during();
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  });
}

describe('writeFileAtomic failures', () => {
  it('wraps a thrown value that is not an Error, without a code', () => {
    const path = join(dir, 'out.html');
    mockedWriteFileSync.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test: a thrown value that is not an Error.
      throw 'boom';
    });
    let thrown: unknown;
    try {
      writeFileAtomic(path, 'x');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(`Cannot write ${path}: boom`);
    expect(thrown).not.toHaveProperty('code');
  });

  it('wraps an Error that has no code, without inventing one', () => {
    const path = join(dir, 'out.html');
    mockedWriteFileSync.mockImplementationOnce(() => {
      throw new Error('disk on fire');
    });
    expect(() => {
      writeFileAtomic(path, 'x');
    }).toThrow(`Cannot write ${path}: disk on fire`);
  });
});

describe('writeFileAtomic', () => {
  it('creates a file that did not exist', () => {
    const path = join(dir, 'out.html');
    writeFileAtomic(path, '<html>new</html>');
    expect(readFileSync(path, 'utf-8')).toBe('<html>new</html>');
    expect(readdirSync(dir)).toEqual(['out.html']);
  });

  it('replaces an existing file and leaves no temporary file behind', () => {
    const path = join(dir, 'out.html');
    writeFileSync(path, '<html>old</html>');
    writeFileAtomic(path, '<html>new</html>');
    expect(readFileSync(path, 'utf-8')).toBe('<html>new</html>');
    expect(readdirSync(dir)).toEqual(['out.html']);
  });

  it('never shows a reader a partial file while it writes', () => {
    const path = join(dir, 'out.html');
    const old = `<html>${'old '.repeat(1000)}</html>`;
    writeFileSync(path, old);
    const seen: string[] = [];
    mockedWriteFileSync.mockImplementationOnce((file, data) => {
      realWriteFileSync(file, textOf(data).slice(0, 10));
      seen.push(readFileSync(path, 'utf-8')); // a reader in the middle of the write
      realWriteFileSync(file, data);
    });
    writeFileAtomic(path, `<html>${'new '.repeat(1000)}</html>`);
    expect(seen).toEqual([old]);
    expect(readFileSync(path, 'utf-8')).toBe(`<html>${'new '.repeat(1000)}</html>`);
  });

  it('leaves the previous file unchanged and removes its temporary file when a write fails part way', () => {
    const path = join(dir, 'out.html');
    writeFileSync(path, '<html>last good build</html>');
    const seen: string[] = [];
    failNextWritePartWay(() => seen.push(readFileSync(path, 'utf-8')));
    expect(() => {
      writeFileAtomic(path, '<html>next build</html>');
    }).toThrow(/out\.html.*ENOSPC/);
    expect(seen).toEqual(['<html>last good build</html>']);
    expect(readFileSync(path, 'utf-8')).toBe('<html>last good build</html>');
    expect(readdirSync(dir)).toEqual(['out.html']);
  });

  it('keeps the error code and the original error as the cause', () => {
    failNextWritePartWay();
    let caught: unknown;
    try {
      writeFileAtomic(join(dir, 'out.html'), 'x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { code?: string }).code).toBe('ENOSPC');
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });

  it('names the destination when its folder does not exist', () => {
    const path = join(dir, 'missing', 'out.html');
    expect(() => {
      writeFileAtomic(path, 'x');
    }).toThrow(path);
  });

  it.skipIf(process.platform === 'win32')('keeps the permissions of the file it replaces', () => {
    const path = join(dir, 'out.html');
    writeFileSync(path, 'old');
    chmodSync(path, 0o640);
    writeFileAtomic(path, 'new');
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32')('writes through a symlink to the file it points to', () => {
    const target = join(dir, 'real.html');
    const link = join(dir, 'link.html');
    writeFileSync(target, 'old');
    symlinkSync(target, link);
    writeFileAtomic(link, 'new');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('new');
    expect(readdirSync(dir).sort()).toEqual(['link.html', 'real.html']);
  });

  describe.skipIf(process.platform === 'win32')('dangling symlinks', () => {
    const entries = () => readdirSync(dir).sort();

    it('creates the target of an absolute dangling link and keeps the link', () => {
      const target = join(dir, 'served.html');
      const link = join(dir, 'link.html');
      symlinkSync(target, link);
      writeFileAtomic(link, 'new');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf-8')).toBe('new');
      expect(entries()).toEqual(['link.html', 'served.html']);
    });

    it('creates the target of a relative dangling link and keeps the link', () => {
      const link = join(dir, 'link.html');
      symlinkSync('served.html', link);
      writeFileAtomic(link, 'new');
      expect(fs.readlinkSync(link)).toBe('served.html');
      expect(readFileSync(join(dir, 'served.html'), 'utf-8')).toBe('new');
      expect(entries()).toEqual(['link.html', 'served.html']);
    });

    it('follows a chain of links to the final missing target', () => {
      fs.mkdirSync(join(dir, 'deploy'));
      symlinkSync(join('deploy', 'final.html'), join(dir, 'b.html'));
      symlinkSync('b.html', join(dir, 'a.html'));
      writeFileAtomic(join(dir, 'a.html'), 'new');
      expect(fs.lstatSync(join(dir, 'a.html')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(join(dir, 'b.html')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(dir, 'deploy', 'final.html'), 'utf-8')).toBe('new');
      expect(entries()).toEqual(['a.html', 'b.html', 'deploy']);
    });

    it('fails and keeps the link when the target folder is missing', () => {
      const link = join(dir, 'link.html');
      symlinkSync(join('missing', 'served.html'), link);
      expect(() => {
        writeFileAtomic(link, 'new');
      }).toThrow(link);
      expect(fs.readlinkSync(link)).toBe(join('missing', 'served.html'));
      expect(entries()).toEqual(['link.html']);
    });

    it('fails and keeps both links of a cycle', () => {
      symlinkSync('b.html', join(dir, 'a.html'));
      symlinkSync('a.html', join(dir, 'b.html'));
      expect(() => {
        writeFileAtomic(join(dir, 'a.html'), 'new');
      }).toThrow(/a\.html/);
      expect(fs.readlinkSync(join(dir, 'a.html'))).toBe('b.html');
      expect(fs.readlinkSync(join(dir, 'b.html'))).toBe('a.html');
      expect(entries()).toEqual(['a.html', 'b.html']);
    });
  });
});

/** A system error as Node throws it, naming `path` (the temporary file, say) in its message. */
function systemError(code: string, syscall: string, path: string): Error {
  // The platform's own number for the code (libuv's, which differ between POSIX and Windows).
  const errno = [...getSystemErrorMap()].find(([, [name]]) => name === code)?.[0];
  return Object.assign(new Error(`${code}: refused, ${syscall} '${path}'`), { code, errno, syscall, path });
}

const POSIX_USER = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('a folder that takes no temporary file or rename (#383)', () => {
  const refusals = ['EACCES', 'EPERM', 'EBUSY'] as const;
  const steps = [
    ['creating the temporary file', 'temp'],
    ['the rename', 'rename'],
  ] as const;
  const refuse = (step: 'temp' | 'rename', code: string): void => {
    if (step === 'temp') {
      mockedWriteFileSync.mockImplementationOnce((file) => {
        throw systemError(code, 'open', String(file));
      });
    } else {
      // Every attempt, so that the retries on Windows fail too.
      mockedRenameSync.mockImplementation((from) => {
        throw systemError(code, 'rename', String(from));
      });
    }
  };

  describe.each(steps)('when %s fails', (_label, step) => {
    it.each(refusals)('writes an existing writable file in place on %s', (code) => {
      const path = join(dir, 'out.html');
      writeFileSync(path, 'old');
      refuse(step, code);
      writeFileAtomic(path, 'new');
      expect(readFileSync(path, 'utf-8')).toBe('new');
      expect(readdirSync(dir)).toEqual(['out.html']);
    });

    it.each(refusals)('keeps the error on %s when there is no file to write in place', (code) => {
      const path = join(dir, 'out.html');
      refuse(step, code);
      expect(() => {
        writeFileAtomic(path, 'new');
      }).toThrow(expect.objectContaining({ code, message: expect.not.stringContaining('.tmp') }));
      expect(readdirSync(dir)).toEqual([]);
    });

    it('keeps any other error, and the previous file', () => {
      const path = join(dir, 'out.html');
      writeFileSync(path, 'old');
      refuse(step, 'ENOSPC');
      expect(() => {
        writeFileAtomic(path, 'new');
      }).toThrow(expect.objectContaining({ code: 'ENOSPC' }));
      expect(readFileSync(path, 'utf-8')).toBe('old');
      expect(readdirSync(dir)).toEqual(['out.html']);
    });
  });

  describe.skipIf(!POSIX_USER)('in a read-only folder', () => {
    let folder: string;
    beforeEach(() => {
      folder = join(dir, 'out');
      fs.mkdirSync(folder);
    });
    afterEach(() => {
      chmodSync(folder, 0o755);
    });

    it('rebuilds a writable file, keeping its permissions, as Tweego does', () => {
      const path = join(folder, 'story.html');
      writeFileSync(path, 'old');
      chmodSync(path, 0o640);
      chmodSync(folder, 0o555);
      expect(() => {
        checkWritable(path);
      }).not.toThrow();
      writeFileAtomic(path, 'new');
      expect(readFileSync(path, 'utf-8')).toBe('new');
      expect(statSync(path).mode & 0o777).toBe(0o640);
      expect(readdirSync(folder)).toEqual(['story.html']);
    });

    it('refuses a read-only file there', () => {
      const path = join(folder, 'story.html');
      writeFileSync(path, 'old');
      chmodSync(path, 0o444);
      chmodSync(folder, 0o555);
      expect(() => {
        writeFileAtomic(path, 'new');
      }).toThrow(expect.objectContaining({ code: 'EACCES' }));
      expect(readFileSync(path, 'utf-8')).toBe('old');
    });

    it('refuses a new file there, naming the output and not the temporary file', () => {
      const path = join(folder, 'story.html');
      chmodSync(folder, 0o555);
      expect(() => {
        writeFileAtomic(path, 'new');
      }).toThrow(`Cannot write ${path}: EACCES: permission denied`);
      expect(readdirSync(folder)).toEqual([]);
    });
  });
});

describe('write errors name the output path given (#388)', () => {
  it('names the output, not the temporary file, for a system error', () => {
    const path = join(dir, 'out.html');
    mockedWriteFileSync.mockImplementationOnce((file) => {
      throw systemError('ENOSPC', 'write', String(file));
    });
    expect(() => {
      writeFileAtomic(path, 'x');
    }).toThrow(`Cannot write ${path}: ENOSPC: no space left on device`);
  });

  it.each([
    ['a missing folder', (d: string) => join(d, 'missing', 'out.html'), 'ENOENT', 'does not exist'],
    [
      'a file as the folder',
      (d: string) => join(d, 'file', 'out.html'),
      '(ENOTDIR|ENOENT)',
      '(ENOTDIR: not a directory|does not exist)',
    ],
    ['a folder as the output', (d: string) => d, 'EISDIR', 'the output is a folder'],
  ])('checks %s before anything is written', (_case, pathIn, code, reason) => {
    writeFileSync(join(dir, 'file'), '');
    const path = pathIn(dir);
    expect(() => {
      checkWritable(path);
    }).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(new RegExp(`^${code}$`)),
        message: expect.stringMatching(new RegExp(`^Cannot write .*${reason}`)),
      }),
    );
    expect(() => {
      writeFileAtomic(path, 'x');
    }).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(new RegExp(`^${code}$`)),
        message: expect.stringContaining(`Cannot write ${path}: `),
      }),
    );
  });

  it('passes a path that can be written, and a stream', () => {
    expect(() => {
      checkWritable(join(dir, 'new.html'));
      checkWritable('/dev/stdout', 'linux');
    }).not.toThrow();
  });
});

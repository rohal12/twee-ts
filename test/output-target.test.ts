/**
 * The output-target matrix (FS-03): how writeFileAtomic writes depends on what is at the path, and every
 * target kind gets the behaviour Tweego's `os.Create` gives it, or a clear error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  openSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isOwnOutput,
  isStreamPath,
  ownDescriptor,
  renameWithRetry,
  strategyFor,
  writeFileAtomic,
  writeToDescriptor,
} from '../src/atomic-write.js';

const POSIX = process.platform !== 'win32';
const ROOT = resolve(import.meta.dirname, '..');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-target-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** What `fn` threw: its message and its Node-style code. */
const errorOf = (fn: () => void): { readonly message: string; readonly code: unknown } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return { message: e.message, code: 'code' in e ? e.code : undefined };
  }
  throw new Error('expected an Error to be thrown');
};

describe('regular files', () => {
  it('creates a missing file', () => {
    writeFileAtomic(join(dir, 'new.html'), 'built');
    expect(readFileSync(join(dir, 'new.html'), 'utf-8')).toBe('built');
  });

  it('replaces a file with one link atomically (a new inode), keeping its permissions', () => {
    const out = join(dir, 'out.html');
    writeFileSync(out, 'old');
    if (POSIX) chmodSync(out, 0o640);
    const before = statSync(out);
    writeFileAtomic(out, 'new');
    const after = statSync(out);
    expect(readFileSync(out, 'utf-8')).toBe('new');
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(POSIX ? 0o640 : before.mode & 0o777);
  });

  it('writes a hard-linked file in place, so every link sees the new build', () => {
    const out = join(dir, 'out.html');
    const other = join(dir, 'other.html');
    writeFileSync(out, 'old');
    linkSync(out, other);
    const before = statSync(out);
    writeFileAtomic(out, 'new');
    expect(readFileSync(other, 'utf-8')).toBe('new');
    expect(statSync(out).ino).toBe(before.ino);
    expect(statSync(out).nlink).toBe(2);
  });

  it.skipIf(!POSIX || process.getuid?.() === 0)('refuses a read-only file, as Tweego does, and leaves it', () => {
    const out = join(dir, 'ro.html');
    writeFileSync(out, 'old');
    chmodSync(out, 0o444);
    const error = errorOf(() => {
      writeFileAtomic(out, 'new');
    });
    expect(error.code).toBe('EACCES');
    expect(error.message).toBe(`Cannot write ${out}: EACCES: the output file is read-only`);
    expect(readFileSync(out, 'utf-8')).toBe('old');
  });

  it('refuses a folder', () => {
    const error = errorOf(() => {
      writeFileAtomic(dir, 'x');
    });
    expect(error.code).toBe('EISDIR');
  });

  it('remembers what it wrote until something else changes it', () => {
    const out = join(dir, 'mine.html');
    writeFileAtomic(out, 'built');
    expect(isOwnOutput(out)).toBe(true);
    writeFileSync(out, 'edited by hand, and longer');
    expect(isOwnOutput(out)).toBe(false);
    expect(isOwnOutput(join(dir, 'never-written'))).toBe(false);
  });
});

describe.skipIf(!POSIX)('links', () => {
  it('writes through a link to its target and keeps the link', () => {
    writeFileSync(join(dir, 'target.html'), 'old');
    symlinkSync('target.html', join(dir, 'link.html'));
    writeFileAtomic(join(dir, 'link.html'), 'new');
    expect(readFileSync(join(dir, 'target.html'), 'utf-8')).toBe('new');
    expect(statSync(join(dir, 'link.html')).isFile()).toBe(true);
  });

  it('creates the target of a relative dangling link held in a linked folder, where the OS would', () => {
    // alias → real/sub; real/sub/out.html → ../build.html, which is real/build.html.
    mkdirSync(join(dir, 'real', 'sub'), { recursive: true });
    symlinkSync(join(dir, 'real', 'sub'), join(dir, 'alias'));
    symlinkSync(join('..', 'build.html'), join(dir, 'real', 'sub', 'out.html'));
    writeFileAtomic(join(dir, 'alias', 'out.html'), 'built');
    expect(readFileSync(join(dir, 'real', 'build.html'), 'utf-8')).toBe('built');
  });

  it('fails on a cycle of links', () => {
    symlinkSync('b', join(dir, 'a'));
    symlinkSync('a', join(dir, 'b'));
    expect(
      errorOf(() => {
        writeFileAtomic(join(dir, 'a'), 'x');
      }).code,
    ).toBe('ELOOP');
  });
});

describe.skipIf(!POSIX)('streams and devices', () => {
  it('writes /dev/null without replacing it', () => {
    expect(() => {
      writeFileAtomic('/dev/null', 'discarded');
    }).not.toThrow();
    expect(statSync('/dev/null').isCharacterDevice()).toBe(true);
  });

  it('writes through a FIFO to its reader, and the FIFO stays one', async () => {
    const fifo = join(dir, 'f.pipe');
    if (spawnSync('mkfifo', [fifo]).status !== 0) return;
    const reader = spawn('cat', [fifo]);
    let received = '';
    reader.stdout.on('data', (chunk: Buffer) => (received += chunk.toString()));
    const done = new Promise<void>((resolveDone) => {
      reader.on('close', () => {
        resolveDone();
      });
    });
    writeFileAtomic(fifo, 'through the pipe');
    await done;
    expect(received).toBe('through the pipe');
    expect(statSync(fifo).isFIFO()).toBe(true);
  });

  it('writes /dev/stdout to the process standard output, a pipe', () => {
    const loader = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const module = pathToFileURL(join(ROOT, 'src', 'atomic-write.ts')).href;
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        loader,
        '-e',
        `import(${JSON.stringify(module)}).then((m) => m.writeFileAtomic('/dev/stdout', 'to stdout'))`,
      ],
      { encoding: 'utf-8' },
    );
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('to stdout');
  });

  it('refuses a socket', async () => {
    const socket = join(dir, 's.sock');
    const server = createServer();
    await new Promise<void>((done) => server.listen(socket, done));
    try {
      expect(
        errorOf(() => {
          writeFileAtomic(socket, 'x');
        }).code,
      ).toBe('EINVAL');
    } finally {
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
    }
  });
});

describe('how a target is classified', () => {
  it('names the stream paths of every platform', () => {
    for (const path of ['/dev/stdout', '/dev/stderr', '/dev/fd/1', '/proc/self/fd/3', '/proc/123/fd/0']) {
      expect(isStreamPath(path, 'linux'), path).toBe(true);
    }
    for (const path of ['/dev/null', '/dev/shm/out.html', 'out.html', '/proc/self/status']) {
      expect(isStreamPath(path, 'linux'), path).toBe(false);
    }
    for (const path of ['NUL', 'nul', 'nul.txt', 'C:\\proj\\CON', 'COM1', 'lpt9.html', '\\\\.\\pipe\\x', 'conout$']) {
      expect(isStreamPath(path, 'win32'), path).toBe(true);
    }
    for (const path of ['null.tw', 'console.html', 'C:\\com10', 'out.html']) {
      expect(isStreamPath(path, 'win32'), path).toBe(false);
    }
  });

  it("writes the process's own descriptors directly", () => {
    expect(ownDescriptor('/dev/stdout')).toBe(1);
    expect(ownDescriptor('/dev/stderr')).toBe(2);
    expect(ownDescriptor('/dev/fd/7')).toBe(7);
    expect(ownDescriptor('/proc/self/fd/4')).toBe(4);
    expect(ownDescriptor('/proc/123/fd/4')).toBeUndefined();
    expect(ownDescriptor('out.html')).toBeUndefined();
  });

  it.skipIf(!POSIX)('writes /dev/fd/N to the open descriptor N', () => {
    const file = join(dir, 'fd.txt');
    const fd = openSync(file, 'w');
    try {
      writeFileAtomic(`/dev/fd/${fd}`, 'through the descriptor');
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file, 'utf-8')).toBe('through the descriptor');
  });

  it('writes a Windows device name through, without replacing anything', () => {
    // On another OS the name is an ordinary file, which shows the write went straight to it.
    const device = join(dir, 'NUL');
    writeFileAtomic(device, 'discarded', 'win32');
    expect(readFileSync(device, 'utf-8')).toBe('discarded');
  });

  it('waits while a non-blocking pipe is full, and writes the rest after a short write', () => {
    const written: string[] = [];
    let calls = 0;
    writeToDescriptor(9, 'abcdef', (fd, bytes, offset) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('EAGAIN: try again'), { code: 'EAGAIN' });
      const chunk = bytes.subarray(offset, offset + 4);
      written.push(`${fd}:${chunk.toString()}`);
      return chunk.length;
    });
    expect(written).toEqual(['9:abcd', '9:ef']);
    expect(() => {
      writeToDescriptor(9, 'x', () => {
        throw Object.assign(new Error('EBADF: bad descriptor'), { code: 'EBADF' });
      });
    }).toThrow('EBADF');
  });

  it('writes a missing target atomically', () => {
    expect(strategyFor(join(dir, 'missing'), undefined)).toBe('atomic');
  });
});

describe('renaming over a file another program holds open on Windows (U2)', () => {
  const busy = (code: string): Error => Object.assign(new Error(`${code}: busy`), { code });

  it('retries EPERM, EBUSY and EACCES with a growing pause', () => {
    const waits: number[] = [];
    let calls = 0;
    renameWithRetry(
      'a',
      'b',
      () => {
        calls++;
        if (calls <= 3) throw busy(['EPERM', 'EBUSY', 'EACCES'][calls - 1] ?? 'EPERM');
      },
      'win32',
      (ms) => waits.push(ms),
    );
    expect(calls).toBe(4);
    expect(waits).toEqual([10, 20, 40]);
  });

  it('gives up after about 0.6 s, throwing the last error', () => {
    const waits: number[] = [];
    expect(() => {
      renameWithRetry(
        'a',
        'b',
        () => {
          throw busy('EBUSY');
        },
        'win32',
        (ms) => waits.push(ms),
      );
    }).toThrow('EBUSY');
    expect(waits.reduce((a, b) => a + b, 0)).toBe(630);
  });

  it('does not retry another error, or on another platform', () => {
    let calls = 0;
    const fail = (): void => {
      calls++;
      throw busy('ENOSPC');
    };
    expect(() => {
      renameWithRetry('a', 'b', fail, 'win32', () => {});
    }).toThrow('ENOSPC');
    expect(() => {
      renameWithRetry(
        'a',
        'b',
        () => {
          calls++;
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test: a thrown value that is not an Error.
          throw 'not an error';
        },
        'win32',
        () => {},
      );
    }).toThrow('not an error');
    expect(() => {
      renameWithRetry(
        'a',
        'b',
        () => {
          calls++;
          throw busy('EBUSY');
        },
        'linux',
      );
    }).toThrow('EBUSY');
    expect(calls).toBe(3);
  });

  it('pauses for real by default', () => {
    let calls = 0;
    const started = Date.now();
    renameWithRetry(
      'a',
      'b',
      () => {
        calls++;
        if (calls === 1) throw busy('EBUSY');
      },
      'win32',
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });
});

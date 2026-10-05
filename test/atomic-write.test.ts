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
import { writeFileAtomic } from '../src/atomic-write.js';

// writeFileSync passes through to the real one unless a test makes it fail part way.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const realWriteFileSync = (await vi.importActual<typeof import('node:fs')>('node:fs')).writeFileSync;
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-atomic-'));
});

afterEach(() => {
  mockedWriteFileSync.mockReset();
  mockedWriteFileSync.mockImplementation(realWriteFileSync);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Makes the next write go wrong after part of `data` reached the file, as a full disk would.
 * `during` runs at that moment, while the partial file is on disk.
 */
function failNextWritePartWay(during: () => void = () => {}): void {
  mockedWriteFileSync.mockImplementationOnce((file, data) => {
    realWriteFileSync(file, String(data).slice(0, 10));
    during();
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  });
}

describe('writeFileAtomic failures', () => {
  it('wraps a thrown value that is not an Error, without a code', () => {
    const path = join(dir, 'out.html');
    mockedWriteFileSync.mockImplementationOnce(() => {
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
    expect(() => writeFileAtomic(path, 'x')).toThrow(`Cannot write ${path}: disk on fire`);
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
      realWriteFileSync(file, String(data).slice(0, 10));
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
    expect(() => writeFileAtomic(path, '<html>next build</html>')).toThrow(/out\.html.*ENOSPC/);
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
    expect(() => writeFileAtomic(path, 'x')).toThrow(path);
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
      expect(() => writeFileAtomic(link, 'new')).toThrow(link);
      expect(fs.readlinkSync(link)).toBe(join('missing', 'served.html'));
      expect(entries()).toEqual(['link.html']);
    });

    it('fails and keeps both links of a cycle', () => {
      symlinkSync('b.html', join(dir, 'a.html'));
      symlinkSync('a.html', join(dir, 'b.html'));
      expect(() => writeFileAtomic(join(dir, 'a.html'), 'new')).toThrow(/a\.html/);
      expect(fs.readlinkSync(join(dir, 'a.html'))).toBe('b.html');
      expect(fs.readlinkSync(join(dir, 'b.html'))).toBe('a.html');
      expect(entries()).toEqual(['a.html', 'b.html']);
    });
  });
});

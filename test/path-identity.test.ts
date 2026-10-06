import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { join, posix, win32 } from 'node:path';
import {
  clearPathIdentityCache,
  createPathIdentifier,
  flipCase,
  foldCase,
  identify,
  isKeyInside,
  isSameOrInside,
  lowerGlobExtension,
  matchesExclude,
  nodeIdentityFileSystem,
  type PathFlavour,
  normalizeWindowsPath,
  sameFile,
} from '../src/path-identity.js';
import { FakeIdentityFs } from './helpers/fake-identity-fs.js';

let dir: string;

beforeEach(() => {
  // The real path, so expectations don't depend on whether the temporary folder is reached through
  // a link (macOS: /var is /private/var).
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-identity-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Whether the temporary folder's volume compares names without case, found the way a user would. */
function tmpIsCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'twee-ts-case-'));
  try {
    writeFileSync(join(probe, 'Probe.txt'), '');
    return existsSync(join(probe, 'PROBE.TXT'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE_TMP = tmpIsCaseInsensitive();

/** A symlink to a folder; Windows needs the type (a junction needs no privilege, but an absolute target). */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, 'junction');
}

/** An identifier on the real file system with a fixed working directory. */
const realAt = (cwd: string) => createPathIdentifier({ cwd: () => cwd });

describe('canonical identity on the real file system', () => {
  it('gives a plain file its real path and a display relative to the working directory', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.tw'), '');
    const id = realAt(dir).identify('src/a.tw');
    expect(id).toMatchObject({
      authored: 'src/a.tw',
      absolute: join(dir, 'src', 'a.tw'),
      canonical: join(dir, 'src', 'a.tw'),
      display: join('src', 'a.tw'),
      caseInsensitive: CASE_INSENSITIVE_TMP,
    });
    expect(id.key).toBe(CASE_INSENSITIVE_TMP ? foldCase(id.canonical) : id.canonical);
  });

  it('gives a file reached through a symlinked root folder the identity of its target', () => {
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'a.tw'), '');
    linkDir(join(dir, 'real'), join(dir, 'alias'));
    const ids = realAt(dir);
    const viaLink = ids.identify(join(dir, 'alias', 'a.tw'));
    expect(viaLink.canonical).toBe(join(dir, 'real', 'a.tw'));
    expect(viaLink.key).toBe(ids.identify('real/a.tw').key);
    expect(viaLink.display).toBe(join('alias', 'a.tw'));
    expect(ids.sameFile('alias/a.tw', 'real/a.tw')).toBe(true);
    expect(ids.isSameOrInside('alias/a.tw', 'real')).toBe(true);
    expect(ids.isSameOrInside('real', 'alias/a.tw')).toBe(false);
  });

  it('follows a dangling link to where its target would be created', () => {
    symlinkSync(join(dir, 'build', 'out.html'), join(dir, 'abs-link.html'));
    symlinkSync(join('build', 'rel.html'), join(dir, 'rel-link.html'));
    // A chain: link → link → missing.
    symlinkSync(join(dir, 'abs-link.html'), join(dir, 'chain.html'));
    const ids = realAt(dir);
    expect(ids.identify('abs-link.html').canonical).toBe(join(dir, 'build', 'out.html'));
    expect(ids.identify('rel-link.html').canonical).toBe(join(dir, 'build', 'rel.html'));
    expect(ids.identify('chain.html').canonical).toBe(join(dir, 'build', 'out.html'));
    expect(ids.sameFile('chain.html', 'build/out.html')).toBe(true);
  });

  it('resolves a relative dangling link against the folder that really holds it', () => {
    // alias → real/sub; real/sub/link → ../target.tw, which is real/target.tw, not alias/../target.tw.
    mkdirSync(join(dir, 'real', 'sub'), { recursive: true });
    linkDir(join(dir, 'real', 'sub'), join(dir, 'alias'));
    symlinkSync(join('..', 'target.tw'), join(dir, 'real', 'sub', 'link.tw'));
    expect(realAt(dir).identify('alias/link.tw').canonical).toBe(join(dir, 'real', 'target.tw'));
  });

  it('stops at a link cycle instead of looping', () => {
    symlinkSync(join(dir, 'b'), join(dir, 'a'));
    symlinkSync(join(dir, 'a'), join(dir, 'b'));
    const id = realAt(dir).identify('a/x.tw');
    expect(id.canonical.startsWith(dir)).toBe(true);
    expect(id.display).toBe(join('a', 'x.tw'));
  });

  it('identifies paths that do not exist by their nearest existing folder', () => {
    mkdirSync(join(dir, 'real'));
    linkDir(join(dir, 'real'), join(dir, 'alias'));
    const ids = realAt(dir);
    const missing = ids.identify('alias/not/yet/here.tw');
    expect(missing.canonical).toBe(join(dir, 'real', 'not', 'yet', 'here.tw'));
    expect(missing.key).toBe(ids.identify(join(dir, 'real', 'not', 'yet', 'here.tw')).key);
  });

  it('reports a working directory reached through a link (/var vs /private/var) relative, not as ../link/…', () => {
    // FS-06: process.cwd() is the real path while the paths a user writes go through the link.
    mkdirSync(join(dir, 'real', 'src'), { recursive: true });
    writeFileSync(join(dir, 'real', 'src', 'a.tw'), '');
    linkDir(join(dir, 'real'), join(dir, 'link'));
    const ids = realAt(join(dir, 'real'));
    const id = ids.identify(join(dir, 'link', 'src', 'a.tw'));
    expect(id.display).toBe(join('src', 'a.tw'));
    expect(ids.matchesExclude(id, ['src/**/*.tw'])).toBe(true);
  });

  it('keeps the name of a file link outside the working directory and the lexical path when nothing is inside', () => {
    mkdirSync(join(dir, 'cwd'));
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'other', 'a.tw'), '');
    const id = realAt(join(dir, 'cwd')).identify(join(dir, 'other', 'a.tw'));
    expect(id.display).toBe(join('..', 'other', 'a.tw'));
    expect(realAt(dir).identify(dir).display).toBe('.');
  });

  it('gives the working directory reached through a link the display "."', () => {
    mkdirSync(join(dir, 'real'));
    linkDir(join(dir, 'real'), join(dir, 'link'));
    expect(realAt(join(dir, 'real')).identify(join(dir, 'link')).display).toBe('.');
  });

  it.skipIf(CASE_INSENSITIVE_TMP)('tells case variants apart on a case-sensitive volume', () => {
    writeFileSync(join(dir, 'a.tw'), '');
    writeFileSync(join(dir, 'A.tw'), '');
    const ids = realAt(dir);
    expect(ids.identify('a.tw').caseInsensitive).toBe(false);
    expect(ids.sameFile('a.tw', 'A.tw')).toBe(false);
    expect(ids.sameFile('missing.tw', 'MISSING.tw')).toBe(false);
  });

  it.runIf(CASE_INSENSITIVE_TMP)('gives case variants one key on a case-insensitive volume', () => {
    mkdirSync(join(dir, 'Src'));
    writeFileSync(join(dir, 'Src', 'Story.tw'), '');
    const ids = realAt(dir);
    expect(ids.identify('src/story.TW').caseInsensitive).toBe(true);
    expect(ids.sameFile('src/story.TW', 'Src/Story.tw')).toBe(true);
    // Components that don't exist yet are folded too.
    expect(ids.sameFile('SRC/New.tw', 'src/new.tw')).toBe(true);
    expect(ids.matchesExclude(ids.identify('Src/Story.tw'), ['SRC/*.TW'])).toBe(true);
  });

  it('module-level functions use the real file system and the working directory', () => {
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'a.tw'), '');
    linkDir(join(dir, 'real'), join(dir, 'alias'));
    clearPathIdentityCache();
    expect(identify(join(dir, 'alias', 'a.tw')).canonical).toBe(join(dir, 'real', 'a.tw'));
    expect(sameFile(join(dir, 'alias', 'a.tw'), join(dir, 'real', 'a.tw'))).toBe(true);
    expect(isSameOrInside(join(dir, 'alias', 'a.tw'), join(dir, 'real'))).toBe(true);
    expect(matchesExclude(identify(join(dir, 'real', 'a.tw')), [join(dir, 'real', '*.tw')])).toBe(true);
    expect(matchesExclude(identify(join(dir, 'real', 'a.tw')), [])).toBe(false);
  });

  it('wraps node:fs without throwing for what is missing or unreadable', () => {
    writeFileSync(join(dir, 'a.tw'), '');
    symlinkSync(join(dir, 'a.tw'), join(dir, 'link.tw'));
    expect(nodeIdentityFileSystem.lstat(join(dir, 'missing'))).toBeUndefined();
    // A NUL byte makes lstat throw rather than report a missing file.
    expect(nodeIdentityFileSystem.lstat(join(dir, 'bad\0name'))).toBeUndefined();
    expect(nodeIdentityFileSystem.readlink(join(dir, 'link.tw'))).toContain('a.tw');
    expect(nodeIdentityFileSystem.readdir(join(dir, 'missing'), 10)).toEqual([]);
    expect(nodeIdentityFileSystem.readdir(dir, 1)).toHaveLength(1);
    expect(nodeIdentityFileSystem.readdir(dir, 10)).toHaveLength(2);
  });
});

describe('case-insensitive volumes, probed per volume', () => {
  it('folds case on an insensitive volume mounted on a case-sensitive one (Linux vfat, exFAT, casefold)', () => {
    const fs = new FakeIdentityFs(posix)
      .mount('/', 1, false)
      .mkdir('/mnt')
      .mount('/mnt/usb', 2, true)
      .mkdir('/mnt/usb/Story')
      .file('/mnt/usb/Story/Start.tw')
      .mkdir('/home')
      .file('/home/a.tw')
      .file('/home/A.tw');
    const ids = createPathIdentifier({ path: posix, fs, cwd: () => '/home' });
    const usb = ids.identify('/mnt/usb/story/START.TW');
    expect(usb.caseInsensitive).toBe(true);
    // realpath keeps the case as written on such a volume, so the key is what makes them equal.
    expect(usb.key).toBe(ids.identify('/mnt/usb/Story/Start.tw').key);
    expect(ids.identify('/home/a.tw').caseInsensitive).toBe(false);
    expect(ids.sameFile('/home/a.tw', '/home/A.tw')).toBe(false);
  });

  it('treats a sensitive volume on Windows as sensitive, and an insensitive one on POSIX as insensitive', () => {
    const winFs = new FakeIdentityFs(win32).mount('C:\\', 1, false).mkdir('C:\\Proj').file('C:\\Proj\\a.tw');
    const win = createPathIdentifier({ path: win32, fs: winFs, cwd: () => 'C:\\Proj' });
    expect(win.identify('A.TW').caseInsensitive).toBe(false);
    expect(win.sameFile('a.tw', 'A.TW')).toBe(false);

    const macFs = new FakeIdentityFs(posix).mount('/', 1, true).mkdir('/Users').file('/Users/a.tw');
    const mac = createPathIdentifier({ path: posix, fs: macFs, cwd: () => '/Users' });
    expect(mac.sameFile('a.tw', 'A.TW')).toBe(true);
  });

  it('probes each volume once', () => {
    const fs = new FakeIdentityFs(posix).mount('/', 1, true).mkdir('/p').file('/p/a.tw').file('/p/b.tw');
    const ids = createPathIdentifier({ path: posix, fs, cwd: () => '/p' });
    ids.identify('a.tw');
    const readdirs = fs.calls.readdir;
    ids.identify('b.tw');
    ids.identify('c.tw');
    expect(fs.calls.readdir).toBe(readdirs);
    ids.clearCache();
    ids.identify('a.tw');
    expect(fs.calls.readdir).toBe(readdirs + 1);
  });

  it('probes the folder name above when no name inside has a letter, and stops at the volume boundary', () => {
    const fs = new FakeIdentityFs(posix).mount('/', 1, true).mkdir('/Data').mkdir('/Data/123').file('/Data/123/456');
    const ids = createPathIdentifier({ path: posix, fs, cwd: () => '/' });
    expect(ids.identify('/data/123/456').caseInsensitive).toBe(true);

    // No letter anywhere on the volume: the default answer.
    const bare = new FakeIdentityFs(posix).mount('/', 1, true).mkdir('/1').file('/1/2');
    expect(createPathIdentifier({ path: posix, fs: bare, cwd: () => '/' }).identify('/1/2').caseInsensitive).toBe(
      false,
    );
    expect(
      createPathIdentifier({ path: posix, fs: bare, cwd: () => '/', defaultCaseInsensitive: true }).identify('/1/2')
        .caseInsensitive,
    ).toBe(true);

    // A volume mounted at a folder without letters: the folder above is on another volume and isn't asked.
    const mounted = new FakeIdentityFs(posix)
      .mount('/', 1, true)
      .mkdir('/Mnt')
      .mkdir('/Mnt/7')
      .mount('/Mnt/7/9', 2, false);
    mounted.file('/Mnt/7/9/0');
    expect(
      createPathIdentifier({ path: posix, fs: mounted, cwd: () => '/' }).identify('/Mnt/7/9/0').caseInsensitive,
    ).toBe(false);
  });

  it('says case-sensitive when the flipped name is another file', () => {
    const fs = new FakeIdentityFs(posix).mount('/', 1, false).mkdir('/p').file('/p/Read').file('/p/rEAD');
    expect(createPathIdentifier({ path: posix, fs, cwd: () => '/p' }).identify('Read').caseInsensitive).toBe(false);
  });

  it('uses the default answer for a path with no existing ancestor', () => {
    const fs = new FakeIdentityFs(win32).mount('C:\\', 1, true);
    const ids = createPathIdentifier({ path: win32, fs, cwd: () => 'C:\\' });
    const id = ids.identify('Z:\\Nowhere\\A.tw');
    expect(id.canonical).toBe('Z:\\Nowhere\\A.tw');
    expect(id.caseInsensitive).toBe(true);
    expect(id.key).toBe('z:\\nowhere\\a.tw');
  });

  it('follows a dangling link to a drive that does not exist', () => {
    const fs = new FakeIdentityFs(win32)
      .mount('C:\\', 1, true)
      .mkdir('C:\\p')
      .symlink('Z:\\Out\\Story.html', 'C:\\p\\out.html');
    const id = createPathIdentifier({ path: win32, fs, cwd: () => 'C:\\p' }).identify('out.html');
    expect(id.canonical).toBe('Z:\\Out\\Story.html');
    // The deepest existing part is the folder holding the link, on an insensitive volume.
    expect(id.key).toBe('z:\\out\\story.html');
  });

  it('keeps a link it can no longer read as written, and skips a name that vanished while probing', () => {
    const fs = new FakeIdentityFs(posix).mount('/', 1, false).mkdir('/p').symlink('/nowhere', '/p/link');
    const flaky = {
      realpath: (p: string) => fs.realpath(p),
      lstat: (p: string) => (p === '/p/gone' ? undefined : fs.lstat(p)),
      readlink: (): string => {
        throw new Error('EINVAL');
      },
      readdir: (d: string, limit: number) => (d === '/p' ? ['gone', ...fs.readdir(d, limit)] : fs.readdir(d, limit)),
    };
    const ids = createPathIdentifier({ path: posix, fs: flaky, cwd: () => '/p' });
    const id = ids.identify('link/x');
    expect(id.canonical).toBe('/p/link/x');
    expect(id.caseInsensitive).toBe(false);
  });

  it('uses the default answer when the existing folder cannot be read', () => {
    const fs = new FakeIdentityFs(posix).mount('/', 1, true).mkdir('/p');
    const blind = {
      realpath: (p: string) => fs.realpath(p),
      readlink: (p: string) => fs.readlink(p),
      readdir: () => [],
      lstat: () => undefined,
    };
    const ids = createPathIdentifier({ path: posix, fs: blind, cwd: () => '/' });
    expect(ids.identify('/p/x').caseInsensitive).toBe(false);
  });
});

describe('Windows paths', () => {
  const winFs = (): FakeIdentityFs =>
    new FakeIdentityFs(win32)
      .mount('C:\\', 1, true)
      .mkdir('C:\\Proj')
      .mkdir('C:\\Proj\\Src')
      .file('C:\\Proj\\Src\\Start.tw')
      .mount('\\\\Server\\Share\\', 2, true)
      .file('\\\\Server\\Share\\Story.tw')
      .mount('D:\\', 3, true)
      .file('D:\\other.tw');

  it('normalises separators, drive letters and long-path prefixes', () => {
    expect(normalizeWindowsPath('c:/Proj/a.tw')).toBe('C:\\Proj\\a.tw');
    expect(normalizeWindowsPath('\\\\?\\c:\\Proj')).toBe('C:\\Proj');
    expect(normalizeWindowsPath('\\\\?\\UNC\\srv\\share\\x')).toBe('\\\\srv\\share\\x');
    expect(normalizeWindowsPath('\\\\srv\\share\\x')).toBe('\\\\srv\\share\\x');
  });

  it('gives every spelling of a file one key', () => {
    const ids = createPathIdentifier({ path: win32, fs: winFs(), cwd: () => 'c:\\proj' });
    const spellings = [
      'Src\\Start.tw',
      'src/start.TW',
      'c:/PROJ/src/Start.tw',
      'C:\\Proj\\Src\\.\\Start.tw',
      'C:\\Proj\\x\\..\\Src\\Start.tw',
      '\\\\?\\C:\\Proj\\Src\\Start.tw',
    ];
    const keys = new Set(spellings.map((s) => ids.identify(s).key));
    expect(keys.size).toBe(1);
    expect(ids.identify('src/start.TW').canonical).toBe('C:\\Proj\\Src\\Start.tw');
    expect(ids.identify('src/start.TW').display).toBe('src\\start.TW');
  });

  it('gives UNC paths one key whatever the server and share spelling', () => {
    const ids = createPathIdentifier({ path: win32, fs: winFs(), cwd: () => 'C:\\Proj' });
    expect(ids.sameFile('\\\\server\\share\\story.tw', '\\\\SERVER\\SHARE\\Story.tw')).toBe(true);
    expect(ids.sameFile('\\\\?\\UNC\\Server\\Share\\Story.tw', '\\\\server\\share\\STORY.TW')).toBe(true);
  });

  it('keeps an absolute display for another drive', () => {
    const ids = createPathIdentifier({ path: win32, fs: winFs(), cwd: () => 'C:\\Proj' });
    expect(ids.identify('d:\\other.tw').display).toBe('D:\\other.tw');
  });

  it('matches exclude globs without case and with either separator', () => {
    const ids = createPathIdentifier({ path: win32, fs: winFs(), cwd: () => 'C:\\Proj' });
    const id = ids.identify('SRC\\Start.TW');
    expect(ids.matchesExclude(id, ['src/**/*.tw'])).toBe(true);
    expect(ids.matchesExclude(id, ['.\\src\\*.tw'])).toBe(true);
    expect(ids.matchesExclude(id, ['c:/proj/src/*.tw'])).toBe(true);
    expect(ids.matchesExclude(id, ['lib/**'])).toBe(false);
  });

  it('is case-sensitive on a Windows key when the volume is (a folder with the case-sensitive flag)', () => {
    const fs = new FakeIdentityFs(win32).mount('c:\\', 1, false).mkdir('C:\\p').file('C:\\p\\A.tw');
    const ids = createPathIdentifier({ path: win32, fs, cwd: () => 'C:\\p' });
    expect(ids.identify('A.tw').key).toBe('C:\\p\\A.tw');
  });
});

describe('exclude globs', () => {
  const fs = (): FakeIdentityFs =>
    new FakeIdentityFs(posix)
      .mount('/', 1, false)
      .mkdir('/proj')
      .mkdir('/proj/src')
      .file('/proj/src/Photo.PNG')
      .file('/proj/src/a.tw')
      .file('/proj/src/LICENSE')
      .file('/proj/src/license')
      .symlink('/proj/src', '/proj/alias');

  it('matches the extension without case on a case-sensitive volume, as the loader reads it (FS-14)', () => {
    const ids = createPathIdentifier({ path: posix, fs: fs(), cwd: () => '/proj' });
    const photo = ids.identify('src/Photo.PNG');
    expect(photo.caseInsensitive).toBe(false);
    expect(ids.matchesExclude(photo, ['src/**/*.png'])).toBe(true);
    expect(ids.matchesExclude(photo, ['src/*.{jpg,png}'])).toBe(true);
    expect(ids.matchesExclude(ids.identify('src/a.tw'), ['src/*.TW'])).toBe(true);
    // The rest of the path keeps its case.
    expect(ids.matchesExclude(photo, ['SRC/**/*.png'])).toBe(false);
    expect(ids.matchesExclude(photo, ['src/photo.png'])).toBe(false);
    // A brace group with names in it is not an extension.
    expect(ids.matchesExclude(ids.identify('src/license'), ['src/{README.md,LICENSE}'])).toBe(false);
    expect(ids.matchesExclude(ids.identify('src/LICENSE'), ['src/{README.md,LICENSE}'])).toBe(true);
    // A file without an extension is not matched by an extension glob.
    expect(ids.matchesExclude(ids.identify('src/LICENSE'), ['src/*.PNG'])).toBe(false);
  });

  it('matches the real path relative to the working directory as well as the written one', () => {
    const ids = createPathIdentifier({ path: posix, fs: fs(), cwd: () => '/proj' });
    const viaAlias = ids.identify('alias/a.tw');
    expect(viaAlias.display).toBe('alias/a.tw');
    expect(ids.matchesExclude(viaAlias, ['alias/*.tw'])).toBe(true);
    expect(ids.matchesExclude(viaAlias, ['src/*.tw'])).toBe(true);
    expect(ids.matchesExclude(viaAlias, ['/proj/alias/*.tw'])).toBe(true);
    expect(ids.matchesExclude(viaAlias, ['/proj/src/*.tw'])).toBe(true);
    expect(ids.matchesExclude(viaAlias, ['./alias/a.tw'])).toBe(true);
    expect(ids.matchesExclude(viaAlias, ['other/**'])).toBe(false);
  });

  it('lower-cases only an extension it recognises', () => {
    expect(lowerGlobExtension('src/**/*.PNG')).toBe('src/**/*.png');
    expect(lowerGlobExtension('*.{PNG,JPG}')).toBe('*.{png,jpg}');
    expect(lowerGlobExtension('a.d/*')).toBeUndefined();
    expect(lowerGlobExtension('a.d\\*')).toBeUndefined();
    expect(lowerGlobExtension('src/**')).toBeUndefined();
    expect(lowerGlobExtension('{README.md,LICENSE}')).toBeUndefined();
  });
});

describe('pure helpers', () => {
  it('folds and flips case per code point', () => {
    expect(foldCase('ÄbC.TW')).toBe('äbc.tw');
    // İ lower-cases to two code points; it is kept as it is.
    expect(foldCase('İ')).toBe('İ');
    expect(flipCase('aB1ß')).toBe('Ab1SS');
    expect(flipCase('123')).toBe('123');
  });

  it('compares keys by whole components', () => {
    expect(isKeyInside('/a/b', '/a', '/')).toBe(true);
    expect(isKeyInside('/a', '/a', '/')).toBe(true);
    expect(isKeyInside('/ab', '/a', '/')).toBe(false);
    expect(isKeyInside('/a', '/', '/')).toBe(true);
    expect(isKeyInside('C:\\a', 'C:\\', '\\')).toBe(true);
  });
});

describe('properties', () => {
  /** A file system with one file reached by many spellings: a link to its folder and dot segments. */
  const spellingFs = (path: PathFlavour, insensitive: boolean, root: string): FakeIdentityFs => {
    const at = (...parts: string[]): string => path.join(root, ...parts);
    return new FakeIdentityFs(path)
      .mount(root, 1, insensitive)
      .mkdir(at('Proj'))
      .mkdir(at('Proj', 'Src'))
      .mkdir(at('Proj', 'Other'))
      .file(at('Proj', 'Src', 'Story.tw'))
      .symlink(at('Proj', 'Src'), at('Proj', 'Alias'))
      .symlink(path.join('..', 'Src'), at('Proj', 'Other', 'Up'));
  };

  /** A random spelling of Proj/Src/Story.tw: through a link or not, with `.`/`x/..` segments, maybe absolute. */
  const spelling = (path: PathFlavour, root: string, insensitive: boolean) =>
    fc
      .record({
        via: fc.constantFrom(['Src'], ['Alias'], ['Other', 'Up']),
        noise: fc.array(fc.constantFrom('.', 'x/..', 'Src/..'), { maxLength: 3 }),
        absolute: fc.boolean(),
        flip: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        slashes: fc.boolean(),
      })
      .map(({ via, noise, absolute, flip, slashes }) => {
        const parts = [...noise, ...via, 'Story.tw'];
        let p = path.join(...parts);
        if (absolute) p = path.join(root, 'Proj', p);
        if (insensitive) p = Array.from(p, (ch, i) => (flip[i % flip.length] === true ? flipCase(ch) : ch)).join('');
        if (slashes && path.sep === '\\') p = p.replace(/\\/g, '/');
        return p;
      });

  for (const [name, path, root] of [
    ['POSIX', posix, '/'],
    ['Windows', win32, 'C:\\'],
  ] as const) {
    for (const insensitive of [false, true]) {
      it(`gives every spelling one key (${name}, ${insensitive ? 'case-insensitive' : 'case-sensitive'})`, () => {
        const ids = createPathIdentifier({
          path,
          fs: spellingFs(path, insensitive, root),
          cwd: () => path.join(root, 'Proj'),
        });
        const expected = ids.identify(path.join(root, 'Proj', 'Src', 'Story.tw')).key;
        fc.assert(
          fc.property(spelling(path, root, insensitive), (p) => {
            expect(ids.identify(p).key).toBe(expected);
            expect(ids.matchesExclude(ids.identify(p), ['Src/*.tw'])).toBe(true);
          }),
        );
      });
    }
  }

  it('never gives two different existing files one key on a case-sensitive volume', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[A-Za-z]{1,3}$/), { minLength: 2, maxLength: 6 }), (names) => {
        const fs = new FakeIdentityFs(posix).mount('/', 1, false).mkdir('/d');
        for (const n of names) fs.file(`/d/${n}`);
        const ids = createPathIdentifier({ path: posix, fs, cwd: () => '/d' });
        expect(new Set(names.map((n) => ids.identify(n).key)).size).toBe(names.length);
      }),
    );
  });
});

describe('the platform flavour', () => {
  it('defaults to node:path', () => {
    expect(createPathIdentifier().identify('x').absolute).toBe(nodePath.resolve('x'));
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  NOTICES_FILE,
  bundledPackages,
  compareWithAllowList,
  packageOfModuleId,
  readPackageLicence,
  renderThirdPartyNotices,
  updateThirdPartyNotices,
} from '../scripts/third-party-notices.mjs';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-notices-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Creates node_modules/<name> under `root` with the given package.json fields and files. */
function fakePackage(root: string, name: string, manifest: Record<string, unknown>, files: Record<string, string>) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }));
  writeFileSync(join(dir, 'lib', 'index.js'), 'export {};');
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return { name, root: `${root.replaceAll('\\', '/')}/node_modules/${name}`, entry: join(dir, 'lib', 'index.js') };
}

describe('packageOfModuleId', () => {
  it.each([
    ['/repo/node_modules/htmlparser2/dist/esm/index.js', 'htmlparser2', '/repo/node_modules/htmlparser2'],
    [
      '/repo/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/esm/decode.js',
      'entities',
      '/repo/node_modules/.pnpm/entities@8.1.0/node_modules/entities',
    ],
    ['/repo/node_modules/@scope/pkg/index.js', '@scope/pkg', '/repo/node_modules/@scope/pkg'],
    [
      'C:\\repo\\node_modules\\.pnpm\\domhandler@6.0.1\\node_modules\\domhandler\\lib\\index.js',
      'domhandler',
      'C:/repo/node_modules/.pnpm/domhandler@6.0.1/node_modules/domhandler',
    ],
    ['/repo/node_modules/outer/node_modules/inner/x.js', 'inner', '/repo/node_modules/outer/node_modules/inner'],
  ])('finds the package of %s', (id, name, root) => {
    expect(packageOfModuleId(id)).toEqual({ name, root });
  });

  it.each([
    ['a source file', '/repo/src/index.ts'],
    ['a virtual module', '\0rolldown/runtime.js'],
    ['a pnpm store folder', '/repo/node_modules/.pnpm/lock.yaml'],
    ['a bare scope', '/repo/node_modules/@scope'],
    ['the node_modules folder itself', '/repo/node_modules/'],
  ])('ignores %s', (_label, id) => {
    expect(packageOfModuleId(id)).toBeUndefined();
  });
});

describe('bundledPackages', () => {
  it('lists each package folder once, sorted by name', () => {
    const ids = [
      '/r/node_modules/b/x.js',
      '/r/node_modules/a/x.js',
      '/r/node_modules/b/y.js',
      '/r/src/index.ts',
      '/r/node_modules/.pnpm/a@2/node_modules/a/z.js',
    ];
    expect(bundledPackages(ids)).toEqual([
      { name: 'a', root: '/r/node_modules/.pnpm/a@2/node_modules/a' },
      { name: 'a', root: '/r/node_modules/a' },
      { name: 'b', root: '/r/node_modules/b' },
    ]);
  });

  it('is empty when nothing comes from node_modules', () => {
    expect(bundledPackages(['/r/src/a.ts', '\0virtual'])).toEqual([]);
  });
});

describe('compareWithAllowList', () => {
  it('names packages that are bundled but not allowed, and allowed but not bundled', () => {
    const bundled = [
      { name: 'a', root: '/a' },
      { name: 'c', root: '/c' },
    ];
    expect(compareWithAllowList(bundled, ['a', 'b'])).toEqual({ unlisted: ['c'], unused: ['b'] });
    expect(compareWithAllowList(bundled, ['c', 'a'])).toEqual({ unlisted: [], unused: [] });
  });
});

describe('readPackageLicence', () => {
  it('reads the SPDX id, the project URL and the licence text', () => {
    const pkg = fakePackage(
      tempDir(),
      'mit-pkg',
      { license: 'MIT', repository: { type: 'git', url: 'git+https://github.com/o/mit-pkg.git' } },
      { LICENSE: '\uFEFFCopyright (c) Someone   \r\n\r\nPermission is hereby granted\r\n' },
    );
    expect(readPackageLicence(pkg)).toEqual({
      name: 'mit-pkg',
      url: 'https://github.com/o/mit-pkg',
      license: 'MIT',
      text: 'Copyright (c) Someone\n\nPermission is hereby granted',
    });
  });

  it.each([
    ['git://github.com/fb55/domhandler.git', 'https://github.com/fb55/domhandler'],
    ['github:o/short', 'https://github.com/o/short'],
  ])('turns the repository %s into %s', (repository, url) => {
    const pkg = fakePackage(tempDir(), 'p', { license: 'MIT', repository }, { 'LICENCE.md': 'text' });
    expect(readPackageLicence(pkg).url).toBe(url);
  });

  it('falls back to the homepage, and to no URL', () => {
    const root = tempDir();
    const withHome = fakePackage(root, 'home', { license: 'ISC', homepage: 'https://example.org' }, { COPYING: 't' });
    const bare = fakePackage(root, 'bare', { license: 'ISC' }, { 'license.txt': 't' });
    expect(readPackageLicence(withHome).url).toBe('https://example.org');
    expect(readPackageLicence(bare).url).toBeUndefined();
  });

  it('joins several licence files in name order', () => {
    const pkg = fakePackage(tempDir(), 'two', { license: 'MIT' }, { 'LICENSE-MIT': 'mit', 'LICENSE-APACHE': 'apache' });
    expect(readPackageLicence(pkg).text).toBe('apache\n\nmit');
  });

  it('fails, naming the package, when it ships no licence file', () => {
    const pkg = fakePackage(tempDir(), 'nolicence', { license: 'MIT' }, { 'README.md': 'readme' });
    expect(() => readPackageLicence(pkg)).toThrow(/nolicence .*ships no LICENSE file/);
  });

  it('fails, naming the package, when its package.json has no license field', () => {
    const pkg = fakePackage(tempDir(), 'nofield', {}, { LICENSE: 'text' });
    expect(() => readPackageLicence(pkg)).toThrow(/nofield .*declares no "license"/);
  });

  it('fails with the cause when package.json cannot be read', () => {
    const error = (() => {
      try {
        readPackageLicence({ name: 'missing', root: join(tempDir(), 'nowhere') });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: expect.stringContaining('missing'), cause: expect.any(Error) });
  });
});

describe('renderThirdPartyNotices', () => {
  const licence = (name: string, text: string) => ({ name, url: `https://example.org/${name}`, license: 'MIT', text });

  it("starts with the twee-ts statement and Tweego's BSD notice, then each package", () => {
    const text = renderThirdPartyNotices([licence('alpha', 'ALPHA TEXT'), licence('beta', 'BETA TEXT')]);
    expect(text).toMatch(/^THIRD-PARTY NOTICES for @rohal12\/twee-ts\n/);
    expect(text).toContain('public domain under the Unlicense');
    expect(text).toContain('Tweego\nhttps://www.motoslave.net/tweego/\nLicense: BSD-2-Clause');
    expect(text).toContain('Copyright (c) 2014-2020, Thomas Michael Edwards');
    expect(text.indexOf('Tweego')).toBeLessThan(text.indexOf('alpha'));
    expect(text.indexOf('ALPHA TEXT')).toBeLessThan(text.indexOf('BETA TEXT'));
    expect(text).toContain('alpha\nhttps://example.org/alpha\nLicense: MIT');
    expect(text.endsWith('BETA TEXT\n')).toBe(true);
    expect(text).not.toContain('\r');
  });

  it('prints a package once when two copies carry the same licence, and twice when they differ', () => {
    const same = renderThirdPartyNotices([licence('dup', 'SAME'), licence('dup', 'SAME')]);
    expect(same.split('SAME').length - 1).toBe(1);
    const different = renderThirdPartyNotices([licence('dup', 'OLD'), licence('dup', 'NEW')]);
    expect(different).toContain('OLD');
    expect(different).toContain('NEW');
  });

  it('leaves out the URL line when there is none', () => {
    const text = renderThirdPartyNotices([{ name: 'nourl', url: undefined, license: 'MIT', text: 'T' }]);
    expect(text).toContain('nourl\nLicense: MIT');
  });
});

describe('updateThirdPartyNotices', () => {
  function setup() {
    const root = tempDir();
    const a = fakePackage(root, 'a', { license: 'MIT' }, { LICENSE: 'A LICENCE' });
    const b = fakePackage(root, '@s/b', { license: 'BSD-2-Clause' }, { LICENSE: 'B LICENCE' });
    return { file: join(root, NOTICES_FILE), moduleIds: [a.entry, b.entry, join(root, 'src', 'index.ts')] };
  }

  it('writes the notices of the bundled packages, then reports no change on the next build', () => {
    const { file, moduleIds } = setup();
    expect(updateThirdPartyNotices({ moduleIds, allowed: ['a', '@s/b'], file })).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('A LICENCE');
    expect(text).toContain('B LICENCE');
    expect(updateThirdPartyNotices({ moduleIds, allowed: ['a', '@s/b'], file })).toBe(false);
  });

  it('treats a checkout with CRLF line endings as unchanged', () => {
    const { file, moduleIds } = setup();
    updateThirdPartyNotices({ moduleIds, allowed: ['a', '@s/b'], file });
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
    expect(updateThirdPartyNotices({ moduleIds, allowed: ['a', '@s/b'], file })).toBe(false);
  });

  it('rewrites a stale file', () => {
    const { file, moduleIds } = setup();
    writeFileSync(file, 'stale');
    expect(updateThirdPartyNotices({ moduleIds, allowed: ['a', '@s/b'], file })).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('A LICENCE');
  });

  it('fails when the bundle holds a package that deps.onlyBundle does not list', () => {
    const { file, moduleIds } = setup();
    expect(() => updateThirdPartyNotices({ moduleIds, allowed: ['a'], file })).toThrow(/Bundled but not listed: @s\/b/);
  });

  it('fails when deps.onlyBundle lists a package that is not bundled', () => {
    const { file, moduleIds } = setup();
    expect(() => updateThirdPartyNotices({ moduleIds, allowed: ['a', '@s/b', 'gone'], file })).toThrow(
      /Listed but not bundled: gone/,
    );
  });
});

describe('the committed THIRD_PARTY_NOTICES', () => {
  const text = readFileSync(join(__dirname, '..', NOTICES_FILE), 'utf8');
  const config = readFileSync(join(__dirname, '..', 'tsdown.config.ts'), 'utf8');
  const listed = /const BUNDLED_PACKAGES = \[([^\]]*)\]/.exec(config)?.[1] ?? '';
  const names = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  it('has a section for Tweego and for every package in deps.onlyBundle', () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of ['Tweego', ...names]) expect(text).toMatch(new RegExp(`^={80}\\n${name}\\n`, 'm'));
  });

  it('ships in the package', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining([NOTICES_FILE, 'UNLICENSE']));
  });
});

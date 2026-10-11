import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import fc from 'fast-check';
import { temporaryName, writeFileAtomic } from '../src/atomic-write.js';
import { compileToFile, watch } from '../src/compiler.js';
import { seedUrlDownload, withCacheHome } from './helpers/format-cache.js';

/** The longest name a file system takes: 255 bytes (ext4, tmpfs, APFS); NTFS counts 255 UTF-16 units. */
const LIMIT = 255;

/** A target name of exactly `bytes` UTF-8 bytes made of `unit`, with `.tw` as its extension; the rest is padded with ASCII. */
function nameOf(unit: string, bytes: number): string {
  const extension = '.tw';
  const room = bytes - extension.length;
  const copies = Math.floor(room / Buffer.byteLength(unit));
  const padding = 'x'.repeat(room - copies * Buffer.byteLength(unit));
  return `${unit.repeat(copies)}${padding}${extension}`;
}

/** The target names a build must accept: each is valid on its own. */
const NAMES: readonly (readonly [string, string])[] = [
  ['short ASCII', 'out.tw'],
  ['220 ASCII bytes', nameOf('a', 220)],
  ['240 ASCII bytes', nameOf('a', 240)],
  ['250 ASCII bytes', nameOf('a', 250)],
  ['255 ASCII bytes', nameOf('a', LIMIT)],
  ['243 bytes of CJK', '文'.repeat(80) + '.tw'],
  ['255 bytes of CJK', nameOf('文', LIMIT)],
  ['255 bytes of two-byte characters', nameOf('é', LIMIT)],
  ['255 bytes of four-byte characters', nameOf('😀', LIMIT)],
  ['254 bytes of CJK', nameOf('文', LIMIT - 1)],
];

const STORY = {
  filename: 'story.tw',
  content: ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nHello',
};

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'twee-ts-long-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The names this file system takes at all; a test for a name it refuses has nothing to say (macOS and Windows
 * count differently, and some file systems have lower limits).
 */
const TAKEN = NAMES.filter(([, name]) => {
  const probe = mkdtempSync(join(tmpdir(), 'twee-ts-long-probe-'));
  try {
    writeFileSync(join(probe, name), '');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

describe.each(TAKEN)('a target of %s', (_label, name) => {
  it('is written by writeFileAtomic, new and replaced, leaving no temporary file', () => {
    const path = join(dir, name);
    writeFileAtomic(path, 'first');
    expect(readFileSync(path, 'utf-8')).toBe('first');
    writeFileAtomic(path, 'second');
    expect(readFileSync(path, 'utf-8')).toBe('second');
    expect(readdirSync(dir)).toEqual([name]);
  });

  it('is written by compileToFile, new and replaced', async () => {
    const outFile = join(dir, name);
    await compileToFile({ sources: [STORY], outputMode: 'twee3', outFile });
    expect(readFileSync(outFile, 'utf-8')).toContain('Hello');
    writeFileSync(outFile, 'previous output');
    await compileToFile({ sources: [STORY], outputMode: 'twee3', outFile });
    expect(readFileSync(outFile, 'utf-8')).toContain('Hello');
    expect(readdirSync(dir)).toEqual([name]);
  });

  it('is written by the first build of a watch', async () => {
    const outFile = join(dir, name);
    const source = join(dir, 'in');
    mkdirSync(source);
    writeFileSync(join(source, 'story.tw'), STORY.content);
    const built = Promise.withResolvers<undefined>();
    const controller = await watch({
      sources: [source],
      outputMode: 'twee3',
      outFile,
      onBuild: () => {
        built.resolve(undefined);
      },
      onError: (error) => {
        built.reject(error);
      },
    });
    try {
      await built.promise;
      expect(readFileSync(outFile, 'utf-8')).toContain('Hello');
    } finally {
      controller.abort();
    }
  });
});

const ROOT = resolve(import.meta.dirname, '..');
const NODE_ARGS = [
  '--import',
  pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
  join(ROOT, 'bin', 'twee-ts.ts'),
];

// A process per case is slow: the CLI runs the cases that differ in kind (ASCII, three-byte, four-byte at the limit).
const CLI_LABELS: ReadonlySet<string> = new Set([
  '255 ASCII bytes',
  '243 bytes of CJK',
  '255 bytes of four-byte characters',
]);

describe.each(TAKEN.filter(([label]) => CLI_LABELS.has(label)))(
  'the CLI with -o naming a target of %s',
  (_label, name) => {
    it('writes the output, new and replaced', () => {
      writeFileSync(join(dir, 'story.tw'), STORY.content);
      const run = (): number | null =>
        spawnSync(process.execPath, [...NODE_ARGS, '-d', '-o', name, 'story.tw'], {
          cwd: dir,
          encoding: 'utf-8',
          timeout: 30_000,
        }).status;
      expect(run()).toBe(0);
      expect(readFileSync(join(dir, name), 'utf-8')).toContain('Hello');
      expect(run()).toBe(0);
      expect(readdirSync(dir).sort()).toEqual([name, 'story.tw'].sort());
    });
  },
);

describe('the story format cache', () => {
  it('keeps every name it makes within the limit for a very long URL, name and version', () => {
    const url = `https://example.test/${'文'.repeat(300)}/format.js`;
    withCacheHome(dir, () => {
      const path = seedUrlDownload(url, '文'.repeat(100), '1.0.0', 'window.storyFormat({});');
      expect(readFileSync(path, 'utf-8')).toContain('storyFormat');
    });
    const names = readdirSync(dir, { recursive: true, encoding: 'utf-8' }).flatMap((entry) => entry.split(/[\\/]/));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => Buffer.byteLength(name) > LIMIT)).toEqual([]);
    expect(names.filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });
});

describe('temporaryName', () => {
  const PID = 4_294_967_295;
  const TOKEN = 'ffffffffffff';

  it.each(NAMES)('stays within the limit, in bytes and in UTF-16 units, for a target of %s', (_label, name) => {
    const temp = temporaryName(name, PID, TOKEN);
    expect(Buffer.byteLength(temp)).toBeLessThanOrEqual(LIMIT);
    expect(temp.length).toBeLessThanOrEqual(LIMIT);
  });

  it('keeps a short name whole, so a leftover file shows what it was for', () => {
    expect(temporaryName('out.html', 7, 'abc')).toBe('.out.html.7-abc.tmp');
  });

  it.each([
    ['a three-byte character cut at the boundary', '文'.repeat(60), '文'.repeat(33)],
    ['a four-byte character cut at the boundary', '😀'.repeat(60), '😀'.repeat(25)],
    ['a two-byte character cut at the boundary', 'é'.repeat(80), 'é'.repeat(50)],
    ['exactly the room', 'a'.repeat(100), 'a'.repeat(100)],
    ['one byte over the room', 'a'.repeat(101), 'a'.repeat(100)],
  ])('cuts %s without splitting a character', (_label, name, kept) => {
    expect(temporaryName(name, 1, 'x')).toBe(`.${kept}.1-x.tmp`);
  });

  it('is a name within the limit, and unique per token, for any target name', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), fc.nat(), (name, pid) => {
        const a = temporaryName(name, pid, 'aaaaaaaaaaaa');
        const b = temporaryName(name, pid, 'bbbbbbbbbbbb');
        expect(Buffer.byteLength(a)).toBeLessThanOrEqual(LIMIT);
        expect(a.length).toBeLessThanOrEqual(LIMIT);
        expect(a).not.toBe(b);
        expect(name.startsWith(a.slice(1, a.lastIndexOf(`.${pid}-`)))).toBe(true);
      }),
    );
  });
});

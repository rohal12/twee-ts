import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CompileOptions, FileCacheEntry, InlineSource } from '../src/types.js';
import { compile, compileIncremental, compileToFile } from '../src/compiler.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-order-abort-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

const IFID_A = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const IFID_B = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D';

function twee(startText: string, ifid = IFID_A): string {
  return `:: StoryData\n{"ifid":"${ifid}"}\n\n:: Start\n${startText}\n`;
}

function inline(filename: string, content: string): InlineSource {
  return { filename, content };
}

const base: Pick<CompileOptions, 'outputMode'> = { outputMode: 'twine2-archive' };

/** Builds the same sources through compile() and compileIncremental() (cold, then warm cache). */
async function buildAll(sources: CompileOptions['sources']) {
  const cache = new Map<string, FileCacheEntry>();
  const plain = await compile({ ...base, sources });
  const cold = await compileIncremental({ ...base, sources }, cache);
  const warm = await compileIncremental({ ...base, sources }, cache, new Set());
  return { builds: [plain, cold, warm], cache };
}

function positions(output: string, ...markers: string[]): number[] {
  return markers.map((m) => output.indexOf(m));
}

describe('source order with inline sources mixed with files', () => {
  it.each(['all', 'one', 'none', 'omitted'] as const)(
    'bounds incremental bookkeeping across alternating groups with %s changed paths (#505)',
    async (changed) => {
      class CountedCache extends Map<string, FileCacheEntry> {
        visits = 0;
        override *keys(): MapIterator<string> {
          for (const key of super.keys()) {
            this.visits++;
            yield key;
          }
        }
      }
      class CountedChanges extends Set<string> {
        visits = 0;
        override *[Symbol.iterator](): SetIterator<string> {
          for (const key of super[Symbol.iterator]()) {
            this.visits++;
            yield key;
          }
        }
      }

      for (const count of [12, 48]) {
        const dir = makeTmpDir();
        const files = Array.from({ length: count }, (_, i) =>
          writeFile(dir, `${String(i)}.tw`, `:: File ${String(i)}\nfile`),
        );
        const sources = files.flatMap((file, i) => [
          file,
          inline(`inline-${String(i)}.tw`, `:: Inline ${String(i)}\ninline`),
        ]);
        const options = { sources, outputMode: 'json' } as const;
        const expected = await compile(options);
        const removed = writeFile(dir, 'removed.tw', ':: Removed\nold');

        for (const warm of [false, true]) {
          const cache = new CountedCache();
          if (warm) await compileIncremental({ ...options, sources: [...sources, removed] }, cache);
          cache.visits = 0;
          const changes =
            changed === 'omitted'
              ? undefined
              : new CountedChanges(files.slice(0, changed === 'all' ? count : changed === 'one' ? 1 : 0));
          const result = await compileIncremental(options, cache, changes);

          expect(result.output).toBe(expected.output);
          expect(result.diagnostics).toEqual(expected.diagnostics);
          expect(cache.visits).toBeLessThanOrEqual(count + 1);
          expect(changes?.visits ?? 0).toBe(changes?.size ?? 0);
          expect(cache.size).toBe(count);
          expect(cache.has(removed)).toBe(false);
        }
      }
    },
  );

  it('emits an inline script before a file that follows it, and after one that precedes it', async () => {
    const dir = makeTmpDir();
    const consumer = writeFile(dir, 'consumer.js', 'globalThis.answer = MARK_CONSUMER;');
    const story = inline('story.tw', twee('Hello'));

    const { builds } = await buildAll([inline('setup.js', 'var MARK_SETUP = 42;'), consumer, story]);
    for (const result of builds) {
      const [setup, user] = positions(result.output, 'MARK_SETUP', 'MARK_CONSUMER');
      expect(setup).toBeGreaterThanOrEqual(0);
      expect(setup).toBeLessThan(user!);
    }

    const reversed = await buildAll([consumer, inline('setup.js', 'var MARK_SETUP = 42;'), story]);
    for (const result of reversed.builds) {
      const [setup, user] = positions(result.output, 'MARK_SETUP', 'MARK_CONSUMER');
      expect(user).toBeGreaterThanOrEqual(0);
      expect(user).toBeLessThan(setup!);
    }
  });

  it('lets a later file override an earlier inline passage, and the reverse', async () => {
    const dir = makeTmpDir();
    const file = writeFile(dir, 'override.tw', ':: Start\nFROM FILE\n');
    const base1 = inline('base.tw', twee('FROM INLINE'));

    const inlineFirst = await buildAll([base1, file]);
    for (const result of inlineFirst.builds) {
      expect(result.output).toContain('FROM FILE');
      expect(result.output).not.toContain('FROM INLINE');
    }

    const fileFirst = await buildAll([file, base1]);
    for (const result of fileFirst.builds) {
      expect(result.output).toContain('FROM INLINE');
      expect(result.output).not.toContain('FROM FILE');
    }
  });

  it('lets the later of two StoryData passages win, whichever kind comes later', async () => {
    const dir = makeTmpDir();
    const file = writeFile(dir, 'data.tw', twee('file', IFID_A));
    const inlineData = inline('data.tw', twee('inline', IFID_B));

    for (const result of (await buildAll([file, inlineData])).builds) expect(result.story.ifid).toBe(IFID_B);
    for (const result of (await buildAll([inlineData, file])).builds) expect(result.story.ifid).toBe(IFID_A);
  });

  it('expands a directory at its position among inline sources', async () => {
    const dir = makeTmpDir();
    const folder = join(dir, 'scripts');
    mkdirSync(folder);
    writeFile(folder, 'a.js', 'var MARK_DIR_A = 1;');
    writeFile(folder, 'b.js', 'var MARK_DIR_B = 2;');

    const { builds } = await buildAll([
      inline('first.js', 'var MARK_FIRST = 0;'),
      folder,
      inline('last.js', 'var MARK_LAST = 3;'),
      inline('story.tw', twee('Hi')),
    ]);
    for (const result of builds) {
      const order = positions(result.output, 'MARK_FIRST', 'MARK_DIR_A', 'MARK_DIR_B', 'MARK_LAST');
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((x, y) => x - y)).toEqual(order);
    }
  });

  it('keeps the cache entries of every file group, not only the last one', async () => {
    const dir = makeTmpDir();
    const one = writeFile(dir, 'one.js', 'var ONE = 1;');
    const two = writeFile(dir, 'two.js', 'var TWO = 2;');
    const { cache } = await buildAll([one, inline('mid.js', 'var MID = 1;'), two, inline('story.tw', twee('Hi'))]);
    expect(cache.size).toBe(2);
  });

  it.each([false, true])('purges the file cache when only inline sources remain: %s (#505)', async (inlineOnly) => {
    const dir = makeTmpDir();
    const file = writeFile(dir, 'old.tw', twee('OLD'));
    const cache = new Map<string, FileCacheEntry>();
    await compileIncremental({ ...base, sources: [file] }, cache);
    expect(cache.size).toBe(1);

    const sources = inlineOnly ? [inline('story.tw', twee('NEW'))] : [];
    const options = { sources, outputMode: 'json' } as const;
    const expected = await compile(options);
    const result = await compileIncremental(options, cache, new Set());

    expect(result.output).toBe(expected.output);
    expect(result.diagnostics).toEqual(expected.diagnostics);
    expect(cache.size).toBe(0);
  });

  it('reports a file named twice, across inline sources, as a duplicate', async () => {
    const dir = makeTmpDir();
    const file = writeFile(dir, 'once.js', 'var ONCE = 1;');
    const result = await compile({ ...base, sources: [file, inline('mid.tw', twee('Hi')), file] });
    expect(result.diagnostics.some((d) => d.message.includes('Skipping duplicate'))).toBe(true);
  });
});

describe('cancellation', () => {
  const STORY = inline('story.tw', twee('Hello'));

  function localFormat(root: string): string {
    const formats = join(root, 'formats');
    mkdirSync(join(formats, 'review-1'), { recursive: true });
    writeFileSync(
      join(formats, 'review-1', 'format.js'),
      'window.storyFormat(' +
        JSON.stringify({
          name: 'Review',
          version: '1.0.0',
          source: '<html><head></head><body>{{STORY_DATA}}</body></html>',
        }) +
        ');',
    );
    return formats;
  }

  it('compileToFile rejects with the reason and keeps the previous output when aborted during format resolution', async () => {
    const root = makeTmpDir();
    const formats = localFormat(root);
    const outFile = join(root, 'story.html');
    writeFileSync(outFile, 'LAST GOOD OUTPUT');
    const controller = new AbortController();
    const reason = new Error('stop it');

    const pending = compileToFile({
      sources: [STORY],
      outFile,
      signal: controller.signal,
      formatId: 'review-1',
      formatPaths: [formats],
      useTweegoPath: false,
      noRemote: true,
    });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(readFileSync(outFile, 'utf8')).toBe('LAST GOOD OUTPUT');
  });

  it('compile rejects with the reason when aborted during format resolution', async () => {
    const root = makeTmpDir();
    const formats = localFormat(root);
    const controller = new AbortController();
    const reason = new Error('stop it');

    const pending = compile({
      sources: [STORY],
      signal: controller.signal,
      formatId: 'review-1',
      formatPaths: [formats],
      useTweegoPath: false,
      noRemote: true,
    });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('compileIncremental rejects when aborted during format resolution', async () => {
    const root = makeTmpDir();
    const formats = localFormat(root);
    const controller = new AbortController();

    const pending = compileIncremental(
      {
        sources: [STORY],
        signal: controller.signal,
        formatId: 'review-1',
        formatPaths: [formats],
        useTweegoPath: false,
        noRemote: true,
      },
      new Map(),
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('compileToFile keeps the previous output when aborted right after the build, before the write', async () => {
    const root = makeTmpDir();
    const outFile = join(root, 'story.twee');
    writeFileSync(outFile, 'LAST GOOD OUTPUT');
    const controller = new AbortController();
    const reason = new Error('late stop');

    // No format is resolved for Twee output, so the build finishes without an asynchronous wait
    // and only the continuation that writes the file is left to run.
    const pending = compileToFile({ sources: [STORY], outFile, outputMode: 'twee3', signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(readFileSync(outFile, 'utf8')).toBe('LAST GOOD OUTPUT');
  });

  it('still compiles and writes when the signal is never aborted', async () => {
    const root = makeTmpDir();
    const outFile = join(root, 'story.twee');
    const controller = new AbortController();
    await compileToFile({ sources: [STORY], outFile, outputMode: 'twee3', signal: controller.signal });
    expect(readFileSync(outFile, 'utf8')).toContain('Hello');
  });
});

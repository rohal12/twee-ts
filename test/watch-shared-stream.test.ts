/**
 * Watch mode where every folder watch reports through one stream that each start or close of a watch replaces, as
 * libuv's FSEvents stream on macOS does (#436): the changes made while it is replaced are reported to no watch. The
 * fs.watch below loses every event for a while after any watch starts or closes, on any platform, and the watch's
 * output must still equal a fresh compile once the stream runs again.
 *
 * The sequence is the counterexample of CI run 38136948300 (macOS): the build after `l2.tw` was linked started the
 * watches on the link's target, and the folder `d3` with its file, created right after, never showed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { FSWatcher, WatchListener } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, watchWithWriteFilter } from '../src/compiler.js';
import type { CompileOptions, CompileResult, InlineSource } from '../src/types.js';

/** How long the emulated stream reports nothing after a watch starts or closes. */
const REPLACING_MS = 300;

const stream = vi.hoisted(() => ({ replacedUntil: 0, lost: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const replace = (): void => {
    stream.replacedUntil = Date.now() + REPLACING_MS;
  };
  const watch = (
    path: string,
    optionsOrListener: { recursive?: boolean } | WatchListener<string>,
    maybeListener?: WatchListener<string>,
  ): FSWatcher => {
    const [options, listener] =
      typeof optionsOrListener === 'function' ? [{}, optionsOrListener] : [optionsOrListener, maybeListener];
    replace();
    const watcher = actual.watch(path, options, (event, filename) => {
      if (Date.now() < stream.replacedUntil) stream.lost++;
      else listener?.(event, filename);
    });
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      replace();
      close();
    };
    return watcher;
  };
  return { ...actual, watch };
});

const LINKS = process.platform !== 'win32';

const STORY_DATA: InlineSource = {
  filename: 'StoryData.tw',
  content: ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nStart\n',
};

const passage = (name: string, text: string): string => `:: P_${name.replace(/\W/g, '_')}\n${text}\n`;

let root: string;
let src: string;
let outside: string;
let outFile: string;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-watch-stream-')));
  src = join(root, 'src');
  outside = join(root, 'outside');
  outFile = join(root, 'out.html');
  mkdirSync(src);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const readOut = (): string => (existsSync(outFile) ? readFileSync(outFile, 'utf-8') : '');

describe.skipIf(!LINKS)('watch with one event stream that starting or closing a watch replaces (#436)', () => {
  it('equals a fresh compile after the macOS counterexample of run 38136948300', { timeout: 60_000 }, async () => {
    writeFileSync(join(src, 'a.tw'), passage('a.tw', 'zero'));
    mkdirSync(join(src, 'd1'));
    writeFileSync(join(src, 'd1', 'c.tw'), passage('d1/c.tw', 'zero'));
    for (const target of ['t1.tw', 't2.tw']) writeFileSync(join(outside, target), passage(`target ${target}`, 'zero'));
    symlinkSync(join(outside, 't1.tw'), join(src, 'l1.tw'));

    const builds: CompileResult[] = [];
    const errors: Error[] = [];
    const options: CompileOptions = {
      sources: [STORY_DATA, src],
      outputMode: 'twine2-archive',
      sourceInfo: true,
    };
    const controller = watchWithWriteFilter(
      { ...options, outFile, onBuild: (r) => builds.push(r), onError: (e) => errors.push(e) },
      () => true,
      { timing: { debounceMs: 30, maxWaitMs: 120 }, stream: { shared: true } },
    );
    /** Waits until the watch's output is a fresh compile of the tree. */
    const converges = async (after: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      let expected = (await compile(options)).output;
      while (readOut() !== expected) {
        if (Date.now() > deadline) throw new Error(`Timed out after ${after}: watch wrote ${readOut()}`);
        await new Promise((r) => setTimeout(r, 20));
        expected = (await compile(options)).output;
      }
      expect(readOut()).toBe(expected);
    };
    try {
      await converges('the initial build');
      const lostBefore = stream.lost;
      symlinkSync(join(outside, 't2.tw'), join(src, 'l2.tw'));
      await converges('l2.tw linked');
      mkdirSync(join(src, 'd3'));
      writeFileSync(join(src, 'd3', 'in.tw'), passage('d3/in', 'one'));
      await converges('d3 made with a file');
      expect(readOut()).toContain('P_d3_in');
      rmSync(join(src, 'l1.tw'));
      symlinkSync(join(outside, 't2.tw'), join(src, 'l1.tw'));
      await converges('l1.tw retargeted');
      // The emulation did lose events: the output came from the builds that followed the stream's replacement.
      expect(stream.lost).toBeGreaterThan(lostBefore);
      expect(errors).toEqual([]);
    } finally {
      controller.abort();
    }
  });
});

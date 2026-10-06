import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { watch, watchWithWriteFilter } from '../src/compiler.js';
import type { CompileResult } from '../src/types.js';
import type * as NodeFs from 'node:fs';

type Listener = (event: string, filename: string | null) => void;

const fake = vi.hoisted(() => ({ listeners: [] as { path: string; listener: Listener }[] }));

// fs.watch records its listeners instead of asking the OS, so the tests deliver the events themselves.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    watch: (path: string, _options: unknown, listener: Listener) => {
      fake.listeners.push({ path, listener });
      return Object.assign(new EventEmitter(), { close: () => {} }) as unknown as FSWatcher;
    },
  };
});

const FORMATS = join(__dirname, 'fixtures', 'storyformats');
const COMPILE = {
  formatId: 'test-format-1',
  formatPaths: [FORMATS],
  useTweegoPath: false,
  noRemote: true,
  outputMode: 'twine2-archive',
} as const;

const story = (text: string): string =>
  `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n${text}\n`;

const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout'] };

/** Delivers an event to every watch started on `path`. */
function emit(path: string, filename: string | null): void {
  const targets = fake.listeners.filter((l) => l.path === path);
  if (targets.length === 0) throw new Error(`no watcher on ${path}`);
  for (const target of targets) target.listener('change', filename);
}

let root: string;
let src: string;
let outFile: string;
let controller: AbortController | undefined;

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  root = mkdtempSync(join(tmpdir(), 'twee-ts-watch-gaps-'));
  src = join(root, 'src');
  mkdirSync(src);
  outFile = join(root, 'out.html');
  writeFileSync(join(src, 'a.tw'), story('A_ONE'));
  writeFileSync(join(src, 'b.tw'), ':: B\nB_ONE\n');
});

afterEach(() => {
  controller?.abort();
  controller = undefined;
  fake.listeners.length = 0;
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

/** A promise for the next build the watch reports. */
function nextBuild(): { promise: Promise<CompileResult>; onBuild: (r: CompileResult) => void } {
  let onBuild: (r: CompileResult) => void = () => {};
  const promise = new Promise<CompileResult>((done) => (onBuild = done));
  return { promise, onBuild };
}

describe('watch with an already aborted signal', () => {
  it('returns a stopped watch that reports nothing', async () => {
    const outer = new AbortController();
    outer.abort(new Error('stop'));
    const built: CompileResult[] = [];
    const errors: Error[] = [];
    let idle: () => void = () => {};
    const settled = new Promise<void>((done) => (idle = done));
    controller = watchWithWriteFilter(
      {
        ...COMPILE,
        sources: [src],
        outFile,
        signal: outer.signal,
        onBuild: (r) => built.push(r),
        onError: (e) => errors.push(e),
      },
      () => true,
      {
        onIdle: () => {
          idle();
        },
      },
    );
    await settled;

    expect(controller.signal.aborted).toBe(true);
    expect(built).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('watch and a hook that fails', () => {
  it('reports what the idle hook throws to onError', async () => {
    const errors: Error[] = [];
    const seen = new Promise<void>((done) => {
      const origin = errors.push.bind(errors);
      errors.push = (...e: Error[]) => {
        const n = origin(...e);
        done();
        return n;
      };
    });
    controller = watchWithWriteFilter(
      { ...COMPILE, sources: [src], outFile, onError: (e) => errors.push(e) },
      () => true,
      {
        onIdle: () => {
          throw new Error('idle failed');
        },
      },
    );
    await seen;

    expect(errors.map((e) => e.message)).toEqual(['idle failed']);
  });

  it('wraps a non-Error thrown by onBuild in an Error for onError', async () => {
    const errors: Error[] = [];
    const seen = new Promise<void>((done) => {
      controller = undefined;
      void watch({
        ...COMPILE,
        sources: [src],
        outFile,
        onBuild: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'plain string';
        },
        onError: (e) => {
          errors.push(e);
          done();
        },
      }).then((c) => (controller = c));
    });
    await seen;

    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]?.message).toBe('plain string');
  });
});

describe('watch with changes made while a build is running', () => {
  it('folds a pending edit and a rebuild of the whole source folder into one follow-up build', async () => {
    const builds: string[] = [];
    const second = nextBuild();
    let first = true;
    controller = await watch({
      ...COMPILE,
      sources: [src],
      outFile,
      onBuild: (result) => {
        builds.push(result.output);
        if (!first) {
          second.onBuild(result);
          return;
        }
        first = false;
        // The first build is still being delivered, so what follows queues behind it.
        writeFileSync(join(src, 'a.tw'), story('A_TWO'));
        emit(src, 'a.tw');
        vi.advanceTimersByTime(500);
        // The folder is replaced: a full rebuild is called for, which absorbs the queued edit.
        renameSync(src, join(root, 'src-old')); // kept, so the new folder cannot reuse its inode
        mkdirSync(src);
        writeFileSync(join(src, 'a.tw'), story('A_THREE'));
        writeFileSync(join(src, 'b.tw'), ':: B\nB_TWO_EDITED\n');
        emit(src, null);
        vi.advanceTimersByTime(500);
      },
    });
    const result = await second.promise;

    expect(builds).toHaveLength(2);
    expect(result.output).toContain('A_THREE');
    expect(result.output).toContain('B_TWO_EDITED');
    expect(readFileSync(outFile, 'utf-8')).toContain('A_THREE');
  });
});

describe('watch with exclude and a module', () => {
  it('still rebuilds for a module that an exclude glob matches', async () => {
    const moduleFile = join(root, 'mod.js');
    writeFileSync(moduleFile, 'var a = 1;');
    const builds: CompileResult[] = [];
    const initial = nextBuild();
    const rebuilt = nextBuild();
    controller = await watch({
      ...COMPILE,
      outputMode: 'html',
      sources: [src],
      modules: [moduleFile],
      exclude: ['**/*.js'],
      outFile,
      onBuild: (r) => {
        builds.push(r);
        (builds.length === 1 ? initial : rebuilt).onBuild(r);
      },
    });
    await initial.promise;

    writeFileSync(moduleFile, 'var a = 2;');
    emit(root, 'mod.js');
    vi.advanceTimersByTime(500);
    const result = await rebuilt.promise;

    expect(builds).toHaveLength(2);
    expect(result.output).toContain('var a = 2;');
  });
});

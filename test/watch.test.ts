import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { EventEmitter } from 'node:events';
import { watchFilesystem } from '../src/filesystem.js';
import type { WatchHandle } from '../src/filesystem.js';
import { watch, watchWithWriteFilter } from '../src/compiler.js';
import type { CompileResult } from '../src/types.js';
import type * as NodeFs from 'node:fs';

type WatchListener = (event: string, filename: string | null) => void;

/** A watch the fake fs.watch started: on the folder that was at `path` when it started. */
interface FakeWatcher {
  readonly path: string;
  readonly recursive: boolean;
  /** The watched folder's identity (device and inode) when the watch started. */
  readonly identity: string;
  readonly listener: WatchListener;
  readonly emitter: EventEmitter;
  closed: boolean;
}

const fake = vi.hoisted(() => ({
  watchers: [] as FakeWatcher[],
  /** Paths fs.watch fails on, with the error code it throws. */
  failing: new Map<string, string>(),
  identityOf: (_path: string): string | undefined => undefined,
}));

// fs.watch records each watcher's listener instead of asking the OS, so the tests deliver
// the events themselves and don't depend on how fast or reliably the OS reports them. As the
// OS does, a watch follows the folder it started on, not the path: once that folder is
// deleted or replaced, events for the path no longer reach it.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const { EventEmitter } = await import('node:events');
  fake.identityOf = (path: string): string | undefined => {
    try {
      const stats = actual.statSync(path);
      return `${stats.dev}:${stats.ino}`;
    } catch {
      return undefined;
    }
  };
  return {
    ...actual,
    watch: (pathname: string, options: { recursive?: boolean }, listener: WatchListener) => {
      const code = fake.failing.get(pathname);
      const identity = fake.identityOf(pathname);
      if (code !== undefined || identity === undefined) {
        const error = code ?? 'ENOENT';
        throw Object.assign(new Error(`${error}: fake fs.watch failed, watch '${pathname}'`), { code: error });
      }
      const emitter = new EventEmitter();
      const watcher: FakeWatcher = {
        path: pathname,
        recursive: options.recursive ?? false,
        identity,
        listener,
        emitter,
        closed: false,
      };
      fake.watchers.push(watcher);
      return Object.assign(emitter, {
        close: () => {
          watcher.closed = true;
        },
      });
    },
  };
});

/** The open watches on the folder now at `path`. */
function liveWatchers(path: string): FakeWatcher[] {
  const identity = fake.identityOf(path);
  return fake.watchers.filter((w) => !w.closed && w.path === path && w.identity === identity);
}

/** Delivers a change event to the watches on the folder at `root`, for `filename` relative to it. */
function emit(root: string, filename: string): void {
  const watchers = liveWatchers(root);
  if (watchers.length === 0) throw new Error(`no watcher on ${root}`);
  for (const w of watchers) w.listener('change', filename);
}

/**
 * Delivers an event to the watches still open on a folder that was at `path` but has since
 * been deleted or moved, as the OS does once for the folder itself.
 */
function emitToOld(path: string, filename: string): void {
  const identity = fake.identityOf(path);
  const watchers = fake.watchers.filter((w) => !w.closed && w.path === path && w.identity !== identity);
  if (watchers.length === 0) throw new Error(`no watcher on a former ${path}`);
  for (const w of watchers) w.listener('rename', filename);
}

/** Emits an 'error' on every open watch on `path`, current or former folder. */
function emitError(path: string, error: Error): void {
  for (const w of fake.watchers.filter((x) => !x.closed && x.path === path)) w.emitter.emit('error', error);
}

const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout'] };

afterEach(() => {
  vi.useRealTimers();
  fake.watchers.length = 0;
  fake.failing.clear();
});

describe('watchFilesystem', () => {
  let root: string;
  let story: string;

  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    root = mkdtempSync(join(tmpdir(), 'twee-ts-watchfs-'));
    story = join(root, 'story');
    mkdirSync(story);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** `filename` relative to the working directory, as the watcher reports it. */
  const rel = (filename: string): string => relative(process.cwd(), filename);

  it('schedules no rebuild for a file the ignore test rejects', () => {
    const builds: (ReadonlySet<string> | undefined)[] = [];
    const handle = watchFilesystem(
      [story],
      join(root, 'out.html'),
      (files) => builds.push(files),
      (file) => file.endsWith('.png'),
    );
    try {
      expect(builds).toEqual([undefined]); // the initial full build
      emit(story, join('art', 'scene.png'));
      expect(vi.getTimerCount()).toBe(0);
      emit(story, 'start.tw');
      vi.advanceTimersByTime(500);
      expect(builds).toEqual([undefined, new Set([rel(join(story, 'start.tw'))])]);
    } finally {
      handle.close();
    }
  });

  it('asks the ignore test about the path relative to the working directory', () => {
    const asked: string[] = [];
    const handle = watchFilesystem(
      [story],
      join(root, 'out.html'),
      () => {},
      (file) => {
        asked.push(file);
        return false;
      },
    );
    try {
      emit(story, join('art', 'scene.png'));
      expect(asked).toEqual([rel(join(story, 'art', 'scene.png'))]);
    } finally {
      handle.close();
    }
  });

  describe('with a watched path that goes away or is not there yet', () => {
    let builds: (ReadonlySet<string> | undefined)[];
    let errors: Error[];
    let handle: WatchHandle | undefined;

    beforeEach(() => {
      builds = [];
      errors = [];
      writeFileSync(join(story, 'a.tw'), ':: A\nOne\n');
    });

    afterEach(() => {
      handle?.close();
      handle = undefined;
    });

    function start(paths: string[]): void {
      handle = watchFilesystem(
        paths,
        join(root, 'out.html'),
        (files) => builds.push(files),
        () => false,
        (error) => errors.push(error),
      );
    }

    /** Lets the debounce run out; returns the builds it started. */
    function settle(): (ReadonlySet<string> | undefined)[] {
      const before = builds.length;
      vi.advanceTimersByTime(500);
      return builds.slice(before);
    }

    it('follows a source folder that is deleted and created again', () => {
      start([story]);
      rmSync(story, { recursive: true });
      emitToOld(story, ''); // what the OS reports to a watch on a deleted folder
      emit(root, 'story');
      expect(settle()).toEqual([undefined]); // a full build without the folder
      expect(liveWatchers(story)).toEqual([]);

      mkdirSync(story);
      writeFileSync(join(story, 'a.tw'), ':: A\nTwo\n');
      emit(root, 'story');
      expect(settle()).toEqual([undefined]); // a full build: files created before the new watch went unseen

      emit(story, 'a.tw');
      expect(settle()).toEqual([new Set([rel(join(story, 'a.tw'))])]);
      expect(errors).toEqual([]);
    });

    it('follows a source folder that is renamed away and replaced', () => {
      start([story]);
      renameSync(story, join(root, 'story-old'));
      emit(root, 'story');
      emit(root, 'story-old');
      expect(settle()).toEqual([undefined]);

      mkdirSync(story);
      writeFileSync(join(story, 'a.tw'), ':: A\nTwo\n');
      emit(root, 'story');
      expect(settle()).toEqual([undefined]);

      emit(story, 'a.tw');
      expect(settle()).toEqual([new Set([rel(join(story, 'a.tw'))])]);
      // The old folder is no longer a source: nothing watches it.
      expect(fake.watchers.filter((w) => !w.closed && w.path === story && w.recursive)).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it('waits for a source folder that does not exist yet', () => {
      const later = join(root, 'later');
      start([later]);
      expect(builds).toEqual([undefined]);
      expect(errors).toEqual([]);

      mkdirSync(later);
      writeFileSync(join(later, 'a.tw'), ':: A\nOne\n');
      emit(root, 'later');
      expect(settle()).toEqual([undefined]);

      emit(later, 'a.tw');
      expect(settle()).toEqual([new Set([rel(join(later, 'a.tw'))])]);
    });

    it('waits for a missing source folder whose parent folders are missing too', () => {
      const deep = join(root, 'one', 'two', 'deep');
      start([deep]);

      mkdirSync(join(root, 'one'));
      emit(root, 'one');
      expect(settle()).toEqual([]); // nothing to build yet; the wait moves down a level

      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, 'a.tw'), ':: A\nOne\n');
      emit(join(root, 'one'), 'two');
      expect(settle()).toEqual([undefined]);

      emit(deep, 'a.tw');
      expect(settle()).toEqual([new Set([rel(join(deep, 'a.tw'))])]);
      expect(errors).toEqual([]);
    });

    it('follows a watched file whose folder is deleted and created again', () => {
      const head = join(root, 'elsewhere', 'head.txt');
      mkdirSync(dirname(head));
      writeFileSync(head, 'one');
      start([story, head]);

      rmSync(dirname(head), { recursive: true });
      emitToOld(dirname(head), 'elsewhere'); // the OS names the deleted folder itself
      expect(settle()).toEqual([undefined]);

      mkdirSync(dirname(head));
      writeFileSync(head, 'two');
      emit(root, 'elsewhere');
      expect(settle()).toEqual([undefined]);

      emit(dirname(head), 'head.txt');
      expect(settle()).toEqual([new Set([rel(head)])]);
      expect(errors).toEqual([]);
    });

    it('survives an error from a watch and follows the folder once it is back', () => {
      start([story]);
      rmSync(story, { recursive: true });
      // Windows reports a deleted watched folder as an error (EPERM) on its watch.
      expect(() => {
        emitError(story, Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
      }).not.toThrow();
      expect(settle()).toEqual([undefined]);

      mkdirSync(story);
      emit(root, 'story');
      expect(settle()).toEqual([undefined]);
      emit(story, 'a.tw');
      expect(settle()).toEqual([new Set([rel(join(story, 'a.tw'))])]);
      // The error is explained by the folder going away: nothing to report.
      expect(errors).toEqual([]);
    });

    it('reports a source folder that cannot be watched, once', () => {
      fake.failing.set(story, 'EACCES');
      start([story]);
      expect(builds).toEqual([undefined]);
      expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/^Cannot watch .*story.*EACCES/)]);

      // Later events in its parent folder try again and stay quiet while it still fails.
      emit(root, 'story');
      expect(errors).toHaveLength(1);

      // Once it can be watched, it is: with a full build, as changes in it went unseen.
      fake.failing.delete(story);
      emit(root, 'story');
      expect(settle()).toEqual([undefined]);
      emit(story, 'a.tw');
      expect(settle()).toEqual([new Set([rel(join(story, 'a.tw'))])]);
      expect(errors).toHaveLength(1);
    });
  });
});

/** The temp folder of the current test in the describe blocks below; each makes a fresh one per test. */
let tmpDir: string;

/** Makes a fresh temp folder for the current test and returns it. */
function freshTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-watch-'));
  return tmpDir;
}

/**
 * An exclude glob for `pattern` inside tmpDir. Exclude globs are read relative to
 * the working directory, and tmpDir lies outside it, where `**` alone doesn't reach.
 */
function inTmp(pattern: string): string {
  return `${relative(process.cwd(), tmpDir).replace(/\\/g, '/')}/${pattern}`;
}

const FORMATS = join(__dirname, 'fixtures', 'storyformats');
const COMPILE = { formatId: 'test-format-1', formatPaths: [FORMATS], useTweegoPath: false, noRemote: true };

const STORY = `:: StoryData
{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}

:: StoryTitle
Watch Test

:: Start
Hello from the story.
`;

/** Hands out watch-mode builds in order, waiting for the next one when none is ready. */
function buildQueue() {
  const ready: CompileResult[] = [];
  const waiting: ((result: CompileResult) => void)[] = [];
  const errors: Error[] = [];
  return {
    errors,
    onBuild: (result: CompileResult): void => {
      const waiter = waiting.shift();
      if (waiter) waiter(result);
      else ready.push(result);
    },
    onError: (error: Error): void => {
      errors.push(error);
    },
    next(): Promise<CompileResult> {
      const result = ready.shift();
      return result ? Promise.resolve(result) : new Promise((done) => waiting.push(done));
    },
  };
}

describe('watch with exclude', () => {
  let story: string;
  let outFile: string;
  let controller: AbortController | undefined;

  beforeEach(() => {
    story = join(freshTmpDir(), 'story');
    outFile = join(tmpDir, 'out.html');
    mkdirSync(join(story, 'art'), { recursive: true });
    writeFileSync(join(story, 'start.tw'), STORY);
    writeFileSync(join(story, 'art', 'scene.png'), Buffer.alloc(16, 7));
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('leaves excluded files out of every build and rebuilds for none of their changes', async () => {
    const builds = buildQueue();
    controller = await watch({
      ...COMPILE,
      sources: [story],
      outFile,
      exclude: [inTmp('**/*.png')],
      onBuild: builds.onBuild,
      onError: builds.onError,
    });
    const first = await builds.next();
    expect(first.stats.files.some((f) => f.endsWith('.png'))).toBe(false);
    expect(readFileSync(outFile, 'utf-8')).not.toContain('Twine.image');

    vi.useFakeTimers(FAKE_TIMERS);
    writeFileSync(join(story, 'art', 'scene.png'), Buffer.alloc(32, 8));
    emit(story, join('art', 'scene.png'));
    expect(vi.getTimerCount()).toBe(0);

    writeFileSync(join(story, 'more.tw'), ':: More\nMore text.\n');
    emit(story, 'more.tw');
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    const second = await builds.next();
    expect(second.output).toContain('More text.');
    expect(second.output).not.toContain('Twine.image');
    expect(second.stats.files.some((f) => f.endsWith('.png'))).toBe(false);
    expect(builds.errors).toEqual([]);
  });

  it('still rebuilds for a module that an exclude glob also matches', async () => {
    const module = join(story, 'lib', 'mod.js');
    mkdirSync(dirname(module));
    writeFileSync(module, 'window.modMarker = 1;');
    const builds = buildQueue();
    controller = await watch({
      ...COMPILE,
      sources: [story],
      outFile,
      exclude: [inTmp('**/lib/**')],
      modules: [module],
      onBuild: builds.onBuild,
      onError: builds.onError,
    });
    const first = await builds.next();
    expect(first.output).toContain('<script id="script-module-mod" type="text/javascript">window.modMarker = 1;');
    expect(first.stats.files.some((f) => f.endsWith('mod.js'))).toBe(false);

    vi.useFakeTimers(FAKE_TIMERS);
    writeFileSync(module, 'window.modMarker = 2;');
    emit(story, join('lib', 'mod.js'));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    expect((await builds.next()).output).toContain('window.modMarker = 2;');
    expect(builds.errors).toEqual([]);
  });
});

describe('watch with the output inside a source folder', () => {
  let story: string;
  let start: string;
  let outFile: string;
  let controller: AbortController | undefined;

  beforeEach(() => {
    story = join(freshTmpDir(), 'story');
    start = join(story, 'start.tw');
    outFile = join(story, 'z-output.html');
    mkdirSync(story);
    writeFileSync(start, STORY.replace('Hello from the story.', 'ORIGINAL_CONTENT\n\n:: Gone\nSOON_DELETED'));
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not load its own earlier output back as a source', async () => {
    const builds = buildQueue();
    controller = await watch({
      sources: [story],
      outputMode: 'twine2-archive',
      outFile,
      onBuild: builds.onBuild,
      onError: builds.onError,
    });
    await builds.next();

    vi.useFakeTimers(FAKE_TIMERS);
    writeFileSync(start, STORY.replace('Hello from the story.', 'UPDATED_CONTENT'));
    emit(story, 'start.tw');
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    const second = await builds.next();
    expect(second.output).toContain('UPDATED_CONTENT');
    expect(second.output).not.toContain('ORIGINAL_CONTENT');
    expect(second.output).not.toContain('SOON_DELETED');
    expect(second.stats.files.some((f) => f.endsWith('z-output.html'))).toBe(false);
    expect(second.diagnostics).toEqual([]);
    expect(builds.errors).toEqual([]);
  });
});

describe('watch and a save that keeps the modification time', () => {
  let story: string;
  let start: string;
  let outFile: string;
  const stamp = new Date(1_700_000_000_000);
  let controller: AbortController | undefined;

  beforeEach(() => {
    story = join(freshTmpDir(), 'story');
    start = join(story, 'start.tw');
    outFile = join(tmpDir, 'out.html');
    mkdirSync(story);
    writeFileSync(start, STORY.replace('Hello from the story.', 'ORIGINAL_CONTENT'));
    utimesSync(start, stamp, stamp);
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rebuilds the saved file with its new content', async () => {
    const builds = buildQueue();
    controller = await watch({
      sources: [story],
      outputMode: 'twine2-archive',
      outFile,
      onBuild: builds.onBuild,
      onError: builds.onError,
    });
    expect((await builds.next()).output).toContain('ORIGINAL_CONTENT');

    vi.useFakeTimers(FAKE_TIMERS);
    writeFileSync(start, STORY.replace('Hello from the story.', 'UPDATED_CONTENT'));
    utimesSync(start, stamp, stamp);
    emit(story, 'start.tw');
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    const second = await builds.next();
    expect(second.output).toContain('UPDATED_CONTENT');
    expect(second.output).not.toContain('ORIGINAL_CONTENT');
    expect(readFileSync(outFile, 'utf-8')).toContain('UPDATED_CONTENT');
    expect(builds.errors).toEqual([]);
  });
});

describe('watch on individual files', () => {
  let story: string;
  let start: string;
  let outFile: string;
  let controller: AbortController | undefined;

  beforeEach(() => {
    story = join(freshTmpDir(), 'story');
    start = join(story, 'start.tw');
    outFile = join(tmpDir, 'out.html');
    mkdirSync(story);
    writeFileSync(start, STORY);
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports a change to a watched file under the path source discovery gives it', () => {
    const builds: (ReadonlySet<string> | undefined)[] = [];
    vi.useFakeTimers(FAKE_TIMERS);
    const handle = watchFilesystem([start], outFile, (files) => builds.push(files));
    try {
      // The OS names only the file, relative to the folder it is watched through.
      emit(story, 'start.tw');
      emit(story, 'other.tw'); // not watched
      vi.advanceTimersByTime(500);
      expect(builds).toEqual([undefined, new Set([relative(process.cwd(), start)])]);
    } finally {
      handle.close();
    }
  });

  it('rebuilds a story whose source is a single file with its new content', async () => {
    const builds = buildQueue();
    controller = await watch({
      sources: [start],
      outputMode: 'twine2-archive',
      outFile,
      onBuild: builds.onBuild,
      onError: builds.onError,
    });
    expect((await builds.next()).output).toContain('Hello from the story.');

    vi.useFakeTimers(FAKE_TIMERS);
    writeFileSync(start, STORY.replace('Hello from the story.', 'UPDATED_CONTENT'));
    emit(story, 'start.tw');
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    const second = await builds.next();
    expect(second.output).toContain('UPDATED_CONTENT');
    expect(second.output).not.toContain('Hello from the story.');
    expect(builds.errors).toEqual([]);
  });

  describe('the head file', () => {
    let elsewhere: string;
    let headFile: string;
    const meta = (content: string): string => `<meta name="watch-test" content="${content}">`;

    beforeEach(() => {
      elsewhere = join(tmpDir, 'elsewhere');
      headFile = join(elsewhere, 'head.txt');
      mkdirSync(elsewhere);
      writeFileSync(headFile, meta('original'));
    });

    it('rebuilds when a head file outside every source folder changes, whatever its type', async () => {
      const builds = buildQueue();
      controller = await watch({
        ...COMPILE,
        sources: [story],
        headFile,
        outFile,
        onBuild: builds.onBuild,
        onError: builds.onError,
      });
      expect((await builds.next()).output).toContain(meta('original'));

      vi.useFakeTimers(FAKE_TIMERS);
      writeFileSync(headFile, meta('HEAD_UPDATED'));
      emit(elsewhere, 'head.txt');
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(500);
      vi.useRealTimers();

      const second = await builds.next();
      expect(second.output).toContain(meta('HEAD_UPDATED'));
      expect(readFileSync(outFile, 'utf-8')).toContain(meta('HEAD_UPDATED'));
      expect(builds.errors).toEqual([]);
    });

    it('rebuilds for a head file inside a source folder that an exclude glob matches', async () => {
      const inside = join(story, 'head.txt');
      writeFileSync(inside, meta('original'));
      const builds = buildQueue();
      controller = await watch({
        ...COMPILE,
        sources: [story],
        headFile: inside,
        exclude: [inTmp('**/head.txt')],
        outFile,
        onBuild: builds.onBuild,
        onError: builds.onError,
      });
      await builds.next();

      vi.useFakeTimers(FAKE_TIMERS);
      writeFileSync(inside, meta('HEAD_UPDATED'));
      emit(story, 'head.txt');
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(500);
      vi.useRealTimers();

      expect((await builds.next()).output).toContain(meta('HEAD_UPDATED'));
      expect(builds.errors).toEqual([]);
    });
  });
});

describe('watch with a build still in flight', () => {
  let story: string;
  let start: string;
  let outFile: string;
  const FORMAT_URL = 'https://formats.invalid/format.js';
  const FORMAT_JS = `window.storyFormat(${JSON.stringify({
    name: 'WatchSerial',
    version: '1.0.0',
    source: '<html><head></head><body>{{STORY_DATA}}</body></html>',
  })});`;
  const SLOW_FORMAT = { formatId: 'watchserial-1', formatUrls: [FORMAT_URL], useTweegoPath: false };
  const source = (text: string): string =>
    `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n${text}\n`;
  const startText = (result: CompileResult): string | undefined =>
    result.story.passages.find((p) => p.name === 'Start')?.text;

  let controller: AbortController | undefined;
  let origCacheHome: string | undefined;

  /**
   * Answers requests for FORMAT_URL, holding back the first until `releaseFirst()`, so the initial
   * build stays in flight (as one waiting for a slow remote format does). `releaseFirst(false)`
   * fails that request, which leaves nothing in the download cache: any later build fetches again.
   */
  function stubSlowFormat() {
    let releaseFirst: (ok: boolean) => void = () => {};
    let notifyFirst: () => void = () => {};
    const gate = new Promise<boolean>((done) => (releaseFirst = done));
    const firstRequested = new Promise<void>((done) => (notifyFirst = done));
    const state = { requests: 0, inFlight: 0, maxInFlight: 0 };
    vi.stubGlobal('fetch', async (url: unknown) => {
      // A failed format request moves on to the format indices, which have nothing.
      if (String(url) !== FORMAT_URL) return new Response('', { status: 404 });
      state.requests++;
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.requests === 1) {
          notifyFirst();
          if (!(await gate)) return new Response('', { status: 404 });
        }
        return new Response(FORMAT_JS);
      } finally {
        state.inFlight--;
      }
    });
    return {
      state,
      firstRequested,
      releaseFirst: (ok = true) => {
        releaseFirst(ok);
      },
    };
  }

  /**
   * Answers requests for FORMAT_URL, holding back each one until the test releases it by its
   * number (from 1): `release(n, true)` answers with the format, `release(n, false)` fails it.
   */
  function stubHeldFormat() {
    const held: ((ok: boolean) => void)[] = [];
    const waiting: { readonly count: number; readonly done: () => void }[] = [];
    const state = { inFlight: 0, maxInFlight: 0 };
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url) !== FORMAT_URL) return new Response('', { status: 404 });
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        const ok = await new Promise<boolean>((release) => {
          held.push(release);
          for (const w of waiting.filter((x) => x.count <= held.length)) w.done();
        });
        return ok ? new Response(FORMAT_JS) : new Response('', { status: 404 });
      } finally {
        state.inFlight--;
      }
    });
    return {
      state,
      /** Resolves once `count` format requests have been made. */
      requested: (count: number): Promise<void> =>
        held.length >= count ? Promise.resolve() : new Promise((done) => waiting.push({ count, done })),
      release: (n: number, ok: boolean): void => {
        const release = held[n - 1];
        if (!release) throw new Error(`format request ${n} has not been made`);
        release(ok);
      },
    };
  }

  /** Delivers a change to `filename` in the story folder and lets its debounce run out. */
  function change(filename: string): void {
    vi.useFakeTimers(FAKE_TIMERS);
    emit(story, filename);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
  }

  beforeEach(() => {
    story = join(freshTmpDir(), 'story');
    start = join(story, 'start.tw');
    outFile = join(tmpDir, 'out.html');
    mkdirSync(story);
    writeFileSync(start, source('OLD_CONTENT'));
    origCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = join(tmpDir, 'cache');
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    vi.unstubAllGlobals();
    if (origCacheHome !== undefined) process.env['XDG_CACHE_HOME'] = origCacheHome;
    else delete process.env['XDG_CACHE_HOME'];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delivers a slow build, then builds the changes made during it once, after it', async () => {
    const format = stubSlowFormat();
    const builds = buildQueue();
    controller = await watch({
      ...SLOW_FORMAT,
      sources: [story],
      outFile,
      onBuild: builds.onBuild,
      onError: builds.onError,
    });
    await format.firstRequested; // the initial build has read OLD_CONTENT and waits for its format

    // Two changes, in separate debounce windows, while it waits.
    writeFileSync(start, source('NEW_CONTENT'));
    change('start.tw');
    writeFileSync(join(story, 'more.tw'), ':: More\nMORE_CONTENT\n');
    change('more.tw');
    format.releaseFirst();

    // The initial build is written and reported: nothing newer has been written yet.
    const first = await builds.next();
    expect(startText(first)).toBe('OLD_CONTENT');
    expect(first.output).not.toContain('MORE_CONTENT');

    // Then one follow-up build with both changes.
    const second = await builds.next();
    expect(startText(second)).toBe('NEW_CONTENT');
    expect(second.output).toContain('MORE_CONTENT');
    expect(readFileSync(outFile, 'utf-8')).toContain('NEW_CONTENT');
    // One build at a time: the follow-up started after the initial build finished.
    expect(format.state.maxInFlight).toBe(1);

    // The next build reported is the next change's: the two changes made one build, and the
    // parse cache still holds the latest content of the file it doesn't reparse.
    writeFileSync(start, source('NEWEST_CONTENT'));
    change('start.tw');
    const third = await builds.next();
    expect(startText(third)).toBe('NEWEST_CONTENT');
    expect(third.output).toContain('MORE_CONTENT');
    expect(readFileSync(outFile, 'utf-8')).toContain('NEWEST_CONTENT');
    expect(builds.errors).toEqual([]);
  });

  it('reports every build while changes keep arriving during each one', async () => {
    const format = stubHeldFormat();
    const builds = buildQueue();
    controller = await watch({
      ...SLOW_FORMAT,
      sources: [story],
      outFile,
      onBuild: builds.onBuild,
      onError: builds.onError,
    });

    // Each build waits for its format; a change arrives during every one of them.
    for (let n = 1; n <= 3; n++) {
      await format.requested(n);
      writeFileSync(start, source(`EDIT_${n}`));
      change('start.tw');
      format.release(n, false); // the format server fails: nothing is cached, so the next build waits again
      await format.requested(n + 1); // the follow-up build has started...
      // ...after the build before it was reported.
      expect(builds.errors).toHaveLength(n);
      expect(builds.errors[n - 1]?.message).toBe('No story format available for HTML output.');
    }

    format.release(4, true);
    const built = await builds.next();
    expect(startText(built)).toBe('EDIT_3');
    expect(readFileSync(outFile, 'utf-8')).toContain('EDIT_3');
    expect(format.state.maxInFlight).toBe(1);
  });

  it('neither writes nor reports a build that finishes after the watch is aborted, nor starts another', async () => {
    const format = stubSlowFormat();
    const reported: CompileResult[] = [];
    const errors: Error[] = [];
    let idle: () => void = () => {};
    const settled = new Promise<void>((done) => (idle = done));
    controller = watchWithWriteFilter(
      {
        ...SLOW_FORMAT,
        sources: [story],
        outFile,
        onBuild: (result) => reported.push(result),
        onError: (error) => errors.push(error),
      },
      () => true,
      {
        onIdle: () => {
          idle();
        },
      },
    );
    await format.firstRequested;
    writeFileSync(start, source('NEW_CONTENT'));
    change('start.tw');

    controller.abort();
    format.releaseFirst(false); // a build started after this one would fetch the format again
    // The released build, and any build that would follow it, has finished; nothing it did may show.
    await settled;

    expect(reported).toEqual([]);
    expect(errors).toEqual([]);
    expect(existsSync(outFile)).toBe(false);
    expect(format.state.requests).toBe(1);
  });
});

describe('watch with callbacks that throw', () => {
  let root: string;
  let story: string;
  let controller: AbortController | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'twee-ts-watch-throw-'));
    story = join(root, 'story');
    mkdirSync(story);
    writeFileSync(join(story, 'start.tw'), STORY);
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('contains an exception thrown by onError and keeps watching', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const builds = buildQueue();
      const errors: string[] = [];
      controller = await watch({
        sources: [story],
        outputMode: 'twine2-archive',
        outFile: join(root, 'out.html'),
        onBuild(result) {
          builds.onBuild(result);
          throw new Error('onBuild failed');
        },
        onError(error) {
          errors.push(error.message);
          throw new Error('onError failed');
        },
      });
      await builds.next();
      // An unhandled rejection is raised once the microtasks have run, before the next macrotask.
      await new Promise((done) => setImmediate(done));
      expect(rejections).toEqual([]);
      expect(errors).toEqual(['onBuild failed']);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('onError failed'));

      // Watching goes on: a later change still builds.
      vi.useFakeTimers(FAKE_TIMERS);
      writeFileSync(join(story, 'start.tw'), STORY.replace('Hello from the story.', 'UPDATED_CONTENT'));
      emit(story, 'start.tw');
      vi.advanceTimersByTime(500);
      vi.useRealTimers();
      expect((await builds.next()).output).toContain('UPDATED_CONTENT');
      await new Promise((done) => setImmediate(done));
      expect(rejections).toEqual([]);
      expect(errors).toEqual(['onBuild failed', 'onBuild failed']);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('watch with a source folder that goes away or is not there yet', () => {
  let root: string;
  let story: string;
  let outFile: string;
  let controller: AbortController | undefined;
  const source = (text: string): string =>
    `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n${text}\n`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'twee-ts-watch-root-'));
    story = join(root, 'story');
    outFile = join(root, 'out.html');
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  /** Delivers the events `deliver` sends and lets their debounce run out. */
  function events(deliver: () => void): void {
    vi.useFakeTimers(FAKE_TIMERS);
    deliver();
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
  }

  async function startWatch(): Promise<ReturnType<typeof buildQueue>> {
    const builds = buildQueue();
    controller = await watch({
      sources: [story],
      outputMode: 'twine2-archive',
      outFile,
      onBuild: builds.onBuild,
      onError: builds.onError,
    });
    return builds;
  }

  it('builds a source folder that is deleted and created again, and follows edits in it', async () => {
    mkdirSync(story);
    writeFileSync(join(story, 'a.tw'), source('V1'));
    const builds = await startWatch();
    expect((await builds.next()).output).toContain('V1');

    rmSync(story, { recursive: true });
    events(() => {
      emit(root, 'story');
    });
    expect((await builds.next()).output).not.toContain('V1');

    mkdirSync(story);
    writeFileSync(join(story, 'a.tw'), source('V2'));
    events(() => {
      emit(root, 'story');
    });
    expect((await builds.next()).output).toContain('V2');
    expect(readFileSync(outFile, 'utf-8')).toContain('V2');

    writeFileSync(join(story, 'a.tw'), source('V3'));
    events(() => {
      emit(story, 'a.tw');
    });
    expect((await builds.next()).output).toContain('V3');
    expect(readFileSync(outFile, 'utf-8')).toContain('V3');
    expect(builds.errors).toEqual([]);
  });

  it('builds a source folder that is renamed away and replaced from the new folder', async () => {
    mkdirSync(story);
    writeFileSync(join(story, 'a.tw'), source('V1'));
    const builds = await startWatch();
    await builds.next();

    renameSync(story, join(root, 'story-old'));
    mkdirSync(story);
    writeFileSync(join(story, 'a.tw'), source('V2'));
    events(() => {
      emit(root, 'story-old');
      emit(root, 'story');
    });
    expect((await builds.next()).output).toContain('V2');

    writeFileSync(join(story, 'a.tw'), source('V3'));
    events(() => {
      emit(story, 'a.tw');
    });
    expect((await builds.next()).output).toContain('V3');
    expect(readFileSync(outFile, 'utf-8')).toContain('V3');
    expect(builds.errors).toEqual([]);
  });

  it('waits for a source folder that does not exist yet and builds it once it does', async () => {
    const builds = await startWatch();
    const first = await builds.next();
    expect(first.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/^path .*story: ENOENT/) }),
    );

    mkdirSync(story);
    writeFileSync(join(story, 'a.tw'), source('ARRIVED'));
    events(() => {
      emit(root, 'story');
    });
    expect((await builds.next()).output).toContain('ARRIVED');
    expect(readFileSync(outFile, 'utf-8')).toContain('ARRIVED');
    expect(builds.errors).toEqual([]);
  });

  it('reports a source folder that cannot be watched to onError', async () => {
    mkdirSync(story);
    writeFileSync(join(story, 'a.tw'), source('V1'));
    fake.failing.set(story, 'EACCES');
    const builds = await startWatch();
    expect((await builds.next()).output).toContain('V1');
    expect(builds.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^Cannot watch .*story: EACCES/)]);
  });
});

describe('watch with a format download that never answers', () => {
  const STALLED_URL = 'https://formats.invalid/stalled/format.js';
  const source = (format: string, text: string): string =>
    `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"${format}","format-version":"1.0.0"}\n\n:: Start\n${text}\n`;

  let dir = '';
  let story = '';
  let outFile = '';
  let controller: AbortController | undefined;
  let origCacheHome: string | undefined;

  /**
   * Stubs `fetch`: STALLED_URL waits until its signal aborts and then rejects with the reason, as the
   * real fetch does; every other URL answers 404 at once. `stalled` resolves with each STALLED_URL request's signal.
   */
  function stubStalledFormat() {
    const signals: AbortSignal[] = [];
    let notify: (signal: AbortSignal) => void = () => {};
    const firstRequest = new Promise<AbortSignal>((done) => (notify = done));
    const settled: Promise<void>[] = [];
    vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
      if (String(url) !== STALLED_URL) return Promise.resolve(new Response('', { status: 404 }));
      const signal = init?.signal;
      if (!signal) return Promise.reject(new Error('a format request without a signal'));
      signals.push(signal);
      notify(signal);
      const pending = new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const reason: unknown = signal.reason;
            reject(reason);
          },
          { once: true },
        );
      });
      settled.push(
        pending.then(
          () => {},
          () => {},
        ),
      );
      return pending;
    });
    return { signals, firstRequest, settled: () => Promise.all(settled) };
  }

  /** Delivers a change to `filename` in the story folder and lets its debounce run out. */
  function change(filename: string): void {
    vi.useFakeTimers(FAKE_TIMERS);
    emit(story, filename);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-watch-stall-'));
    story = join(dir, 'story');
    outFile = join(dir, 'out.html');
    mkdirSync(story);
    writeFileSync(join(story, 'start.tw'), source('Remote', 'FIRST'));
    origCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = join(dir, 'cache');
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    vi.unstubAllGlobals();
    if (origCacheHome !== undefined) process.env['XDG_CACHE_HOME'] = origCacheHome;
    else delete process.env['XDG_CACHE_HOME'];
    rmSync(dir, { recursive: true, force: true });
  });

  it('abort() cancels the download the build waits on, and nothing is reported', async () => {
    const format = stubStalledFormat();
    const reported: CompileResult[] = [];
    const errors: Error[] = [];
    controller = await watch({
      sources: [story],
      outFile,
      formatUrls: [STALLED_URL],
      formatPaths: [FORMATS],
      useTweegoPath: false,
      onBuild: (result) => reported.push(result),
      onError: (error) => errors.push(error),
    });
    const signal = await format.firstRequest;
    expect(signal.aborted).toBe(false);

    controller.abort();
    expect(signal.aborted).toBe(true);
    await format.settled(); // the request has ended, so nothing keeps the process alive

    expect(reported).toEqual([]);
    expect(errors).toEqual([]);
    expect(existsSync(outFile)).toBe(false);
    expect(format.signals).toHaveLength(1);
  });

  it('times the download out, so a change made meanwhile is built and delivered', async () => {
    const format = stubStalledFormat();
    const builds = buildQueue();
    controller = await watch({
      sources: [story],
      outFile,
      formatUrls: [STALLED_URL],
      formatPaths: [FORMATS],
      useTweegoPath: false,
      formatFetchTimeout: 50,
      onBuild: builds.onBuild,
      onError: builds.onError,
    });
    await format.firstRequest;

    // While the first build waits, the story switches to a format found locally.
    writeFileSync(join(story, 'start.tw'), source('Test Format', 'SECOND'));
    change('start.tw');

    const delivered = await builds.next();
    expect(delivered.story.passages.find((p) => p.name === 'Start')?.text).toBe('SECOND');
    expect(delivered.format?.name).toBe('Test Format');
    expect(readFileSync(outFile, 'utf-8')).toContain('SECOND');
    expect(format.signals[0]?.aborted).toBe(true);
  });

  it('stops watching when the signal in its options aborts', async () => {
    const format = stubStalledFormat();
    const outer = new AbortController();
    controller = await watch({
      sources: [story],
      outFile,
      formatUrls: [STALLED_URL],
      formatPaths: [FORMATS],
      useTweegoPath: false,
      signal: outer.signal,
    });
    const signal = await format.firstRequest;
    outer.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(fake.watchers.filter((w) => !w.closed)).toEqual([]);
  });
});

// Symbolic links need privileges on Windows.
describe.skipIf(process.platform === 'win32')('watch with the output reached through a link (#152)', () => {
  let root: string;
  let controller: AbortController | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'twee-ts-watch-link-')));
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('neither loads the output back nor rebuilds for writing it', async () => {
    const story = join(root, 'story');
    const start = join(story, 'start.tw');
    mkdirSync(story);
    symlinkSync('story', join(root, 'out'));
    writeFileSync(start, STORY.replace('Hello from the story.', 'ORIGINAL_CONTENT\n\n:: Gone\nSOON_DELETED'));
    const builds = buildQueue();
    controller = await watch({
      sources: [story],
      outputMode: 'twine2-archive',
      outFile: join(root, 'out', 'z.html'),
      onBuild: builds.onBuild,
      onError: builds.onError,
    });
    await builds.next();
    expect(readFileSync(join(story, 'z.html'), 'utf-8')).toContain('ORIGINAL_CONTENT');

    vi.useFakeTimers(FAKE_TIMERS);
    // The watcher on the source folder reports the output the build wrote there.
    emit(story, 'z.html');
    expect(vi.getTimerCount()).toBe(0);
    writeFileSync(start, STORY.replace('Hello from the story.', 'UPDATED_CONTENT'));
    emit(story, 'start.tw');
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    const second = await builds.next();
    expect(second.output).toContain('UPDATED_CONTENT');
    expect(second.output).not.toContain('ORIGINAL_CONTENT');
    expect(second.output).not.toContain('SOON_DELETED');
    expect(second.stats.files).toEqual([relative(process.cwd(), start)]);
    expect(builds.errors).toEqual([]);
  });
});

describe('watch with a named source that is the output (#157)', () => {
  let root: string;
  let controller: AbortController | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'twee-ts-watch-inplace-'));
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the error and leaves the file unchanged', async () => {
    const file = join(root, 'a.tw');
    writeFileSync(file, STORY);
    const built: CompileResult[] = [];
    let failed: (error: Error) => void = () => {};
    const failure = new Promise<Error>((done) => (failed = done));
    controller = await watch({
      sources: [file],
      outputMode: 'twee3',
      outFile: file,
      onBuild: (result) => built.push(result),
      onError: failed,
    });
    expect((await failure).message).toBe(`path ${file}: Output file cannot be an input source.`);
    expect(built).toEqual([]);
    expect(readFileSync(file, 'utf-8')).toBe(STORY);
  });
});

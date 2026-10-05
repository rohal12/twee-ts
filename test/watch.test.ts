import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dirname, join, relative } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { watchFilesystem } from '../src/filesystem.js';
import { watch } from '../src/compiler.js';
import type { CompileResult } from '../src/types.js';

type WatchListener = (event: string, filename: string | null) => void;

const listeners = vi.hoisted(() => new Map<string, WatchListener>());

// fs.watch records each watcher's listener instead of asking the OS, so the tests deliver
// the events themselves and don't depend on how fast or reliably the OS reports them.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (pathname: string, _options: unknown, listener: WatchListener) => {
      listeners.set(pathname, listener);
      return { close: () => listeners.delete(pathname) };
    },
  };
});

/** Delivers a change event to the watcher on `root`, for `filename` relative to it. */
function emit(root: string, filename: string): void {
  const listener = listeners.get(root);
  if (!listener) throw new Error(`no watcher on ${root}`);
  listener('change', filename);
}

const FAKE_TIMERS = { toFake: ['setTimeout', 'clearTimeout'] } as const;

afterEach(() => {
  vi.useRealTimers();
  listeners.clear();
});

describe('watchFilesystem', () => {
  beforeEach(() => vi.useFakeTimers(FAKE_TIMERS));

  it('schedules no rebuild for a file the ignore test rejects', () => {
    const builds: (ReadonlySet<string> | undefined)[] = [];
    const handle = watchFilesystem(
      ['story'],
      'out.html',
      (files) => builds.push(files),
      (file) => file.endsWith('.png'),
    );
    try {
      expect(builds).toEqual([undefined]); // the initial full build
      emit('story', join('art', 'scene.png'));
      expect(vi.getTimerCount()).toBe(0);
      emit('story', 'start.tw');
      vi.advanceTimersByTime(500);
      expect(builds).toEqual([undefined, new Set([join('story', 'start.tw')])]);
    } finally {
      handle.close();
    }
  });

  it('asks the ignore test about the path relative to the working directory', () => {
    const asked: string[] = [];
    const handle = watchFilesystem(
      ['story'],
      'out.html',
      () => {},
      (file) => {
        asked.push(file);
        return false;
      },
    );
    try {
      emit('story', join('art', 'scene.png'));
      expect(asked).toEqual([join('story', 'art', 'scene.png')]);
    } finally {
      handle.close();
    }
  });
});

const TMP_DIR = join(__dirname, '__tmp_watch__');
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
    onBuild(result: CompileResult): void {
      const waiter = waiting.shift();
      if (waiter) waiter(result);
      else ready.push(result);
    },
    onError(error: Error): void {
      errors.push(error);
    },
    next(): Promise<CompileResult> {
      const result = ready.shift();
      return result ? Promise.resolve(result) : new Promise((done) => waiting.push(done));
    },
  };
}

describe('watch with exclude', () => {
  const story = join(TMP_DIR, 'story');
  const outFile = join(TMP_DIR, 'out.html');
  let controller: AbortController | undefined;

  beforeEach(() => {
    mkdirSync(join(story, 'art'), { recursive: true });
    writeFileSync(join(story, 'start.tw'), STORY);
    writeFileSync(join(story, 'art', 'scene.png'), Buffer.alloc(16, 7));
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('leaves excluded files out of every build and rebuilds for none of their changes', async () => {
    const builds = buildQueue();
    controller = await watch({
      ...COMPILE,
      sources: [story],
      outFile,
      exclude: ['**/*.png'],
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
      exclude: ['**/lib/**'],
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
  const story = join(TMP_DIR, 'story');
  const start = join(story, 'start.tw');
  const outFile = join(story, 'z-output.html');
  let controller: AbortController | undefined;

  beforeEach(() => {
    mkdirSync(story, { recursive: true });
    writeFileSync(start, STORY.replace('Hello from the story.', 'ORIGINAL_CONTENT\n\n:: Gone\nSOON_DELETED'));
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(TMP_DIR, { recursive: true, force: true });
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
  const story = join(TMP_DIR, 'story');
  const start = join(story, 'start.tw');
  const outFile = join(TMP_DIR, 'out.html');
  const stamp = new Date(1_700_000_000_000);
  let controller: AbortController | undefined;

  beforeEach(() => {
    mkdirSync(story, { recursive: true });
    writeFileSync(start, STORY.replace('Hello from the story.', 'ORIGINAL_CONTENT'));
    utimesSync(start, stamp, stamp);
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(TMP_DIR, { recursive: true, force: true });
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
  const story = join(TMP_DIR, 'story');
  const start = join(story, 'start.tw');
  const outFile = join(TMP_DIR, 'out.html');
  let controller: AbortController | undefined;

  beforeEach(() => {
    mkdirSync(story, { recursive: true });
    writeFileSync(start, STORY);
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    rmSync(TMP_DIR, { recursive: true, force: true });
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
    const elsewhere = join(TMP_DIR, 'elsewhere');
    const headFile = join(elsewhere, 'head.txt');
    const meta = (content: string): string => `<meta name="watch-test" content="${content}">`;

    beforeEach(() => {
      mkdirSync(elsewhere, { recursive: true });
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
        exclude: ['**/head.txt'],
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
  const story = join(TMP_DIR, 'story');
  const start = join(story, 'start.tw');
  const outFile = join(TMP_DIR, 'out.html');
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
    return { state, firstRequested, releaseFirst: (ok = true) => releaseFirst(ok) };
  }

  /** Delivers a change to `filename` in the story folder and lets its debounce run out. */
  function change(filename: string): void {
    vi.useFakeTimers(FAKE_TIMERS);
    emit(story, filename);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
  }

  beforeEach(() => {
    mkdirSync(story, { recursive: true });
    writeFileSync(start, source('OLD_CONTENT'));
    origCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = join(TMP_DIR, 'cache');
  });

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    vi.unstubAllGlobals();
    if (origCacheHome !== undefined) process.env['XDG_CACHE_HOME'] = origCacheHome;
    else delete process.env['XDG_CACHE_HOME'];
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('builds the changes made during a slow build once, after it, and never writes the stale result', async () => {
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

    const first = await builds.next();
    expect(startText(first)).toBe('NEW_CONTENT');
    expect(first.output).toContain('MORE_CONTENT');
    expect(readFileSync(outFile, 'utf-8')).toContain('NEW_CONTENT');
    expect(readFileSync(outFile, 'utf-8')).not.toContain('OLD_CONTENT');
    // One build at a time: the follow-up started after the initial build finished.
    expect(format.state.maxInFlight).toBe(1);

    // The next build reported is the next change's: no stale build arrives in between,
    // and the parse cache still holds the latest content of the file it doesn't reparse.
    writeFileSync(start, source('NEWEST_CONTENT'));
    change('start.tw');
    const second = await builds.next();
    expect(startText(second)).toBe('NEWEST_CONTENT');
    expect(second.output).toContain('MORE_CONTENT');
    expect(readFileSync(outFile, 'utf-8')).toContain('NEWEST_CONTENT');
    expect(builds.errors).toEqual([]);
  });

  it('neither writes nor reports a build that finishes after the watch is aborted, nor starts another', async () => {
    const format = stubSlowFormat();
    const reported: CompileResult[] = [];
    const errors: Error[] = [];
    controller = await watch({
      ...SLOW_FORMAT,
      sources: [story],
      outFile,
      onBuild: (result) => reported.push(result),
      onError: (error) => errors.push(error),
    });
    await format.firstRequested;
    writeFileSync(start, source('NEW_CONTENT'));
    change('start.tw');

    controller.abort();
    format.releaseFirst(false); // a build started after this one would fetch the format again
    // Give the released build time to finish; nothing it does may show.
    await new Promise((done) => setTimeout(done, 200));

    expect(reported).toEqual([]);
    expect(errors).toEqual([]);
    expect(existsSync(outFile)).toBe(false);
    expect(format.state.requests).toBe(1);
  });
});

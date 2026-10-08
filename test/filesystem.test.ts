import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { basename, dirname, join, parse, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { getFilenames, isExcluded, outputPaths, realPathOf, watchFilesystem } from '../src/filesystem.js';
import type { WatchHandle } from '../src/filesystem.js';

let tmpDir: string;

describe('getFilenames', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-fs-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collects files from a directory', () => {
    writeFileSync(join(tmpDir, 'a.tw'), '');
    writeFileSync(join(tmpDir, 'b.css'), '');
    const result = getFilenames([tmpDir]).filenames;
    expect(result).toHaveLength(2);
    expect(result.some((f) => f.endsWith('a.tw'))).toBe(true);
    expect(result.some((f) => f.endsWith('b.css'))).toBe(true);
  });

  it('collects files recursively', () => {
    const sub = join(tmpDir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(tmpDir, 'root.tw'), '');
    writeFileSync(join(sub, 'nested.tw'), '');
    const result = getFilenames([tmpDir]).filenames;
    expect(result).toHaveLength(2);
    expect(result.some((f) => f.includes('nested.tw'))).toBe(true);
  });

  it('accepts individual file paths', () => {
    const file = join(tmpDir, 'single.tw');
    writeFileSync(file, '');
    const result = getFilenames([file]).filenames;
    expect(result).toHaveLength(1);
  });

  it('excludes the output file', () => {
    const outFile = join(tmpDir, 'output.html');
    writeFileSync(join(tmpDir, 'story.tw'), '');
    writeFileSync(outFile, '');
    const result = getFilenames([tmpDir], outFile).filenames;
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('story.tw');
  });

  it('reports a non-existent path as a warning, like Tweego', () => {
    const missing = join(tmpDir, 'nonexistent');
    const { filenames, diagnostics } = getFilenames([missing]);
    expect(filenames).toEqual([]);
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message: expect.stringContaining(`path ${missing}: ENOENT: no such file or directory`),
        file: missing,
      },
    ]);
  });

  it('keeps collecting the other paths after a missing one', () => {
    const file = join(tmpDir, 'story.tw');
    writeFileSync(file, '');
    const { filenames, diagnostics } = getFilenames([join(tmpDir, 'nonexistent'), file]);
    expect(filenames).toHaveLength(1);
    expect(filenames[0]).toContain('story.tw');
    expect(diagnostics).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable directory as a warning',
    () => {
      const locked = join(tmpDir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        const { filenames, diagnostics } = getFilenames([locked]);
        expect(filenames).toEqual([]);
        expect(diagnostics).toEqual([
          { level: 'warning', message: expect.stringContaining(`path ${locked}: EACCES`), file: locked },
        ]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it('handles empty input', () => {
    expect(getFilenames([])).toEqual({
      filenames: [],
      files: [],
      diagnostics: [],
      outputSources: [],
      skippedOutputs: [],
    });
  });

  describe('with exclude globs', () => {
    /**
     * `pattern` inside tmpDir. Exclude globs are read relative to the working
     * directory, and tmpDir lies outside it, where `**` alone doesn't reach.
     */
    const inTmp = (pattern: string): string => `${relative(process.cwd(), tmpDir).replace(/\\/g, '/')}/${pattern}`;
    const names = (filenames: string[]): string[] => filenames.map((f) => basename(f)).sort();

    beforeEach(() => {
      mkdirSync(join(tmpDir, 'art'));
      writeFileSync(join(tmpDir, 'story.tw'), '');
      writeFileSync(join(tmpDir, 'cover.png'), '');
      writeFileSync(join(tmpDir, 'art', 'scene.png'), '');
      writeFileSync(join(tmpDir, 'art', 'notes.tw'), '');
    });

    it('leaves out the files that match', () => {
      const { filenames, diagnostics } = getFilenames([tmpDir], undefined, [inTmp('**/*.png')]);
      expect(names(filenames)).toEqual(['notes.tw', 'story.tw']);
      expect(diagnostics).toEqual([]);
    });

    it('matches against the path relative to the working directory', () => {
      const { filenames } = getFilenames([tmpDir], undefined, [inTmp('art/**')]);
      expect(names(filenames)).toEqual(['cover.png', 'story.tw']);
    });

    it('leaves out a file listed directly when it matches', () => {
      expect(getFilenames([join(tmpDir, 'cover.png')], undefined, [inTmp('**/*.png')]).filenames).toEqual([]);
    });

    it('keeps every file when no pattern matches', () => {
      expect(getFilenames([tmpDir], undefined, [inTmp('**/*.mp3')]).filenames).toHaveLength(4);
    });
  });
});

// Symbolic links need privileges on Windows.
describe.skipIf(process.platform === 'win32')('getFilenames with build outputs and symbolic links', () => {
  let root: string;
  let story: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'twee-ts-outputs-')));
    story = join(root, 'story');
    mkdirSync(story);
    writeFileSync(join(story, 'a.tw'), ':: Start\nHello\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const names = (filenames: readonly string[]): string[] => filenames.map((f) => relative(root, resolve(f))).sort();

  describe('compares outputs by real path (#152)', () => {
    it('leaves out an output named through a link to its folder', () => {
      writeFileSync(join(story, 'z.html'), 'last build');
      symlinkSync('story', join(root, 'out'));
      const { filenames } = getFilenames([story], join(root, 'out', 'z.html'));
      expect(names(filenames)).toEqual([join('story', 'a.tw')]);
    });

    it('leaves out the output when the sources are named through a symlinked project folder', () => {
      // As from a shell in a symlinked folder: $PWD is the link, the working directory the real path.
      mkdirSync(join(root, 'real'));
      renameSync(story, join(root, 'real', 'story'));
      symlinkSync('real', join(root, 'link'));
      writeFileSync(join(root, 'real', 'story', 'z.html'), 'last build');
      const { filenames } = getFilenames([join(root, 'link', 'story')], join(root, 'real', 'story', 'z.html'));
      expect(names(filenames)).toEqual([join('link', 'story', 'a.tw')]);
    });

    it('compares an output that does not exist yet by its folder', () => {
      symlinkSync('story', join(root, 'out'));
      expect(realPathOf(join(root, 'out', 'z.html'))).toBe(join(story, 'z.html'));
      expect(realPathOf(join(root, 'out', 'new', 'z.html'))).toBe(join(story, 'new', 'z.html'));
    });

    it('leaves out a link in the sources to the output file', () => {
      mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, 'dist', 'z.html'), 'last build');
      symlinkSync(join('..', 'dist', 'z.html'), join(story, 'z.html'));
      const { filenames } = getFilenames([story], join(root, 'dist', 'z.html'));
      expect(names(filenames)).toEqual([join('story', 'a.tw')]);
    });
  });

  describe('does not follow links to folders inside a source folder (#160)', () => {
    it('reads each file once with a link back to its own folder', () => {
      symlinkSync('.', join(story, 's1'));
      expect(getFilenames([story])).toMatchObject({
        filenames: [relative(process.cwd(), join(story, 'a.tw'))],
        diagnostics: [],
        outputSources: [],
      });
    });

    it('finishes at once with two links back to the folder', () => {
      symlinkSync('.', join(story, 's1'));
      symlinkSync('.', join(story, 's2'));
      expect(names(getFilenames([story]).filenames)).toEqual([join('story', 'a.tw')]);
    });

    it('does not follow a link to a parent folder', () => {
      writeFileSync(join(root, 'outside.tw'), ':: Outside\n');
      symlinkSync('..', join(story, 'up'));
      expect(names(getFilenames([story]).filenames)).toEqual([join('story', 'a.tw')]);
    });

    it('does not follow a link to the output folder', () => {
      mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, 'dist', 'z.html'), 'last build');
      symlinkSync(join('..', 'dist'), join(story, 'build'));
      expect(names(getFilenames([story], join(root, 'dist', 'z.html')).filenames)).toEqual([join('story', 'a.tw')]);
    });

    it('still reads a link to a file, and a linked folder named as a source', () => {
      mkdirSync(join(root, 'shared'));
      writeFileSync(join(root, 'shared', 'b.tw'), ':: B\n');
      symlinkSync(join('..', 'shared', 'b.tw'), join(story, 'b.tw'));
      symlinkSync('shared', join(root, 'linked'));
      expect(names(getFilenames([story, join(root, 'linked')]).filenames)).toEqual([
        join('linked', 'b.tw'),
        join('story', 'a.tw'),
        join('story', 'b.tw'),
      ]);
    });

    it('skips a link whose target is missing without a word, as Tweego does (FS-15, an editor lock file)', () => {
      symlinkSync('user@host.123:1700000000', join(story, '.#a.tw'));
      symlinkSync('missing.tw', join(story, 'dangling.tw'));
      const { filenames, diagnostics } = getFilenames([story]);
      expect(names(filenames)).toEqual([join('story', 'a.tw')]);
      expect(diagnostics).toEqual([]);
    });

    it('warns about a named link whose target is missing, naming the target', () => {
      symlinkSync('missing.tw', join(story, 'dangling.tw'));
      const { filenames, diagnostics } = getFilenames([join(story, 'dangling.tw')]);
      expect(filenames).toEqual([]);
      expect(diagnostics).toEqual([
        {
          level: 'warning',
          message: `path ${join(story, 'dangling.tw')}: Symbolic link to a missing target (missing.tw).`,
          file: join(story, 'dangling.tw'),
        },
      ]);
    });
  });

  describe('a named source that is an output (#157)', () => {
    it('is listed in outputSources, not read', () => {
      const file = join(story, 'a.tw');
      expect(getFilenames([file], file)).toMatchObject({ filenames: [], diagnostics: [], outputSources: [file] });
    });

    it('is found through a link too', () => {
      symlinkSync('story', join(root, 'alias'));
      const named = join(root, 'alias', 'a.tw');
      expect(getFilenames([named], join(story, 'a.tw')).outputSources).toEqual([named]);
    });

    it('is not an output found while walking a folder, which is skipped silently', () => {
      writeFileSync(join(story, 'z.html'), 'last build');
      expect(getFilenames([story], join(story, 'z.html'))).toMatchObject({
        filenames: [relative(process.cwd(), join(story, 'a.tw'))],
        diagnostics: [],
        outputSources: [],
        skippedOutputs: [{ path: relative(process.cwd(), join(story, 'z.html')), folder: story }],
      });
    });
  });

  describe('output folders', () => {
    beforeEach(() => {
      mkdirSync(join(story, 'build', 'assets'), { recursive: true });
      writeFileSync(join(story, 'build', 'index.html'), 'story');
      writeFileSync(join(story, 'build', 'assets', 'old-chunk.js'), 'old');
    });

    it('skips an output folder found while walking a source folder whole', () => {
      const outputs = { files: [], dirs: [join(story, 'build')] };
      expect(names(getFilenames([story], outputs).filenames)).toEqual([join('story', 'a.tw')]);
    });

    it('walks an output folder named as a source, leaving out only the output files', () => {
      const outputs = { files: [join(story, 'build', 'index.html')], dirs: [story] };
      expect(names(getFilenames([story], outputs).filenames)).toEqual([
        join('story', 'a.tw'),
        join('story', 'build', 'assets', 'old-chunk.js'),
      ]);
    });

    it('walks a source folder inside an output folder', () => {
      const outputs = { files: [], dirs: [root] };
      expect(names(getFilenames([story], outputs).filenames)).toHaveLength(3);
    });
  });

  describe('outputPaths', () => {
    it('tells whether a path is one discovery leaves out, given the source folders', () => {
      const build = join(story, 'build');
      const output = outputPaths({ files: [join(root, 'out.html')], dirs: [build] });
      expect(output.isOutput(join(root, 'out.html'), [story])).toBe(true);
      expect(output.isOutput(join(build, 'assets', 'old-chunk.js'), [story])).toBe(true);
      expect(output.isOutput(join(story, 'a.tw'), [story])).toBe(false);
      // A source folder inside the output folder is walked.
      expect(output.isOutput(join(build, 'x.tw'), [story, build])).toBe(false);
      expect(output.isOutput(join(build, 'x.tw'), [build])).toBe(false);
    });

    it('knows the hard links of an output that did not exist when it was built, and of one replaced since (#268)', () => {
      const out = join(root, 'out.html');
      const alias = join(story, 'alias.html');
      const output = outputPaths({ files: [out], dirs: [] });
      // The output is missing when the paths are made, then written, and an alias made.
      writeFileSync(out, 'one');
      linkSync(out, alias);
      expect(output.isFile(alias)).toBe(true);
      // An atomic replacement is a new file: its aliases are outputs, the old alias no longer is.
      const replacement = join(root, 'out.tmp');
      writeFileSync(replacement, 'two');
      renameSync(replacement, out);
      const second = join(story, 'second.html');
      linkSync(out, second);
      expect(output.isFile(second)).toBe(true);
      expect(output.isFile(alias)).toBe(false);
      expect(output.isOutput(second, [story])).toBe(true);
    });

    it('tells whether a folder holds an output', () => {
      const output = outputPaths({ files: [join(story, 'build', 'index.html')], dirs: [join(root, 'dist')] });
      expect(output.holds(story)).toBe(true);
      expect(output.holds(join(story, 'build'))).toBe(true);
      expect(output.holds(join(root, 'dist'))).toBe(true);
      expect(output.holds(join(story, 'parts'))).toBe(false);
      expect(output.holds(join(story, 'build', 'index.html'))).toBe(false);
    });
  });
});

describe('outputPaths with a root folder', () => {
  it('holds an output below a folder whose path already ends in a separator', () => {
    const root = parse(tmpdir()).root;
    const output = outputPaths({ files: [join(tmpdir(), 'twee-ts-never-built', 'out.html')], dirs: [] });
    expect(output.holds(root)).toBe(true);
  });
});

describe('isExcluded', () => {
  it('matches a path relative to the working directory', () => {
    expect(isExcluded(join('src', 'art', 'scene.png'), ['src/art/**'])).toBe(true);
    expect(isExcluded(join('src', 'story', 'start.tw'), ['src/art/**'])).toBe(false);
  });

  it('matches an absolute path by its path relative to the working directory', () => {
    expect(isExcluded(join(process.cwd(), 'src', 'art', 'scene.png'), ['src/art/**'])).toBe(true);
    expect(isExcluded(join(process.cwd(), 'src', 'art', 'scene.png'), ['art/**'])).toBe(false);
  });

  it('keeps * within one folder and lets ** cross folders', () => {
    expect(isExcluded(join('src', 'art', 'scene.png'), ['src/*.png'])).toBe(false);
    expect(isExcluded(join('src', 'art', 'scene.png'), ['src/**/*.png'])).toBe(true);
    expect(isExcluded('cover.png', ['**/*.png'])).toBe(true);
  });

  it('matches when any one pattern matches', () => {
    expect(isExcluded(join('src', 'clip.mp4'), ['**/*.png', '**/*.mp4'])).toBe(true);
  });

  it('reads a leading ./ in a pattern as the working directory', () => {
    expect(isExcluded(join('src', 'art', 'scene.png'), ['./src/art/**'])).toBe(true);
  });

  it('excludes nothing without patterns', () => {
    expect(isExcluded('cover.png', [])).toBe(false);
  });
});

// These use the OS's own file watcher, which reports a change to a watched file
// by the file's name alone; test/watch.test.ts covers the rest with a stand-in.
describe('watchFilesystem on individual files', { timeout: 20_000 }, () => {
  let story: string;
  let start: string;
  let outFile: string;
  let handle: WatchHandle | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-fs-watch-'));
    story = join(tmpDir, 'story');
    start = join(story, 'start.tw');
    outFile = join(tmpDir, 'out.html');
    mkdirSync(story);
    writeFileSync(start, ':: Start\nOne\n');
  });

  afterEach(() => {
    handle?.close();
    handle = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  interface Builds {
    /** Waits (up to `timeoutMs`) for the next rebuild's changed files. */
    next(timeoutMs?: number): Promise<ReadonlySet<string> | undefined>;
    /**
     * Makes the first change after the initial build with `write(attempt)`, repeating it until
     * the watcher reports a rebuild, and returns that rebuild's changed files. macOS starts its
     * file-system event stream a moment after fs.watch returns, and a change made before then is
     * never reported; there is no event for "the watch is live" to wait for instead.
     */
    firstChange(write: (attempt: number) => void): Promise<ReadonlySet<string> | undefined>;
  }

  /** Starts watching `paths`. */
  function watchBuilds(paths: string[]): Builds {
    const ready: (ReadonlySet<string> | undefined)[] = [];
    const waiting: ((files: ReadonlySet<string> | undefined) => void)[] = [];
    handle = watchFilesystem(paths, outFile, (files) => {
      const waiter = waiting.shift();
      if (waiter) waiter(files);
      else ready.push(files);
    });
    const next = (timeoutMs = 10_000): Promise<ReadonlySet<string> | undefined> =>
      ready.length > 0
        ? Promise.resolve(ready.shift())
        : new Promise((done, fail) => {
            const waiter = (files: ReadonlySet<string> | undefined): void => {
              clearTimeout(timer);
              done(files);
            };
            const timer = setTimeout(() => {
              waiting.splice(waiting.indexOf(waiter), 1);
              fail(new Error(`no rebuild within ${timeoutMs} ms`));
            }, timeoutMs);
            waiting.push(waiter);
          });
    const firstChange = async (write: (attempt: number) => void): Promise<ReadonlySet<string> | undefined> => {
      for (let attempt = 0; ; attempt++) {
        write(attempt);
        try {
          return await next(attempt < 9 ? 1_000 : 10_000);
        } catch (e) {
          if (attempt >= 9) throw e;
        }
      }
    };
    return { next, firstChange };
  }

  it('reports a change under the path source discovery gives the file', async () => {
    const builds = watchBuilds([start]);
    expect(await builds.next()).toBeUndefined(); // the initial full build
    const changed = await builds.firstChange((n) => {
      writeFileSync(start, `:: Start\nTwo ${n}\n`);
    });
    expect(changed).toEqual(new Set(getFilenames([start]).filenames));
  });

  it('ignores a hard link of an output that was missing when the watch started (#268)', async () => {
    const builds = watchBuilds([story]);
    await builds.next();
    writeFileSync(outFile, 'built');
    linkSync(outFile, join(story, 'alias.html'));
    // The alias is a build input, so an event for it must not start a build; the source change does, once.
    const changed = await builds.firstChange((n) => {
      writeFileSync(outFile, `built ${n}`);
      writeFileSync(start, `:: Start\nTwo ${n}\n`);
    });
    expect(changed).toEqual(new Set([relative(process.cwd(), start)]));
  });

  it('keeps watching a file that an editor saved by replacing it', async () => {
    const builds = watchBuilds([start]);
    await builds.next();
    const temp = join(story, '.start.tw.swp');
    const replaced = await builds.firstChange((n) => {
      writeFileSync(temp, `:: Start\nTwo ${n}\n`);
      renameSync(temp, start);
    });
    expect(replaced).toEqual(new Set([relative(process.cwd(), start)]));
    writeFileSync(start, ':: Start\nThree\n');
    expect(await builds.next()).toEqual(new Set([relative(process.cwd(), start)]));
  });

  it('keeps seeing edits to a file in a watched folder that an editor saved by replacing it (#325)', async () => {
    const nested = join(story, 'nested');
    mkdirSync(nested);
    const deep = join(nested, 'deep.tw');
    writeFileSync(deep, ':: Deep\none\n');
    const builds = watchBuilds([story]);
    await builds.next();
    // A build reports the file, or is a full one: macOS FSEvents may deliver the folder's creation (made just
    // before the watch began) as an event of the folder, which schedules a full build.
    const reports = (changed: ReadonlySet<string> | undefined, file: string): boolean =>
      changed === undefined || changed.has(relative(process.cwd(), file));
    for (const file of [start, deep, start]) {
      const temp = join(dirname(file), '.save.swp');
      const replaced = await builds.firstChange((n) => {
        writeFileSync(temp, `:: Start\nSaved ${n}\n`);
        renameSync(temp, file);
      });
      expect(reports(replaced, file)).toBe(true);
      // Two later in-place edits, after the replacement.
      for (const text of ['Later', 'Latest']) {
        const edited = await builds.firstChange((n) => {
          writeFileSync(file, `:: Start\n${text} ${n}\n`);
        });
        expect(reports(edited, file)).toBe(true);
      }
    }
  });

  it('does not rebuild for a change to a file of a type it does not build for', async () => {
    const builds = watchBuilds([story]);
    await builds.next();
    const changed = await builds.firstChange((n) => {
      writeFileSync(join(story, 'notes.unknown'), `not a source ${n}`);
      writeFileSync(start, `:: Start\nTwo ${n}\n`);
    });
    expect(changed).toEqual(new Set([relative(process.cwd(), start)]));
  });

  it('rebuilds for a named file of a type it would not build for in a folder', async () => {
    const head = join(tmpDir, 'head.txt');
    writeFileSync(head, '<meta name="a">');
    const builds = watchBuilds([story, head]);
    await builds.next();
    const changed = [
      ...((await builds.firstChange((n) => {
        writeFileSync(head, `<meta name="b${n}">`);
      })) ?? []),
    ];
    expect(changed).toContain(relative(process.cwd(), head));
    // macOS FSEvents may still deliver the setup's own write of start.tw (made just before the
    // watch began) with this change; nothing else may be reported.
    expect(changed.filter((f) => f !== relative(process.cwd(), start))).toEqual([relative(process.cwd(), head)]);
  });
});

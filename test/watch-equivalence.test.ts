/**
 * Watch mode against the real file system: after any sequence of file-system operations, once events
 * settle, the watch's output equals a fresh compile of the same tree (the oracle). Operations come from a
 * catalogue (create, modify, delete and rename files and folders, move folders in and out, create,
 * retarget and delete symbolic links, edit a link's target outside the watched folder, and edits that keep
 * the modification time), in sequences fast-check generates. Plus the regressions of #247 (FS-04, FS-12,
 * FS-13), #239, and a check that a stopped watch leaves no watcher or timer behind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, watchWithWriteFilter } from '../src/compiler.js';
import type { CompileOptions, CompileResult, InlineSource } from '../src/types.js';

const STORY_DATA: InlineSource = {
  filename: 'StoryData.tw',
  content: ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nStart\n',
};

/** Symbolic links need privileges on Windows; junctions don't, but only link folders. */
const LINKS = process.platform !== 'win32';
const TIMING = { debounceMs: 30, maxWaitMs: 120 } as const;

let root: string;
let src: string;
let outside: string;
let outFile: string;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-watch-eq-')));
  src = join(root, 'src');
  outside = join(root, 'outside');
  outFile = join(root, 'out.json');
  mkdirSync(src);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const passage = (name: string, text: string): string => `:: P_${name.replace(/\W/g, '_')}\n${text}\n`;

/** Polls `check` until it holds; fails, naming `what`, after `timeoutMs`. */
async function eventually(
  check: () => boolean | Promise<boolean>,
  what: () => string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Watching {
  readonly controller: AbortController;
  readonly builds: CompileResult[];
  readonly errors: Error[];
  readonly options: CompileOptions;
}

function startWatch(sources: CompileOptions['sources'], extra: Partial<CompileOptions> = {}): Watching {
  const builds: CompileResult[] = [];
  const errors: Error[] = [];
  const options: CompileOptions = { sources, outputMode: 'json', ...extra };
  const controller = watchWithWriteFilter(
    { ...options, outFile, onBuild: (r) => builds.push(r), onError: (e) => errors.push(e) },
    () => true,
    { timing: TIMING },
  );
  return { controller, builds, errors, options };
}

const readOut = (): string => (existsSync(outFile) ? readFileSync(outFile, 'utf-8') : '');

/**
 * Waits until the OS watcher reports changes: rewrites `file` with the content it has until a build
 * follows. macOS's FSEvents stream starts some time after fs.watch() returns, and a change made before it
 * has started is never reported; a user's edits come later than that, a test's first operation may not.
 */
async function primed(w: Watching, file: string): Promise<void> {
  const content = readFileSync(file);
  const before = w.builds.length;
  let polls = 0;
  await eventually(
    () => {
      if (polls++ % 25 === 0) writeFileSync(file, content);
      return w.builds.length > before;
    },
    () => `a build after rewriting ${file}`,
  );
}

/** Waits until the watch's output is what a fresh compile of the tree gives. */
async function converges(w: Watching, label: () => string): Promise<void> {
  let expected = '';
  await eventually(
    async () => {
      expected = (await compile(w.options)).output;
      return readOut() === expected;
    },
    () =>
      `${label()}\nexpected: ${expected}\nwatch wrote: ${readOut()}\nerrors: ${w.errors.map((e) => e.message).join('; ')}`,
  );
  expect(readOut()).toBe(expected);
}

/** One file-system operation on the tree; it does nothing when what it needs isn't there. */
type Op =
  | { readonly kind: 'write'; readonly file: string; readonly text: string }
  | { readonly kind: 'sameMtimeWrite'; readonly file: string; readonly text: string }
  | { readonly kind: 'delete'; readonly file: string }
  | { readonly kind: 'renameFile'; readonly from: string; readonly to: string }
  | { readonly kind: 'mkdirWithFile'; readonly dir: string; readonly text: string }
  | { readonly kind: 'renameDir'; readonly from: string; readonly to: string }
  | { readonly kind: 'moveDirOut'; readonly dir: string }
  | { readonly kind: 'moveDirIn'; readonly dir: string }
  | { readonly kind: 'removeDir'; readonly dir: string }
  | { readonly kind: 'link'; readonly name: string; readonly target: string }
  | { readonly kind: 'unlink'; readonly name: string }
  | { readonly kind: 'editTarget'; readonly target: string; readonly text: string };

const FILES = ['a.tw', 'b.tw', 'd1/c.tw', 'd2/e.tw', 'notes.txt'];
const DIRS = ['d1', 'd2', 'd3'];
const TARGETS = ['t1.tw', 't2.tw'];
const texts = fc.constantFrom('one', 'two', 'three', 'four');

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('write' as const), file: fc.constantFrom(...FILES), text: texts }),
  fc.record({ kind: fc.constant('sameMtimeWrite' as const), file: fc.constantFrom(...FILES), text: texts }),
  fc.record({ kind: fc.constant('delete' as const), file: fc.constantFrom(...FILES) }),
  fc.record({
    kind: fc.constant('renameFile' as const),
    from: fc.constantFrom(...FILES),
    to: fc.constantFrom(...FILES),
  }),
  fc.record({ kind: fc.constant('mkdirWithFile' as const), dir: fc.constantFrom(...DIRS), text: texts }),
  fc.record({ kind: fc.constant('renameDir' as const), from: fc.constantFrom(...DIRS), to: fc.constantFrom(...DIRS) }),
  fc.record({ kind: fc.constant('moveDirOut' as const), dir: fc.constantFrom(...DIRS) }),
  fc.record({ kind: fc.constant('moveDirIn' as const), dir: fc.constantFrom(...DIRS) }),
  fc.record({ kind: fc.constant('removeDir' as const), dir: fc.constantFrom(...DIRS) }),
  ...(LINKS
    ? [
        fc.record({
          kind: fc.constant('link' as const),
          name: fc.constantFrom('l1.tw', 'l2.tw'),
          target: fc.constantFrom(...TARGETS),
        }),
        fc.record({ kind: fc.constant('unlink' as const), name: fc.constantFrom('l1.tw', 'l2.tw') }),
        fc.record({ kind: fc.constant('editTarget' as const), target: fc.constantFrom(...TARGETS), text: texts }),
      ]
    : []),
);

function apply(op: Op): void {
  const at = (p: string): string => join(src, p);
  const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
  switch (op.kind) {
    case 'write':
      // A file inside a folder needs the folder.
      if (op.file.includes('/') && !isDir(at(op.file.split('/')[0] ?? ''))) return;
      if (isDir(at(op.file))) return;
      writeFileSync(at(op.file), passage(op.file, op.text));
      return;
    case 'sameMtimeWrite': {
      if (!existsSync(at(op.file)) || isDir(at(op.file))) return;
      const { atime, mtime } = statSync(at(op.file));
      writeFileSync(at(op.file), passage(op.file, `${op.text}!`));
      utimesSync(at(op.file), atime, mtime);
      return;
    }
    case 'delete':
      if (existsSync(at(op.file)) && !isDir(at(op.file))) rmSync(at(op.file));
      return;
    case 'renameFile':
      if (!existsSync(at(op.from)) || isDir(at(op.from)) || existsSync(at(op.to))) return;
      if (op.to.includes('/') && !isDir(at(op.to.split('/')[0] ?? ''))) return;
      renameSync(at(op.from), at(op.to));
      return;
    case 'mkdirWithFile':
      if (existsSync(at(op.dir))) return;
      mkdirSync(at(op.dir));
      writeFileSync(join(at(op.dir), 'in.tw'), passage(`${op.dir}/in`, op.text));
      return;
    case 'renameDir':
      if (!isDir(at(op.from)) || existsSync(at(op.to))) return;
      renameSync(at(op.from), at(op.to));
      return;
    case 'moveDirOut':
      if (!isDir(at(op.dir)) || existsSync(join(outside, op.dir))) return;
      renameSync(at(op.dir), join(outside, op.dir));
      return;
    case 'moveDirIn':
      if (!isDir(join(outside, op.dir)) || existsSync(at(op.dir))) return;
      renameSync(join(outside, op.dir), at(op.dir));
      return;
    case 'removeDir':
      if (isDir(at(op.dir))) rmSync(at(op.dir), { recursive: true });
      return;
    case 'link':
      // Create or retarget.
      rmSync(at(op.name), { force: true });
      symlinkSync(join(outside, op.target), at(op.name));
      return;
    case 'unlink':
      rmSync(at(op.name), { force: true });
      return;
    case 'editTarget':
      writeFileSync(join(outside, op.target), passage(`target ${op.target}`, op.text));
      return;
    default: {
      const _exhaustive: never = op;
      throw new Error(`unhandled op ${JSON.stringify(_exhaustive)}`);
    }
  }
}

describe('watch output equals a fresh compile after any sequence of operations', { timeout: 300_000 }, () => {
  it('for generated sequences', async () => {
    expect.hasAssertions();
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 8 }), async (ops) => {
        rmSync(src, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
        rmSync(outFile, { force: true });
        mkdirSync(src);
        mkdirSync(outside);
        // A tree with something for every operation to work on.
        writeFileSync(join(src, 'a.tw'), passage('a.tw', 'zero'));
        mkdirSync(join(src, 'd1'));
        writeFileSync(join(src, 'd1', 'c.tw'), passage('d1/c.tw', 'zero'));
        mkdirSync(join(outside, 'd2'));
        writeFileSync(join(outside, 'd2', 'e.tw'), passage('d2/e.tw', 'zero'));
        for (const target of TARGETS) writeFileSync(join(outside, target), passage(`target ${target}`, 'zero'));
        if (LINKS) symlinkSync(join(outside, 't1.tw'), join(src, 'l1.tw'));
        // The source file info in the output makes every path change show.
        const w = startWatch([STORY_DATA, src], { outputMode: 'twine2-archive', sourceInfo: true });
        try {
          await converges(w, () => 'initial build');
          await primed(w, join(src, 'a.tw'));
          await converges(w, () => 'after priming');
          for (const [i, op] of ops.entries()) {
            apply(op);
            await converges(w, () => `after ${JSON.stringify(ops.slice(0, i + 1))}`);
          }
        } finally {
          w.controller.abort();
        }
      }),
      { numRuns: 30 },
    );
  });
});

describe('folders moved or renamed under a watched folder (FS-04)', { timeout: 30_000 }, () => {
  beforeEach(() => {
    mkdirSync(join(src, 'sub'));
    writeFileSync(join(src, 'main.tw'), passage('main', 'main'));
    writeFileSync(join(src, 'sub', 'side.tw'), passage('side', 'SIDE'));
  });

  it('rebuilds without the folder moved out', async () => {
    const w = startWatch([STORY_DATA, src]);
    try {
      await eventually(
        () => readOut().includes('SIDE'),
        () => 'first build',
      );
      await primed(w, join(src, 'main.tw'));
      renameSync(join(src, 'sub'), join(outside, 'sub'));
      await eventually(
        () => readOut() !== '' && !readOut().includes('SIDE'),
        () => 'side passage still in the output',
      );
      expect(readOut()).toContain('main');
    } finally {
      w.controller.abort();
    }
  });

  it('rebuilds for a folder renamed, a folder with a dot in its name included', async () => {
    const w = startWatch([STORY_DATA, src], { sourceInfo: true, outputMode: 'twine2-archive' });
    try {
      await eventually(
        () => readOut().includes('sub/side.tw') || readOut().includes('sub\\side.tw'),
        () => 'first build',
      );
      await primed(w, join(src, 'main.tw'));
      renameSync(join(src, 'sub'), join(src, 'chapter.v2'));
      await eventually(
        () => readOut().includes('chapter.v2'),
        () => 'renamed folder in the source info',
      );
      renameSync(join(src, 'chapter.v2'), join(outside, 'chapter.v2'));
      await eventually(
        () => !readOut().includes('SIDE'),
        () => 'folder with a dot moved out',
      );
      expect(w.errors).toEqual([]);
    } finally {
      w.controller.abort();
    }
  });
});

describe.skipIf(!LINKS)('a source named through a symbolic link (#239)', { timeout: 30_000 }, () => {
  for (const [kind, linkTo] of [
    ['absolute', (target: string) => target],
    ['relative', () => join('..', 'actual', 'story.tw')],
  ] as const) {
    it(`follows edits, replacements and retargeting of a ${kind} link's target`, async () => {
      mkdirSync(join(root, 'actual'));
      mkdirSync(join(root, 'aliases'));
      const target = join(root, 'actual', 'story.tw');
      const other = join(root, 'actual', 'other.tw');
      const link = join(root, 'aliases', 'story.tw');
      writeFileSync(target, passage('s', 'BEFORE'));
      writeFileSync(other, passage('s', 'OTHER'));
      symlinkSync(linkTo(target), link);
      const w = startWatch([STORY_DATA, link]);
      try {
        await eventually(
          () => readOut().includes('BEFORE'),
          () => 'first build',
        );
        writeFileSync(target, passage('s', 'AFTER'));
        await eventually(
          () => readOut().includes('AFTER'),
          () => 'in-place edit of the target',
        );
        writeFileSync(`${target}.tmp`, passage('s', 'REPLACED'));
        renameSync(`${target}.tmp`, target);
        await eventually(
          () => readOut().includes('REPLACED'),
          () => 'atomic replacement of the target',
        );
        rmSync(link);
        symlinkSync(other, link);
        await eventually(
          () => readOut().includes('OTHER'),
          () => 'link retargeted',
        );
        writeFileSync(other, passage('s', 'OTHER EDITED'));
        await eventually(
          () => readOut().includes('OTHER EDITED'),
          () => 'edit of the new target',
        );
        expect(w.errors).toEqual([]);
      } finally {
        w.controller.abort();
      }
    });
  }

  it('follows the target of a linked head file and a linked module', async () => {
    mkdirSync(join(root, 'actual'));
    writeFileSync(join(root, 'actual', 'head.html'), '<meta name="v1">');
    writeFileSync(join(root, 'actual', 'mod.css'), '.v1{}');
    symlinkSync(join(root, 'actual', 'head.html'), join(root, 'head.html'));
    symlinkSync(join(root, 'actual', 'mod.css'), join(root, 'mod.css'));
    const formats = join(import.meta.dirname, 'fixtures', 'storyformats');
    const w = startWatch([STORY_DATA], {
      outputMode: 'html',
      formatId: 'test-format-1',
      formatPaths: [formats],
      useTweegoPath: false,
      headFile: join(root, 'head.html'),
      modules: [join(root, 'mod.css')],
    });
    try {
      await eventually(
        () => readOut().includes('v1'),
        () => 'first build',
      );
      writeFileSync(join(root, 'actual', 'head.html'), '<meta name="v2">');
      await eventually(
        () => readOut().includes('"v2"'),
        () => 'head target edit',
      );
      writeFileSync(join(root, 'actual', 'mod.css'), '.v3{}');
      await eventually(
        () => readOut().includes('.v3{}'),
        () => 'module target edit',
      );
      expect(w.errors).toEqual([]);
    } finally {
      w.controller.abort();
    }
  });

  it('follows a file found in a watched folder through a link to outside it', async () => {
    writeFileSync(join(outside, 'x.tw'), passage('x', 'X1'));
    symlinkSync(join(outside, 'x.tw'), join(src, 'x.tw'));
    const w = startWatch([STORY_DATA, src]);
    try {
      await eventually(
        () => readOut().includes('X1'),
        () => 'first build',
      );
      writeFileSync(join(outside, 'x.tw'), passage('x', 'X2'));
      await eventually(
        () => readOut().includes('X2'),
        () => 'edit of the target outside',
      );
      expect(w.errors).toEqual([]);
    } finally {
      w.controller.abort();
    }
  });
});

describe('watch stops on a configuration error found while watching (FS-13)', { timeout: 30_000 }, () => {
  it.skipIf(!LINKS)('reports it and stops when a link turns the output into a source', async () => {
    writeFileSync(join(src, 'a.tw'), passage('a', 'A'));
    const w = startWatch([STORY_DATA, join(root, 'named.tw')]);
    try {
      await eventually(
        () => w.builds.length > 0,
        () => 'first build',
      );
      symlinkSync(outFile, join(root, 'named.tw'));
      await eventually(
        () => w.controller.signal.aborted,
        () => 'the watch to stop',
      );
      expect(w.errors.map((e) => e.message)).toContainEqual(
        expect.stringContaining('Output file cannot be an input source.'),
      );
    } finally {
      w.controller.abort();
    }
  });
});

describe('a stopped watch leaves nothing behind', { timeout: 30_000 }, () => {
  const handles = (): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  };

  it('closes every watcher and timer', async () => {
    writeFileSync(join(src, 'a.tw'), passage('a', 'A'));
    await new Promise((r) => setTimeout(r, 0));
    const before = handles();
    const w = startWatch([STORY_DATA, src, join(root, 'missing-yet.tw')]);
    await eventually(
      () => w.builds.length > 0,
      () => 'first build',
    );
    writeFileSync(join(src, 'a.tw'), passage('a', 'B'));
    w.controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    const after = handles();
    expect(after['FSEventWrap'] ?? 0).toBe(before['FSEventWrap'] ?? 0);
    expect(after['Timeout'] ?? 0).toBeLessThanOrEqual(before['Timeout'] ?? 0);
  });
});

/**
 * A link found in a source or module folder whose target cannot be reached (a link loop, a target in a folder that
 * cannot be searched, a missing target) is judged by its own name first (#446): a file type the role does not load is
 * skipped without a word, and so is a file `exclude` leaves out, before the target is read. Only a link that would be
 * loaded is then read, and a link loop is a link to nothing, as a dangling link is. The table "Inputs That Can't Be
 * Used" in docs/cli.md decides the rest. Each case runs through discovery and through the API, the watch and both
 * plugins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { rollup } from 'rollup';
import { compile } from '../src/compiler.js';
import { watch } from '../src/compiler.js';
import { getFilenames, watchFilesystem } from '../src/filesystem.js';
import { tweeTsPlugin as rollupTweeTs } from '../src/plugins/rollup.js';
import { tweeTsPlugin as viteTweeTs } from '../src/plugins/vite.js';
import { buildFiles, cleanUp, COMPILE, makeProject, startServer, STORY, tempDir, textOf } from './helpers/plugins.js';

const noLinks = process.platform === 'win32';
// A folder its owner cannot search; root searches it anyway, and Windows has no such mode bits.
const canLockFolder = process.platform !== 'win32' && process.getuid?.() !== 0;

const locked: string[] = [];
afterEach(async () => {
  for (const folder of locked.splice(0)) chmodSync(folder, 0o755);
  await cleanUp();
});

type Kind = 'loop' | 'dangling' | 'unsearchable';
const KINDS: readonly Kind[] = canLockFolder ? ['loop', 'dangling', 'unsearchable'] : ['loop', 'dangling'];

/** Makes the link `at` whose target cannot be reached the way `kind` says. */
function unreachableLink(kind: Kind, at: string): void {
  mkdirSync(join(at, '..'), { recursive: true });
  if (kind === 'loop') {
    symlinkSync(at.slice(at.lastIndexOf('/') + 1), at);
  } else if (kind === 'dangling') {
    symlinkSync('missing-target', at);
  } else {
    const folder = tempDir();
    writeFileSync(join(folder, 'target'), ':: Locked\nLocked.\n');
    chmodSync(folder, 0o000);
    locked.push(folder);
    symlinkSync(join(folder, 'target'), at);
  }
}

/** The path of `file` relative to the working directory, forward slashes: what an exclude glob matches. */
const fromCwd = (file: string): string => relative(process.cwd(), file).replace(/\\/g, '/');

const messages = (diagnostics: readonly { readonly level: string; readonly message: string }[]): string[] =>
  diagnostics.map((d) => `${d.level}: ${d.message}`);

describe.skipIf(noLinks)('a link in a folder that cannot be followed, found by getFilenames (#446)', () => {
  // [role, a name the role loads, a name it does not]
  const ROLES = [
    ['source', 'link.tw', 'link.txt'],
    ['module', 'link.js', 'link.txt'],
  ] as const;

  describe.each(ROLES)('%s', (role, loaded, other) => {
    describe.each(KINDS)('%s link', (kind) => {
      it(`skips a link of a type the role does not load (${other}) without a word`, () => {
        const dir = makeProject({ 'folder/ok.tw': ':: Ok\nOk.\n', 'folder/ok.js': 'window.ok = 1;' });
        unreachableLink(kind, join(dir, 'folder', other));
        const found = getFilenames([join(dir, 'folder')], undefined, [], role);
        expect(messages(found.diagnostics)).toEqual([]);
        expect(found.filenames.map((file) => resolve(file))).not.toContain(join(dir, 'folder', other));
      });
    });

    it.each(['loop', 'dangling'] as const)(
      `skips a ${loaded} link that is a %s without a word, as a dangling link is`,
      (kind) => {
        const dir = makeProject({});
        unreachableLink(kind, join(dir, 'folder', loaded));
        const found = getFilenames([join(dir, 'folder')], undefined, [], role);
        expect(messages(found.diagnostics)).toEqual([]);
        expect(found.filenames).toEqual([]);
      },
    );
  });

  describe.each(KINDS)('%s link that exclude leaves out', (kind) => {
    it('is skipped without a word', () => {
      const dir = makeProject({ 'folder/ok.tw': ':: Ok\nOk.\n' });
      unreachableLink(kind, join(dir, 'folder', 'link.tw'));
      const found = getFilenames([join(dir, 'folder')], undefined, [fromCwd(join(dir, 'folder', 'link.tw'))]);
      expect(messages(found.diagnostics)).toEqual([]);
      expect(found.filenames.map((file) => resolve(file))).toEqual([join(dir, 'folder', 'ok.tw')]);
    });
  });

  it.skipIf(!canLockFolder)(
    'reports a link into a folder that cannot be searched when exclude leaves it in and the role loads it',
    () => {
      const dir = makeProject({});
      unreachableLink('unsearchable', join(dir, 'folder', 'link.tw'));
      const found = getFilenames([join(dir, 'folder')]);
      expect(found.filenames).toEqual([]);
      expect(found.diagnostics).toEqual([expect.objectContaining({ level: 'error' })]);
    },
  );
});

describe.skipIf(noLinks)('a link in a source folder that cannot be followed, through every surface (#446)', () => {
  it.each(KINDS)('keeps watching ordinary files beside a %s link and notices its replacement', async (kind) => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const folder = join(dir, 'story');
    const link = join(folder, 'link.tw');
    unreachableLink(kind, link);
    const builds: (ReadonlySet<string> | undefined)[] = [];
    const errors: Error[] = [];
    const handle = watchFilesystem(
      [folder],
      join(dir, 'out.html'),
      (files) => builds.push(files),
      undefined,
      (error) => errors.push(error),
      { debounceMs: 10 },
      { shared: false },
    );
    try {
      expect(errors).toEqual([]);
      writeFileSync(join(folder, 'start.tw'), STORY + '\nChanged.');
      await vi.waitFor(
        () => {
          expect(builds.length).toBeGreaterThan(1);
        },
        { timeout: 5000 },
      );
      expect(errors).toEqual([]);
      builds.length = 0;
      unlinkSync(link);
      writeFileSync(link, ':: Replaced\nNow readable.');
      await vi.waitFor(
        () => {
          expect(builds.length).toBeGreaterThan(0);
        },
        { timeout: 5000 },
      );
      expect(errors).toEqual([]);
    } finally {
      handle.close();
    }
  });

  /** A project with a story and, per kind, a link excluded by name and a link of another type. */
  function project(): { dir: string; exclude: string[] } {
    const dir = makeProject({ 'story/start.tw': STORY });
    const exclude: string[] = [];
    for (const kind of KINDS) {
      unreachableLink(kind, join(dir, 'story', `excluded-${kind}.tw`));
      exclude.push(fromCwd(join(dir, 'story', `excluded-${kind}.tw`)));
      unreachableLink(kind, join(dir, 'story', `other-${kind}.txt`));
    }
    return { dir, exclude };
  }

  const pluginOptions = (dir: string, exclude: string[]) => ({
    sources: [join(dir, 'story')],
    format: 'test-format-1',
    compileOptions: { ...COMPILE, exclude },
  });

  it('compile() builds the story', async () => {
    const { dir, exclude } = project();
    const result = await compile({ ...COMPILE, sources: [join(dir, 'story')], exclude, formatId: 'test-format-1' });
    expect(messages(result.diagnostics)).toEqual([]);
    expect(result.output).toContain('Hello from the story.');
  });

  it('watch() builds the story', async () => {
    const { dir, exclude } = project();
    const out = join(dir, 'out.html');
    const built = await new Promise<string[]>((done, fail) => {
      void watch({
        ...COMPILE,
        sources: [join(dir, 'story')],
        exclude,
        formatId: 'test-format-1',
        outFile: out,
        onBuild: (result) => {
          done(messages(result.diagnostics));
        },
        onError: fail,
      }).then((controller) => {
        setTimeout(() => {
          controller.abort();
        }, 0);
      }, fail);
    });
    expect(built).toEqual([]);
  });

  it('the Rollup plugin builds the story', async () => {
    const { dir, exclude } = project();
    writeFileSync(join(dir, 'entry.js'), 'export const a = 1;\n');
    const bundle = await rollup({
      input: join(dir, 'entry.js'),
      plugins: [rollupTweeTs(pluginOptions(dir, exclude))],
      onLog: () => undefined,
    });
    const { output } = await bundle.generate({ format: 'es' });
    await bundle.close();
    const story = output.find((item) => item.fileName === 'index.html');
    expect(story?.type === 'asset' ? String(story.source) : '').toContain('Hello from the story.');
  });

  it('the Vite plugin builds the story', async () => {
    const { dir, exclude } = project();
    const files = await buildFiles({ root: dir, plugins: [viteTweeTs(pluginOptions(dir, exclude))] });
    expect(textOf(files.get('index.html'))).toContain('Hello from the story.');
  });

  it('the Vite dev server serves the story', async () => {
    const { dir, exclude } = project();
    const { url } = await startServer({
      root: dir,
      plugins: [viteTweeTs(pluginOptions(dir, exclude))],
      server: { watch: null },
    });
    expect(await (await fetch(`${url}/`)).text()).toContain('Hello from the story.');
  });
});

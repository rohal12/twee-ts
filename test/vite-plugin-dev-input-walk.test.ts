/**
 * The dev server's request catch-up (#371): before serving the story it compares the story's input files with the
 * last compile, and reuses the files of its last walk of the inputs while no folder that walk listed, no named
 * input and no output changed. A request with nothing changed then lists no folder and identifies no file; every
 * change to the inputs is still served, with no watcher at all. A fresh build is the oracle.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { createLogger } from 'vite';
import { decompileHTML } from '../src/html-parser.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { resolvePluginOptions } from '../src/plugins/options.js';
import { buildFiles, cleanUp, COMPILE, makeProject, startServer, STORY, textOf } from './helpers/plugins.js';

const calls = vi.hoisted(() => ({
  readdir: [] as string[],
  realpath: [] as string[],
  watch: [] as string[],
  failWatch: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  const realpathSync = Object.assign((...args: Parameters<typeof real.realpathSync>) => real.realpathSync(...args), {
    native: (...args: Parameters<typeof real.realpathSync.native>) => {
      calls.realpath.push(String(args[0]));
      return real.realpathSync.native(...args);
    },
  });
  const readdirSync = (...args: Parameters<typeof real.readdirSync>): ReturnType<typeof real.readdirSync> => {
    calls.readdir.push(String(args[0]));
    return real.readdirSync(...args);
  };
  const watch = (...args: Parameters<typeof real.watch>): ReturnType<typeof real.watch> => {
    calls.watch.push(String(args[0]));
    if (String(args[0]) === calls.failWatch) throw new Error('Watch unavailable');
    return real.watch(...args);
  };
  return { ...real, default: { ...real, readdirSync, realpathSync, watch }, readdirSync, realpathSync, watch };
});

afterEach(async () => {
  await cleanUp();
  calls.failWatch = undefined;
});

const passage = (name: string): string => `:: ${name}\n${name} text.\n`;

/** A project whose story is spread over folders, with an empty one. */
function project(): string {
  const dir = makeProject({
    'story/start.tw': STORY,
    'story/one.tw': passage('One'),
    'story/scenes/two.tw': passage('Two'),
    'story/scenes/deep/three.tw': passage('Three'),
  });
  fs.mkdirSync(join(dir, 'story', 'empty'));
  return dir;
}

const plugin = (dir: string): Plugin[] => [
  tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE }),
];

/** The passage names a story holds, sorted. */
function names(html: string): string[] {
  return decompileHTML(html)
    .story.passages.map((p) => p.name)
    .sort();
}

async function built(dir: string): Promise<string[]> {
  const files = await buildFiles({ root: dir, plugins: plugin(dir) });
  return names(textOf(files.get('index.html')));
}

/** A change to the story's inputs, which no watcher reports. */
interface Change {
  readonly name: string;
  readonly apply: (story: string) => void;
}

const CHANGES: readonly Change[] = [
  {
    name: 'a file added',
    apply: (story) => {
      fs.writeFileSync(join(story, 'four.tw'), passage('Four'));
    },
  },
  {
    name: 'a file added to a subfolder',
    apply: (story) => {
      fs.writeFileSync(join(story, 'scenes/deep/f.tw'), passage('F'));
    },
  },
  {
    name: 'a file added to an empty folder',
    apply: (story) => {
      fs.writeFileSync(join(story, 'empty/e.tw'), passage('E'));
    },
  },
  {
    name: 'a folder with a file added',
    apply: (story) => {
      fs.mkdirSync(join(story, 'new/deeper'), { recursive: true });
      fs.writeFileSync(join(story, 'new/deeper/n.tw'), passage('N'));
    },
  },
  {
    name: 'a file removed',
    apply: (story) => {
      fs.rmSync(join(story, 'one.tw'));
    },
  },
  {
    name: 'a file renamed',
    apply: (story) => {
      fs.renameSync(join(story, 'one.tw'), join(story, 'scenes/moved.tw'));
    },
  },
  {
    name: 'a folder removed',
    apply: (story) => {
      fs.rmSync(join(story, 'scenes'), { recursive: true });
    },
  },
  {
    name: 'a folder removed and made again with other files',
    apply: (story) => {
      fs.rmSync(join(story, 'scenes'), { recursive: true });
      fs.mkdirSync(join(story, 'scenes'));
      fs.writeFileSync(join(story, 'scenes/again.tw'), passage('Again'));
    },
  },
  {
    name: 'a file replaced by a folder of the same name',
    apply: (story) => {
      fs.rmSync(join(story, 'one.tw'));
      fs.mkdirSync(join(story, 'one.tw'));
      fs.writeFileSync(join(story, 'one.tw/inner.tw'), passage('Inner'));
    },
  },
  {
    name: 'a passage renamed in place',
    apply: (story) => {
      fs.writeFileSync(join(story, 'one.tw'), passage('Renamed'));
    },
  },
];

describe('vite plugin dev: the request catch-up reuses its walk of the inputs (#371)', { timeout: 30_000 }, () => {
  it.each(CHANGES)('serves the story a fresh build makes after $name, with no watcher', async (change) => {
    const dir = project();
    const { url } = await startServer({ root: dir, plugins: plugin(dir), server: { watch: null } });
    expect(names(await (await fetch(url)).text())).toEqual(await built(dir));
    change.apply(join(dir, 'story'));
    const expected = await built(dir);
    expect(names(await (await fetch(url)).text())).toEqual(expected);
    // And again, from the walk it just made.
    expect(names(await (await fetch(url)).text())).toEqual(expected);
  });

  it.skipIf(process.platform === 'win32')(
    'serves the files of a source folder named through a link that is retargeted, with no watcher',
    async () => {
      const dir = makeProject({ 'a/start.tw': STORY, 'a/one.tw': passage('One'), 'b/start.tw': STORY });
      fs.writeFileSync(join(dir, 'b/two.tw'), passage('Two'));
      fs.symlinkSync('a', join(dir, 'story'));
      const { url } = await startServer({ root: dir, plugins: plugin(dir), server: { watch: null } });
      expect(names(await (await fetch(url)).text())).toContain('One');
      fs.rmSync(join(dir, 'story'));
      fs.symlinkSync('b', join(dir, 'story'));
      const served = names(await (await fetch(url)).text());
      expect(served).toContain('Two');
      expect(served).not.toContain('One');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'serves the new target of a linked source file whose link in another folder is retargeted',
    async () => {
      const dir = makeProject({ 'story/start.tw': STORY, 'shared/x.tw': passage('X'), 'shared/y.tw': passage('Y') });
      fs.symlinkSync('x.tw', join(dir, 'shared/current.tw'));
      fs.symlinkSync('../shared/current.tw', join(dir, 'story/linked.tw'));
      const { url } = await startServer({ root: dir, plugins: plugin(dir), server: { watch: null } });
      expect(names(await (await fetch(url)).text())).toContain('X');
      // The link the story folder holds is unchanged; the one it points at now reaches another file.
      fs.rmSync(join(dir, 'shared/current.tw'));
      fs.symlinkSync('y.tw', join(dir, 'shared/current.tw'));
      const served = names(await (await fetch(url)).text());
      expect(served).toContain('Y');
      expect(served).not.toContain('X');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reuses module discovery across source exclusions and refreshes file-link membership (#567)',
    () => {
      const dir = makeProject({
        'story/start.tw': STORY,
        'story/excluded.png': 'x',
        'shared/one.js': 'ONE',
        'shared/two.js': 'TWO',
      });
      fs.mkdirSync(join(dir, 'modules'));
      fs.symlinkSync('one.js', join(dir, 'shared/current.js'));
      fs.symlinkSync('../shared/current.js', join(dir, 'modules/linked.js'));
      fs.symlinkSync('../shared/missing.js', join(dir, 'modules/dangling.js'));
      const options = resolvePluginOptions('vite', {
        sources: [join(dir, 'story')],
        compileOptions: { modules: [join(dir, 'modules')], exclude: [{ base: dir, glob: '**/*' }] },
      });
      calls.readdir.length = 0;
      for (let n = 0; n < 20; n += 1) expect(options.excluded(join(dir, 'story/excluded.png'))).toBe(true);
      expect(calls.readdir.filter((path) => path === join(dir, 'modules'))).toHaveLength(1);
      expect(options.excluded(join(dir, 'shared/one.js'))).toBe(false);
      fs.rmSync(join(dir, 'shared/current.js'));
      fs.symlinkSync('two.js', join(dir, 'shared/current.js'));
      expect(options.excluded(join(dir, 'shared/two.js'))).toBe(false);
      expect(options.excluded(join(dir, 'shared/one.js'))).toBe(true);
      fs.writeFileSync(join(dir, 'shared/missing.js'), 'RECOVERED');
      expect(options.excluded(join(dir, 'shared/missing.js'))).toBe(false);
      fs.rmSync(join(dir, 'modules/linked.js'));
      expect(options.excluded(join(dir, 'shared/two.js'))).toBe(true);
    },
  );

  it('lists no folder and identifies no file for a request with nothing changed', async () => {
    const dir = project();
    const { url } = await startServer({ root: dir, plugins: plugin(dir), server: { watch: null } });
    await fetch(url);
    const story = join(dir, 'story');
    calls.readdir.length = 0;
    calls.realpath.length = 0;
    await fetch(url);
    await fetch(url);
    expect(calls.readdir.filter((path) => path.startsWith(story))).toEqual([]);
    expect(calls.realpath.filter((path) => path.startsWith(join(story, 'scenes')))).toEqual([]);
    // A change brings a walk again.
    fs.writeFileSync(join(story, 'scenes/deep/late.tw'), passage('Late'));
    expect(names(await (await fetch(url)).text())).toContain('Late');
    expect(calls.readdir.filter((path) => path.startsWith(story)).length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')(
    'reuses a walk with omitted link candidates and preserves exclusions (#576)',
    async () => {
      const dir = project();
      const story = join(dir, 'story');
      fs.mkdirSync(join(dir, 'external'));
      fs.symlinkSync('../external/missing', join(story, 'candidate.tw'));
      fs.symlinkSync('../external/excluded', join(story, 'excluded.tw'));
      fs.mkdirSync(join(dir, 'dist/external'), { recursive: true });
      fs.symlinkSync('../dist/external/output', join(story, 'output.tw'));
      fs.symlinkSync('../external/folder', join(story, 'directory.tw'));
      fs.symlinkSync('../external/unknown', join(story, 'notes.txt'));
      fs.mkdirSync(join(dir, 'external/folder'));
      fs.writeFileSync(join(dir, 'external/folder/hidden.tw'), passage('Hidden'));
      const { url } = await startServer({
        root: dir,
        server: { watch: null },
        plugins: [
          tweeTsPlugin({
            sources: [story],
            outputFilename: 'external/output',
            format: 'test-format-1',
            compileOptions: { ...COMPILE, exclude: [{ base: story, glob: 'excluded.tw' }] },
          }),
        ],
      });
      const page = `${url}/external/output`;
      const before = names(await (await fetch(page)).text());
      calls.readdir.length = 0;
      await fetch(page);
      await fetch(page);
      expect(calls.readdir.filter((path) => path.startsWith(story))).toEqual([]);
      fs.writeFileSync(join(dir, 'external/excluded'), passage('Excluded'));
      fs.writeFileSync(join(dir, 'dist/external/output'), passage('Output'));
      fs.writeFileSync(join(dir, 'external/unknown'), passage('Unknown'));
      expect(names(await (await fetch(page)).text())).toEqual(before);
      fs.writeFileSync(join(dir, 'external/missing'), passage('Recovered'));
      expect(names(await (await fetch(page)).text())).toEqual([...before, 'Recovered'].sort());
    },
  );

  it.skipIf(process.platform === 'win32')(
    'watches external target parents and retains native link watches across rebuilds (#576)',
    async () => {
      const dir = project();
      const external = makeProject({ target: passage('Linked') });
      fs.symlinkSync(join(external, 'target'), join(dir, 'story/linked.tw'));
      const { url } = await startServer({ root: dir, plugins: plugin(dir) });
      expect(names(await (await fetch(url)).text())).toContain('Linked');
      expect(calls.watch).toContain(join(dir, 'story'));
      expect(calls.watch).toContain(external);
      calls.watch.length = 0;
      fs.writeFileSync(join(dir, 'story/start.tw'), STORY + '\nChanged.');
      expect(await (await fetch(url)).text()).toContain('Changed.');
      // Replacing these watches resets the shared macOS event stream just after each build.
      expect(calls.watch.filter((path) => path === join(dir, 'story'))).toEqual([]);
      fs.writeFileSync(join(external, 'target'), passage('ChangedLinked'));
      expect(names(await (await fetch(url)).text())).toContain('ChangedLinked');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports unavailable recovery watches and still catches up on request (#576)',
    async () => {
      const dir = project();
      const external = makeProject({});
      fs.symlinkSync(join(external, 'target'), join(dir, 'story/candidate.tw'));
      calls.failWatch = external;
      const logger = createLogger('silent');
      const warn = vi.spyOn(logger, 'warn');
      const { url } = await startServer({ root: dir, plugins: plugin(dir), customLogger: logger });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Watch unavailable'));
      fs.writeFileSync(join(external, 'target'), passage('Recovered'));
      expect(names(await (await fetch(url)).text())).toContain('Recovered');
    },
  );
});

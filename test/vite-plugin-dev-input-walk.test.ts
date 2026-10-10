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
import { decompileHTML } from '../src/html-parser.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { buildFiles, cleanUp, COMPILE, makeProject, startServer, STORY, textOf } from './helpers/plugins.js';

const calls = vi.hoisted(() => ({ readdir: [] as string[], realpath: [] as string[] }));

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
  return { ...real, default: { ...real, readdirSync, realpathSync }, readdirSync, realpathSync };
});

afterEach(cleanUp);

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
});

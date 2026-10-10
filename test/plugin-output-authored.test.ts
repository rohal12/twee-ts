/**
 * A bundler's build writes its chunks and assets over what is in the output folder, but the story it writes is
 * checked as the CLI checks its output file: an existing file of a loadable type that twee-ts did not build, inside
 * a source folder, is the author's own, and the build fails instead of overwriting it (#402). The dev server
 * writes nothing, so it serves the story all the same.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { COMPILE, STORY, cleanUp, makeProject, startServer, storyWith } from './helpers/plugins.js';

afterEach(cleanUp);

const AUTHORED_HTML =
  '<!doctype html><html><body><tw-storydata name="Authored" startnode="1" creator="Twine" creator-version="2.6.2" ' +
  'ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" format="Harlowe" format-version="3.3.0" options="" hidden>' +
  '<tw-passagedata pid="1" name="Start" tags="" position="0,0" size="100,100">Authored</tw-passagedata>' +
  '</tw-storydata></body></html>';

const project = (): string => makeProject({ 'story/start.tw': STORY, 'story/story.html': AUTHORED_HTML });

const plugin = (dir: string): ReturnType<typeof tweeTsPlugin> =>
  tweeTsPlugin({
    sources: [join(dir, 'story')],
    format: 'test-format-1',
    outputFilename: 'story.html',
    compileOptions: COMPILE,
  });

describe('the Vite build over an authored file at the story path (#402)', () => {
  it.each([
    ['build.outDir', (dir: string) => ({ outDir: join(dir, 'story') })],
    [
      'an output.dir',
      (dir: string) => ({ outDir: join(dir, 'dist'), rolldownOptions: { output: { dir: join(dir, 'story') } } }),
    ],
  ])('fails and leaves the file alone with %s inside the sources', async (_name, buildOptions) => {
    const dir = project();
    await expect(
      build({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        build: { emptyOutDir: false, ...buildOptions(dir) },
        plugins: [plugin(dir)],
      }),
    ).rejects.toThrow('Output file cannot be an input source');
    expect(readFileSync(join(dir, 'story', 'story.html'), 'utf-8')).toBe(AUTHORED_HTML);
  });

  it('writes over an earlier build of the story', async () => {
    const dir = makeProject({ 'story/start.tw': STORY });
    const run = (): Promise<unknown> =>
      build({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        build: { outDir: join(dir, 'story'), emptyOutDir: false },
        plugins: [plugin(dir)],
      });
    await run();
    writeFileSync(join(dir, 'story', 'start.tw'), storyWith('Second build.'));
    await run();
    expect(readFileSync(join(dir, 'story', 'story.html'), 'utf-8')).toContain('Second build.');
  });

  it('still serves the story from the dev server', async () => {
    const dir = project();
    const { url } = await startServer({
      root: dir,
      publicDir: false,
      server: { watch: null },
      build: { outDir: join(dir, 'story') },
      plugins: [plugin(dir)],
    });
    const body = await (await fetch(`${url}/story.html`)).text();
    expect(body).toContain('Hello from the story.');
  });
});

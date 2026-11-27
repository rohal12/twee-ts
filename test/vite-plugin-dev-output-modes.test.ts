import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { compile, parseTwee } from '../src/index.js';
import type { OutputMode } from '../src/index.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  makeProject,
  cleanUp,
  NO_DEP_OPTIMIZER,
  serverUrl,
  buildFiles,
  textOf,
  COMPILE,
  STORY,
  storyWith,
} from './helpers/plugins.js';

let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await cleanUp();
});

const MODES: readonly (readonly [OutputMode, string, string])[] = [
  ['json', 'story.json', 'application/json'],
  ['twee3', 'story.twee', 'text/plain'],
  ['twee1', 'story.twee', 'text/plain'],
  ['twine2-archive', 'story.html', 'text/html'],
  ['twine1-archive', 'story.html', 'text/html'],
];

/** What a consumer reads from each output: the story name, or the passage names in order. */
const structure: Record<OutputMode, (text: string) => unknown> = {
  json: (text) => [(JSON.parse(text) as { name: string }).name],
  twee3: (text) => parseTwee(text).passages.map((p) => p.name),
  twee1: (text) => parseTwee(text).passages.map((p) => p.name),
  html: () => [],
  'twine2-archive': (text) => [text.includes('tw-storydata')],
  'twine1-archive': (text) => [text.includes('tiddler')],
};

describe('vite plugin dev: output modes other than playable HTML (#358)', () => {
  it.each(MODES)('serves %s as compiled, with its media type, and again after an edit', async (mode, name, type) => {
    const root = makeProject({ 'story/start.tw': STORY });
    const config = () => ({
      configFile: false as const,
      root,
      logLevel: 'silent' as const,
      plugins: [
        tweeTsPlugin({
          sources: [join(root, 'story')],
          format: 'test-format-1',
          outputFilename: name,
          compileOptions: { ...COMPILE, outputMode: mode },
        }),
      ],
    });
    server = await createServer({
      ...NO_DEP_OPTIMIZER,
      ...config(),
      server: { host: '127.0.0.1', port: 0, watch: null },
    });
    await server.listen();
    const url = `${serverUrl(server)}/${name}`;
    const first = await fetch(url);
    const dev = await first.text();
    expect(first.headers.get('content-type')).toContain(type);
    expect(dev).not.toContain('/@vite/client');
    const built = textOf((await buildFiles(config())).get(name));
    expect(dev).toBe(built);
    expect(structure[mode](dev)).toEqual(structure[mode](built));
    expect(structure[mode](dev)).not.toEqual([]);

    writeFileSync(join(root, 'story/start.tw'), storyWith('Edited text.'));
    const second = await (await fetch(url)).text();
    expect(second).toContain('Edited text.');
    expect(second).not.toContain('/@vite/client');
  });
});

describe('vite plugin dev: successful empty Twee exports (#584)', () => {
  it.each(
    (['twee1', 'twee3'] as const).flatMap((outputMode) =>
      [false, true].map((failedFirst) => ({ outputMode, failedFirst })),
    ),
  )('serves empty $outputMode output (failed first build: $failedFirst)', async ({ outputMode, failedFirst }) => {
    const broken = ':: StoryData\n{invalid JSON';
    const root = makeProject({ 'story.tw': failedFirst ? broken : '' });
    const source = join(root, 'story.tw');
    const config = () => ({
      configFile: false as const,
      root,
      logLevel: 'silent' as const,
      plugins: [tweeTsPlugin({ sources: [source], outputFilename: 'story.twee', compileOptions: { outputMode } })],
    });
    server = await createServer({
      ...NO_DEP_OPTIMIZER,
      ...config(),
      server: { host: '127.0.0.1', port: 0, watch: null },
    });
    await server.listen();
    const url = `${serverUrl(server)}/story.twee`;
    const initial = await fetch(url);
    expect(initial.headers.get('content-type')).toBe(
      failedFirst ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    );
    expect((await initial.text()).includes('The story has not compiled yet.')).toBe(failedFirst);
    writeFileSync(source, '');
    const direct = await compile({ sources: [source], outputMode });
    expect(direct.diagnostics).toEqual([]);
    expect(direct.output).toBe('');
    const built = (await buildFiles(config())).get('story.twee');
    expect(built).toBe('');

    const expectEmpty = async (): Promise<void> => {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(url, { method });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(response.headers.get('content-length')).toBe('0');
        expect(await response.text()).toBe(direct.output);
      }
    };
    await expectEmpty();
    writeFileSync(source, ':: Start\nNonempty control');
    expect(await (await fetch(url)).text()).toContain('Nonempty control');
    writeFileSync(source, '');
    await expectEmpty();

    const send = vi.spyOn(server.ws, 'send');
    writeFileSync(source, broken);
    await expectEmpty();
    expect(send).toHaveBeenCalledWith({ type: 'error', err: expect.objectContaining({ plugin: 'twee-ts' }) });
    writeFileSync(source, ':: Start\nRecovered');
    expect(await (await fetch(url)).text()).toContain('Recovered');
  });
});

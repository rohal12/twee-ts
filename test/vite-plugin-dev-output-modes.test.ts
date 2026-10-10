import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { parseTwee } from '../src/index.js';
import type { OutputMode } from '../src/index.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { makeProject, cleanUp, serverUrl, buildFiles, textOf, COMPILE, STORY, storyWith } from './helpers/plugins.js';

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
    server = await createServer({ ...config(), server: { host: '127.0.0.1', port: 0, watch: null } });
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

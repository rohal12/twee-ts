/** Explicitly imported map data survives both entry build branches and dev, outside the static root (#457). */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  COMPILE,
  STORY,
  buildFiles,
  cleanUp,
  makeProject,
  startServer,
  textOf,
  userScript,
} from './helpers/plugins.js';

afterEach(cleanUp);

describe('imported map assets (#457)', () => {
  it.each(['inside', 'separate', 'dev'] as const)('serves the referenced bytes: %s', async (mode) => {
    const assets = makeProject({ 'world.map': 'map-file-data', 'world.txt': 'text-file-data' });
    const root = makeProject({
      'story/start.tw': STORY,
      'outer.js': 'globalThis.outer = 1;',
      'entry.js': `import map from ${JSON.stringify(`${assets}/world.map?url&no-inline`)};
import text from ${JSON.stringify(`${assets}/world.txt?url&no-inline`)};
globalThis.urls = [map, text];`,
    });
    const common = {
      root,
      base: '/game/',
      publicDir: false as const,
      plugins: [
        tweeTsPlugin({
          sources: [join(root, 'story')],
          entry: join(root, 'entry.js'),
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    };
    let html: string;
    let url: string;
    let emitted: string[] | undefined;
    let generatedMap = false;
    if (mode === 'dev') {
      ({ url } = await startServer({ ...common, server: { watch: null } }));
      html = await (await fetch(`${url}/game/index.html`)).text();
    } else {
      const files = await buildFiles({
        ...common,
        build: {
          sourcemap: true,
          minify: false,
          ...(mode === 'separate' ? { rolldownOptions: { input: join(root, 'outer.js') } } : {}),
        },
      });
      html = textOf(files.get('index.html'));
      emitted = [textOf(files.get('world.map')), textOf(files.get('world.txt'))];
      generatedMap = files.has('twee-ts-entry.js.map');
      const deployed = makeProject(Object.fromEntries(files));
      ({ url } = await startServer({ root: deployed, base: '/game/', publicDir: false, server: { watch: null } }));
    }
    const served = await Promise.all(
      ['world.map', 'world.txt'].map(async (name) => {
        const response = await fetch(`${url}/game/${name}`);
        return { status: response.status, body: await response.text() };
      }),
    );
    expect(served).toEqual([
      { status: 200, body: 'map-file-data' },
      { status: 200, body: 'text-file-data' },
    ]);
    expect(emitted).toEqual(mode === 'dev' ? undefined : ['map-file-data', 'text-file-data']);
    expect(generatedMap).toBe(false);
    expect(userScript(html)).toContain('/game/world.map');
    expect(userScript(html)).toContain('/game/world.txt');
  });
});

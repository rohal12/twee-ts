/** Vite owns string-result encoding; runtime URLs encode paths, preserving URL postfixes (#574). */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { InlineConfig } from 'vite';
import { decompileHTML } from '../src/html-parser.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  cleanUp,
  COMPILE,
  makeProject,
  startServer,
  STORY,
  buildFiles,
  textOf,
  userScript,
} from './helpers/plugins.js';

afterEach(cleanUp);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="café"/></svg>';
const PUBLIC = Buffer.from([1, 2, 3]);

describe.each(['./', '/app/', 'https://example.com/app/'])('entry URL encoding under %s', (base) => {
  describe.each(['index.html', 'nested/story.html'])('%s', (outputFilename) => {
    it.each(['inside', 'separate', 'dev'] as const)('preserves components and serves assets: %s', async (branch) => {
      const dir = makeProject({
        'story/start.tw': STORY,
        'entry.js': `import svg from './image%name.svg?no-inline&tag=a%26b#caf%C3%A9';
          import './style.css'; out.url = svg;`,
        'extra.js': 'globalThis.extra = 1;',
        'image%name.svg': SVG,
        'public/percent%name.png': PUBLIC,
        'public/plain.png': PUBLIC,
        'style.css': 'body { background: url("/percent%25name.png") } p { background: url("/plain.png") }',
      });
      const config: InlineConfig = {
        root: dir,
        base,
        plugins: [
          tweeTsPlugin({
            sources: [join(dir, 'story')],
            entry: join(dir, 'entry.js'),
            outputFilename,
            format: 'test-format-1',
            compileOptions: COMPILE,
          }),
        ],
      };
      const files =
        branch === 'dev'
          ? undefined
          : await buildFiles({
              ...config,
              build: {
                write: true,
                ...(branch === 'separate' ? { rolldownOptions: { input: join(dir, 'extra.js') } } : {}),
              },
            });
      const server = branch === 'dev' ? await startServer({ ...config, server: { watch: null } }) : undefined;
      const deployedAt = base === './' ? '/' : '/app/';
      const page = `${server?.url ?? 'http://localhost'}${deployedAt}${outputFilename}`;
      const html = files === undefined ? await (await fetch(page)).text() : textOf(files.get(outputFilename));
      const out: { url?: string } = {};
      runInNewContext(userScript(html), { out, URL, document: { URL: page }, window: {} });
      const asset = new URL(out.url ?? '', page);
      expect.soft(asset.search).toBe('?tag=a%26b');
      expect.soft(asset.hash).toBe('#caf%C3%A9');
      const css = decompileHTML(html)
        .story.passages.filter((p) => p.tags.includes('stylesheet'))
        .map((p) => p.text)
        .join('\n');
      const references = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => new URL(match[1] ?? '', page));
      expect(references.map((url) => decodeURIComponent(url.pathname.split('/').at(-1) ?? '')).sort()).toEqual([
        'percent%name.png',
        'plain.png',
      ]);
      // Full deployment URLs select another origin; test the same paths on the local server.
      const read = async (url: URL): Promise<string> => {
        if (server !== undefined) {
          const response = await fetch(`${server.url}${url.pathname}${url.search}`);
          return `${response.status}:${await response.text()}`;
        }
        const name = decodeURIComponent(url.pathname.slice(deployedAt.length));
        return `200:${readFileSync(join(dir, 'dist', name), 'utf8')}`;
      };
      expect(await read(asset)).toBe(`200:${SVG}`);
      for (const reference of references) expect(await read(reference)).toBe(`200:${PUBLIC.toString()}`);
    });
  });
});

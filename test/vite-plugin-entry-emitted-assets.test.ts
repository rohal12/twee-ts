/** Plugin-emitted resources remain URL-addressable beside the entry's extracted code (#331, #457). */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { decompileHTML } from '../src/html-parser.js';
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

function resourcePlugin(
  resources: Readonly<Record<string, string>>,
  originalFileName: string | undefined,
  useName: boolean,
  customUrl: boolean,
): Plugin {
  return {
    name: 'emitted-resources',
    enforce: 'pre',
    resolveFileUrl: {
      order: 'pre',
      handler({ fileName }) {
        return customUrl ? JSON.stringify(`/game/${fileName}`) : null;
      },
    },
    resolveId(id) {
      if (id === 'virtual:resources') return '\0resources';
      return undefined;
    },
    load(id) {
      if (id !== '\0resources') return undefined;
      const urls = Object.entries(resources).map(([fileName, source]) => {
        const ref = this.emitFile({
          type: 'asset',
          ...(useName ? { name: fileName } : { fileName }),
          source,
          ...(originalFileName === undefined ? {} : { originalFileName }),
        });
        return `import.meta.ROLLUP_FILE_URL_${ref}`;
      });
      return `export default [${urls.join(',')}];`;
    },
  };
}

describe.each([
  [undefined, false, false],
  ['relative-resource', false, false],
  ['style.css', false, false],
  ['style.css', true, false],
  ['style.css', false, true],
] as const)(
  'emitted assets with originalFileName %s (name-only: %s, custom URL: %s)',
  (originalFileName, useName, customUrl) => {
    it.each([
      ['inside', false],
      ['inside', true],
      ['inside', 'hidden'],
      ['inside', 'inline'],
      ['separate', false],
      ['separate', true],
      ['separate', 'hidden'],
      ['separate', 'inline'],
      ['dev', false],
    ] as const)('serves resources and applies only the entry CSS: %s, sourcemap %s', async (mode, sourcemap) => {
      const resources = {
        [useName ? 'style.css' : 'lazy.css']: 'body { color: red }',
        'world.map': 'MAP DATA',
        'world.txt': 'TEXT DATA',
      };
      const root = makeProject({
        'story/start.tw': STORY,
        'outer.js': 'globalThis.outer = 1;',
        'applied.css': 'p { color: blue }',
        'entry.js': `import urls from 'virtual:resources'; import './applied.css'; globalThis.urls = urls;`,
      });
      const common = {
        root,
        base: '/game/',
        publicDir: false as const,
        plugins: [
          resourcePlugin(resources, originalFileName, useName, customUrl),
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
      let generatedMap = false;
      if (mode === 'dev') {
        ({ url } = await startServer({ ...common, server: { watch: null } }));
        html = await (await fetch(`${url}/game/index.html`)).text();
      } else {
        const files = await buildFiles({
          ...common,
          build: {
            sourcemap,
            minify: false,
            ...(mode === 'separate' ? { rolldownOptions: { input: join(root, 'outer.js') } } : {}),
          },
        });
        html = textOf(files.get('index.html'));
        generatedMap = files.has('twee-ts-entry.js.map');
        const deployed = makeProject(Object.fromEntries(files));
        ({ url } = await startServer({ root: deployed, base: '/game/', publicDir: false, server: { watch: null } }));
      }
      const served = await Promise.all(
        Object.keys(resources).map(async (name) => {
          // A browser loads a stylesheet as CSS; Vite otherwise transforms a dev CSS request into a JS module.
          const response = await fetch(`${url}/game/${name}`, { headers: { Accept: 'text/css' } });
          return { status: response.status, body: await response.text() };
        }),
      );
      expect(generatedMap).toBe(false);
      expect(served).toEqual(Object.values(resources).map((body) => ({ status: 200, body })));
      const styles = decompileHTML(html)
        .story.passages.filter((p) => p.tags.includes('stylesheet'))
        .map((p) => p.text)
        .join('\n');
      expect(styles).toMatch(/color: ?(blue|#00f)/);
      expect(styles).not.toContain('red');
      for (const name of Object.keys(resources)) expect(userScript(html)).toContain(`/game/${name}`);
    });
  },
);

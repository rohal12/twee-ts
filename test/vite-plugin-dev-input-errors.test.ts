/** Failed input probes must reach compiler diagnostics without breaking the dev story route (#500). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createLogger } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { cleanUp, COMPILE, makeProject, startServer, STORY, storyWith } from './helpers/plugins.js';

afterEach(cleanUp);

const ROLES = [
  { role: 'source', file: 'extra.tw', content: ':: Extra\nExtra input.\n', marker: 'Extra input.', prefix: 'load ' },
  {
    role: 'head',
    file: 'head.html',
    content: '<meta name="extra" content="input">',
    marker: 'name="extra"',
    prefix: 'load head file ',
  },
  {
    role: 'module',
    file: 'extra.js',
    content: 'globalThis.extra = "input";',
    marker: 'globalThis.extra',
    prefix: 'load module ',
  },
] as const;

/** The request result, including status: Vite's error middleware otherwise disguises a failed story route. */
async function page(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

describe('vite plugin dev: failed named input tracking (#500)', { timeout: 30_000 }, () => {
  it
    .skipIf(process.platform === 'win32')
    .each(
      ROLES.flatMap((input) =>
        ['startup', 'after a good compile', 'after missing'].map((when) => ({ ...input, when })),
      ),
    )(
    'retains a page and recovers from a looping $role input $when',
    async ({ role, file, content, marker, prefix, when }) => {
      const root = makeProject({ 'story.tw': STORY });
      const input = join(root, file);
      const logger = createLogger('silent');
      const errors = vi.spyOn(logger, 'error');
      const loop = (): void => {
        rmSync(input, { force: true });
        symlinkSync(basename(input), input);
      };
      if (when === 'startup') loop();
      else if (when === 'after a good compile') writeFileSync(input, content);
      const { server, url } = await startServer({
        root,
        customLogger: logger,
        plugins: [
          tweeTsPlugin({
            sources: [join(root, 'story.tw'), ...(role === 'source' ? [input] : [])],
            format: 'test-format-1',
            compileOptions: {
              ...COMPILE,
              ...(role === 'head' ? { headFile: input } : {}),
              ...(role === 'module' ? { modules: [input] } : {}),
            },
          }),
        ],
        server: { watch: null },
      });
      const initial = await page(url);
      expect(initial.status).toBe(200);
      expect(initial.body.includes('The story has not compiled yet.')).toBe(
        when === 'startup' || (when === 'after missing' && role === 'head'),
      );
      const send = vi.spyOn(server.ws, 'send');
      if (when !== 'startup') loop();
      const failed = await page(url);
      expect(failed.status).toBe(200);
      expect(failed.body).toBe(initial.body);
      expect(failed.body).toContain('/@vite/client');
      expect(errors.mock.calls.map(([message]) => message).join('\n')).toContain(`${prefix}${input}: ELOOP`);
      const overlay = {
        type: 'error',
        err: expect.objectContaining({ message: expect.stringContaining(`${prefix}${input}: ELOOP`) }),
      };
      expect(send.mock.calls.map(([payload]) => payload)).toEqual(when === 'startup' ? [] : [overlay]);
      const reports = errors.mock.calls.length;
      expect(await page(url)).toEqual(failed);
      expect(await page(url)).toEqual(failed);
      expect(errors).toHaveBeenCalledTimes(reports);
      rmSync(input);
      writeFileSync(input, content);
      const recovered = await page(url);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toContain(marker);
      expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '/index.html' });
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each(ROLES)(
    'retains the last story when a $role input parent becomes inaccessible',
    async ({ role, file, content, prefix }) => {
      const root = makeProject({ 'story.tw': STORY });
      const parent = join(root, 'private');
      mkdirSync(parent);
      const input = join(parent, file);
      writeFileSync(input, content);
      const { server, url } = await startServer({
        root,
        plugins: [
          tweeTsPlugin({
            sources: [join(root, 'story.tw'), ...(role === 'source' ? [input] : [])],
            format: 'test-format-1',
            compileOptions: {
              ...COMPILE,
              ...(role === 'head' ? { headFile: input } : {}),
              ...(role === 'module' ? { modules: [input] } : {}),
            },
          }),
        ],
        server: { watch: null },
      });
      const initial = await page(url);
      const send = vi.spyOn(server.ws, 'send');
      try {
        chmodSync(parent, 0);
        expect(await page(url)).toEqual(initial);
        expect(send).toHaveBeenCalledWith({
          type: 'error',
          err: expect.objectContaining({ message: expect.stringContaining(`${prefix}${input}: EACCES`) }),
        });
      } finally {
        chmodSync(parent, 0o700);
      }
      writeFileSync(join(root, 'story.tw'), storyWith('Recovered permissions.'));
      expect((await page(url)).body).toContain('Recovered permissions.');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps another story available while one input fails and recovers',
    async () => {
      const root = makeProject({ 'a.tw': storyWith('First story.'), 'b.tw': storyWith('Second story.') });
      const input = join(root, 'a.tw');
      const { url } = await startServer({
        root,
        server: { watch: null },
        plugins: ['a', 'b'].map((name) =>
          tweeTsPlugin({
            sources: [join(root, `${name}.tw`)],
            format: 'test-format-1',
            outputFilename: `${name}.html`,
            compileOptions: COMPILE,
          }),
        ),
      });
      rmSync(input);
      symlinkSync('a.tw', input);
      // Every story request catches up every instance, including the one whose input cannot be probed.
      const second = await page(`${url}/b.html`);
      expect(second.status).toBe(200);
      expect(second.body).toContain('Second story.');
      expect((await page(`${url}/a.html`)).body).toContain('First story.');
      rmSync(input);
      writeFileSync(input, storyWith('First story recovered.'));
      expect(await page(`${url}/b.html`)).toEqual(second);
      expect((await page(`${url}/a.html`)).body).toContain('First story recovered.');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'retains the story when a watched entry folder becomes a link loop',
    async () => {
      const root = makeProject({
        'story.tw': STORY,
        'data/value.txt': 'ORIGINAL',
        'main.js': 'import value from "virtual:data"; globalThis.data = value;',
      });
      const folder = join(root, 'data');
      const { server, url } = await startServer({
        root,
        server: { watch: null },
        plugins: [
          {
            name: 'watched-data-folder',
            resolveId: (id) => (id === 'virtual:data' ? '\0virtual:data' : undefined),
            load(id) {
              if (id !== '\0virtual:data') return undefined;
              this.addWatchFile(folder);
              return `export default ${JSON.stringify(readFileSync(join(folder, 'value.txt'), 'utf8'))};`;
            },
          },
          tweeTsPlugin({
            sources: [join(root, 'story.tw')],
            format: 'test-format-1',
            entry: join(root, 'main.js'),
            compileOptions: COMPILE,
          }),
        ],
      });
      const initial = await page(url);
      const send = vi.spyOn(server.ws, 'send');
      rmSync(folder, { recursive: true });
      symlinkSync('data', folder);
      expect(await page(url)).toEqual(initial);
      expect(send).toHaveBeenCalledWith({
        type: 'error',
        err: expect.objectContaining({ message: expect.stringContaining('ELOOP') }),
      });
      rmSync(folder);
      mkdirSync(folder);
      writeFileSync(join(folder, 'value.txt'), 'RECOVERED');
      const recovered = await page(url);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toContain('RECOVERED');
    },
  );
});

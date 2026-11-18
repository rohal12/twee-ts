/** Linked files keep the source/module role of the folder that discovered them (#566, #567). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { watch as rollupWatch } from 'rollup';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { tweeTsPlugin as rollupPlugin } from '../src/plugins/rollup.js';
import type { ExcludeGlob } from '../src/types.js';
import {
  cleanUp,
  COMPILE,
  makeProject,
  SETTLED,
  startServer,
  STORY,
  tempDir,
  trackBuildWatch,
} from './helpers/plugins.js';

afterEach(cleanUp);

function project(role: 'source' | 'module', extension = 'js') {
  const root = makeProject({ 'story/start.tw': STORY, 'entry.js': '' });
  const shared = tempDir();
  const folder = join(root, role === 'source' ? 'story' : 'modules');
  mkdirSync(join(folder, 'deep'), { recursive: true });
  const name = role === 'source' ? 'linked.tw' : `linked.${extension}`;
  const target = join(shared, name);
  const next = join(shared, `next.${role === 'source' ? 'tw' : extension}`);
  const middle = join(shared, `current.${role === 'source' ? 'tw' : extension}`);
  const alias = join(folder, 'deep', name);
  const content = (text: string): string => (role === 'source' ? `:: Linked\n${text}` : `/* ${text} */`);
  writeFileSync(target, content('FIRST'));
  writeFileSync(next, content('RETARGETED'));
  symlinkSync(target, middle);
  symlinkSync(middle, alias);
  const sources = [join(root, 'story')];
  const compileOptions = { ...COMPILE, ...(role === 'module' ? { modules: [folder] } : {}) };
  return { root, folder, target, next, middle, alias, content, sources, compileOptions };
}

const excludes = (folder: string): readonly (readonly (string | ExcludeGlob)[])[] => [
  [join(folder, '**/*')],
  [`${relative(process.cwd(), folder)}/**/*`],
  [{ base: folder, glob: '**/*' }],
  [
    `${relative(process.cwd(), folder)}/**/*.js`,
    `${relative(process.cwd(), folder)}/**/*.css`,
    `${relative(process.cwd(), folder)}/**/*.woff`,
  ],
];

const reloads = (send: { mock: { calls: unknown[][] } }): number =>
  send.mock.calls.filter(([payload]) => Reflect.get(Object(payload), 'type') === 'full-reload').length;

describe.skipIf(process.platform === 'win32')('linked input updates (#566, #567)', { timeout: 30_000 }, () => {
  it.each([
    { role: 'source', excluded: false },
    { role: 'module', excluded: false },
    { role: 'module', excluded: true },
  ] as const)(
    'reloads a discovered $role (excluded: $excluded) before any catch-up request (#566)',
    async ({ role, excluded }) => {
      const p = project(role);
      const { server, url } = await startServer({
        root: p.root,
        plugins: [
          tweeTsPlugin({
            sources: p.sources,
            format: 'test-format-1',
            compileOptions: {
              ...p.compileOptions,
              ...(excluded ? { exclude: [{ base: p.root, glob: '**/*.js' }] } : {}),
            },
          }),
        ],
      });
      expect(await (await fetch(url)).text()).toContain('FIRST');
      const send = vi.spyOn(server.ws, 'send');
      writeFileSync(p.target, p.content('SECOND_VERSION'));
      await vi.waitFor(() => {
        expect(reloads(send)).toBeGreaterThan(0);
      }, SETTLED);
      expect(await (await fetch(url)).text()).toContain('SECOND_VERSION');
      const replaced = reloads(send);
      rmSync(p.alias);
      writeFileSync(p.alias, p.content('REPLACED_LINK'));
      await vi.waitFor(() => {
        expect(reloads(send)).toBeGreaterThan(replaced);
      }, SETTLED);
      expect(await (await fetch(url)).text()).toContain('REPLACED_LINK');
      const restored = reloads(send);
      rmSync(p.alias);
      symlinkSync(p.middle, p.alias);
      await vi.waitFor(() => {
        expect(reloads(send)).toBeGreaterThan(restored);
      }, SETTLED);
      expect(await (await fetch(url)).text()).toContain('SECOND_VERSION');
      const before = reloads(send);
      rmSync(p.middle);
      symlinkSync(p.next, p.middle);
      await vi.waitFor(() => {
        expect(reloads(send)).toBeGreaterThan(before);
      }, SETTLED);
      expect(await (await fetch(url)).text()).toContain('RETARGETED');
      const moved = reloads(send);
      // The newly selected target must be watched too, without another HTTP request bringing the change.
      await vi.waitFor(() => {
        if (reloads(send) === moved) writeFileSync(p.next, p.content('SAVED_AFTER_RETARGET'));
        expect(reloads(send)).toBeGreaterThan(moved);
      }, SETTLED);
      expect(await (await fetch(url)).text()).toContain('SAVED_AFTER_RETARGET');
    },
  );

  it.each(['source', 'module'] as const)(
    'reloads for a newly discovered %s file link before a request (#566)',
    async (role) => {
      const p = project(role);
      rmSync(p.alias);
      const { server, url } = await startServer({
        root: p.root,
        plugins: [
          tweeTsPlugin({
            sources: p.sources,
            format: 'test-format-1',
            compileOptions: p.compileOptions,
          }),
        ],
      });
      expect(await (await fetch(url)).text()).not.toContain('FIRST');
      const send = vi.spyOn(server.ws, 'send');
      symlinkSync(p.middle, p.alias);
      await vi.waitFor(() => {
        expect(reloads(send)).toBeGreaterThan(0);
      }, SETTLED);
      expect(await (await fetch(url)).text()).toContain('FIRST');
    },
  );

  it.each(['js', 'css', 'woff'])(
    'catches up with excluded discovered .%s modules without a watcher (#567)',
    async (ext) => {
      const p = project('module', ext);
      for (const exclude of excludes(p.folder)) {
        writeFileSync(p.target, p.content('FIRST'));
        const { url } = await startServer({
          root: p.root,
          server: { watch: null },
          plugins: [
            tweeTsPlugin({
              sources: p.sources,
              format: 'test-format-1',
              compileOptions: { ...p.compileOptions, exclude },
            }),
          ],
        });
        const observed = (text: string): string =>
          ext === 'woff' ? Buffer.from(p.content(text)).toString('base64') : text;
        expect(await (await fetch(url)).text()).toContain(observed('FIRST'));
        writeFileSync(p.target, p.content('SECOND_VERSION'));
        expect(await (await fetch(url)).text()).toContain(observed('SECOND_VERSION'));
      }
    },
  );

  it('rebuilds Rollup for an excluded discovered module link (#567)', async () => {
    const p = project('module');
    const out = join(p.root, 'dist/index.html');
    const watcher = trackBuildWatch(
      rollupWatch({
        input: join(p.root, 'entry.js'),
        plugins: [
          rollupPlugin({
            sources: p.sources,
            format: 'test-format-1',
            compileOptions: {
              ...p.compileOptions,
              exclude: [{ base: p.folder, glob: '**/*.js' }],
            },
          }),
        ],
        output: { dir: join(p.root, 'dist'), format: 'es' },
        onLog: () => {},
      }),
    );
    try {
      await vi.waitFor(() => {
        expect(readFileSync(out, 'utf8')).toContain('FIRST');
      }, SETTLED);
      await vi.waitFor(() => {
        if (!readFileSync(out, 'utf8').includes('SECOND_VERSION')) writeFileSync(p.target, p.content('SECOND_VERSION'));
        expect(readFileSync(out, 'utf8')).toContain('SECOND_VERSION');
      }, SETTLED);
    } finally {
      await watcher.close();
    }
  });
});

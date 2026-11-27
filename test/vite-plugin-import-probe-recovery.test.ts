/** A failed filesystem probe must not discard an import's recovery observations (#583). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, createLogger } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  buildWatchSeesFolders,
  cleanUp,
  COMPILE,
  makeProject,
  SETTLED,
  startServer,
  STORY,
  trackBuildWatch,
} from './helpers/plugins.js';
import type { BuildWatcher } from './helpers/plugins.js';

const restricted: string[] = [];
afterEach(async () => {
  for (const folder of restricted.splice(0)) chmodSync(folder, 0o700);
  await cleanUp();
});

const FAILURES = [
  { fault: 'loop', code: 'ELOOP', skip: process.platform === 'win32' },
  { fault: 'permission', code: 'EACCES', skip: process.platform === 'win32' || process.getuid?.() === 0 },
] as const;

/** An external entry, so root watching cannot conceal a lost dependency observation. */
function project(fault: 'loop' | 'permission', linked = false, workers = 0) {
  const root = makeProject({ 'story.tw': STORY, 'outer.js': 'globalThis.outer = 1;' });
  const app = makeProject({
    'main.js': 'import { value } from "./restricted/dep.js"; globalThis.probe = value;',
    ...(linked ? {} : { 'restricted/dep.js': 'export const value = "ORIGINAL";' }),
  });
  const dependency = linked ? makeProject({ 'restricted/dep.js': 'export const value = "ORIGINAL";' }) : app;
  const folder = join(dependency, 'restricted');
  if (linked) symlinkSync(folder, join(app, 'restricted'), 'junction');
  const dep = join(folder, 'dep.js');
  let entryName = 'main.js';
  for (let depth = 1; depth <= workers; depth += 1) {
    const name = `worker-entry-${String(depth)}.js`;
    writeFileSync(join(app, name), `new Worker(new URL('./${entryName}', import.meta.url), { type: 'module' });`);
    entryName = name;
  }
  restricted.push(folder);
  return {
    root,
    dep,
    entry: join(app, entryName),
    breakImport: () => {
      if (fault === 'permission') chmodSync(folder, 0);
      else {
        rmSync(dep);
        symlinkSync('dep.js', dep);
      }
    },
    repair: () => {
      chmodSync(folder, 0o700);
      if (fault === 'loop') {
        rmSync(dep);
        writeFileSync(dep, 'export const value = "RECOVERED_EXTERNAL";');
      }
    },
    recovered: fault === 'loop' ? 'RECOVERED_EXTERNAL' : 'ORIGINAL',
  };
}

describe.each(FAILURES)(
  'vite plugin: import probe failure $code (#583)',
  { timeout: 30_000 },
  ({ fault, code, skip }) => {
    it
      .skipIf(skip)
      .each([false, true].flatMap((watcher) => [false, true].map((afterGood) => ({ watcher, afterGood }))))(
      'recovers in dev (watcher: $watcher, after good bundle: $afterGood)',
      async ({ watcher, afterGood }) => {
        const { root, entry, dep, breakImport, repair, recovered } = project(fault);
        if (!afterGood) breakImport();
        const logger = createLogger('silent');
        const errors = vi.spyOn(logger, 'error');
        const { server, url } = await startServer({
          root,
          customLogger: logger,
          server: watcher ? {} : { watch: null },
          plugins: [
            tweeTsPlugin({
              sources: [join(root, 'story.tw')],
              format: 'test-format-1',
              entry,
              compileOptions: COMPILE,
            }),
          ],
        });
        const page = async (): Promise<string> => (await fetch(url)).text();
        const initial = await page();
        expect(initial).toContain(afterGood ? 'ORIGINAL' : 'The story has not compiled yet.');
        if (afterGood) breakImport();
        expect(() => statSync(dep)).toThrow(expect.objectContaining({ code }));
        expect(await page()).toBe(initial);
        expect(errors.mock.calls.map(([message]) => message).join('\n')).toContain('dep.js');
        const send = vi.spyOn(server.ws, 'send');
        repair();
        // With a watcher, wait for the reload before requesting: request catch-up must not mask a lost watch.
        const reloaded = (): void => {
          expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '/index.html' });
        };
        if (watcher) await vi.waitFor(reloaded, SETTLED);
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(recovered);
      },
    );

    it
      .skipIf(skip || !buildWatchSeesFolders)
      .each(
        [false, true].flatMap((separate) =>
          [false, true].flatMap((linked) => [0, 1, 2].map((workers) => ({ separate, linked, workers }))),
        ),
      )(
      'recovers in build watch (separate: $separate, linked: $linked, workers: $workers)',
      async ({ separate, linked, workers }) => {
        const { root, entry, dep, breakImport, repair, recovered } = project(fault, linked, workers);
        breakImport();
        expect(() => statSync(dep)).toThrow(expect.objectContaining({ code }));
        const logger = createLogger('silent');
        const errors = vi.spyOn(logger, 'error');
        const started: unknown = await build({
          configFile: false,
          root,
          customLogger: logger,
          plugins: [
            tweeTsPlugin({
              sources: [join(root, 'story.tw')],
              format: 'test-format-1',
              entry,
              outputFilename: 'story.html',
              compileOptions: COMPILE,
            }),
          ],
          build: {
            watch: {},
            outDir: join(root, 'out'),
            ...(separate ? { rolldownOptions: { input: join(root, 'outer.js') } } : {}),
          },
        });
        const watcher = trackBuildWatch(started as BuildWatcher);
        const events: string[] = [];
        watcher.on('event', (event) => events.push(event.code));
        await vi.waitFor(() => {
          expect(events).toContain('ERROR');
          expect(events.at(-1)).toBe('END');
        }, SETTLED);
        expect(errors.mock.calls.map(([message]) => message).join('\n')).toContain('dep.js');
        repair();
        await vi.waitFor(() => {
          let story: string;
          try {
            story = readFileSync(join(root, 'out/story.html'), 'utf8');
          } catch {
            throw new Error(`No story; events: ${JSON.stringify(events)}`);
          }
          const assets = join(root, 'out/assets');
          const scripts =
            workers === 0 ? [] : readdirSync(assets).map((name) => readFileSync(join(assets, name), 'utf8'));
          expect(story).toContain('Hello from the story.');
          expect([story, ...scripts].join('\n')).toContain(recovered);
        }, SETTLED);
      },
    );
  },
);

it.skipIf(process.platform !== 'linux' || process.getuid?.() === 0 || !buildWatchSeesFolders)(
  'keeps another configuration idle when one shared plugin watcher closes',
  async () => {
    const { root, entry, breakImport, repair } = project('permission');
    breakImport();
    const otherRoot = makeProject({ 'outer.js': 'globalThis.outer = 1;' });
    const plugin = tweeTsPlugin({
      sources: [join(root, 'story.tw')],
      format: 'test-format-1',
      entry,
      outputFilename: 'story.html',
      compileOptions: COMPILE,
    });
    const active: { watcher: BuildWatcher; events: string[] }[] = [];
    for (const buildRoot of [root, otherRoot]) {
      const started: unknown = await build({
        configFile: false,
        root: buildRoot,
        logLevel: 'silent',
        plugins: [plugin],
        build: {
          watch: {},
          outDir: join(buildRoot, 'out'),
          rolldownOptions: { input: join(buildRoot, 'outer.js') },
        },
      });
      const watcher = trackBuildWatch(started as BuildWatcher);
      const events: string[] = [];
      watcher.on('event', (event) => events.push(event.code));
      active.push({ watcher, events });
      await vi.waitFor(() => {
        expect(events).toContain('ERROR');
        expect(events.at(-1)).toBe('END');
      }, SETTLED);
    }
    const [first, second] = active;
    if (first === undefined || second === undefined) throw new Error('Both watchers must be started');
    await first.watcher.close();
    // Closing one owner must neither remove the other's signal nor start a build of its still-broken entry.
    await new Promise((done) => setTimeout(done, 1000));
    expect(second.events.filter((event) => event === 'ERROR')).toHaveLength(1);
    repair();
    await vi.waitFor(() => {
      expect(readFileSync(join(otherRoot, 'out/story.html'), 'utf8')).toContain('ORIGINAL');
    }, SETTLED);
  },
  30_000,
);

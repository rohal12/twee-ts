/**
 * A watcher event that arrives after a request already caught up with the change it reports (#343): the entry's
 * bundle already has the change, so the event bundles nothing more and reloads nothing. A change the bundle has
 * not read is still bundled, also one whose file state the file system leaves as it was (coarse timestamps).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { makeProject, cleanUp, startServer, STORY, COMPILE } from './helpers/plugins.js';

/** Files whose modification and change times statSync reports as fixed values, by resolved path. */
const pinned = vi.hoisted(() => ({ times: new Map<string, { mtimeMs: number; ctimeMs: number }>() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const statSync = (...args: Parameters<typeof actual.statSync>): ReturnType<typeof actual.statSync> => {
    const stat = actual.statSync(...args);
    const times = pinned.times.get(resolve(String(args[0])));
    return stat === undefined || times === undefined ? stat : Object.assign(stat, times);
  };
  return { ...actual, statSync, default: { ...actual, statSync } };
});

afterEach(async () => {
  pinned.times.clear();
  await cleanUp();
});

const ENTRY = `import { value } from './dep.js';
const widgets = import.meta.glob('./widgets/*.js', { eager: true, import: 'default' });
globalThis.probe = [value, ...Object.values(widgets)].join(',');
`;

/** What the dev server did, as a plugin among the user's (which the entry build runs too) sees it. */
interface Observed {
  readonly plugin: Plugin;
  /** How many times the entry was bundled (and the server's own build started). */
  bundles(): number;
  /** How many full reloads the server sent. */
  reloads(): number;
  /** Holds back the watcher's `all` events for `file` until release(). */
  hold(file: string): void;
  /** How many events are held back. */
  held(): number;
  /** Hands the held events on, and stops holding. */
  release(): void;
}

function observe(): Observed {
  let bundles = 0;
  let reloads = 0;
  const holding = new Set<string>();
  const held: unknown[][] = [];
  let watcher: ViteDevServer['watcher'] | undefined;
  return {
    plugin: {
      name: 'observe-dev-server',
      buildStart() {
        bundles += 1;
      },
      configureServer(server) {
        watcher = server.watcher;
        const emit = server.watcher.emit.bind(server.watcher);
        server.watcher.emit = (event: string | symbol, ...args: unknown[]): boolean => {
          if (event === 'all' && holding.has(resolve(String(args[1])))) {
            held.push(args);
            return true;
          }
          return emit(event, ...args);
        };
        const send = server.ws.send.bind(server.ws);
        server.ws.send = (payload: unknown, ...rest: unknown[]): void => {
          if (typeof payload === 'object' && payload !== null && Reflect.get(payload, 'type') === 'full-reload') {
            reloads += 1;
          }
          Reflect.apply(send, server.ws, [payload, ...rest]);
        };
      },
    },
    bundles: () => bundles,
    reloads: () => reloads,
    hold: (file) => holding.add(resolve(file)),
    held: () => held.length,
    release: () => {
      holding.clear();
      for (const args of held.splice(0)) watcher?.emit('all', ...args);
    },
  };
}

/** Starts a dev server with a watcher for a project whose entry imports `app/dep.js` and globs `app/widgets/`. */
async function start(): Promise<{ root: string; url: string; observed: Observed }> {
  const root = makeProject({
    'story/start.tw': STORY,
    'app/main.js': ENTRY,
    'app/dep.js': "export const value = 'DEP_ONE';\n",
    'app/widgets/a.js': "export default 'WIDGET_A';\n",
  });
  const observed = observe();
  const { url } = await startServer({
    root,
    plugins: [
      observed.plugin,
      tweeTsPlugin({
        sources: [join(root, 'story')],
        format: 'test-format-1',
        entry: join(root, 'app/main.js'),
        compileOptions: COMPILE,
      }),
    ],
  });
  return { root, url: `${url}/`, observed };
}

async function page(url: string): Promise<string> {
  return (await fetch(url)).text();
}

/** Longer than the dev server's debounce, so a rebuild an event started is queued, and a request then waits for it. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 300));

describe('vite plugin dev: a watcher event for a change a request already caught up with (#343)', () => {
  it.each([
    ['an edit to a module of the entry', 'app/dep.js', "export const value = 'DEP_TWO';\n", 'DEP_TWO'],
    ['a file added to a glob folder', 'app/widgets/b.js', "export default 'WIDGET_B';\n", 'WIDGET_B'],
  ])(
    'bundles and reloads nothing more for %s',
    async (_name, file, content, marker) => {
      const { root, url, observed } = await start();
      expect(await page(url)).toContain('DEP_ONE');
      const path = join(root, file);
      observed.hold(path);
      writeFileSync(path, content);
      await vi.waitFor(() => {
        expect(observed.held()).toBeGreaterThan(0);
      }, 10_000);
      const before = observed.bundles();
      // The request finds the change before the watcher has reported it, and bundles the entry with it.
      expect(await page(url)).toContain(marker);
      const caughtUp = observed.bundles();
      expect(caughtUp).toBe(before + 1);
      const reloads = observed.reloads();
      observed.release();
      await settle();
      expect(await page(url)).toContain(marker);
      expect(observed.bundles()).toBe(caughtUp);
      expect(observed.reloads()).toBe(reloads);
    },
    30_000,
  );

  it('still bundles an edit made after the request caught up, when the watcher reports it', async () => {
    const { root, url, observed } = await start();
    const dep = join(root, 'app/dep.js');
    observed.hold(dep);
    writeFileSync(dep, "export const value = 'DEP_TWO';\n");
    await vi.waitFor(() => {
      expect(observed.held()).toBeGreaterThan(0);
    }, 10_000);
    expect(await page(url)).toContain('DEP_TWO');
    const reloads = observed.reloads();
    writeFileSync(dep, "export const value = 'DEP_SIX';\n");
    observed.release();
    await expect.poll(() => observed.reloads(), { timeout: 10_000, interval: 50 }).toBeGreaterThan(reloads);
    expect(await page(url)).toContain('DEP_SIX');
  }, 30_000);

  it('still bundles a module saved unchanged after the bundle read it', async () => {
    const { root, url, observed } = await start();
    expect(await page(url)).toContain('DEP_ONE');
    const before = observed.bundles();
    // Saved again with the same content: its state changes, as touching it to force a rebuild does.
    writeFileSync(join(root, 'app/dep.js'), "export const value = 'DEP_ONE';\n");
    await expect.poll(() => observed.bundles(), { timeout: 10_000, interval: 50 }).toBeGreaterThan(before);
  }, 30_000);

  it('still bundles an edit that leaves the file state as it was (coarse timestamps)', async () => {
    const { root, url, observed } = await start();
    const dep = join(root, 'app/dep.js');
    // The file system reports the same times after a save, as one with coarse timestamps may for a quick one.
    pinned.times.set(resolve(dep), { mtimeMs: 1_000_000, ctimeMs: 1_000_000 });
    expect(await page(url)).toContain('DEP_ONE');
    const before = observed.bundles();
    await settle();
    // The same length, in place: size and inode stay as they were too.
    writeFileSync(dep, "export const value = 'DEP_TWO';\n");
    await expect.poll(() => page(url), { timeout: 10_000, interval: 100 }).toContain('DEP_TWO');
    expect(observed.bundles()).toBeGreaterThan(before);
  }, 30_000);
});

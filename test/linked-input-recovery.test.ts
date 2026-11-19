/** Discovered file links recover without an unrelated save (#575, #576). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from '../src/compiler.js';
import type { CompileResult } from '../src/types.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { cleanUp, COMPILE, makeProject, startServer, STORY, tempDir } from './helpers/plugins.js';

afterEach(cleanUp);
const settled = { timeout: 10_000, interval: 100 };

const CASES = (['source', 'module'] as const).flatMap((role) =>
  (['target', 'hop', 'folder'] as const).map((missing) => ({ role, missing })),
);

function fixture(role: 'source' | 'module', missing: 'target' | 'hop' | 'folder') {
  const dir = makeProject({ 'story/start.tw': STORY });
  const shared = tempDir(); // Outside the Vite root and every named input.
  const folder = join(shared, 'external');
  mkdirSync(folder);
  const target = join(folder, 'content');
  const hop = join(shared, 'hop');
  const content = role === 'source' ? ':: Linked\nRECOVERED_INPUT' : 'window.linked = "RECOVERED_INPUT";';
  const restore = (): void => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(target, content);
    if (missing === 'hop') symlinkSync(target, hop);
  };
  restore();
  if (missing !== 'hop') symlinkSync(target, hop);
  const alias = join(dir, 'story', 'nested', role === 'source' ? 'alias.tw' : 'alias.js');
  mkdirSync(join(alias, '..'), { recursive: true });
  symlinkSync(hop, alias);
  const remove = (): void => {
    rmSync(missing === 'hop' ? hop : missing === 'folder' ? folder : target, { recursive: true });
  };
  const compileOptions = {
    ...COMPILE,
    ...(role === 'module' ? { modules: [join(dir, 'story', 'nested')], exclude: ['**/*.js'] } : {}),
  };
  return { dir, target, content, restore, remove, compileOptions };
}

describe.skipIf(process.platform === 'win32')('discovered link recovery', { timeout: 30_000 }, () => {
  it.each(CASES)('native watch restores a $role after its $missing disappears (#575)', async ({ role, missing }) => {
    const f = fixture(role, missing);
    const builds: CompileResult[] = [];
    const errors: Error[] = [];
    const controller = await watch({
      ...f.compileOptions,
      sources: [join(f.dir, 'story')],
      outputMode: 'json',
      outFile: join(f.dir, 'out.json'),
      onBuild: (result) => builds.push(result),
      onError: (error) => errors.push(error),
    });
    try {
      await vi.waitFor(() => {
        expect(builds.at(-1)?.output).toContain('RECOVERED_INPUT');
      }, settled);
      const initial = builds.length;
      // Establish that the external watch is running (including macOS's stream startup).
      await vi.waitFor(() => {
        writeFileSync(f.target, f.content);
        expect(builds.length).toBeGreaterThan(initial);
      }, settled);
      f.remove();
      await vi.waitFor(() => {
        expect(builds.at(-1)?.output).not.toContain('RECOVERED_INPUT');
      }, settled);
      f.restore();
      await vi.waitFor(() => {
        expect(builds.at(-1)?.output).toContain('RECOVERED_INPUT');
      }, settled);
      expect(errors).toEqual([]);
    } finally {
      controller.abort();
    }
  });

  describe.each([false, true])('Vite watcher enabled: %s', (watching) => {
    it.each(CASES.flatMap((c) => [false, true].map((initiallyMissing) => ({ ...c, initiallyMissing }))))(
      'restores $role $missing, initially missing: $initiallyMissing (#576)',
      async ({ role, missing, initiallyMissing }) => {
        const f = fixture(role, missing);
        if (initiallyMissing) f.remove();
        const { server, url } = await startServer({
          root: f.dir,
          plugins: [
            tweeTsPlugin({
              sources: [join(f.dir, 'story')],
              format: 'test-format-1',
              compileOptions: f.compileOptions,
            }),
          ],
          server: watching ? {} : { watch: null },
        });
        const sent = vi.spyOn(server.ws, 'send');
        const waitForReload = async (stage: string): Promise<void> => {
          await vi.waitFor(() => {
            expect(sent, stage).toHaveBeenCalledWith(expect.objectContaining({ type: 'full-reload' }));
          }, settled);
        };
        const primeTargetWatch = async (): Promise<void> => {
          // startServer waits for the root's files, not this external target. In particular, macOS
          // can list an added watch before FSEvents reports its changes. Observe a real target event
          // before the one-shot removal, just as the native-watch cases above establish readiness.
          let changed = false;
          const onChange = (path: string): void => {
            if (path === f.target) changed = true;
          };
          server.watcher.on('change', onChange);
          sent.mockClear();
          try {
            await vi.waitFor(() => {
              writeFileSync(f.target, f.content);
              expect(changed, 'external target watcher readiness').toBe(true);
            }, settled);
            await waitForReload('build after the readiness probe');
          } finally {
            server.watcher.off('change', onChange);
          }
          sent.mockClear();
        };
        expect((await (await fetch(url)).text()).includes('RECOVERED_INPUT')).toBe(!initiallyMissing);
        if (!initiallyMissing) {
          if (watching) await primeTargetWatch();
          f.remove();
          if (watching) await waitForReload('build after removing the target, hop or folder');
        }
        expect(await (await fetch(url)).text()).not.toContain('RECOVERED_INPUT');
        // No request may repair the watcher before it reports recovery itself.
        sent.mockClear();
        f.restore();
        if (watching) await waitForReload('automatic recovery after restoring the target, hop or folder');
        expect(await (await fetch(url)).text()).toContain('RECOVERED_INPUT');
      },
    );
  });
});

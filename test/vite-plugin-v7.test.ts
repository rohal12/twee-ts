/**
 * The Vite plugin as it behaves on Vite 7, which names the bundler options
 * `rollupOptions` and has no entry bundling. The installed Vite is newer, so its
 * version is replaced here. (The peer-version CI job runs the integration tests
 * against the real Vite 5, 6 and 7.)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import type * as Vite from 'vite';

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof Vite>();
  return { ...actual, version: '7.1.0' };
});

interface Hooks {
  config(userConfig: Record<string, unknown>, env: { command: string; mode: string }): unknown;
  configEnvironment(name: string, config: Record<string, unknown>, env: { command: string; mode: string }): unknown;
  configResolved(config: unknown): void;
  buildStart(this: { addWatchFile(id: string): void; meta: { watchMode: boolean } }): Promise<void>;
}

const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello\n';
const BUILD = { command: 'build', mode: 'production' };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vite plugin on Vite 7', () => {
  it('refuses the entry option, naming the version it found', () => {
    expect(() => tweeTsPlugin({ sources: ['story'], entry: 'app/main.ts' })).toThrow(
      'twee-ts: the entry option needs Vite 8 or newer (found 7.1.0).',
    );
  });

  it("gives the client build without input the stand-in input under rollupOptions, in the environment's options", () => {
    const hooks = tweeTsPlugin({ sources: ['story'] }) as unknown as Hooks;
    expect(hooks.config({}, BUILD)).toBeUndefined();
    expect(hooks.configEnvironment('client', {}, BUILD)).toEqual({
      build: { rollupOptions: { input: 'virtual:twee-ts-empty-input' } },
    });
    expect(
      hooks.configEnvironment('client', { build: { rollupOptions: { input: 'main.js' } } }, BUILD),
    ).toBeUndefined();
  });

  it('leaves out the output folder that rollupOptions.output.dir names when watching a build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-ts-vite7-'));
    dirs.push(dir);
    for (const name of ['story/start.tw', 'story/out/index.html']) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), name.endsWith('.tw') ? STORY : 'last build');
    }
    const hooks = tweeTsPlugin({ sources: [join(dir, 'story')] }) as unknown as Hooks;
    hooks.configResolved({
      command: 'build',
      root: dir,
      publicDir: '',
      build: { outDir: 'dist', copyPublicDir: false, rollupOptions: { output: { dir: join(dir, 'story', 'out') } } },
      logger: { warn: vi.fn() },
    });
    const added: string[] = [];
    await hooks.buildStart.call({ addWatchFile: (id) => added.push(id), meta: { watchMode: true } });
    expect(added.some((target) => target.endsWith('/start.tw'))).toBe(true);
    expect(added.some((target) => target.includes('/out'))).toBe(false);
  });
});

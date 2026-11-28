/** Bundler watches recover linked inputs without an unrelated save (#588). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from 'rollup';
import { tweeTsPlugin as rollupPlugin } from '../src/plugins/rollup.js';
import { tweeTsPlugin as vitePlugin } from '../src/plugins/vite.js';
import { resolvePluginOptions } from '../src/plugins/options.js';
import { watchPlan } from '../src/plugins/watch-targets.js';
import { outputPaths } from '../src/filesystem.js';
import { cleanUp, COMPILE, makeProject, startBuildWatch, STORY, tempDir, trackBuildWatch } from './helpers/plugins.js';

afterEach(cleanUp);
const settled = { timeout: 10_000, interval: 100 };
const CASES = (['rollup', 'vite'] as const).flatMap((bundler) =>
  (['source', 'module'] as const).flatMap((role) =>
    (['named', 'discovered'] as const).flatMap((selection) =>
      (['target', 'hop', 'folder'] as const).flatMap((missing) =>
        [false, true].map((initiallyMissing) => ({ bundler, role, selection, missing, initiallyMissing })),
      ),
    ),
  ),
);

describe.skipIf(process.platform === 'win32')('bundler link recovery', { timeout: 60_000 }, () => {
  it.each(CASES)(
    '$bundler $selection $role: missing $missing, initially missing $initiallyMissing',
    async ({ bundler, role, selection, missing, initiallyMissing }) => {
      const dir = makeProject({ 'story/start.tw': STORY, 'entry.js': 'export const a = 1;' });
      const shared = tempDir();
      const folder = join(shared, 'external', 'nested');
      const target = join(folder, 'content'); // The alias determines the file type.
      const hop = join(shared, 'hop');
      const inputFolder = join(dir, role === 'source' ? 'story' : 'modules');
      mkdirSync(inputFolder, { recursive: true });
      const alias = join(inputFolder, role === 'source' ? 'alias.tw' : 'alias.js');
      const content = (text: string): string =>
        role === 'source' ? `:: Linked\n${text}` : `window.linked = '${text}';`;
      const restore = (): void => {
        mkdirSync(folder, { recursive: true });
        writeFileSync(target, content('RECOVERED_INPUT'));
        if (!existsSync(hop)) symlinkSync(target, hop);
      };
      restore();
      symlinkSync(hop, alias);
      const remove = (): void => {
        rmSync(missing === 'hop' ? hop : missing === 'folder' ? join(shared, 'external') : target, { recursive: true });
      };
      if (initiallyMissing) remove();
      const selected = selection === 'named' ? alias : inputFolder;
      const options = {
        sources: role === 'source' ? [join(dir, 'story/start.tw'), selected] : [join(dir, 'story')],
        format: 'test-format-1',
        compileOptions: { ...COMPILE, ...(role === 'module' ? { modules: [selected] } : {}) },
      };
      const outDir = join(dir, 'dist');
      const errors: string[] = [];
      let builds = 0;
      const observer = {
        name: 'observe-completed-builds',
        writeBundle() {
          builds += 1;
        },
      };
      if (bundler === 'vite') {
        await startBuildWatch({
          root: dir,
          plugins: [vitePlugin(options), observer],
          build: { outDir },
        });
      } else {
        const watcher = trackBuildWatch(
          watch({
            input: join(dir, 'entry.js'),
            plugins: [rollupPlugin(options), observer],
            output: { dir: outDir, format: 'es' },
            onLog: () => {},
          }),
        );
        watcher.on('event', (event) => {
          if (event.code === 'ERROR') errors.push(event.error.message);
        });
      }
      const out = join(outDir, 'index.html');
      const output = (): string => (existsSync(out) ? readFileSync(out, 'utf8') : '');
      await vi.waitFor(() => {
        expect(builds).toBeGreaterThan(0);
        expect(output()).toContain('Hello from the story.');
      }, settled);
      expect(output().includes('RECOVERED_INPUT')).toBe(!initiallyMissing);
      for (let cycle = 0; cycle < 2; cycle += 1) {
        if (!initiallyMissing || cycle > 0) {
          remove();
        }
        await vi.waitFor(() => {
          expect(output()).not.toContain('RECOVERED_INPUT');
        }, settled);
        restore();
        await vi.waitFor(() => {
          expect(output()).toContain('RECOVERED_INPUT');
        }, settled);
      }
      // Recovered inputs remain watched for ordinary edits too.
      await vi.waitFor(() => {
        writeFileSync(target, content('EDITED_INPUT'));
        expect(output()).toContain('EDITED_INPUT');
      }, settled);
      // Watching availability must still detect retargets between two existing destinations.
      const replacement = join(shared, 'replacement');
      writeFileSync(replacement, content('RETARGETED_INPUT'));
      rmSync(hop);
      symlinkSync(replacement, hop);
      await vi.waitFor(() => {
        expect(output()).toContain('RETARGETED_INPUT');
      }, settled);
      expect(errors).toEqual([]);
    },
  );

  it.each(['source', 'module'] as const)('recovers only eligible %s file links', (role) => {
    const dir = makeProject({ 'start.tw': STORY });
    const shared = tempDir();
    const folder = tempDir();
    const names = ['alias.tw', 'alias.js', 'excluded.js', 'unknown.txt', 'folder.js', 'output.js', 'loop.js'];
    for (const name of names) {
      const target = name === 'folder.js' ? folder : name === 'loop.js' ? join(dir, name) : join(shared, name);
      symlinkSync(target, join(dir, name));
    }
    const options = resolvePluginOptions('rollup', {
      sources: role === 'source' ? [dir] : [join(dir, 'start.tw')],
      compileOptions: {
        exclude: [join(dir, 'excluded.js')],
        ...(role === 'module' ? { modules: [dir] } : {}),
      },
    });
    const outputs = outputPaths({ files: [join(shared, 'output.js')], dirs: [] });
    const expected = role === 'source' ? ['alias.tw', 'alias.js'] : ['alias.js', 'excluded.js'];
    for (const spelling of ['given', 'real'] as const) {
      const plan = watchPlan(options.inputs, options.excluded, outputs, spelling, options.recoverable);
      expect(plan.recovery.sort()).toEqual(expected.flatMap((name) => [join(dir, name), join(shared, name)]).sort());
    }
  });

  it('moves recovery anchors down as missing parent folders are created', () => {
    const dir = makeProject({ 'start.tw': STORY });
    const shared = tempDir();
    const alias = join(dir, 'alias.tw');
    const target = join(shared, 'one', 'two', 'content');
    symlinkSync(target, alias);
    const recovery = (): string[] =>
      watchPlan([dir], () => false, outputPaths({ files: [], dirs: [] }), 'real').recovery;
    expect(recovery().sort()).toEqual([alias, join(shared, 'one')].sort());
    mkdirSync(join(shared, 'one'));
    expect(recovery().sort()).toEqual([alias, join(shared, 'one', 'two')].sort());
    mkdirSync(join(shared, 'one', 'two'));
    expect(recovery().sort()).toEqual([alias, target].sort());
  });
});

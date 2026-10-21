/**
 * The Rollup plugin watches the links the story's inputs are reached through with a signal file in a temporary folder
 * (src/plugins/link-watch.ts). That is a refinement of the build watch (#444): when the folder cannot be made (a
 * missing or read-only TMPDIR, as in a sandbox or a container), the build still succeeds and the plugin says once what
 * it cannot do, as the CLI watch does for its probe folder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from 'rollup';
import type { RollupWatcher } from 'rollup';
import { createLinkWatch } from '../src/plugins/link-watch.js';
import { tweeTsPlugin } from '../src/plugins/rollup.js';
import { trackBuildWatch, cleanUp, COMPILE, makeProject, storyWith, tempDir } from './helpers/plugins.js';

const settled = { timeout: 20_000, interval: 100 };
const noLinks = process.platform === 'win32';
// A folder its owner can't write to; root writes to it anyway, and Windows has no such mode bits.
const canMakeReadOnly = process.platform !== 'win32' && process.getuid?.() !== 0;

const watchers: RollupWatcher[] = [];
const originalTmpdir = { TMPDIR: process.env['TMPDIR'], TMP: process.env['TMP'], TEMP: process.env['TEMP'] };

afterEach(async () => {
  for (const [name, value] of Object.entries(originalTmpdir)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
  await cleanUp();
});

/** Makes every temporary folder the process asks for `tmp`. */
function useTmpdir(tmp: string): void {
  process.env['TMPDIR'] = tmp;
  process.env['TMP'] = tmp;
  process.env['TEMP'] = tmp;
}

/** The ways a temporary folder cannot be used. */
const UNUSABLE: readonly (readonly [string, () => string])[] = [
  ['missing', () => join(tempDir(), 'does-not-exist')] as const,
  ...(canMakeReadOnly
    ? [
        [
          'read-only',
          () => {
            const folder = join(tempDir(), 'readonly');
            mkdirSync(folder);
            chmodSync(folder, 0o555);
            return folder;
          },
        ] as const,
      ]
    : []),
];

describe.skipIf(noLinks)('the link watch without a temporary folder (#444)', () => {
  it.each(UNUSABLE)('createLinkWatch returns nothing when the temporary folder is %s', (_name, make) => {
    useTmpdir(make());
    expect(createLinkWatch()).toBeUndefined();
  });

  it.each(UNUSABLE)(
    'a Rollup build watch of a source reached through a link still builds, and warns once, when TMPDIR is %s',
    async (_name, make) => {
      const dir = makeProject({ 'real.tw': storyWith('FIRST') });
      symlinkSync(join(dir, 'real.tw'), join(dir, 'story.tw'));
      writeFileSync(join(dir, 'entry.js'), 'export const a = 1;\n');
      useTmpdir(make());
      const out = join(dir, 'dist', 'index.html');
      const warnings: string[] = [];
      const watcher = trackBuildWatch(
        watch({
          input: join(dir, 'entry.js'),
          plugins: [
            tweeTsPlugin({
              sources: [join(dir, 'story.tw')],
              format: 'test-format-1',
              compileOptions: COMPILE,
            }),
          ],
          output: { dir: join(dir, 'dist'), format: 'es' },
          watch: { buildDelay: 50 },
          onLog: (level, log) => {
            if (level === 'warn') warnings.push(log.message);
          },
        }),
      );
      watchers.push(watcher);
      const errors: string[] = [];
      watcher.on('event', (event) => {
        if (event.code === 'ERROR') errors.push(event.error.message);
      });
      await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(existsSync(out) && readFileSync(out, 'utf-8')).toContain('FIRST');
      }, settled);
      // An edit of the file starts the next build, which does not warn again.
      const again = setInterval(() => {
        writeFileSync(join(dir, 'real.tw'), storyWith('SECOND'));
      }, 250);
      try {
        await vi.waitFor(() => {
          expect(readFileSync(out, 'utf-8')).toContain('SECOND');
        }, settled);
      } finally {
        clearInterval(again);
      }
      expect(errors).toEqual([]);
      expect(warnings.filter((warning) => warning.includes('link'))).toEqual([
        expect.stringContaining('[twee-ts] The link watch is unavailable'),
      ]);
    },
    60_000,
  );
});

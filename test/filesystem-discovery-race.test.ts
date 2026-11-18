import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { getFilenames } from '../src/filesystem.js';
import { compile } from '../src/compiler.js';

const race = vi.hoisted(() => ({ path: '', code: '', skip: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const stat = actual.statSync(...args);
      if (args[0] === race.path && race.code === 'ENOENT' && race.skip-- === 0) actual.unlinkSync(race.path);
      return stat;
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (args[0] === race.path && race.code !== '' && race.code !== 'ENOENT') {
        throw Object.assign(new Error(`${race.code}: changed after stat`), { code: race.code });
      }
      return actual.lstatSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  race.path = '';
  race.code = '';
  race.skip = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function files(): { first: string; good: string; last: string } {
  const root = mkdtempSync(join(tmpdir(), 'twee-discovery-race-'));
  roots.push(root);
  const paths = { first: join(root, 'first.js'), good: join(root, 'good.js'), last: join(root, 'last.js') };
  for (const path of Object.values(paths)) writeFileSync(path, 'globalThis.loaded = true;');
  return paths;
}

for (const role of ['source', 'module'] as const) {
  describe(`named ${role} lookup races (#281)`, () => {
    it.each([
      ['ENOENT', 'warning'],
      ['ENOTDIR', 'warning'],
      ['EACCES', 'error'],
      ['EIO', 'error'],
    ] as const)('collects %s after a successful stat and continues discovery', (code, level) => {
      const { first, good, last } = files();
      race.path = first;
      race.code = code;
      unlinkSync(last);
      const result = getFilenames([first, good, last], undefined, [], role);
      expect(result.filenames).toEqual([relative(process.cwd(), good)]);
      expect(result.diagnostics).toEqual([
        { level, file: first, message: expect.stringContaining(code) },
        { level: 'warning', file: last, message: expect.stringContaining('ENOENT') },
      ]);
    });

    it('compiles other sources after an input disappears and recovers on the next build', async () => {
      const { first } = files();
      race.path = first;
      race.code = 'ENOENT';
      race.skip = 1; // The output-safety check precedes discovery.
      const options = {
        sources: [
          {
            filename: 'story.tw',
            content:
              ':: StoryTitle\nRace\n:: StoryData\n{"ifid":"12345678-1234-4123-8123-123456789ABC"}\n:: Start\nGood',
          },
          ...(role === 'source' ? [first] : []),
        ],
        ...(role === 'module' ? { modules: [first] } : {}),
        outputMode: 'html' as const,
        formatId: 'test-format-1',
        formatPaths: ['test/fixtures/storyformats'],
        useTweegoPath: false,
        noRemote: true,
      };
      const result = await compile(options);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([{ level: 'warning', file: first, message: expect.stringContaining('ENOENT') }]),
      );
      expect(result.output).toContain('Good');
      race.code = '';
      writeFileSync(first, 'globalThis.loaded = true;');
      const recovered = await compile(options);
      expect(recovered.diagnostics.filter((d) => d.file === first)).toEqual([]);
    });
  });
}

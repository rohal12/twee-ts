import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { compile, compileForOutputFile, compileIncremental, compileToFile, watch } from '../src/compiler.js';
import { identify } from '../src/path-identity.js';
import { writeFileAtomic } from '../src/atomic-write.js';
import type { FileCacheEntry } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-dot-segments-')));
  mkdirSync(join(dir, 'real/deep'), { recursive: true });
  symlinkSync('real/deep', join(dir, 'pivot'), 'dir');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('filesystem order of symlinks and dot segments (#219, #462)', () => {
  it.each([false, true])('loads named files and folders, competing lexical file: %s', async (competing) => {
    writeFileSync(join(dir, 'real/a.tw'), ':: Start\nRIGHT');
    if (competing) writeFileSync(join(dir, 'a.tw'), ':: Start\nWRONG');
    for (const suffix of ['/a.tw', '']) {
      const source = `${dir}/pivot/..${suffix}`;
      const options = { sources: [source], outputMode: 'json' } as const;
      const cache = new Map<string, FileCacheEntry>();
      for (const result of [
        await compile(options),
        await compileIncremental(options, cache),
        await compileIncremental(options, cache),
      ]) {
        expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('RIGHT');
        expect(result.diagnostics).toEqual([]);
        expect(readFileSync(result.stats.files[0] ?? '', 'utf8')).toBe(':: Start\nRIGHT');
      }
    }
    expect(identify(`${dir}/pivot/../a.tw`).key).toBe(identify(join(dir, 'real/a.tw')).key);
    const excluded = await compile({
      sources: [`${dir}/pivot/..`],
      exclude: [join(dir, 'real/*.tw')],
      outputMode: 'json',
    });
    expect(excluded.story.passages).toHaveLength(0);
  });

  it.each([false, true])('resolves dangling link identity with an absolute target: %s', (absolute) => {
    const target = `${absolute ? `${dir}/` : ''}pivot/../missing/out.html`;
    symlinkSync(target, join(dir, 'out.html'));
    expect(identify(join(dir, 'out.html')).canonical).toBe(identify(join(dir, 'real/missing/out.html')).canonical);
  });

  it.each(['story.tw', 'module.js', 'head.html', 'twee-ts.config.json'])(
    'writes the intended target without overwriting %s',
    async (name) => {
      const source = join(dir, 'story.tw');
      writeFileSync(source, ':: Start\nSOURCE');
      const victim = join(dir, name);
      if (name !== 'story.tw') writeFileSync(victim, name === 'twee-ts.config.json' ? '{}' : 'PRECIOUS');
      const before = readFileSync(victim, 'utf8');
      for (const absolute of [false, true]) {
        const output = join(dir, `out-${String(absolute)}.html`);
        symlinkSync(`${absolute ? `${dir}/` : ''}pivot/../${name}`, output);
        const options = {
          sources: [source],
          outputMode: 'json',
          outFile: output,
          ...(name === 'module.js' ? { modules: [victim] } : {}),
          ...(name === 'head.html' ? { headFile: victim } : {}),
        } as const;
        const checked = await compileForOutputFile(options, output, undefined, [{ role: 'config', path: victim }]);
        expect(checked.diagnostics).toEqual([]);
        const result = await compileToFile(options);
        expect(readFileSync(join(dir, 'real', name), 'utf8')).toBe(result.output);
        expect(readFileSync(victim, 'utf8')).toBe(before);
        expect(lstatSync(output).isSymbolicLink()).toBe(true);
      }
    },
  );

  it.each([false, true])('refuses an actual input overlap through dot segments, existing: %s', async (existing) => {
    const source = join(dir, 'real/story.tw');
    writeFileSync(source, ':: Start\nPRECIOUS');
    const output = join(dir, 'output.json');
    symlinkSync('pivot/../story.tw', output);
    // A missing destination is still the same named input, even before loading can report it missing.
    if (!existing) rmSync(source);
    await expect(compileToFile({ sources: [source], outputMode: 'json', outFile: output })).rejects.toMatchObject({
      code: 'OUTPUT_IS_INPUT',
    });
    expect(lstatSync(output).isSymbolicLink()).toBe(true);
    expect(existsSync(source)).toBe(existing);
  });

  it(
    'watches the source selected by filesystem dot-segment semantics and writes through the output link',
    { timeout: 20_000 },
    async () => {
      const source = join(dir, 'real/a.tw');
      writeFileSync(source, ':: Start\nFIRST');
      writeFileSync(join(dir, 'a.tw'), ':: Start\nWRONG');
      const output = join(dir, 'out.json');
      symlinkSync('pivot/../served.json', output);
      const seen: string[] = [];
      const errors: unknown[] = [];
      const controller = await watch({
        sources: [`${dir}/pivot/../a.tw`],
        outFile: output,
        outputMode: 'json',
        onBuild: (result) => {
          seen.push(result.story.passages[0]?.text ?? '');
        },
        onError: (error) => {
          errors.push(error);
        },
      });
      try {
        await expect.poll(() => seen, { timeout: 10_000 }).toContain('FIRST');
        writeFileSync(source, ':: Start\nSECOND');
        await expect.poll(() => seen, { timeout: 10_000 }).toContain('SECOND');
        expect(errors).toEqual([]);
        expect(readFileSync(join(dir, 'real/served.json'), 'utf8')).toContain('SECOND');
        expect(readFileSync(join(dir, 'a.tw'), 'utf8')).toBe(':: Start\nWRONG');
      } finally {
        controller.abort();
      }
    },
  );

  it('keeps missing-parent links intact and writes a path containing dot segments', () => {
    const missing = join(dir, 'missing.html');
    symlinkSync('pivot/../absent/out.html', missing);
    expect(() => {
      writeFileAtomic(missing, 'OUTPUT');
    }).toThrow(/ENOENT/);
    expect(lstatSync(missing).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, 'absent'))).toBe(false);
    const authored = `${relative(process.cwd(), dir)}/pivot/../direct.html`;
    writeFileAtomic(authored, 'DIRECT');
    expect(readFileSync(join(dir, 'real', basename(authored)), 'utf8')).toBe('DIRECT');
    expect(existsSync(join(dir, 'direct.html'))).toBe(false);
  });
});

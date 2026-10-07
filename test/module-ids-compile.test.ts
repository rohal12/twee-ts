/**
 * Module element ids are unique in the page the public entry points write, whatever way the modules are loaded
 * (#296): one id namespace for the whole build, not one per module.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compile, compileIncremental, compileToFile } from '../src/compiler.js';
import type { CompileOptions, FileCacheEntry } from '../src/types.js';

const STORY =
  ':: StoryTitle\nProbe\n\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello.\n';
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-module-ids-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): string {
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const idsOf = (html: string): string[] =>
  [...html.matchAll(/id="((?:script|style)-module-[^"]*)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

function options(modules: string[]): CompileOptions {
  return {
    sources: [{ filename: 'story.tw', content: STORY }],
    modules,
    formatPaths: ['test/fixtures/storyformats'],
    formatId: 'test-format-1',
    noRemote: true,
    useTweegoPath: false,
  };
}

const CASES = [
  ['two scripts with one stem', ['lib/ui.js', 'vendor/ui.js'], ['script-module-ui', 'script-module-ui-2']],
  ['a stylesheet and a font with one stem', ['ui.css', 'ui.woff2'], ['style-module-ui', 'style-module-ui-2']],
  ['a script and a stylesheet', ['lib/ui.js', 'ui.css'], ['script-module-ui', 'style-module-ui']],
  ['stems that slugify alike', ['a/my ui.js', 'b/my_ui.js'], ['script-module-my_ui', 'script-module-my_ui-2']],
] as const;

describe.each(CASES)('%s', (_name, files, expected) => {
  const prepare = (): string[] =>
    files.map((f) => write(f, f.endsWith('.woff2') ? Buffer.from([1, 2]) : 'globalThis.probe = 1;'));

  it('compile() gives unique ids and warns', async () => {
    const result = await compile(options(prepare()));
    expect(idsOf(result.output)).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
    expect(result.diagnostics.filter((d) => d.message.includes('would both have the element id'))).toHaveLength(
      expected.some((id) => id.endsWith('-2')) ? 1 : 0,
    );
  });

  it('compileToFile() writes unique ids', async () => {
    const out = join(dir, 'out.html');
    await compileToFile({ ...options(prepare()), outFile: out });
    expect(idsOf(readFileSync(out, 'utf8'))).toEqual(expected);
  });

  it('compileIncremental() gives unique ids cold and warm', async () => {
    const opts = options(prepare());
    const cache = new Map<string, FileCacheEntry>();
    const cold = await compileIncremental(opts, cache);
    const warm = await compileIncremental(opts, cache);
    expect(idsOf(cold.output)).toEqual(expected);
    expect(idsOf(warm.output)).toEqual(expected);
  });
});

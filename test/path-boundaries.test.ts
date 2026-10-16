import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileIncremental, compileToFile } from '../src/compiler.js';
import { loadConfigFile, rebaseConfigPaths } from '../src/config.js';
import { discoverFormats, getFormatSearchDirs, readFormatSource } from '../src/formats.js';
import type { FileCacheEntry } from '../src/types.js';
import { cleanUp, makeProject, storyWith } from './helpers/plugins.js';

afterEach(cleanUp);

function fixture(competing: boolean): string {
  const dir = makeProject({ 'real/a.tw': storyWith('RIGHT'), ...(competing ? { 'a.tw': storyWith('WRONG') } : {}) });
  mkdirSync(join(dir, 'real/deep'));
  symlinkSync(join(dir, 'real/deep'), join(dir, 'pivot'), 'junction');
  return dir;
}

describe.skipIf(process.platform === 'win32')('path construction boundaries (#465, #467)', () => {
  it.each([false, true])('loads config-relative files and folders with lexical competitor: %s', async (competing) => {
    const dir = fixture(competing);
    for (const suffix of ['/a.tw', '']) {
      const config = join(dir, 'twee-ts.config.json');
      writeFileSync(config, JSON.stringify({ sources: [`pivot/..${suffix}`], outputMode: 'json' }));
      const loaded = loadConfigFile(config);
      const options = { ...loaded, sources: loaded.sources ?? [] };
      const cache = new Map<string, FileCacheEntry>();
      for (const result of [
        await compile(options),
        await compileIncremental(options, cache),
        await compileIncremental(options, cache),
      ]) {
        expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('RIGHT');
        expect(result.diagnostics).toEqual([]);
      }
    }
  });

  it('rebases every config path field without discarding authored parent steps', async () => {
    const dir = fixture(true);
    for (const [name, text] of [
      ['module.js', 'RIGHT_MODULE'],
      ['head.html', 'RIGHT_HEAD'],
    ] as const) {
      writeFileSync(join(dir, 'real', name), text);
      writeFileSync(join(dir, name), 'WRONG');
    }
    const config = rebaseConfigPaths(
      {
        sources: ['pivot/../a.tw'],
        modules: ['pivot/../module.js'],
        headFile: 'pivot/../head.html',
        formatPaths: ['pivot/..'],
        output: 'pivot/../out.json',
        outputMode: 'json',
      },
      join(dir, 'config.json'),
    );
    expect(readFileSync(config.sources?.[0] ?? '', 'utf8')).toContain('RIGHT');
    expect(readFileSync(config.modules?.[0] ?? '', 'utf8')).toBe('RIGHT_MODULE');
    expect(readFileSync(config.headFile ?? '', 'utf8')).toBe('RIGHT_HEAD');
    expect(readFileSync(`${config.formatPaths?.[0] ?? ''}/a.tw`, 'utf8')).toContain('RIGHT');
    await compileToFile({ sources: config.sources ?? [], outputMode: 'json', outFile: config.output ?? '' });
    expect(readFileSync(join(dir, 'real/out.json'), 'utf8')).toContain('RIGHT');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const authored = { sources: ['pivot/../a.tw'] };
      expect(rebaseConfigPaths(authored, join(dir, 'config.json'))).toBe(authored);
    } finally {
      cwd.mockRestore();
    }
  });

  it('keeps a missing intermediate directory in a rebased path', () => {
    const dir = fixture(true);
    const config = rebaseConfigPaths({ sources: ['missing/../a.tw'] }, join(dir, 'config.json'));
    expect(() => readFileSync(config.sources?.[0] ?? '')).toThrow(/ENOENT/);
  });

  it.each([false, true])('discovers both format kinds in the supplied directory, competitor: %s', async (competing) => {
    const dir = fixture(competing);
    for (const folder of competing ? ['real', '.'] : ['real']) {
      const marker = folder === 'real' ? 'RIGHT_FORMAT' : 'WRONG_FORMAT';
      mkdirSync(join(dir, folder, 'modern'));
      mkdirSync(join(dir, folder, 'classic'));
      writeFileSync(
        join(dir, folder, 'modern/format.js'),
        `window.storyFormat(${JSON.stringify({
          name: 'Modern',
          version: '1.0.0',
          source: `<!doctype html><title>{{STORY_NAME}}</title><body>${marker}{{STORY_DATA}}</body>`,
        })});`,
      );
      writeFileSync(
        join(dir, folder, 'classic/header.html'),
        `<!doctype html><head></head><body>${marker}<script>"ENGINE"</script><div id="storeArea">"STORY"</div></body>`,
      );
      writeFileSync(join(dir, folder, 'engine.js'), `globalThis.engine="${marker}_ENGINE";`);
    }
    const search = `${dir}/pivot/..`;
    const formats = discoverFormats([search]);
    for (const id of ['modern', 'classic']) {
      const format = formats.get(id);
      expect(format).toBeDefined();
      expect(format === undefined ? undefined : readFormatSource(format)).toContain('RIGHT_FORMAT');
    }
    for (const formatId of ['modern', 'classic']) {
      const result = await compile({
        sources: [join(dir, 'real/a.tw')],
        formatPaths: [search],
        formatId,
        useTweegoPath: false,
        noRemote: true,
      });
      expect(result.output).toContain('RIGHT_FORMAT');
      expect(result.output).not.toContain('WRONG_FORMAT');
    }
    const old = process.env['TWEEGO_PATH'];
    process.env['TWEEGO_PATH'] = search;
    try {
      const viaEnv = discoverFormats(getFormatSearchDirs());
      expect(viaEnv.get('modern')).toEqual(formats.get('modern'));
    } finally {
      if (old === undefined) delete process.env['TWEEGO_PATH'];
      else process.env['TWEEGO_PATH'] = old;
    }
    expect(discoverFormats([`${dir}/missing/..`]).size).toBe(0);
  });
});

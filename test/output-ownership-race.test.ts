/**
 * An output that becomes an authored source or module file of a named folder while a story format is downloaded
 * (#301): the build is rejected and the authored bytes are kept.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileToFile } from '../src/compiler.js';
import { formatJs, isolateFormatEnvironment, startFormatServer } from './helpers/format-server.js';

const root = isolateFormatEnvironment('output-ownership-race');
const STORY = ':: StoryData\n{"ifid":"12345678-1234-4234-8234-123456789ABC"}\n\n:: Start\nCompiled content';
const AUTHORED =
  '<tw-storydata name="Authored"><tw-passagedata name="Start">DO NOT ERASE</tw-passagedata></tw-storydata>';
const FORMAT = formatJs('ReviewRace', '1.0.0');

describe('compileToFile when the output becomes an authored file during format resolution', () => {
  it.each(['existing', 'new'] as const)('rejects a source-folder output that was %s', async (scenario) => {
    const dir = root();
    const src = join(dir, 'src');
    mkdirSync(src);
    const outFile = join(src, 'out.html');
    const sources = [{ filename: 'story.tw', content: STORY }];
    if (scenario === 'existing') {
      writeFileSync(outFile, (await compile({ sources, outputMode: 'twine2-archive' })).output);
    }
    const server = await startFormatServer({
      '/format.js': (_req, res) => {
        writeFileSync(outFile, AUTHORED);
        res.writeHead(200, { 'content-type': 'application/javascript' }).end(FORMAT);
      },
    });
    await expect(
      compileToFile({
        sources: [src, ...sources],
        outFile,
        formatId: 'reviewrace-1',
        formatUrls: [`${server.origin}/format.js`],
        useDefaultFormatIndices: false,
        useTweegoPath: false,
        formatPaths: [],
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_IS_INPUT' });
    expect(readFileSync(outFile, 'utf8')).toBe(AUTHORED);
  });

  it('rejects a module-folder output created during the download', async () => {
    const dir = root();
    const mods = join(dir, 'mods');
    mkdirSync(mods);
    const outFile = join(mods, 'out.js');
    const server = await startFormatServer({
      '/format.js': (_req, res) => {
        writeFileSync(outFile, 'window.authored = 1;');
        res.writeHead(200, { 'content-type': 'application/javascript' }).end(FORMAT);
      },
    });
    await expect(
      compileToFile({
        sources: [{ filename: 'story.tw', content: STORY }],
        modules: [mods],
        outFile,
        formatId: 'reviewrace-1',
        formatUrls: [`${server.origin}/format.js`],
        useDefaultFormatIndices: false,
        useTweegoPath: false,
        formatPaths: [],
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_IS_INPUT' });
    expect(readFileSync(outFile, 'utf8')).toBe('window.authored = 1;');
  });
});

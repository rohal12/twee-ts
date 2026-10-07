/**
 * An output link retargeted at an input while a story format is downloaded (#301): the build is rejected and
 * the input and the previous output are kept, for every kind of named input.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileToFile } from '../src/compiler.js';
import { formatJs, isolateFormatEnvironment, startFormatServer } from './helpers/format-server.js';

const root = isolateFormatEnvironment('output-retarget');
const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello original source.';
const FORMAT = formatJs('OutputRaceUnique', '1.0.0');

type Victim = 'source' | 'module' | 'head' | 'folder-source';

describe('compileToFile when the output is retargeted during format resolution', () => {
  it.each<Victim>(['source', 'module', 'head', 'folder-source'])(
    'rejects an output that now is the %s',
    async (victim) => {
      const dir = root();
      mkdirSync(join(dir, 'src'));
      const paths: Record<Victim, string> = {
        source: join(dir, 'story.tw'),
        module: join(dir, 'mod.js'),
        head: join(dir, 'head.html'),
        'folder-source': join(dir, 'src', 'a.tw'),
      };
      writeFileSync(join(dir, 'story.tw'), STORY);
      writeFileSync(join(dir, 'src', 'a.tw'), STORY.replace('original', 'folder'));
      writeFileSync(paths.module, 'window.x = 1;');
      writeFileSync(paths.head, '<meta name="a">');
      const output = join(dir, 'out.html');
      const previous = join(dir, 'previous.html');
      writeFileSync(previous, 'previous output');
      symlinkSync(previous, output);
      const before = readFileSync(paths[victim], 'utf8');

      const server = await startFormatServer({
        '/format.js': (_req, res) => {
          unlinkSync(output);
          symlinkSync(paths[victim], output);
          res.writeHead(200, { 'content-type': 'application/javascript' }).end(FORMAT);
        },
      });
      await expect(
        compileToFile({
          sources: [victim === 'folder-source' ? join(dir, 'src') : join(dir, 'story.tw')],
          modules: [paths.module],
          headFile: paths.head,
          outFile: output,
          formatId: 'outputraceunique-1',
          formatUrls: [`${server.origin}/format.js`],
          useDefaultFormatIndices: false,
          useTweegoPath: false,
          formatPaths: [],
        }),
      ).rejects.toMatchObject({ code: 'OUTPUT_IS_INPUT' });

      expect(readFileSync(paths[victim], 'utf8')).toBe(before);
      expect(readFileSync(previous, 'utf8')).toBe('previous output');
    },
  );
});

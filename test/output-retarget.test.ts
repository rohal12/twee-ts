/**
 * An output link retargeted at an input while a story format is downloaded (#301): the build is rejected and
 * the input and the previous output are kept, for every kind of named input.
 */
import { describe, it, expect } from 'vitest';
import { linkSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { rollup } from 'rollup';
import { build } from 'vite';
import { compileToFile } from '../src/compiler.js';
import { tweeTsPlugin as rollupPlugin } from '../src/plugins/rollup.js';
import { tweeTsPlugin as vitePlugin } from '../src/plugins/vite.js';
import { formatJs, isolateFormatEnvironment, startFormatServer } from './helpers/format-server.js';

const root = isolateFormatEnvironment('output-retarget');
const STORY =
  ':: StoryTitle\nOutput race\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello original source.';
const FORMAT = formatJs('OutputRaceUnique', '1.0.0');

type Victim = 'source' | 'module' | 'head' | 'folder-source';

describe('compileToFile when the output is retargeted during format resolution', () => {
  it('refreshes a populated inode index after awaiting a format (#482)', async () => {
    const dir = root();
    const source = join(dir, 'story.tw');
    const head = join(dir, 'head.html');
    const output = join(dir, 'out.html');
    writeFileSync(source, STORY);
    writeFileSync(head, '<meta name="probe">');
    // This unrelated linked input makes the initial safety check read the output inode index.
    linkSync(head, join(dir, 'head-copy.html'));
    writeFileSync(output, 'previous output');
    const server = await startFormatServer({
      '/format.js': (_req, res) => {
        unlinkSync(output);
        linkSync(source, output);
        res.end(FORMAT);
      },
    });
    await expect(
      compileToFile({
        sources: [source],
        headFile: head,
        outFile: output,
        formatId: 'outputraceunique-1',
        formatUrls: [`${server.origin}/format.js`],
        useDefaultFormatIndices: false,
        useTweegoPath: false,
        formatPaths: [],
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_IS_INPUT' });
    expect(readFileSync(source, 'utf8')).toBe(STORY);
    expect(readFileSync(output, 'utf8')).toBe(STORY);
  });

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

describe.skipIf(process.platform === 'win32').each(['Rollup', 'Vite'] as const)(
  '%s output identities after format resolution (#301)',
  (bundler) => {
    it.each<Victim>(['source', 'module', 'head', 'folder-source'])(
      'preserves a %s after output file or parent-link retargeting',
      async (victim) => {
        for (const parentLink of [false, true]) {
          const dir = join(root(), parentLink ? 'parent-link' : 'file-link');
          mkdirSync(join(dir, 'src'), { recursive: true });
          mkdirSync(join(dir, 'out'));
          const paths: Record<Victim, string> = {
            source: join(dir, 'story.tw'),
            module: join(dir, 'mod.js'),
            head: join(dir, 'head.html'),
            'folder-source': join(dir, 'src', 'a.tw'),
          };
          writeFileSync(paths.source, STORY);
          writeFileSync(paths['folder-source'], STORY);
          writeFileSync(paths.module, 'window.x = 1;');
          writeFileSync(paths.head, '<meta name="a">');
          writeFileSync(join(dir, 'entry.js'), 'export const answer = 42;');
          const filename = basename(paths[victim]);
          const previous = join(dir, 'out', filename);
          writeFileSync(previous, 'previous output');
          const linkedDir = join(dir, 'linked');
          if (parentLink) symlinkSync(join(dir, 'out'), linkedDir, 'dir');
          const outDir = parentLink ? linkedDir : join(dir, 'out');
          const output = join(outDir, filename);
          if (!parentLink) {
            unlinkSync(previous);
            writeFileSync(join(dir, 'previous.html'), 'previous output');
            symlinkSync(join(dir, 'previous.html'), output);
          }
          const before = readFileSync(paths[victim], 'utf8');
          const server = await startFormatServer({
            '/format.js': (_req, res) => {
              unlinkSync(parentLink ? linkedDir : output);
              symlinkSync(parentLink ? dirname(paths[victim]) : paths[victim], parentLink ? linkedDir : output);
              res.end(FORMAT);
            },
          });
          const options = {
            sources: [victim === 'folder-source' ? join(dir, 'src') : paths.source],
            format: 'outputraceunique-1',
            outputFilename: filename,
            compileOptions: {
              modules: [paths.module],
              headFile: paths.head,
              formatUrls: [`${server.origin}/format.js`],
              useDefaultFormatIndices: false,
              useTweegoPath: false,
              formatPaths: [],
            },
          };
          const write = async (): Promise<void> => {
            if (bundler === 'Vite') {
              await build({
                configFile: false,
                root: dir,
                logLevel: 'silent',
                plugins: [vitePlugin(options)],
                build: { outDir, emptyOutDir: false, rolldownOptions: { input: join(dir, 'entry.js') } },
              });
            } else {
              const bundle = await rollup({ input: join(dir, 'entry.js'), plugins: [rollupPlugin(options)] });
              try {
                await bundle.write({ dir: outDir });
              } finally {
                await bundle.close();
              }
            }
          };
          await expect(write()).rejects.toThrow(/Output file cannot be an input source/);
          expect(readFileSync(paths[victim], 'utf8')).toBe(before);
          expect(readFileSync(parentLink ? previous : join(dir, 'previous.html'), 'utf8')).toBe('previous output');
        }
      },
      30_000,
    );
  },
);

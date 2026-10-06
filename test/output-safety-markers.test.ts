/**
 * What counts as an earlier build (#273): a file's structure, never text that happens to look like
 * what twee-ts writes. An authored file of a loadable type in a source or module folder that quotes a
 * build mark in a script, a comment, an attribute or passage text is the author's, so a build into its
 * path is refused (`OUTPUT_IS_INPUT`) and leaves its bytes as they were; a genuine earlier build of each
 * output that carries a mark is still rebuilt, also by another process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileToFile } from '../src/compiler.js';
import { isLoadableType, isPreviousBuild } from '../src/filesystem.js';
import type { OutputMode } from '../src/types.js';

const FORMAT_DIR = join(import.meta.dirname, 'fixtures', 'storyformats');
const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nPRECIOUS\n';
const TWINE2 = '<tw-storydata name="x" creator="Twee-ts">';
const VERSION = 'Compiled with twee-ts, 2.0.0';

let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-markers-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Authored files that quote a build mark without being a build: [name, file name, content]. */
const AUTHORED: readonly (readonly [string, string, string])[] = [
  ['a script with the JSON creator in an object literal', 'a.js', 'globalThis.example = {"creator": "Twee-ts"};'],
  ['a script with the Twine 1 version in a comment', 'a.js', `// ${VERSION}, docs example\nglobalThis.result = 42;`],
  ['a script holding a story element in a string', 'a.js', `globalThis.html = '${TWINE2}';`],
  ['a stylesheet quoting the version', 'a.css', `/* ${VERSION} */\nbody { color: red; }`],
  ['a stylesheet quoting a story element', 'a.css', `/* ${TWINE2} */`],
  ['a Twee file with the version in passage text', 'a.tw', `:: Notes\n${VERSION}\n${TWINE2}\n`],
  ['a page with the story element in a comment', 'a.html', `<!doctype html><!-- ${TWINE2} --><p>hi</p>`],
  ['a page with the story element in an attribute', 'a.html', `<p title='${TWINE2}'>hi</p>`],
  ['a page with the story element in a script', 'a.html', `<script>var s = '${TWINE2}';</script>`],
  ['a page with the version but no store area', 'a.html', `<p>${VERSION}</p>`],
  [
    'a page with the version in an attribute of a store area',
    'a.html',
    `<div id="storeArea" title="${VERSION}"></div>`,
  ],
  ['a JSON file naming the creator in a string', 'a.json', JSON.stringify({ note: '"creator": "Twee-ts"' })],
  ['a JSON file of another creator', 'a.json', JSON.stringify({ creator: 'Someone', passages: [] })],
  ['a JSON file with the creator but no passages', 'a.json', JSON.stringify({ creator: 'Twee-ts' })],
  [
    'a JSON file with the creator below the top level',
    'a.json',
    JSON.stringify({ x: { creator: 'Twee-ts', passages: [] } }),
  ],
];

describe('an authored file that quotes a build mark', () => {
  it.each(AUTHORED)('is not an earlier build: %s', (_name, file, content) => {
    const path = join(dir, file);
    writeFileSync(path, content);
    expect(isPreviousBuild(path)).toBe(false);
  });

  describe.each(['source', 'module'] as const)('in a %s folder', (role) => {
    it.each(AUTHORED.filter(([, file]) => isLoadableType(file, role)))(
      'is refused and left as it was: %s',
      async (_name, file, content) => {
        const folder = join(dir, 'folder');
        mkdirSync(folder);
        const story = join(dir, 'story.tw');
        writeFileSync(story, STORY);
        const outFile = join(folder, file);
        writeFileSync(outFile, content);
        const options = role === 'source' ? { sources: [folder, story] } : { sources: [story], modules: [folder] };
        await expect(compileToFile({ ...options, outputMode: 'json', outFile })).rejects.toMatchObject({
          code: 'OUTPUT_IS_INPUT',
        });
        expect(readFileSync(outFile, 'utf-8')).toBe(content);
      },
    );
  });
});

describe('a genuine earlier build', () => {
  /** An output mode, the file it writes in the folder, and the build options it needs. */
  const BUILDS: readonly (readonly [string, OutputMode, string])[] = [
    ['Twine 2 HTML', 'html', 'out.html'],
    ['Twine 2 archive', 'twine2-archive', 'out.html'],
    ['JSON', 'json', 'out.json'],
    ['JSON in a file named like a script', 'json', 'out.js'],
  ];

  it.each(BUILDS)('is rebuilt over, also when another process wrote it: %s', async (_name, outputMode, file) => {
    const folder = join(dir, 'src');
    mkdirSync(folder);
    writeFileSync(join(folder, 'a.tw'), STORY);
    const outFile = join(folder, file);
    const options = {
      sources: [folder],
      outputMode,
      outFile,
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    };
    await compileToFile(options);
    expect(isPreviousBuild(outFile)).toBe(true);
    // Another process, with no memory of the first build, builds again.
    const copy = readFileSync(outFile, 'utf-8');
    rmSync(outFile);
    writeFileSync(outFile, copy);
    writeFileSync(join(folder, 'a.tw'), STORY.replace('PRECIOUS', 'UPDATED'));
    const second = await compileToFile(options);
    expect(second.stats.files).toHaveLength(1);
    expect(readFileSync(outFile, 'utf-8')).toContain('UPDATED');
  });

  it('is recognised for Twine 1 HTML, by its store area and the version text where the format put it', async () => {
    const formats = join(dir, 'formats');
    mkdirSync(join(formats, 'one'), { recursive: true });
    writeFileSync(
      join(formats, 'one', 'header.html'),
      '<!doctype html><html><head><!-- "VERSION" --></head><body><div id="storeArea">"STORY"</div></body></html>',
    );
    const folder = join(dir, 'src');
    mkdirSync(folder);
    writeFileSync(join(folder, 'a.tw'), `${STORY}\n:: StoryTitle\nT\n`);
    const outFile = join(folder, 'out.html');
    const options = { sources: [folder], outFile, formatId: 'one', formatPaths: [formats], useTweegoPath: false };
    await compileToFile(options);
    expect(isPreviousBuild(outFile)).toBe(true);
    await compileToFile(options);
    expect(readFileSync(outFile, 'utf-8')).toContain('PRECIOUS');
  });
});

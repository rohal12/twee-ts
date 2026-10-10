/**
 * Lint reports every diagnostic a Twine 2 HTML build gives about the story's own data (#365): each case is built
 * as Twine 2 HTML (with a local test format) and as a Twine 2 archive, the oracles, and linted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { lint, formatLintReport } from '../src/lint.js';
import type { CompileOptions, InlineSource } from '../src/types.js';

const FORMAT_DIR = join(import.meta.dirname, 'fixtures', 'storyformats');
const HTML_OPTIONS = { formatId: 'test-format-1', formatPaths: [FORMAT_DIR], useTweegoPath: false, noRemote: true };
const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

/** A story whose StoryData holds `data` besides the IFID, with `rest` after the start passage. */
function story(rest: string, data = '', title = 'Title'): InlineSource[] {
  return [
    {
      filename: 'story.tw',
      content: `:: StoryTitle\n${title}\n\n:: StoryData\n{"ifid":"${IFID}"${data}}\n\n:: Start\nHello.\n\n${rest}`,
    },
  ];
}

/**
 * Every kind of story data the HTML output checks reject or warn about, each once. `html: false` for the cases
 * whose story format name or version no format has, which only the archive (written with the story's own format
 * fields) can build.
 */
const CASES: readonly (readonly [name: string, sources: InlineSource[], html: boolean])[] = [
  ['U+0000 in passage text', story(':: Room\nA\u0000B\n'), true],
  ['a lone surrogate in passage text', story(':: Room\nA\ud800B\n'), true],
  ['U+0000 in a passage name', story(':: Ro\u0000om\nText\n'), true],
  ['a lone surrogate in a passage name', story(':: Ro\udc00om\nText\n'), true],
  ['U+0000 in a passage tag', story(':: Room [t\u0000g]\nText\n'), true],
  ['U+0000 in the story name', story('', '', 'Ti\u0000tle'), true],
  ['U+0000 in a passage position', story(':: Room {"position":"1\\u0000,2"}\nText\n'), true],
  ['U+0000 in a passage size', story(':: Room {"size":"1\\u0000,2"}\nText\n'), true],
  ['U+0000 in a tag color', story(':: Room [t]\nText\n', ',"tag-colors":{"t\\u0000":"red"}'), true],
  ['a story option with white space', story('', ',"options":["a b"]'), true],
  ['an empty story option', story('', ',"options":[""]'), true],
  ['U+0000 in a story option', story('', ',"options":["a\\u0000"]'), true],
  ['U+0000 in the story format name', story('', ',"format":"test\\u0000format"'), false],
  ['U+0000 in the story format version', story('', ',"format":"test-format","format-version":"1\\u0000"'), false],
  ['"</script" in story JavaScript', story(':: Code [script]\nvar a = 1 </script/ 2;\n'), true],
  [
    '"<!--" in a regular expression with the u flag, before a "<script"',
    story(':: Code [script]\nvar r = /<!--/u;\n\n:: More [script]\nvar s = "<script>";\n'),
    true,
  ],
  ['"</style" in a stylesheet', story(':: Theme [stylesheet]\n</style> body { color: red; }\n'), true],
];

const messages = (diagnostics: readonly { readonly message: string }[]): string[] => diagnostics.map((d) => d.message);

describe('lint reports what Twine 2 HTML output reports about the story data (#365)', () => {
  it.each(CASES)('%s, as the Twine 2 archive does', async (_name, sources) => {
    const linted = messages((await lint({ sources })).diagnostics);
    const archive = messages((await compile({ sources, outputMode: 'twine2-archive' })).diagnostics);
    // Each case gives at least one diagnostic in the output, and lint reports each one, once.
    expect(archive.length).toBeGreaterThan(0);
    expect(linted).toEqual(expect.arrayContaining(archive));
    expect(new Set(linted).size).toBe(linted.length);
  });

  it.each(CASES.filter(([, , html]) => html))('%s, as Twine 2 HTML does', async (_name, sources) => {
    const linted = messages((await lint({ sources })).diagnostics);
    const built = messages((await compile({ sources, ...HTML_OPTIONS })).diagnostics);
    expect(built.length).toBeGreaterThan(0);
    expect(linted).toEqual(expect.arrayContaining(built));
  });

  it('fails the report for an error HTML output gives, as the build fails', async () => {
    const result = await lint({ sources: story('', ',"options":["a b"]') });
    expect(formatLintReport(result)).toContain(
      'error: The story option "a b" is empty or contains white space; options are written space-separated',
    );
    expect(formatLintReport(result)).toContain('Lint failed.');
  });

  it('checks no text of a Twine.private passage, which the output leaves out', async () => {
    const sources = story(':: Notes [Twine.private]\nA\u0000B </script>\n');
    expect((await lint({ sources })).diagnostics).toEqual([]);
    expect((await compile({ sources, outputMode: 'twine2-archive' })).diagnostics).toEqual([]);
  });
});

describe('lint reports what Twine 2 HTML output reports about the modules and the head file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-lint-head-'));
    writeFileSync(join(dir, 'zero.js'), 'var a = "A\u0000B";');
    writeFileSync(join(dir, 'end.js'), 'var a = 1 </script/ 2;');
    writeFileSync(join(dir, 'end.css'), '</style> p { color: red; }');
    writeFileSync(join(dir, 'latin1.js'), Buffer.from([0x76, 0x61, 0x72, 0x20, 0x61, 0x3d, 0x22, 0xe9, 0x22, 0x3b]));
    writeFileSync(join(dir, 'notes.txt'), 'not a module');
    writeFileSync(join(dir, 'head.html'), '<meta name="theme-color" content="#000">');
    writeFileSync(
      join(dir, 'latin1.html'),
      Buffer.concat([Buffer.from('<meta name="a" content="'), Buffer.from([0xe9]), Buffer.from('">')]),
    );
    writeFileSync(join(dir, 'ok.js'), 'var ok = 1;');
    mkdirSync(join(dir, 'mods'));
    writeFileSync(join(dir, 'mods', 'one.js'), 'var one = 1;');
    writeFileSync(join(dir, 'mods', 'two.js'), 'var two = 2;');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Each kind of module or head file input HTML output reports on, as compile options. */
  const HEAD_CASES: readonly (readonly [name: string, options: (dir: string) => Partial<CompileOptions>])[] = [
    ['U+0000 in a module', (d) => ({ modules: [join(d, 'zero.js')] })],
    ['"</script" in a script module', (d) => ({ modules: [join(d, 'end.js')] })],
    ['"</style" in a style module', (d) => ({ modules: [join(d, 'end.css')] })],
    ['a module that is not UTF-8', (d) => ({ modules: [join(d, 'latin1.js')] })],
    ['a named module of a type modules do not load', (d) => ({ modules: [join(d, 'notes.txt')] })],
    ['a module that does not exist', (d) => ({ modules: [join(d, 'missing.js')] })],
    ['a module given twice', (d) => ({ modules: [join(d, 'ok.js'), join(d, 'ok.js')] })],
    ['a module given and found in a module folder', (d) => ({ modules: [join(d, 'mods'), join(d, 'mods', 'one.js')] })],
    ['a head file that is not UTF-8', (d) => ({ headFile: join(d, 'latin1.html') })],
  ];

  it.each(HEAD_CASES)('%s', async (_name, extra) => {
    const options = { sources: story(''), ...extra(dir) };
    const built = messages((await compile({ ...options, ...HTML_OPTIONS })).diagnostics);
    const linted = messages((await lint(options)).diagnostics);
    expect(built.length).toBeGreaterThan(0);
    expect(linted).toEqual(expect.arrayContaining(built));
    expect(new Set(linted).size).toBe(linted.length);
  });

  it('stops at a head file that cannot be read, as the build does', async () => {
    const options = { sources: story(''), headFile: join(dir, 'missing.html') };
    const build = compile({ ...options, ...HTML_OPTIONS });
    await expect(build).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
    const message = await build.catch((e: unknown) => (e instanceof Error ? e.message : ''));
    await expect(lint(options)).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE', message });
  });

  it('passes modules and a head file that HTML output takes without a word', async () => {
    const options = {
      sources: story(''),
      modules: [join(dir, 'ok.js'), join(dir, 'mods')],
      headFile: join(dir, 'head.html'),
    };
    expect((await compile({ ...options, ...HTML_OPTIONS })).diagnostics).toEqual([]);
    expect((await lint(options)).diagnostics).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { compile, compileIncremental, compileToFile, TweeTsError } from '../src/compiler.js';
import type { CompileResult, Diagnostic, FileCacheEntry } from '../src/types.js';
import { decompileHTML } from '../src/html-parser.js';
import { Parser } from 'htmlparser2';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

describe('compile', () => {
  it('warns about a source path that does not exist instead of dropping it silently', async () => {
    const missing = join(FIXTURES_DIR, 'no-such-story');
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'minimal.tw'), missing],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).toContain('Minimal Story');
    expect(result.diagnostics).toContainEqual({
      level: 'warning',
      message: expect.stringContaining(`path ${missing}: ENOENT`),
    });
  });

  it('warns about a module path that does not exist', async () => {
    const missing = join(FIXTURES_DIR, 'no-such-module.js');
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'minimal.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      modules: [missing],
    });

    expect(result.diagnostics).toContainEqual({
      level: 'warning',
      message: expect.stringContaining(`path ${missing}: ENOENT`),
    });
  });

  it('compiles a minimal twee file to HTML', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'minimal.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).toContain('<html>');
    expect(result.output).toContain('Minimal Story');
    expect(result.output).toContain('tw-storydata');
    expect(result.output).toContain('Hello, world!');
    expect(result.stats.passages).toBeGreaterThan(0);
  });

  it('compiles multi-passage file', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).toContain('tw-passagedata');
    expect(result.output).toContain('Room');
    expect(result.output).toContain('Secret Room');
    expect(result.stats.passages).toBeGreaterThanOrEqual(5);
  });

  it('compiles to Twee3 output', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      outputMode: 'twee3',
    });

    expect(result.output).toContain(':: Start');
    expect(result.output).toContain(':: Room [location]');
    expect(result.output).toContain(':: Secret Room [location hidden]');
  });

  it('compiles to JSON output', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'storydata.tw')],
      outputMode: 'json',
    });

    const json = JSON.parse(result.output);
    expect(json.name).toBe('A Story With Metadata');
    expect(json.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(json.passages.length).toBeGreaterThan(0);
  });

  it('supports inline sources', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'inline.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nInline Story\n\n:: Start\nHello from inline!',
        },
      ],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).toContain('Hello from inline!');
    expect(result.output).toContain('Inline Story');
  });

  it('compiles to Twine 2 archive', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'minimal.tw')],
      outputMode: 'twine2-archive',
    });

    expect(result.output).toContain('<tw-storydata');
    expect(result.output).toContain('</tw-storydata>');
    expect(result.output).not.toContain('<html>');
  });

  it('preserves story metadata in JSON output (spec-compliant keys)', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'storydata.tw')],
      outputMode: 'json',
    });

    const json = JSON.parse(result.output);
    expect(json.format).toBe('SugarCube');
    expect(json['format-version']).toBe('2.37.3');
    expect(json.start).toBe('Begin');
    expect(json['tag-colors']).toEqual({ location: 'green', character: 'blue' });
  });

  it('reports diagnostics rather than throwing', async () => {
    const result = await compile({
      sources: [{ filename: 'broken.tw', content: ':: Test [unclosed\nContent' }],
      outputMode: 'twee3',
    });

    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('treats aliased tag as script in Twine 2 HTML', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'alias.tw',
          content: [
            ':: StoryData',
            '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
            '',
            ':: StoryTitle',
            'Alias Test',
            '',
            ':: Start',
            'Hello',
            '',
            ':: MyLib [library]',
            'window.myLib = true;',
          ].join('\n'),
        },
      ],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      tagAliases: { library: 'script' },
    });

    // Library passage should be in the script block, not as passagedata
    expect(result.output).toContain('id="twine-user-script"');
    expect(result.output).toContain('window.myLib = true;');
    // Should NOT appear as a regular passage
    expect(result.output).not.toContain('name="MyLib"');
  });

  it('treats aliased tag as stylesheet in Twine 2 HTML', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'alias-css.tw',
          content: [
            ':: StoryData',
            '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
            '',
            ':: StoryTitle',
            'CSS Alias Test',
            '',
            ':: Start',
            'Hello',
            '',
            ':: Theme [theme]',
            'body { color: red; }',
          ].join('\n'),
        },
      ],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      tagAliases: { theme: 'stylesheet' },
    });

    expect(result.output).toContain('id="twine-user-stylesheet"');
    expect(result.output).toContain('body { color: red; }');
    expect(result.output).not.toContain('name="Theme"');
  });

  it('handles passage position metadata in output', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'storydata.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).toContain('position="100,100"');
    expect(result.output).toContain('size="200,100"');
  });
});

describe('compile with exclude', () => {
  const TMP_DIR = join(__dirname, '__tmp_exclude__');
  const options = { formatId: 'test-format-1', formatPaths: [FORMAT_DIR], useTweegoPath: false, noRemote: true };

  beforeEach(() => {
    mkdirSync(join(TMP_DIR, 'story', 'art'), { recursive: true });
    writeFileSync(join(TMP_DIR, 'story', 'start.tw'), readFileSync(join(FIXTURES_DIR, 'minimal.tw')));
    writeFileSync(join(TMP_DIR, 'story', 'art', 'scene.png'), Buffer.alloc(16, 7));
  });

  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('loads every media file found in a source folder by default, as Tweego does', async () => {
    const result = await compile({ ...options, sources: [join(TMP_DIR, 'story')] });
    expect(result.output).toContain('Twine.image');
    expect(result.stats.files.some((f) => f.endsWith('scene.png'))).toBe(true);
  });

  it('leaves out the files that match an exclude glob', async () => {
    const result = await compile({ ...options, sources: [join(TMP_DIR, 'story')], exclude: ['**/*.png'] });
    expect(result.output).toContain('Hello, world!');
    expect(result.output).not.toContain('Twine.image');
    expect(result.stats.files.some((f) => f.endsWith('scene.png'))).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it('leaves them out of compileToFile too', async () => {
    const outFile = join(TMP_DIR, 'out.html');
    const result = await compileToFile({
      ...options,
      sources: [join(TMP_DIR, 'story')],
      outFile,
      exclude: ['**/art/**'],
    });
    expect(result.stats.files.some((f) => f.endsWith('scene.png'))).toBe(false);
    expect(readFileSync(outFile, 'utf-8')).not.toContain('Twine.image');
  });

  it('leaves modules alone', async () => {
    const module = join(TMP_DIR, 'story', 'art', 'mod.js');
    writeFileSync(module, 'window.modMarker = 1;');
    const result = await compile({
      ...options,
      sources: [join(TMP_DIR, 'story')],
      exclude: ['**/art/**'],
      modules: [module],
    });
    expect(result.output).toContain('<script id="script-module-mod" type="text/javascript">window.modMarker = 1;');
    expect(result.stats.files.some((f) => f.endsWith('mod.js'))).toBe(false);
  });
});

describe('compile with closing tags inside scripts and styles', () => {
  const TMP_DIR = join(__dirname, '__tmp_closing_tags__');
  const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nTags\n\n:: Start\nHi';
  const story = { filename: 'story.tw', content: STORY };
  const html = { formatId: 'test-format-1', formatPaths: [FORMAT_DIR], useTweegoPath: false, noRemote: true };

  /** The JavaScript a script holding `code` leaves in the page: evaluates it and returns the window it set. */
  function run(code: string): Record<string, unknown> {
    const window: Record<string, unknown> = {};
    new Function('window', code)(window);
    return window;
  }

  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('keeps a JavaScript source holding a closing script tag whole', async () => {
    const result = await compile({
      sources: [story, { filename: 'script.js', content: 'window.marker="</script>"; window.after = true;' }],
      outputMode: 'twine2-archive',
    });

    const { story: decompiled } = decompileHTML(result.output);
    const script = decompiled.passages.find((p) => p.tags.includes('script'));
    expect(script?.text).toBe('window.marker="<\\/script>"; window.after = true;');
    expect(run(script?.text ?? '')).toEqual({ marker: '</script>', after: true });
    expect(decompiled.passages.map((p) => p.name)).toContain('Start');
  });

  it('escapes closing script tags in any letter case, with whitespace, attributes or a slash', async () => {
    const code = 'window.a = ["</SCRIPT>", "</Script >", "</script\\tid=x>", "</script/>"];';
    const result = await compile({
      sources: [
        story,
        { filename: 'tags.tw', content: `:: Code [script]\n${code}\n\n:: More [script]\nwindow.b = 1;` },
      ],
      outputMode: 'twine2-archive',
    });

    expect(result.output.match(/<\/script/gi)).toEqual(['</script']);
    const { story: decompiled } = decompileHTML(result.output);
    const script = decompiled.passages.find((p) => p.tags.includes('script'));
    expect(run(script?.text ?? '')).toEqual({ a: ['</SCRIPT>', '</Script >', '</script\tid=x>', '</script/>'], b: 1 });
  });

  it('escapes a comment opener that would stop the end tag from closing the script', async () => {
    const result = await compile({
      sources: [story, { filename: 'script.js', content: 'window.html = "<!--<script>";' }],
      outputMode: 'twine2-archive',
    });

    expect(result.output).toContain('window.html = "<\\!--<script>";</script>');
  });

  it('escapes closing style tags in stylesheets', async () => {
    const result = await compile({
      sources: [story, { filename: 'style.css', content: 'a::after { content: "</STYLE >"; }' }],
      outputMode: 'twine2-archive',
    });

    expect(result.output.match(/<\/style/gi)).toEqual(['</style']);
    const { story: decompiled } = decompileHTML(result.output);
    const stylesheet = decompiled.passages.find((p) => p.tags.includes('stylesheet'));
    expect(stylesheet?.text).toBe('a::after { content: "<\\/STYLE >"; }');
  });

  it('escapes them in JavaScript and CSS files on disk compiled to HTML', async () => {
    writeFileSync(join(TMP_DIR, 'start.tw'), STORY);
    writeFileSync(join(TMP_DIR, 'code.js'), 'window.x = "</script>";');
    writeFileSync(join(TMP_DIR, 'look.css'), 'b::before { content: "</style>"; }');
    const result = await compile({ ...html, sources: [TMP_DIR] });

    expect(result.output).toContain('window.x = "<\\/script>";</script>');
    expect(result.output).toContain('b::before { content: "<\\/style>"; }</style>');
    expect(result.output.match(/<\/script/gi)).toHaveLength(1);
    expect(result.output.match(/<\/style/gi)).toHaveLength(1);
  });

  it('escapes them in head modules', async () => {
    const js = join(TMP_DIR, 'mod.js');
    const css = join(TMP_DIR, 'mod.css');
    writeFileSync(js, 'window.m = "</Script>" + "<!--<script>";');
    writeFileSync(css, 'i::after { content: "</style>"; }');
    const result = await compile({ ...html, sources: [story], modules: [js, css] });

    expect(result.output).toContain(
      '<script id="script-module-mod" type="text/javascript">window.m = "<\\/Script>" + "<\\!--<script>";</script>',
    );
    expect(result.output).toContain(
      '<style id="style-module-mod" type="text/css">i::after { content: "<\\/style>"; }</style>',
    );
  });

  it('compiles the decompiled story to the same script and stylesheet', async () => {
    const sources = [
      story,
      { filename: 'script.js', content: 'window.marker="</script>" + "<!--<script>";' },
      { filename: 'style.css', content: 'a::after { content: "</style>"; }' },
    ];
    const first = await compile({ sources, outputMode: 'twine2-archive' });
    const archive = join(TMP_DIR, 'story.html');
    writeFileSync(archive, first.output);
    const again = await compile({ sources: [archive], outputMode: 'twine2-archive' });

    const elements = (output: string): string[] => output.match(/<(script|style)[ >].*?<\/\1>/g) ?? [];
    expect(elements(first.output)).toEqual([
      '<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">a::after { content: "<\\/style>"; }</style>',
      '<script role="script" id="twine-user-script" type="text/twine-javascript">window.marker="<\\/script>" + "<\\!--<script>";</script>',
    ]);
    expect(elements(again.output)).toEqual(elements(first.output));
  });
});

describe('compileToFile with the output inside a source folder', () => {
  const TMP_DIR = join(__dirname, '__tmp_outfile__');
  const story = join(TMP_DIR, 'story');
  const start = join(story, 'start.tw');
  const passages = (text: string, extra = ''): string =>
    `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nOut Test\n\n:: Start\n${text}\n${extra}`;

  beforeEach(() => {
    mkdirSync(story, { recursive: true });
    writeFileSync(start, passages('ORIGINAL_CONTENT', '\n:: Gone\nSOON_DELETED\n'));
  });

  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it.each([
    ['an absolute', (p: string) => p],
    ['a relative', (p: string) => relative(process.cwd(), p)],
  ])('does not load its own earlier output back as a source (%s output path)', async (_kind, asGiven) => {
    const outFile = asGiven(join(story, 'z-output.html'));
    const options = { sources: [story], outputMode: 'twine2-archive', outFile } as const;
    await compileToFile(options);

    writeFileSync(start, passages('UPDATED_CONTENT'));
    const second = await compileToFile(options);

    expect(second.output).toContain('UPDATED_CONTENT');
    expect(second.output).not.toContain('ORIGINAL_CONTENT');
    expect(second.output).not.toContain('SOON_DELETED');
    expect(second.stats.files.some((f) => f.endsWith('z-output.html'))).toBe(false);
    expect(second.diagnostics).toEqual([]);
    expect(readFileSync(outFile, 'utf-8')).toContain('UPDATED_CONTENT');
  });

  it('leaves the output out of module discovery too', async () => {
    const options = {
      sources: [start],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      noRemote: true,
      modules: [story],
      outFile: join(story, 'out.js'),
    };
    await compileToFile(options);
    const second = await compileToFile(options);
    expect(second.output).not.toContain('script-module-out');
  });
});

// Symbolic links need privileges on Windows.
describe.skipIf(process.platform === 'win32')('compileToFile with the output reached through links (#152)', () => {
  let root: string;
  const passages = (text: string, extra = ''): string =>
    `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nLink Test\n\n:: Start\n${text}\n${extra}`;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'twee-ts-links-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Builds twice, editing Start and deleting a passage in between; returns the second build. */
  async function twoBuilds(start: string, sources: string, outFile: string) {
    writeFileSync(start, passages('ORIGINAL_CONTENT', '\n:: Gone\nSOON_DELETED\n'));
    const options = { sources: [sources], outputMode: 'twine2-archive', outFile } as const;
    await compileToFile(options);
    writeFileSync(start, passages('UPDATED_CONTENT'));
    return compileToFile(options);
  }

  function expectEdited(result: CompileResult, outFile: string, files: readonly string[]): void {
    expect(result.output).toContain('UPDATED_CONTENT');
    expect(result.output).not.toContain('ORIGINAL_CONTENT');
    expect(result.output).not.toContain('SOON_DELETED');
    expect(result.stats.files.map((f) => resolve(f))).toEqual(files);
    expect(result.diagnostics).toEqual([]);
    expect(readFileSync(outFile, 'utf-8')).toContain('UPDATED_CONTENT');
  }

  it('sources named through a symlinked project folder, output by its real path', async () => {
    mkdirSync(join(root, 'real', 'story'), { recursive: true });
    symlinkSync('real', join(root, 'link'));
    const outFile = join(root, 'real', 'story', 'z.html');
    const result = await twoBuilds(join(root, 'real', 'story', 'a.tw'), join(root, 'link', 'story'), outFile);
    expectEdited(result, outFile, [join(root, 'link', 'story', 'a.tw')]);
  });

  it('output named through a link to the source folder', async () => {
    mkdirSync(join(root, 'story'));
    symlinkSync('story', join(root, 'out'));
    const outFile = join(root, 'out', 'z.html');
    const result = await twoBuilds(join(root, 'story', 'a.tw'), join(root, 'story'), outFile);
    expectEdited(result, outFile, [join(root, 'story', 'a.tw')]);
  });

  it('a link in the source folder to the output folder', async () => {
    mkdirSync(join(root, 'story'));
    mkdirSync(join(root, 'dist'));
    symlinkSync(join('..', 'dist'), join(root, 'story', 'build'));
    const outFile = join(root, 'dist', 'z.html');
    const result = await twoBuilds(join(root, 'story', 'a.tw'), join(root, 'story'), outFile);
    expectEdited(result, outFile, [join(root, 'story', 'a.tw')]);
  });
});

describe('compileToFile with a named source that is the output (#157)', () => {
  let root: string;
  const SOURCE = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello world\n';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'twee-ts-inplace-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('rejects a source file that is the output and leaves it unchanged', async () => {
    const file = join(root, 'a.tw');
    writeFileSync(file, SOURCE);
    const build = compileToFile({ sources: [file], outputMode: 'twee3', outFile: file });
    await expect(build).rejects.toThrow(TweeTsError);
    await expect(build).rejects.toThrow(`path ${file}: Output file cannot be an input source.`);
    expect(readFileSync(file, 'utf-8')).toBe(SOURCE);
  });

  it('rejects a module or head file that is the output', async () => {
    const story = join(root, 'a.tw');
    writeFileSync(story, SOURCE);
    const out = join(root, 'out.html');
    writeFileSync(out, 'kept');
    const options = { sources: [story], formatId: 'test-format-1', formatPaths: [FORMAT_DIR], useTweegoPath: false };
    await expect(compileToFile({ ...options, noRemote: true, modules: [out], outFile: out })).rejects.toThrow(
      `path ${out}: Output file cannot be an input source.`,
    );
    await expect(compileToFile({ ...options, noRemote: true, headFile: out, outFile: out })).rejects.toThrow(
      `path ${out}: Output file cannot be an input source.`,
    );
    expect(readFileSync(out, 'utf-8')).toBe('kept');
  });

  it('still skips an output found inside a source folder without an error', async () => {
    writeFileSync(join(root, 'a.tw'), SOURCE);
    const outFile = join(root, 'z.tw');
    await compileToFile({ sources: [root], outputMode: 'twee3', outFile });
    const second = await compileToFile({ sources: [root], outputMode: 'twee3', outFile });
    expect(second.diagnostics).toEqual([]);
    expect(second.stats.files.map((f) => resolve(f))).toEqual([join(root, 'a.tw')]);
  });
});

describe('Twee output records the effective StoryData', () => {
  const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
  const SOURCE = [
    ':: StoryTitle',
    'Effective',
    '',
    ':: StoryData',
    JSON.stringify({ ifid: IFID, format: 'SugarCube', options: ['strict'], start: 'Start' }),
    '',
    ':: Start',
    'Original',
    '',
    ':: Prologue',
    'New start',
  ].join('\n');

  const TWEE_MODES = ['twee3', 'twee1'] as const;

  async function roundTrip(
    content: string,
    outputMode: (typeof TWEE_MODES)[number],
    overrides: { readonly startPassage?: string; readonly testMode?: boolean },
  ) {
    const first = await compile({ sources: [{ filename: 'story.tw', content }], outputMode, ...overrides });
    const again = await compile({ sources: [{ filename: 'roundtrip.tw', content: first.output }], outputMode });
    return { first, again };
  }

  for (const outputMode of TWEE_MODES) {
    describe(outputMode, () => {
      it('keeps a start passage override through a round trip', async () => {
        const { first, again } = await roundTrip(SOURCE, outputMode, { startPassage: 'Prologue' });
        expect(first.story.twine2.start).toBe('Prologue');
        expect(first.output).toContain('"start": "Prologue"');
        expect(again.story.twine2.start).toBe('Prologue');
      });

      it('keeps the debug option from test mode through a round trip', async () => {
        const { first, again } = await roundTrip(SOURCE, outputMode, { testMode: true });
        expect([...first.story.twine2.options.keys()]).toEqual(['strict', 'debug']);
        expect([...again.story.twine2.options.keys()]).toEqual(['strict', 'debug']);
      });

      it('records overrides for a story without a StoryData passage, after StoryTitle', async () => {
        const source = ':: StoryTitle\nNo Data\n\n:: Start\nOriginal\n\n:: Prologue\nNew start';
        const { first, again } = await roundTrip(source, outputMode, { startPassage: 'Prologue', testMode: true });
        expect(first.story.passages.map((p) => p.name)).toEqual(['StoryTitle', 'Start', 'Prologue']);
        expect(first.output).toMatch(/^:: StoryTitle\nNo Data\n\n\n:: StoryData\n\{/);
        expect(again.story.twine2.start).toBe('Prologue');
        expect(again.story.twine2.options.has('debug')).toBe(true);
        expect(again.story.ifid).toBe(first.story.ifid);
      });

      it('writes no StoryData passage for a story without one when nothing overrides it', async () => {
        const source = ':: StoryTitle\nNo Data\n\n:: Start\nOriginal';
        const result = await compile({ sources: [{ filename: 'story.tw', content: source }], outputMode });
        expect(result.output).toBe(':: StoryTitle\nNo Data\n\n\n:: Start\nOriginal\n\n\n');
      });
    });
  }

  it('leaves the StoryData text unchanged when nothing overrides it', async () => {
    const result = await compile({ sources: [{ filename: 'story.tw', content: SOURCE }], outputMode: 'twee3' });
    expect(result.output).toContain(
      `:: StoryData\n{\n\t"ifid": "${IFID}",\n\t"format": "SugarCube",\n\t"options": [\n\t\t"strict"\n\t],\n\t"start": "Start"\n}\n\n\n`,
    );
  });

  it('leaves the output unchanged when the overrides match the StoryData', async () => {
    const plain = await compile({ sources: [{ filename: 'story.tw', content: SOURCE }], outputMode: 'twee3' });
    const overridden = await compile({
      sources: [{ filename: 'story.tw', content: SOURCE }],
      outputMode: 'twee3',
      startPassage: 'Start',
    });
    expect(overridden.output).toBe(plain.output);
  });

  it('records the IFID generated for a StoryData passage without one', async () => {
    const source = ':: StoryData\n{"start":"Start"}\n\n:: Start\nOriginal';
    const result = await compile({ sources: [{ filename: 'story.tw', content: source }], outputMode: 'twee3' });
    expect(result.diagnostics.some((d) => d.level === 'error' && d.message.includes('IFID not found'))).toBe(true);
    expect(result.output).toContain(`"ifid": "${result.story.ifid}"`);
  });

  it('keeps a StoryData passage that cannot be parsed as written', async () => {
    const source = ':: StoryData\n{not json\n\n:: Start\nOriginal';
    const result = await compile({
      sources: [{ filename: 'story.tw', content: source }],
      outputMode: 'twee3',
      startPassage: 'Start',
    });
    expect(result.output).toContain(':: StoryData\n{not json\n\n\n');
  });
});

describe('a wrapped IFID is written as the bare UUID', () => {
  const BARE = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
  const WRAPPED = `UUID://${BARE}//`;
  const SOURCE = `:: StoryTitle\nWrapped\n\n:: StoryData\n${JSON.stringify({ ifid: WRAPPED })}\n\n:: Start\nHello`;
  const TMP_DIR = join(__dirname, '__tmp_wrapped_ifid__');

  beforeEach(() => {
    mkdirSync(join(TMP_DIR, 'twine1-test'), { recursive: true });
    writeFileSync(
      join(TMP_DIR, 'twine1-test', 'header.html'),
      '<html><body><div id="storeArea">"STORY"</div></body></html>',
    );
  });

  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  function compileWrapped(outputMode: 'html' | 'twine2-archive' | 'twee3' | 'json', content = SOURCE) {
    return compile({
      sources: [{ filename: 'story.tw', content }],
      outputMode,
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      noRemote: true,
    });
  }

  function babelComments(output: string): string[] {
    return output.match(/<!-- UUID:.*?-->/g) ?? [];
  }

  for (const outputMode of ['html', 'twine2-archive'] as const) {
    it(`writes one wrapper in the Babel comment and none in the ifid attribute (${outputMode})`, async () => {
      const result = await compileWrapped(outputMode);
      expect(result.diagnostics).toEqual([]);
      expect(result.story.ifid).toBe(BARE);
      expect(/ifid="([^"]*)"/.exec(result.output)?.[1]).toBe(BARE);
      expect(babelComments(result.output)).toEqual([`<!-- UUID://${BARE}// -->`]);
    });
  }

  it('writes one wrapper in the Twine 1 HTML comment', async () => {
    const result = await compile({
      sources: [{ filename: 'story.tw', content: SOURCE }],
      formatId: 'twine1-test',
      formatPaths: [TMP_DIR],
      useTweegoPath: false,
      noRemote: true,
    });
    expect(result.diagnostics).toEqual([]);
    expect(babelComments(result.output)).toEqual([`<!-- UUID://${BARE}// -->`]);
  });

  it('writes the bare UUID in JSON output', async () => {
    const result = await compileWrapped('json');
    expect(JSON.parse(result.output).ifid).toBe(BARE);
  });

  it('writes the bare UUID into Twee StoryData, which compiles again to the same IFID', async () => {
    const first = await compileWrapped('twee3');
    expect(first.output).toContain(`"ifid": "${BARE}"`);
    expect(first.output).not.toContain('UUID://');
    const again = await compileWrapped('html', first.output);
    expect(again.diagnostics).toEqual([]);
    expect(/ifid="([^"]*)"/.exec(again.output)?.[1]).toBe(BARE);
  });

  it('reuses a wrapped legacy StorySettings ifid as the bare UUID', async () => {
    const result = await compileWrapped(
      'twine2-archive',
      `:: StoryTitle\nLegacy\n\n:: StorySettings\nifid:uuid://${BARE.toLowerCase()}//\n\n:: Start\nHello`,
    );
    expect(result.diagnostics.map((d) => d.message)).toContain(
      'Story IFID not found; reusing "ifid" entry from the "StorySettings" special passage.',
    );
    expect(result.story.ifid).toBe(BARE);
    expect(/ifid="([^"]*)"/.exec(result.output)?.[1]).toBe(BARE);
    expect(babelComments(result.output)).toEqual([`<!-- UUID://${BARE}// -->`]);
  });
});

describe('format template placeholders', () => {
  const TMP_DIR = join(__dirname, '__tmp_template_placeholders__');
  const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
  const html = { formatId: 'test-format-1', formatPaths: [FORMAT_DIR], useTweegoPath: false, noRemote: true };

  function story(title: string, start: string): { filename: string; content: string } {
    return {
      filename: 'story.tw',
      content: `:: StoryTitle\n${title}\n\n:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start\n${start}\n`,
    };
  }

  /** Writes a Twine 2 format whose template is `source` and returns compile options for it. */
  function twine2Format(source: string) {
    mkdirSync(join(TMP_DIR, 'custom-2'), { recursive: true });
    const format = { name: 'Custom', version: '1.0.0', source };
    writeFileSync(join(TMP_DIR, 'custom-2', 'format.js'), `window.storyFormat(${JSON.stringify(format)});`);
    return { formatId: 'custom-2', formatPaths: [TMP_DIR], useTweegoPath: false, noRemote: true };
  }

  /** Writes a Twine 1 format whose header is `header` and returns compile options for it. */
  function twine1Format(header: string) {
    mkdirSync(join(TMP_DIR, 'custom-1'), { recursive: true });
    writeFileSync(join(TMP_DIR, 'custom-1', 'header.html'), header);
    return { formatId: 'custom-1', formatPaths: [TMP_DIR], useTweegoPath: false, noRemote: true };
  }

  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('keeps a title holding {{STORY_DATA}} and passage text holding {{STORY_NAME}} literal', async () => {
    const result = await compile({ ...html, sources: [story('{{STORY_DATA}}', 'Hi {{STORY_NAME}} {{STORY_DATA}}')] });

    expect(result.diagnostics).toEqual([]);
    expect(result.output).toMatch(/^<html><head><title>\{\{STORY_DATA\}\}<\/title><\/head><body><!-- UUID:/);
    expect(result.output.match(/<tw-storydata/g)).toHaveLength(1);
    const { story: decompiled } = decompileHTML(result.output);
    expect(decompiled.name).toBe('{{STORY_DATA}}');
    expect(decompiled.passages.map((p) => [p.name, p.text])).toEqual([
      ['StoryData', expect.any(String)],
      ['Start', 'Hi {{STORY_NAME}} {{STORY_DATA}}'],
    ]);
  });

  it('inserts replacement patterns in the title literally', async () => {
    const title = "A $& B $' C $` D $$ E";
    const result = await compile({ ...html, sources: [story(title, 'Hello')] });

    expect(result.output).toContain('<title>A $&amp; B $&#39; C $` D $$ E</title>');
    expect(decompileHTML(result.output).story.name).toBe(title);
  });

  it('fills every {{STORY_NAME}} but only the first {{STORY_DATA}}, as Tweego does', async () => {
    const options = twine2Format(
      '<title>{{STORY_NAME}}</title><h1>{{STORY_NAME}}</h1>{{STORY_DATA}}<p>{{STORY_DATA}}</p>',
    );
    const result = await compile({ ...options, sources: [story('Name', 'Hello')] });

    expect(result.output).toMatch(
      /^<title>Name<\/title><h1>Name<\/h1><!-- UUID:.*<\/tw-storydata><p>\{\{STORY_DATA\}\}<\/p>$/,
    );
  });

  it('keeps a Twine 1 start passage named like a placeholder from taking the story data', async () => {
    const options = twine1Format(
      '<html><head><script>var start="START_AT", size="STORY_SIZE";</script></head>' +
        '<body><div id="storeArea">"STORY"</div></body></html>',
    );
    const result = await compile({
      ...options,
      startPassage: 'STORY',
      sources: [{ filename: 'story.tw', content: ':: StoryTitle\nT\n\n:: STORY\nhi\n' }],
    });

    expect(result.output).toContain('<script>var start="STORY", size="2";</script>');
    expect(result.output).toMatch(
      /<div id="storeArea"><div tiddler="StoryTitle".*<div tiddler="STORY"[^>]*>hi<\/div><\/div>/,
    );
  });

  it('keeps a Twine 1 format without "STORY" a pre-1.4 format when the start passage is named STORY', async () => {
    const options = twine1Format('<html><body><script>var start="START_AT";</script><div id="storeArea">');
    const result = await compile({
      ...options,
      startPassage: 'STORY',
      sources: [{ filename: 'story.tw', content: ':: StoryTitle\nT\n\n:: STORY\nhi\n' }],
    });

    expect(result.output).toMatch(
      /^<html><body><script>var start="STORY";<\/script><!-- UUID:\/\/[^ ]+\/\/ --><div id="storeArea"><div tiddler=/,
    );
    expect(result.output).toMatch(/hi<\/div><\/div>\n<\/body>\n<\/html>\n$/);
  });

  for (const start of ['</script>x', '</SCRIPT >x', '<!--<script>x', '"\'\\\n\u2028</head>']) {
    it(`keeps the script element whole around a Twine 1 start passage named ${JSON.stringify(start)}`, async () => {
      const options = twine1Format(
        '<html><head><script>var start="START_AT";</script><script>var other = 1;</script></head>' +
          '<body><div id="storeArea">"STORY"</div></body></html>',
      );
      const result = await compile({
        ...options,
        startPassage: start,
        sources: [{ filename: 'story.tw', content: ':: StoryTitle\nT\n\n:: Start\nhi\n' }],
      });

      const scripts = scriptElements(result.output);
      expect(scripts).toHaveLength(2);
      // With no `<` in the inserted literal, no HTML tokenizer state can end or extend the element early.
      expect(scripts[0]).toMatch(/^var start="[^<]*";$/);
      expect(new Function(`${scripts[0] ?? ''}; return start;`)()).toBe(start);
      expect(scripts[1]).toBe('var other = 1;');
    });
  }
});

/** The text of each script element in `html`, read as an HTML parser reads it. */
function scriptElements(html: string): string[] {
  const texts: string[] = [];
  let current: string | undefined;
  const parser = new Parser({
    onopentag: (name) => {
      if (name === 'script') current = '';
    },
    ontext: (text) => {
      if (current !== undefined) current += text;
    },
    onclosetag: (name) => {
      if (name === 'script' && current !== undefined) texts.push(current);
      current = undefined;
    },
  });
  parser.write(html);
  parser.end();
  return texts;
}

describe('module and head file injection', () => {
  const TMP_DIR = join(__dirname, '__tmp_head_injection__');
  const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
  const STORY = `:: StoryTitle\nHead\n\n:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start\nHello\n`;
  const META = '<meta name="review" content="injected">';
  const MODULE = '<style id="style-module-mod" type="text/css">h1 { color: red; }</style>';

  function twine2Format(source: string) {
    mkdirSync(join(TMP_DIR, 'formats', 'custom-2'), { recursive: true });
    const format = { name: 'Custom', version: '1.0.0', source };
    writeFileSync(join(TMP_DIR, 'formats', 'custom-2', 'format.js'), `window.storyFormat(${JSON.stringify(format)});`);
    return { formatId: 'custom-2', formatPaths: [join(TMP_DIR, 'formats')], useTweegoPath: false, noRemote: true };
  }

  function twine1Format(header: string) {
    mkdirSync(join(TMP_DIR, 'formats', 'custom-1'), { recursive: true });
    writeFileSync(join(TMP_DIR, 'formats', 'custom-1', 'header.html'), header);
    return { formatId: 'custom-1', formatPaths: [join(TMP_DIR, 'formats')], useTweegoPath: false, noRemote: true };
  }

  function headOptions() {
    writeFileSync(join(TMP_DIR, 'mod.css'), 'h1 { color: red; }');
    writeFileSync(join(TMP_DIR, 'head.html'), META);
    return { modules: [join(TMP_DIR, 'mod.css')], headFile: join(TMP_DIR, 'head.html') };
  }

  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  const CLOSING_TAGS: readonly (readonly [string, string])[] = [
    ['lowercase', '</head>'],
    ['uppercase', '</HEAD>'],
    ['mixed-case', '</Head>'],
    ['space before >', '</head >'],
    ['newline before >', '</head\n>'],
    ['mixed case and whitespace', '</hEaD\t >'],
  ];

  for (const [label, close] of CLOSING_TAGS) {
    it(`injects modules and the head file before a ${label} closing head tag in a Twine 2 template`, async () => {
      const options = twine2Format(
        `<html><head><title>{{STORY_NAME}}</title>${close}<body>{{STORY_DATA}}</body></html>`,
      );
      const result = await compile({
        ...options,
        ...headOptions(),
        sources: [{ filename: 'story.tw', content: STORY }],
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.output).toContain(`<html><head><title>Head</title>${MODULE}\n${META}\n${close}<body><!-- UUID:`);
      expect(decompileHTML(result.output).story.passages.map((p) => p.name)).toEqual(['StoryData', 'Start']);
    });

    it(`injects modules and the head file before a ${label} closing head tag in a Twine 1 header`, async () => {
      const options = twine1Format(
        `<html><head><title>T</title>${close}<body><div id="storeArea">"STORY"</div></body></html>`,
      );
      const result = await compile({
        ...options,
        ...headOptions(),
        sources: [{ filename: 'story.tw', content: STORY }],
      });

      expect(result.output).toContain(`<title>T</title>${MODULE}\n${META}\n${close}<body><!-- UUID:`);
    });
  }

  it('injects only before the first closing head tag', async () => {
    const options = twine2Format(
      '<html><head><title>{{STORY_NAME}}</title></HEAD><body><template></head></template>{{STORY_DATA}}</body></html>',
    );
    const result = await compile({ ...options, ...headOptions(), sources: [{ filename: 'story.tw', content: STORY }] });

    expect(result.output.split(META)).toHaveLength(2);
    expect(result.output).toContain(`${META}\n</HEAD><body><template></head></template>`);
  });

  it('does not inject at a closing head tag inside the story data', async () => {
    const options = twine2Format('<html><head><title>{{STORY_NAME}}</title><body>{{STORY_DATA}}</body></html>');
    const script = 'window.tag = "</head>";';
    const result = await compile({
      ...options,
      ...headOptions(),
      sources: [
        { filename: 'story.tw', content: STORY },
        { filename: 'tag.tw', content: `:: Code [script]\n${script}\n` },
      ],
    });

    // The template has no closing head tag, so the content goes before its body start tag instead.
    expect(result.output.split(META)).toHaveLength(2);
    expect(result.output).toContain(`<title>Head</title>${MODULE}\n${META}\n<body><!-- UUID:`);
    const { story } = decompileHTML(result.output);
    expect(story.passages.find((p) => p.tags.includes('script'))?.text).toBe(script);
  });

  const NO_CLOSING_HEAD = 'has no closing head tag; the modules and head file were injected before its body start tag.';
  const NOWHERE = 'has no closing head tag and no body start tag; the modules and head file were not injected.';

  for (const body of ['<body>', '<BODY class="x">', '<Body\n>', '<body/>']) {
    it(`injects before a ${JSON.stringify(body)} start tag when a Twine 2 template has no closing head tag`, async () => {
      const options = twine2Format(`<html><head><title>{{STORY_NAME}}</title>${body}{{STORY_DATA}}</body></html>`);
      const result = await compile({
        ...options,
        ...headOptions(),
        sources: [{ filename: 'story.tw', content: STORY }],
      });

      expect(result.output).toContain(`<title>Head</title>${MODULE}\n${META}\n${body}<!-- UUID:`);
      expect(result.diagnostics).toEqual([
        { level: 'warning', message: `Story format "Custom" 1.0.0 ${NO_CLOSING_HEAD}` },
      ]);
    });
  }

  it('injects before the body start tag when a Twine 1.4 header has no closing head tag', async () => {
    const options = twine1Format('<html><title>T</title><body><div id="storeArea">"STORY"</div></body></html>');
    const result = await compile({ ...options, ...headOptions(), sources: [{ filename: 'story.tw', content: STORY }] });

    expect(result.output).toContain(`<title>T</title>${MODULE}\n${META}\n<body><!-- UUID:`);
    expect(result.diagnostics).toEqual([{ level: 'warning', message: `Story format "custom-1" ${NO_CLOSING_HEAD}` }]);
  });

  it('injects before the body start tag when a pre-1.4 Twine 1 header has no closing head tag', async () => {
    const options = twine1Format('<html><title>T</title><body><div id="storeArea">');
    const result = await compile({ ...options, ...headOptions(), sources: [{ filename: 'story.tw', content: STORY }] });

    expect(result.output.startsWith(`<html><title>T</title>${MODULE}\n${META}\n<body><!--`)).toBe(true);
    expect(result.output).toMatch(/<\/div><\/div>\n<\/body>\n<\/html>\n$/);
    expect(result.diagnostics).toEqual([{ level: 'warning', message: `Story format "custom-1" ${NO_CLOSING_HEAD}` }]);
  });

  it('looks for the body start tag in the footer of a pre-1.4 Twine 1 format too', async () => {
    const options = twine1Format('<div id="storeArea">');
    writeFileSync(join(TMP_DIR, 'formats', 'custom-1', 'footer.html'), '</div><body></body>');
    const result = await compile({ ...options, ...headOptions(), sources: [{ filename: 'story.tw', content: STORY }] });

    expect(result.output.endsWith(`</div></div>${MODULE}\n${META}\n<body></body>`)).toBe(true);
    expect(result.diagnostics).toEqual([{ level: 'warning', message: `Story format "custom-1" ${NO_CLOSING_HEAD}` }]);
  });

  it('warns and injects nothing when a Twine 2 template has neither a closing head tag nor a body start tag', async () => {
    const options = twine2Format('<title>{{STORY_NAME}}</title>{{STORY_DATA}}');
    const script = 'window.tags = "</head><body>";';
    const sources = [
      { filename: 'story.tw', content: STORY },
      { filename: 'tag.tw', content: `:: Code [script]\n${script}\n` },
    ];
    const result = await compile({ ...options, ...headOptions(), sources });
    const plain = await compile({ ...options, sources });

    expect(result.output).toBe(plain.output);
    expect(result.diagnostics).toEqual([{ level: 'warning', message: `Story format "Custom" 1.0.0 ${NOWHERE}` }]);
  });

  it('warns and injects nothing when a Twine 1 header has neither a closing head tag nor a body start tag', async () => {
    const options = twine1Format('<div id="storeArea">"STORY"</div>');
    const result = await compile({ ...options, ...headOptions(), sources: [{ filename: 'story.tw', content: STORY }] });

    expect(result.output).not.toContain(META);
    expect(result.output).not.toContain(MODULE);
    expect(result.diagnostics).toEqual([{ level: 'warning', message: `Story format "custom-1" ${NOWHERE}` }]);
  });

  it('reports nothing for a template without a closing head tag when there is nothing to inject', async () => {
    const twine2 = await compile({
      ...twine2Format('<title>{{STORY_NAME}}</title>{{STORY_DATA}}'),
      sources: [{ filename: 'story.tw', content: STORY }],
    });
    const twine1 = await compile({
      ...twine1Format('<div id="storeArea">"STORY"</div>'),
      sources: [{ filename: 'story.tw', content: STORY }],
    });

    expect(twine2.diagnostics).toEqual([]);
    expect(twine1.diagnostics).toEqual([]);
  });

  it('does not fill placeholders in the injected module and head file content', async () => {
    const options = twine2Format('<html><head><title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>');
    writeFileSync(join(TMP_DIR, 'mod.js'), 'window.placeholders = ["{{STORY_DATA}}", "{{STORY_NAME}}"];');
    writeFileSync(join(TMP_DIR, 'head.html'), '<meta name="{{STORY_NAME}}" content="{{STORY_DATA}}">');
    const result = await compile({
      ...options,
      modules: [join(TMP_DIR, 'mod.js')],
      headFile: join(TMP_DIR, 'head.html'),
      sources: [{ filename: 'story.tw', content: STORY }],
    });

    expect(result.output).toContain('window.placeholders = ["{{STORY_DATA}}", "{{STORY_NAME}}"];</script>');
    expect(result.output).toContain('<meta name="{{STORY_NAME}}" content="{{STORY_DATA}}">\n</head><body><!-- UUID:');
    expect(decompileHTML(result.output).story.passages.map((p) => p.name)).toEqual(['StoryData', 'Start']);
  });

  it('injects at the template tag, not at a Twine 1 start passage named like a closing head tag', async () => {
    const options = twine1Format(
      '<html><head><script>var start="START_AT";</script></head><body><div id="storeArea">"STORY"</div></body></html>',
    );
    const result = await compile({
      ...options,
      ...headOptions(),
      startPassage: '</head>',
      sources: [{ filename: 'story.tw', content: ':: StoryTitle\nT\n\n:: </head>\nhi\n' }],
    });

    expect(result.output).toContain(`<script>var start="\\x3C/head>";</script>${MODULE}\n${META}\n</head><body>`);
  });
});

describe('compile with sources that are not valid UTF-8', () => {
  const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
  const html = { formatId: 'test-format-1', formatPaths: [FORMAT_DIR], useTweegoPath: false, noRemote: true };
  let dir: string;

  /** `text` encoded as Windows-1252, for text whose characters are all in Latin-1. */
  const windows1252 = (text: string): Buffer => Buffer.from(text, 'latin1');
  const story = (text: string): string =>
    `:: StoryData\n{"ifid":"${IFID}"}\n\n:: StoryTitle\nCafé\n\n:: Start\n${text}\n`;
  const fallbackWarning = (file: string): Diagnostic => ({
    level: 'warning',
    message: `read ${file}: Invalid UTF-8; assuming charset is windows-1252.`,
    file,
  });
  /** A source or module path as the build lists it: relative to the working directory. */
  const asListed = (file: string): string => relative(process.cwd(), file);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-encoding-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads Windows-1252 Twee and CSS files as Windows-1252, as Tweego does, and warns for each', async () => {
    const tw = join(dir, 'story.tw');
    const css = join(dir, 'style.css');
    writeFileSync(tw, windows1252(story('café')));
    writeFileSync(css, windows1252('/* café */'));

    const result = await compile({ sources: [tw, css], outputMode: 'twee3' });

    expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('café');
    expect(result.story.passages.find((p) => p.name === 'style.css')?.text).toBe('/* café */');
    expect(result.diagnostics).toEqual([fallbackWarning(asListed(tw)), fallbackWarning(asListed(css))]);
  });

  it('reports nothing for valid UTF-8 sources', async () => {
    const tw = join(dir, 'story.tw');
    const css = join(dir, 'style.css');
    writeFileSync(tw, story('café €'));
    writeFileSync(css, '/* café € */');

    const result = await compile({ sources: [tw, css], outputMode: 'twee3' });

    expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('café €');
    expect(result.diagnostics).toEqual([]);
  });

  it('replays the warning from the cache in an incremental build', async () => {
    const js = join(dir, 'script.js');
    writeFileSync(join(dir, 'story.tw'), story('Hi'));
    writeFileSync(js, windows1252('// café'));
    const cache = new Map<string, FileCacheEntry>();
    const options = { sources: [dir], outputMode: 'twee3' as const };

    const first = await compileIncremental(options, cache);
    const second = await compileIncremental(options, cache);

    expect(first.diagnostics).toEqual([fallbackWarning(asListed(js))]);
    expect(second.diagnostics).toEqual([fallbackWarning(asListed(js))]);
    expect(second.story.passages.find((p) => p.name === 'script.js')?.text).toBe('// café');
  });

  it('decodes an in-memory Buffer source the same way', async () => {
    const result = await compile({
      sources: [{ filename: 'story.tw', content: windows1252(story('café')) }],
      outputMode: 'twee3',
    });

    expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('café');
    expect(result.diagnostics).toEqual([fallbackWarning('story.tw')]);
  });

  it('decodes Windows-1252 modules and head files, and warns for each', async () => {
    const module = join(dir, 'module.js');
    const head = join(dir, 'head.html');
    writeFileSync(module, windows1252('window.word = "café";'));
    writeFileSync(head, windows1252('<meta name="x" content="café">'));

    const result = await compile({
      ...html,
      sources: [{ filename: 'story.tw', content: story('Hi') }],
      modules: [module],
      headFile: head,
    });

    expect(result.output).toContain('window.word = "café";');
    expect(result.output).toContain('<meta name="x" content="café">');
    expect(result.diagnostics).toEqual([fallbackWarning(asListed(module)), fallbackWarning(head)]);
  });

  it('decodes a Windows-1252 Twine 2 story format and warns', async () => {
    const formatDir = join(dir, 'formats', 'legacy-1');
    const formatFile = join(formatDir, 'format.js');
    mkdirSync(formatDir, { recursive: true });
    writeFileSync(
      formatFile,
      windows1252(
        'window.storyFormat({"name":"Legacy","version":"1.0.0","source":"<html><head></head><body>café {{STORY_DATA}}</body></html>"});',
      ),
    );

    const result = await compile({
      sources: [{ filename: 'story.tw', content: story('Hi') }],
      formatId: 'legacy-1',
      formatPaths: [join(dir, 'formats')],
      useTweegoPath: false,
      noRemote: true,
    });

    expect(result.output).toMatch(/<body>café <!-- UUID:\/\/[^>]*--><tw-storydata /);
    expect(result.diagnostics).toEqual([fallbackWarning(formatFile)]);
  });

  it('decodes Windows-1252 Twine 1 format components and warns', async () => {
    const formatDir = join(dir, 'formats', 'legacy-tw1');
    const engine = join(dir, 'formats', 'engine.js');
    mkdirSync(formatDir, { recursive: true });
    writeFileSync(
      join(formatDir, 'header.html'),
      '<html><head></head><body><script>"ENGINE"</script>"STORY"</body></html>',
    );
    writeFileSync(engine, windows1252('var word = "café";'));

    const result = await compile({
      sources: [{ filename: 'story.tw', content: story('Hi') }],
      formatId: 'legacy-tw1',
      formatPaths: [join(dir, 'formats')],
      useTweegoPath: false,
      noRemote: true,
    });

    expect(result.output).toContain('<script>var word = "café";</script>');
    expect(result.diagnostics).toEqual([fallbackWarning(engine)]);
  });
});

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const STORY_DATA_TW = `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start\nHello\n`;

function twine2HTML(opts: {
  readonly name: string;
  readonly ifid?: string;
  readonly script?: string;
  readonly style?: string;
  readonly passage?: string;
}): string {
  const ifid = opts.ifid === undefined ? `ifid="${IFID}"` : opts.ifid;
  return (
    `<tw-storydata name="${opts.name}" startnode="1" ${ifid} format="Test Format" format-version="1.0.0">` +
    (opts.style === undefined ? '' : `<style role="stylesheet" type="text/twine-css">${opts.style}</style>`) +
    (opts.script === undefined ? '' : `<script role="script" type="text/twine-javascript">${opts.script}</script>`) +
    `<tw-passagedata pid="1" name="${opts.passage ?? 'Start'}" tags="" position="0,0" size="100,100">Text</tw-passagedata>` +
    `</tw-storydata>`
  );
}

function replacements(diagnostics: readonly { readonly message: string }[]): string[] {
  return diagnostics.map((d) => d.message).filter((m) => m.startsWith('Replacing existing passage'));
}

describe('passage names generated for loaded files are unique across the story', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-generated-names-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, content: string | Buffer): string {
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  function named(passages: readonly { name: string; tags: string[]; text: string }[], tag: string): string[][] {
    return passages.filter((p) => p.tags.includes(tag)).map((p) => [p.name, p.text]);
  }

  it('keeps the story script and stylesheet of every imported Twine 2 HTML file', async () => {
    const part1 = write('part1.html', twine2HTML({ name: 'One', script: 'window.one = 1;', style: '.one {}' }));
    const part2 = write(
      'part2.html',
      twine2HTML({ name: 'Two', script: 'window.two = 2;', style: '.two {}', passage: 'Chapter 2' }),
    );
    const result = await compile({ sources: [part1, part2], outputMode: 'twine2-archive' });

    expect(replacements(result.diagnostics)).toEqual([
      'Replacing existing passage "StoryTitle" with duplicate.',
      'Replacing existing passage "StoryData" with duplicate.',
    ]);
    expect(named(result.story.passages, 'script')).toEqual([
      ['Story JavaScript', 'window.one = 1;'],
      ['Story JavaScript 2', 'window.two = 2;'],
    ]);
    expect(named(result.story.passages, 'stylesheet')).toEqual([
      ['Story Stylesheet', '.one {}'],
      ['Story Stylesheet 2', '.two {}'],
    ]);
    expect(result.output).toContain('/* twine-user-script #2: "Story JavaScript 2" */\nwindow.two = 2;');
    expect(result.output).toContain('/* twine-user-stylesheet #2: "Story Stylesheet 2" */\n.two {}');
  });

  for (const order of ['before', 'after'] as const) {
    it(`keeps a real "Story JavaScript" passage loaded ${order} an imported story script`, async () => {
      const html = write('story.html', twine2HTML({ name: 'Imported', script: 'window.code = 1;' }));
      const twee = write('real.tw', ':: Story JavaScript\nA real passage.\n');
      const result = await compile({
        sources: order === 'before' ? [twee, html] : [html, twee],
        outputMode: 'twine2-archive',
      });

      expect(result.diagnostics).toEqual([]);
      const real = ['Story JavaScript', [], 'A real passage.'];
      const code = ['Story JavaScript 2', ['script'], 'window.code = 1;'];
      // The story script keeps its place in the passage list when a later real passage takes its name.
      expect(
        result.story.passages.filter((p) => p.name.startsWith('Story JavaScript')).map((p) => [p.name, p.tags, p.text]),
      ).toEqual(order === 'before' ? [real, code] : [code, real]);
      expect(result.output).toContain('window.code = 1;');
    });
  }

  it('keeps stylesheets and scripts with the same file name in different folders', async () => {
    const files = [
      write('story.tw', STORY_DATA_TW),
      write('a/style.css', '.a {}'),
      write('b/style.css', '.b {}'),
      write('a/main.js', 'window.a = 1;'),
      write('b/main.js', 'window.b = 2;'),
    ];
    const result = await compile({ sources: files, outputMode: 'twine2-archive' });

    expect(result.diagnostics).toEqual([]);
    expect(named(result.story.passages, 'stylesheet')).toEqual([
      ['style.css', '.a {}'],
      ['style.css 2', '.b {}'],
    ]);
    expect(named(result.story.passages, 'script')).toEqual([
      ['main.js', 'window.a = 1;'],
      ['main.js 2', 'window.b = 2;'],
    ]);
    expect(result.output).toContain('/* twine-user-stylesheet #2: "style.css 2" */\n.b {}');
    expect(result.output).toContain('/* twine-user-script #2: "main.js 2" */\nwindow.b = 2;');
  });

  it('names in-memory stylesheets and scripts the same way', async () => {
    const result = await compile({
      sources: [
        { filename: 'story.tw', content: STORY_DATA_TW },
        { filename: 'a/style.css', content: '.a {}' },
        { filename: 'b/style.css', content: '.b {}' },
      ],
      outputMode: 'twine2-archive',
    });

    expect(result.diagnostics).toEqual([]);
    expect(named(result.story.passages, 'stylesheet')).toEqual([
      ['style.css', '.a {}'],
      ['style.css 2', '.b {}'],
    ]);
  });

  for (const order of ['before', 'after'] as const) {
    it(`does not let a media file named StoryTitle loaded ${order} the StoryTitle passage take its place`, async () => {
      const title = write('title.tw', `:: StoryTitle\nMy Story\n\n${STORY_DATA_TW}`);
      const image = write('images/StoryTitle.png', 'PNG');
      const result = await compile({
        sources: order === 'before' ? [image, title] : [title, image],
        outputMode: 'twee3',
      });

      expect(result.diagnostics).toEqual([
        {
          level: 'warning',
          message: `Passage "StoryTitle" from "${relative(process.cwd(), image)}" renamed to "StoryTitle 2"; "StoryTitle" is a compiler special passage name.`,
        },
      ]);
      expect(result.story.name).toBe('My Story');
      expect(result.story.passages.find((p) => p.name === 'StoryTitle')?.text).toBe('My Story');
      expect(result.story.passages.find((p) => p.name === 'StoryTitle 2')).toEqual({
        name: 'StoryTitle 2',
        tags: ['Twine.image'],
        text: 'data:image/png;base64,UE5H',
      });
    });
  }

  for (const order of ['before', 'after'] as const) {
    it(`keeps a passage and a media file with its name loaded ${order} it`, async () => {
      const twee = write('story.tw', `${STORY_DATA_TW}\n:: forest\nA real passage.\n`);
      const image = write('img/forest.png', 'PNG');
      const result = await compile({
        sources: order === 'before' ? [image, twee] : [twee, image],
        outputMode: 'twee3',
      });

      expect(result.diagnostics).toEqual([
        {
          level: 'warning',
          message: `Passage "forest" from "${relative(process.cwd(), image)}" renamed to "forest 2"; another passage has the name "forest".`,
        },
      ]);
      expect(result.story.passages.find((p) => p.name === 'forest')?.text).toBe('A real passage.');
      expect(result.story.passages.find((p) => p.name === 'forest 2')?.tags).toEqual(['Twine.image']);
    });
  }

  it('keeps two media files with the same name in different folders', async () => {
    const files = [write('story.tw', STORY_DATA_TW), write('a/bg.png', 'A'), write('b/bg.png', 'B')];
    const result = await compile({ sources: files, outputMode: 'twee3' });

    expect(result.diagnostics).toEqual([
      {
        level: 'warning',
        message: `Passage "bg" from "${relative(process.cwd(), files[2]!)}" renamed to "bg 2"; another passage has the name "bg".`,
      },
    ]);
    expect(named(result.story.passages, 'Twine.image')).toEqual([
      ['bg', 'data:image/png;base64,QQ=='],
      ['bg 2', 'data:image/png;base64,Qg=='],
    ]);
  });

  it('leaves the names alone when nothing collides', async () => {
    const files = [
      write('story.tw', `:: StoryTitle\nNames\n\n${STORY_DATA_TW}`),
      write('style.css', '.a {}'),
      write('main.js', 'window.a = 1;'),
      write('photo.png', 'PNG'),
      write('imported.html', twine2HTML({ name: 'Names', script: 'window.b = 2;', style: '.b {}', passage: 'Other' })),
    ];
    const result = await compile({ sources: files, outputMode: 'twee3' });

    expect(result.story.passages.map((p) => p.name)).toEqual([
      'StoryTitle',
      'StoryData',
      'Start',
      'style.css',
      'main.js',
      'photo',
      'Story Stylesheet',
      'Story JavaScript',
      'Other',
    ]);
  });
});

describe('StoryData from several sources', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-storydata-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('takes the story metadata from the last StoryData passage alone', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'a.tw',
          content:
            `:: StoryData\n{"ifid":"${IFID}","options":["debug"],"start":"Old","tag-colors":{"old":"red"}}\n` +
            ':: Start\nHi\n:: Old\nOld start',
        },
        { filename: 'b.tw', content: `:: StoryData\n{"ifid":"${IFID}"}` },
      ],
      outputMode: 'twee3',
    });

    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'Replacing existing passage "StoryData" with duplicate.',
    ]);
    expect(JSON.parse(result.story.passages.find((p) => p.name === 'StoryData')!.text)).toEqual({ ifid: IFID });
    expect(result.story.twine2.options.size).toBe(0);
    expect(result.story.twine2.start).toBe('');
    expect(result.story.twine2.tagColors.size).toBe(0);
  });

  it('takes the story metadata of an imported Twine 2 HTML file that follows a Twee StoryData', async () => {
    const twee = join(dir, 'a.tw');
    writeFileSync(
      twee,
      `:: StoryData\n{"ifid":"0B3F1A2C-1D4E-4F5A-8B6C-7D8E9F0A1B2C","format":"SugarCube","options":["debug"],"start":"Old","tag-colors":{"old":"red"}}\n\n:: Old\nOld start\n`,
    );
    const html = join(dir, 'b.html');
    writeFileSync(html, twine2HTML({ name: 'Imported' }));
    const result = await compile({ sources: [twee, html], outputMode: 'twee3' });

    expect(result.story.ifid).toBe(IFID);
    expect(result.story.twine2.format).toBe('Test Format');
    expect(result.story.twine2.formatVersion).toBe('1.0.0');
    expect(result.story.twine2.options.size).toBe(0);
    expect(result.story.twine2.start).toBe('Start');
    expect(result.story.twine2.tagColors.size).toBe(0);
  });
});

describe('compiling a Twine 2 HTML file with a bad tw-storydata ifid', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-html-ifid-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function compileHTML(ifid: string) {
    const file = join(dir, 'story.html');
    writeFileSync(file, twine2HTML({ name: 'T', ifid }));
    return compile({ sources: [file], outputMode: 'twee3' });
  }

  it('reports an invalid ifid once', async () => {
    const result = await compileHTML('ifid="not-a-uuid"');
    expect(result.diagnostics).toEqual([{ level: 'error', message: 'Cannot validate IFID; invalid IFID length: 10.' }]);
  });

  it('reports a missing ifid once', async () => {
    const result = await compileHTML('');
    expect(result.diagnostics).toEqual([
      { level: 'error', message: expect.stringMatching(/^Story IFID not found\. Add an IFID to your story/) },
    ]);
  });
});

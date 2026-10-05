import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, relative } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { compile, compileToFile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';

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

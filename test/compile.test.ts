import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { compile, compileIncremental, compileToFile } from '../src/compiler.js';
import type { Diagnostic, FileCacheEntry } from '../src/types.js';
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
});

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

    expect(result.output).not.toContain(META);
    const { story } = decompileHTML(result.output);
    expect(story.passages.find((p) => p.tags.includes('script'))?.text).toBe(script);
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

    expect(result.output).toContain(`<script>var start="</head>";</script>${MODULE}\n${META}\n</head><body>`);
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

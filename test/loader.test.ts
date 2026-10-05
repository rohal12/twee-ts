import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Story, Diagnostic, FileCacheEntry } from '../src/types.js';
import { createStory } from '../src/story.js';
import { loadSources, loadInlineSources, loadSourcesCached } from '../src/loader.js';

const TMP_DIR = join(__dirname, '__tmp_loader__');

function freshStory(): Story {
  return createStory();
}

describe('loadSources', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('loads .tw files as passages', () => {
    const file = join(TMP_DIR, 'story.tw');
    writeFileSync(file, ':: Start\nHello world');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], { trim: true }, diag, new Set());
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('loads .twee2 files with twee2 compat', () => {
    const file = join(TMP_DIR, 'story.twee2');
    writeFileSync(file, ':: Start\nHello');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], { trim: true }, diag, new Set());
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('loads .css files as stylesheet passages', () => {
    const file = join(TMP_DIR, 'style.css');
    writeFileSync(file, 'body { color: red; }');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('stylesheet'))).toBe(true);
  });

  it('loads .js files as script passages', () => {
    const file = join(TMP_DIR, 'script.js');
    writeFileSync(file, 'console.log("hi")');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('script'))).toBe(true);
  });

  it('loads image files as Twine.image passages', () => {
    const file = join(TMP_DIR, 'photo.png');
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    const passage = story.passages.find((p) => p.tags.includes('Twine.image'));
    expect(passage).toBeDefined();
    expect(passage!.text).toContain('data:image/png;base64,');
  });

  it('loads audio files as Twine.audio passages', () => {
    const file = join(TMP_DIR, 'sound.mp3');
    writeFileSync(file, Buffer.from([0xff, 0xfb]));
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('Twine.audio'))).toBe(true);
  });

  it('loads video files as Twine.video passages', () => {
    const file = join(TMP_DIR, 'clip.mp4');
    writeFileSync(file, Buffer.from([0x00, 0x00]));
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('Twine.video'))).toBe(true);
  });

  it('loads vtt files as Twine.vtt passages', () => {
    const file = join(TMP_DIR, 'subs.vtt');
    writeFileSync(file, 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('Twine.vtt'))).toBe(true);
  });

  it('loads font files as stylesheet passages with @font-face', () => {
    const file = join(TMP_DIR, 'myfont.ttf');
    writeFileSync(file, Buffer.from([0x00, 0x01, 0x00, 0x00]));
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    const passage = story.passages.find((p) => p.name === 'myfont.ttf');
    expect(passage).toBeDefined();
    expect(passage!.text).toContain('@font-face');
    expect(passage!.text).toContain('font-family: "myfont"');
  });

  // Windows file names cannot hold `"`, `\` or a line break.
  it.skipIf(process.platform === 'win32')('writes the font family of a font file as a valid CSS string', () => {
    const file = join(TMP_DIR, 'My "Fancy" \\Font\nTwo.woff');
    writeFileSync(file, 'FONT');
    const story = freshStory();
    loadSources(story, [file], {}, [], new Set());
    expect(story.passages.map((p) => p.text)).toEqual([
      '@font-face {\n\tfont-family: "My \\"Fancy\\" \\\\Font\\a Two";\n\tsrc: url("data:font/woff;base64,Rk9OVA==") format("woff");\n}',
    ]);
  });

  it('warns on duplicate files', () => {
    const file = join(TMP_DIR, 'dup.tw');
    writeFileSync(file, ':: Start\nHello');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    const processed = new Set<string>();
    loadSources(story, [file, file], { trim: true }, diag, processed);
    expect(diag.some((d) => d.message.includes('Skipping duplicate'))).toBe(true);
  });

  it('skips unknown file types', () => {
    const file = join(TMP_DIR, 'data.json');
    writeFileSync(file, '{}');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages).toHaveLength(0);
  });

  it('collects error diagnostics for unreadable files', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [join(TMP_DIR, 'missing.tw')], { trim: true }, diag, new Set());
    expect(diag.some((d) => d.level === 'error')).toBe(true);
  });

  it('prepends StoryTitle if story has a name but no StoryTitle passage', () => {
    const file = join(TMP_DIR, 'named.tw');
    writeFileSync(file, ':: Start\nContent');
    const story = freshStory();
    story.name = 'My Story';
    const diag: Diagnostic[] = [];
    loadSources(story, [file], { trim: true }, diag, new Set());
    expect(story.passages[0].name).toBe('StoryTitle');
    expect(story.passages[0].text).toBe('My Story');
  });
});

describe('loadInlineSources', () => {
  it('parses inline twee content', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(
      story,
      [{ filename: 'inline.tw', content: ':: Start\nHello from inline!' }],
      { trim: true },
      diag,
    );
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('handles Buffer content', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(
      story,
      [{ filename: 'buf.tw', content: Buffer.from(':: Start\nFrom buffer') }],
      { trim: true },
      diag,
    );
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('treats .twee2 inline sources with twee2 compat', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(story, [{ filename: 'old.twee2', content: ':: Start\nTwee2 content' }], { trim: true }, diag);
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('parses inline sources without extension as twee', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(story, [{ filename: 'noext', content: ':: Start\nNo ext' }], { trim: true }, diag);
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('skips string sources (file paths handled externally)', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(story, ['some/path.tw'], { trim: true }, diag);
    expect(story.passages).toHaveLength(0);
  });
});

describe('loadInlineSources: scripts and stylesheets', () => {
  it('loads an in-memory .js source as a script passage', () => {
    const story = freshStory();
    const diagnostics: Diagnostic[] = [];
    loadInlineSources(story, [{ filename: 'app.js', content: 'window.x = 1;' }], {}, diagnostics);
    expect(story.passages).toEqual([{ name: 'app.js', tags: ['script'], text: 'window.x = 1;' }]);
    expect(diagnostics).toEqual([]);
  });

  it('loads an in-memory .css source as a stylesheet passage', () => {
    const story = freshStory();
    const diagnostics: Diagnostic[] = [];
    loadInlineSources(story, [{ filename: 'app.css', content: 'body { color: red; }' }], {}, diagnostics);
    expect(story.passages).toEqual([{ name: 'app.css', tags: ['stylesheet'], text: 'body { color: red; }' }]);
    expect(diagnostics).toEqual([]);
  });

  it('accepts Buffer content for scripts', () => {
    const story = freshStory();
    const diagnostics: Diagnostic[] = [];
    loadInlineSources(
      story,
      [{ filename: 'lib/app.js', content: Buffer.from('let y = 2;', 'utf-8') }],
      {},
      diagnostics,
    );
    expect(story.passages).toEqual([{ name: 'app.js', tags: ['script'], text: 'let y = 2;' }]);
  });

  it('warns about an in-memory source it cannot load from memory', () => {
    const story = freshStory();
    const diagnostics: Diagnostic[] = [];
    loadInlineSources(story, [{ filename: 'pic.png', content: Buffer.from([1, 2, 3]) }], {}, diagnostics);
    expect(story.passages).toEqual([]);
    expect(diagnostics).toEqual([
      { level: 'warning', message: 'load pic.png: in-memory sources of type .png are not supported; skipped.' },
    ]);
  });

  it('puts an in-memory script into the compiled Story JavaScript', async () => {
    const { compile } = await import('../src/compiler.js');
    const result = await compile({
      sources: [
        {
          filename: 'story.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nT\n\n:: Start\nHi\n',
        },
        { filename: 'app.js', content: 'window.inlineMarker = 1;' },
        { filename: 'app.css', content: '.inline-marker { color: red; }' },
      ],
      formatId: 'test-format-1',
      formatPaths: [join(__dirname, 'fixtures', 'storyformats')],
      useTweegoPath: false,
      noRemote: true,
    });
    expect(result.output).toMatch(/id="twine-user-script"[^>]*>[\s\S]*window\.inlineMarker = 1;/);
    expect(result.output).toMatch(/id="twine-user-stylesheet"[^>]*>[\s\S]*\.inline-marker/);
  });
});

describe('loadInlineSources: BOM and line-ending normalization', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  function loadInline(filename: string, content: string | Buffer): { story: Story; diagnostics: Diagnostic[] } {
    const story = freshStory();
    const diagnostics: Diagnostic[] = [];
    loadInlineSources(story, [{ filename, content }], { trim: true }, diagnostics);
    return { story, diagnostics };
  }

  function loadFromDisk(filename: string, content: string | Buffer): { story: Story; diagnostics: Diagnostic[] } {
    const file = join(TMP_DIR, filename);
    writeFileSync(file, content);
    const story = freshStory();
    const diagnostics: Diagnostic[] = [];
    loadSources(story, [file], { trim: true }, diagnostics, new Set());
    return { story, diagnostics };
  }

  /** Passages without source locations, which name the file and so differ between the loaders. */
  function contents(story: Story): unknown[] {
    return story.passages.map(({ name, tags, text, metadata }) => ({ name, tags, text, metadata }));
  }

  it('parses a tagged header followed by CRLF', () => {
    const { story, diagnostics } = loadInline('inline.tw', ':: Start [tag]\r\nHello\r\n');
    expect(diagnostics).toEqual([]);
    expect(story.passages.map((p) => [p.name, p.tags, p.text])).toEqual([['Start', ['tag'], 'Hello']]);
  });

  it('parses a metadata header followed by CRLF', () => {
    const { story, diagnostics } = loadInline('inline.tw', ':: Start [tag] {"position":"10,20"}\r\nHello\r\n');
    expect(diagnostics).toEqual([]);
    expect(story.passages[0]!.metadata).toEqual({ position: '10,20' });
  });

  it('keeps the header after a BOM in the middle of a Twee file and of an inline source', () => {
    // `cat a.tw b.tw > all.tw`, where both files were saved with a UTF-8 BOM.
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const bytes = Buffer.concat([bom, Buffer.from(':: Start\nfirst\n\n'), bom, Buffer.from(':: Second\nsecond\n')]);
    for (const { story, diagnostics } of [loadFromDisk('all.tw', bytes), loadInline('all.tw', bytes)]) {
      expect(diagnostics).toEqual([]);
      expect(story.passages.map((p) => [p.name, p.text])).toEqual([
        ['Start', 'first'],
        ['Second', 'second'],
      ]);
    }
  });

  it('strips a leading BOM from string content', () => {
    const { story, diagnostics } = loadInline('inline.tw', '﻿:: Start\nHello');
    expect(diagnostics).toEqual([]);
    expect(story.passages.map((p) => p.name)).toEqual(['Start']);
  });

  it('strips a leading BOM and CRLF from Buffer content', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(':: Start [tag]\r\nHello\r\n')]);
    const { story, diagnostics } = loadInline('inline.tw', bytes);
    expect(diagnostics).toEqual([]);
    expect(story.passages.map((p) => [p.name, p.text])).toEqual([['Start', 'Hello']]);
  });

  it('normalizes .twee2 inline sources', () => {
    const { story, diagnostics } = loadInline('old.tw2', '﻿:: Start [tag] <10,20>\r\nHello\r\n');
    expect(diagnostics).toEqual([]);
    expect(story.passages[0]!.metadata).toEqual({ position: '10,20' });
  });

  it('normalizes inline stylesheets and scripts', () => {
    const css = loadInline('app.css', '﻿body {\r\n  color: red;\r\n}\r\n');
    expect(css.story.passages[0]!.text).toBe('body {\n  color: red;\n}\n');
    const js = loadInline('app.js', Buffer.from('let a = 1;\rlet b = 2;'));
    expect(js.story.passages[0]!.text).toBe('let a = 1;\nlet b = 2;');
  });

  it.each([
    ['story.tw', '﻿:: Start [a b] {"position":"1,2"}\r\nHello\r\n\r\n:: Next\rThere\r'],
    ['styles.css', '﻿body {\r\n}\r\n'],
    ['app.js', 'one();\r\ntwo();\r'],
  ])('loads %s from memory the same as from disk', (filename, content) => {
    const inline = loadInline(filename, Buffer.from(content));
    const disk = loadFromDisk(filename, content);
    expect(inline.diagnostics).toEqual(disk.diagnostics);
    expect(contents(inline.story)).toEqual(contents(disk.story));
  });
});

describe('loadSources: Twine 2 HTML story name', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  const NAMED_HTML = `<tw-storydata name="Review Story" startnode="1" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" hidden>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">Hello</tw-passagedata>
</tw-storydata>`;

  it('keeps the story name of a Twine 2 HTML file as a StoryTitle passage', () => {
    const file = join(TMP_DIR, 'story.html');
    writeFileSync(file, NAMED_HTML);
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], { trim: true }, diag, new Set());
    expect(diag).toEqual([]);
    expect(story.name).toBe('Review Story');
    expect(story.passages.map((p) => p.name)).toEqual(['StoryTitle', 'StoryData', 'Start']);
    expect(story.passages[0]!.text).toBe('Review Story');
  });

  it('lets a later StoryTitle passage replace the HTML story name, with the usual duplicate warning', () => {
    const html = join(TMP_DIR, 'a.html');
    const twee = join(TMP_DIR, 'b.tw');
    writeFileSync(html, NAMED_HTML);
    writeFileSync(twee, ':: StoryTitle\nOverride');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [html, twee], { trim: true }, diag, new Set());
    expect(story.name).toBe('Override');
    expect(story.passages.filter((p) => p.name === 'StoryTitle').map((p) => p.text)).toEqual(['Override']);
    expect(diag.map((d) => d.message)).toEqual(['Replacing existing passage "StoryTitle" with duplicate.']);
  });

  it('does not add a second StoryTitle when the HTML already has one', () => {
    const file = join(TMP_DIR, 'story.html');
    writeFileSync(
      file,
      NAMED_HTML.replace(
        '</tw-storydata>',
        '<tw-passagedata pid="2" name="StoryTitle" tags="" position="0,0" size="100,100">Passage Title</tw-passagedata>\n</tw-storydata>',
      ),
    );
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], { trim: true }, diag, new Set());
    expect(diag).toEqual([]);
    expect(story.name).toBe('Passage Title');
    expect(story.passages.filter((p) => p.name === 'StoryTitle')).toHaveLength(1);
  });

  it('adds no StoryTitle for an unnamed Twine 2 HTML file', () => {
    const file = join(TMP_DIR, 'story.html');
    writeFileSync(file, NAMED_HTML.replace(' name="Review Story"', ''));
    const story = freshStory();
    loadSources(story, [file], { trim: true }, [], new Set());
    expect(story.name).toBe('');
    expect(story.passages.some((p) => p.name === 'StoryTitle')).toBe(false);
  });
});

describe('loadSourcesCached: generated passage names', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-loader-names-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, content: string): string {
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  it('gives the same names when cached passages are replayed', () => {
    const files = [
      write('img/forest.png', 'PNG'),
      write('a/style.css', '.a {}'),
      write('b/style.css', '.b {}'),
      write('story.tw', ':: forest\nA real passage.\n'),
    ];
    const cache = new Map<string, FileCacheEntry>();
    const build = (): { names: string[]; messages: string[] } => {
      const story = freshStory();
      const diag: Diagnostic[] = [];
      loadSourcesCached(story, files, { trim: true }, diag, new Set(), cache);
      return { names: story.passages.map((p) => p.name), messages: diag.map((d) => d.message) };
    };

    const first = build();
    expect(first.names).toEqual(['forest 2', 'style.css', 'style.css 2', 'forest']);
    expect(first.messages).toHaveLength(1);
    expect(build()).toEqual(first);
    expect(cache.get(files[2]!)?.passages.map((p) => p.name)).toEqual(['style.css']);
  });
});

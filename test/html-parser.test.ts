import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OutputMode } from '../src/types.js';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';
import { parseJsonObject } from './helpers/json.js';

const MINIMAL_TWINE2_HTML = `<tw-storydata name="Test Story" startnode="1" creator="Twine" creator-version="2.0"
  ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" zoom="1"
  format="SugarCube" format-version="2.37.3" options="" tags="" hidden>
<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">body { color: red; }</style>
<script role="script" id="twine-user-script" type="text/twine-javascript">console.log("hi")</script>
<tw-tag name="important" color="red"></tw-tag>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">Hello world</tw-passagedata>
<tw-passagedata pid="2" name="Second" tags="tag1 tag2" position="200,100" size="100,100">Second passage</tw-passagedata>
</tw-storydata>`;

describe('decompileHTML', () => {
  it('parses story metadata from tw-storydata', () => {
    const { story, diagnostics } = decompileHTML(MINIMAL_TWINE2_HTML);
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
    expect(story.name).toBe('Test Story');
    expect(story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(story.twine2.format).toBe('SugarCube');
    expect(story.twine2.formatVersion).toBe('2.37.3');
    expect(story.twine2.zoom).toBe(1);
  });

  it('parses passages from tw-passagedata', () => {
    const { story } = decompileHTML(MINIMAL_TWINE2_HTML);
    const start = story.passages.find((p) => p.name === 'Start');
    expect(start).toBeDefined();
    expect(start!.text).toBe('Hello world');
    expect(start!.metadata?.position).toBe('100,100');
    expect(start!.metadata?.size).toBe('100,100');
  });

  it('parses passage tags', () => {
    const { story } = decompileHTML(MINIMAL_TWINE2_HTML);
    const second = story.passages.find((p) => p.name === 'Second');
    expect(second).toBeDefined();
    expect(second!.tags).toEqual(['tag1', 'tag2']);
  });

  it('resolves start passage from startnode pid', () => {
    const { story } = decompileHTML(MINIMAL_TWINE2_HTML);
    expect(story.twine2.start).toBe('Start');
  });

  it('parses stylesheet from style element', () => {
    const { story } = decompileHTML(MINIMAL_TWINE2_HTML);
    const stylesheet = story.passages.find((p) => p.name === 'Story Stylesheet');
    expect(stylesheet).toBeDefined();
    expect(stylesheet!.tags).toContain('stylesheet');
    expect(stylesheet!.text).toBe('body { color: red; }');
  });

  it('parses script from script element', () => {
    const { story } = decompileHTML(MINIMAL_TWINE2_HTML);
    const script = story.passages.find((p) => p.name === 'Story JavaScript');
    expect(script).toBeDefined();
    expect(script!.tags).toContain('script');
    expect(script!.text).toBe('console.log("hi")');
  });

  it('parses tag colors from tw-tag elements', () => {
    const { story } = decompileHTML(MINIMAL_TWINE2_HTML);
    expect(story.twine2.tagColors.get('important')).toBe('red');
  });

  it('stores a wrapped ifid attribute as the bare uppercase UUID', () => {
    const html = MINIMAL_TWINE2_HTML.replace(
      'ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"',
      'ifid="uuid://d674c58c-defa-4f70-b7a2-27742230c0fc//"',
    );
    const { story } = decompileHTML(html);
    expect(story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(parseJsonObject(story.passages[0]!.text)['ifid']).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });

  it('prepends StoryData passage', () => {
    const { story } = decompileHTML(MINIMAL_TWINE2_HTML);
    expect(story.passages[0]?.name).toBe('StoryData');
    const data = parseJsonObject(story.passages[0]!.text);
    expect(data['ifid']).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(data['format']).toBe('SugarCube');
  });

  it('returns error diagnostic for missing tw-storydata', () => {
    const { diagnostics } = decompileHTML('<html><body>no story here</body></html>');
    expect(diagnostics.some((d) => d.level === 'error' && d.message.includes('story data not found'))).toBe(true);
  });

  it('handles empty stylesheet and script elements', () => {
    const html = `<tw-storydata name="Empty" startnode="1" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" format="SugarCube" format-version="2.37.3" hidden>
<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css"></style>
<script role="script" id="twine-user-script" type="text/twine-javascript"></script>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">Hello</tw-passagedata>
</tw-storydata>`;
    const { story } = decompileHTML(html);
    expect(story.passages.find((p) => p.name === 'Story Stylesheet')).toBeUndefined();
    expect(story.passages.find((p) => p.name === 'Story JavaScript')).toBeUndefined();
  });

  it('decodes HTML entities in passage content', () => {
    const html = `<tw-storydata name="Entities" startnode="1" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" format="SugarCube" format-version="2.37.3" hidden>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;</tw-passagedata>
</tw-storydata>`;
    const { story } = decompileHTML(html);
    const start = story.passages.find((p) => p.name === 'Start');
    expect(start!.text).toBe('<b>bold</b> & "quoted"');
  });

  it('decodes HTML entities in passage names', () => {
    const html = `<tw-storydata name="Entities" startnode="1" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" format="SugarCube" format-version="2.37.3" hidden>
<tw-passagedata pid="1" name="Foo &amp; Bar" tags="" position="100,100" size="100,100">Content</tw-passagedata>
</tw-storydata>`;
    const { story } = decompileHTML(html);
    expect(story.passages.some((p) => p.name === 'Foo & Bar')).toBe(true);
  });

  it('parses options attribute', () => {
    const html = `<tw-storydata name="Opts" startnode="1" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"
      format="SugarCube" format-version="2.37.3" options="debug" hidden>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">Hello</tw-passagedata>
</tw-storydata>`;
    const { story } = decompileHTML(html);
    expect(story.twine2.options.get('debug')).toBe(true);
  });

  it('handles full HTML document wrapping tw-storydata', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>My Story</title></head>
<body>
${MINIMAL_TWINE2_HTML}
</body>
</html>`;
    const { story, diagnostics } = decompileHTML(html);
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
    expect(story.name).toBe('Test Story');
    expect(story.passages.find((p) => p.name === 'Start')).toBeDefined();
  });
});

const MINIMAL_TWINE1_HTML = `<div id="store-area" data-size="3" hidden>
<div tiddler="Start" tags="" created="202301010000" modified="202301010000" modifier="twee" twine-position="100,100">Hello from Twine 1</div>
<div tiddler="Second" tags="tag1 tag2" created="202301010000" modified="202301010000" modifier="twee" twine-position="200,100">Second passage</div>
<div tiddler="StorySettings" tags="" created="202301010000" modified="202301010000" modifier="twee" twine-position="300,100">undo:off</div>
</div>`;

describe('decompileHTML — Twine 1', () => {
  it('parses passages from tiddler divs', () => {
    const { story, diagnostics } = decompileHTML(MINIMAL_TWINE1_HTML);
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
    const start = story.passages.find((p) => p.name === 'Start');
    expect(start).toBeDefined();
    expect(start!.text).toBe('Hello from Twine 1');
  });

  it('parses passage tags', () => {
    const { story } = decompileHTML(MINIMAL_TWINE1_HTML);
    const second = story.passages.find((p) => p.name === 'Second');
    expect(second).toBeDefined();
    expect(second!.tags).toEqual(['tag1', 'tag2']);
  });

  it('parses twine-position as metadata', () => {
    const { story } = decompileHTML(MINIMAL_TWINE1_HTML);
    const start = story.passages.find((p) => p.name === 'Start');
    expect(start!.metadata?.position).toBe('100,100');
  });

  it('unescapes tiddler content', () => {
    const html = `<div id="store-area" hidden>
<div tiddler="Escaped" tags="" twine-position="100,100">Line 1\\nLine 2\\tTabbed\\sBackslash</div>
</div>`;
    const { story } = decompileHTML(html);
    const p = story.passages.find((p) => p.name === 'Escaped');
    expect(p!.text).toBe('Line 1\nLine 2\tTabbed\\Backslash');
  });

  it('handles storeArea variant (camelCase id)', () => {
    const html = `<div id="storeArea" hidden>
<div tiddler="Start" tags="" twine-position="100,100">Hello</div>
</div>`;
    const { story, diagnostics } = decompileHTML(html);
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
    expect(story.passages.find((p) => p.name === 'Start')).toBeDefined();
  });

  it('skips non-tiddler child divs', () => {
    const html = `<div id="store-area" hidden>
<div class="other">Not a tiddler</div>
<div tiddler="Start" tags="" twine-position="100,100">Hello</div>
</div>`;
    const { story } = decompileHTML(html);
    expect(story.passages).toHaveLength(1);
    expect(story.passages[0]!.name).toBe('Start');
  });

  it('handles full HTML document wrapping store-area', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>My Twine 1 Story</title></head>
<body>
${MINIMAL_TWINE1_HTML}
</body>
</html>`;
    const { story, diagnostics } = decompileHTML(html);
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
    expect(story.passages.find((p) => p.name === 'Start')).toBeDefined();
  });

  it('handles empty tiddler content', () => {
    const html = `<div id="store-area" hidden>
<div tiddler="Empty" tags="" twine-position="100,100"></div>
</div>`;
    const { story } = decompileHTML(html);
    const p = story.passages.find((p) => p.name === 'Empty');
    expect(p).toBeDefined();
    expect(p!.text).toBe('');
  });

  it('reverses ROT13 obfuscation of names, tags and text for every tiddler but StorySettings and images', () => {
    const html = `<div id="storeArea" hidden>
<div tiddler="FgbelGvgyr" tags="" twine-position="10,10">Erivrj</div>
<div tiddler="Fgneg" tags="vageb" twine-position="100,100">Uryyb jbeyq [[Arkg]]</div>
<div tiddler="StorySettings" tags="" twine-position="200,100">undo:off\\nObfuscate: ROT13</div>
<div tiddler="pic" tags="Twine.image" twine-position="300,100">data:image/png;base64,AAAA</div>
</div>`;
    const { story, diagnostics } = decompileHTML(html);
    expect(diagnostics).toEqual([]);
    expect(story.name).toBe('Review');
    expect(story.passages.map((p) => [p.name, p.tags, p.text])).toEqual([
      ['StoryTitle', [], 'Review'],
      ['Start', ['intro'], 'Hello world [[Next]]'],
      ['StorySettings', [], 'undo:off\nObfuscate: ROT13'],
      ['pic', ['Twine.image'], 'data:image/png;base64,AAAA'],
    ]);
  });

  it('leaves tiddlers alone when obfuscation is off', () => {
    const html = `<div id="storeArea" hidden>
<div tiddler="StorySettings" tags="" twine-position="200,100">obfuscate:off</div>
<div tiddler="Start" tags="" twine-position="100,100">Uryyb</div>
</div>`;
    const { story } = decompileHTML(html);
    expect(story.passages.find((p) => p.name === 'Start')!.text).toBe('Uryyb');
  });
});

describe('decompileHTML — story-level tags', () => {
  it('reads the tags attribute of tw-storydata', () => {
    const html = MINIMAL_TWINE2_HTML.replace('tags=""', 'tags="fiction adult"');
    const { story } = decompileHTML(html);
    expect(story.twine2.tags).toBe('fiction adult');
    const storyData = story.passages.find((p) => p.name === 'StoryData');
    expect(parseJsonObject(storyData!.text)['tags']).toBe('fiction adult');
  });

  it('leaves tags empty when the attribute is empty or missing', () => {
    expect(decompileHTML(MINIMAL_TWINE2_HTML).story.twine2.tags).toBe('');
    expect(decompileHTML(MINIMAL_TWINE2_HTML.replace('tags=""', '')).story.twine2.tags).toBe('');
  });
});

describe('HTML round trips through compile()', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-html-roundtrip-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

  async function compileToFile(content: string, outputMode: OutputMode, name: string): Promise<string> {
    const result = await compile({ sources: [{ filename: 'story.tw', content }], outputMode });
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    const file = join(dir, name);
    writeFileSync(file, result.output, 'utf-8');
    return file;
  }

  const TWINE2_SOURCE = [
    ':: StoryTitle',
    'Review Story',
    '',
    ':: StoryData',
    JSON.stringify({ ifid: IFID, tags: 'fiction adult' }),
    '',
    ':: Start',
    'Hello world',
  ].join('\n');

  it('keeps the story title and story tags from Twine 2 HTML to Twee', async () => {
    const file = await compileToFile(TWINE2_SOURCE, 'twine2-archive', 'story.html');
    expect(decompileHTML(readFileSync(file, 'utf-8')).story.name).toBe('Review Story');

    const result = await compile({ sources: [file], outputMode: 'twee3' });
    expect(result.story.name).toBe('Review Story');
    expect(result.story.twine2.tags).toBe('fiction adult');
    expect(result.output).toContain(':: StoryTitle\nReview Story\n');
    expect(result.output).toMatch(/"tags": "fiction adult"/);
  });

  it('keeps the story title and story tags from Twine 2 HTML to Twine 2 HTML', async () => {
    const file = await compileToFile(TWINE2_SOURCE, 'twine2-archive', 'story.html');
    const result = await compile({ sources: [file], outputMode: 'twine2-archive' });
    expect(result.output).toContain('name="Review Story"');
    expect(result.output).toContain('tags="fiction adult"');
  });

  const OBFUSCATED_SOURCE = [
    ':: StorySettings',
    'obfuscate:rot13',
    '',
    ':: StoryTitle',
    'Review',
    '',
    ':: StoryData',
    JSON.stringify({ ifid: IFID }),
    '',
    ':: Start',
    'Hello world',
  ].join('\n');

  it('decodes obfuscated Twine 1 HTML to Twee', async () => {
    const file = await compileToFile(OBFUSCATED_SOURCE, 'twine1-archive', 'story.html');
    const { story } = decompileHTML(readFileSync(file, 'utf-8'));
    expect(story.passages.find((p) => p.name === 'Start')!.text).toBe('Hello world');
    expect(story.passages.find((p) => p.name === 'StorySettings')!.text).toBe('obfuscate:rot13');

    const result = await compile({ sources: [file], outputMode: 'twee3' });
    expect(result.story.name).toBe('Review');
    expect(result.output).toMatch(/:: Start \{[^}]*\}\nHello world\n/);
    expect(result.output).toMatch(/:: StorySettings \{[^}]*\}\nobfuscate:rot13\n/);
  });

  it('encodes obfuscated Twine 1 HTML exactly once when recompiled to Twine 1 HTML', async () => {
    const file = await compileToFile(OBFUSCATED_SOURCE, 'twine1-archive', 'story.html');
    const result = await compile({ sources: [file], outputMode: 'twine1-archive' });
    expect(result.output).toContain('Uryyb jbeyq');
    const { story } = decompileHTML(result.output);
    expect(story.passages.find((p) => p.name === 'Start')!.text).toBe('Hello world');
  });
});

describe('decompileHTML — passage whitespace', () => {
  const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
  const TWINE2_HTML = `<tw-storydata name="Spaced" startnode="1" ifid="${IFID}" hidden>
<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">
  body { color: red; }
</style>
<script role="script" id="twine-user-script" type="text/twine-javascript">  window.x = 1;  </script>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">\n  indented content  \n</tw-passagedata>
</tw-storydata>`;
  const TWINE1_HTML = `<div id="storeArea" hidden>
<div tiddler="Start" tags="" twine-position="100,100">\\n  indented content  \\n</div>
</div>`;

  function text(html: string, name: string, options?: { trim?: boolean }): string | undefined {
    return decompileHTML(html, options).story.passages.find((p) => p.name === name)?.text;
  }

  it('trims Twine 2 passage text at both ends by default, as the Twee lexer does', () => {
    expect(text(TWINE2_HTML, 'Start')).toBe('indented content');
    expect(text(TWINE2_HTML, 'Start', { trim: true })).toBe('indented content');
  });

  it('keeps Twine 2 passage text exactly when trim is off', () => {
    expect(text(TWINE2_HTML, 'Start', { trim: false })).toBe('\n  indented content  \n');
  });

  it('applies the trim option to the Twine 2 story stylesheet and script', () => {
    expect(text(TWINE2_HTML, 'Story Stylesheet')).toBe('body { color: red; }');
    expect(text(TWINE2_HTML, 'Story JavaScript')).toBe('window.x = 1;');
    expect(text(TWINE2_HTML, 'Story Stylesheet', { trim: false })).toBe('\n  body { color: red; }\n');
    expect(text(TWINE2_HTML, 'Story JavaScript', { trim: false })).toBe('  window.x = 1;  ');
  });

  it('still skips a whitespace-only stylesheet or script when trim is off', () => {
    const html = `<tw-storydata name="Blank" startnode="1" ifid="${IFID}" hidden>
<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">
</style>
<script role="script" id="twine-user-script" type="text/twine-javascript">  </script>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">Hello</tw-passagedata>
</tw-storydata>`;
    const names = decompileHTML(html, { trim: false }).story.passages.map((p) => p.name);
    expect(names).toEqual(['StoryData', 'Start']);
  });

  it('trims Twine 1 tiddler text by default and keeps it exactly when trim is off', () => {
    expect(text(TWINE1_HTML, 'Start')).toBe('indented content');
    expect(text(TWINE1_HTML, 'Start', { trim: false })).toBe('\n  indented content  \n');
  });
});

describe('decompileHTML — story stylesheet and script names', () => {
  const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
  const CASES = [
    { element: 'style', tag: 'stylesheet', name: 'Story Stylesheet', code: 'body { color: red; }' },
    { element: 'script', tag: 'script', name: 'Story JavaScript', code: 'globalThis.essentialSetup = true;' },
  ] as const;

  function replacements(diagnostics: readonly { message: string }[]): string[] {
    return diagnostics.map((d) => d.message).filter((m) => m.includes('Replacing existing passage'));
  }

  for (const { element, tag, name, code } of CASES) {
    describe(`a generated ${name}`, () => {
      const html = `<tw-storydata name="Clash" startnode="2" ifid="${IFID}" hidden>
<${element} type="text/twine-${element === 'style' ? 'css' : 'javascript'}">${code}</${element}>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">[[${name}]]</tw-passagedata>
<tw-passagedata pid="2" name="${name}" tags="" position="200,100" size="100,100">This is a real story passage.</tw-passagedata>
<tw-passagedata pid="3" name="${name} 2" tags="" position="300,100" size="100,100">Another real passage.</tw-passagedata>
</tw-storydata>`;

      it(`keeps both a real "${name}" passage and the story ${tag}`, () => {
        const { story, diagnostics } = decompileHTML(html);
        expect(replacements(diagnostics)).toEqual([]);
        expect(story.passages.map((p) => [p.name, p.tags, p.text])).toEqual([
          ['StoryData', [], expect.any(String)],
          [`${name} 3`, [tag], code],
          ['Start', [], `[[${name}]]`],
          [name, [], 'This is a real story passage.'],
          [`${name} 2`, [], 'Another real passage.'],
        ]);
        expect(story.twine2.start).toBe(name);
      });
    });
  }

  it('gives a second style or script element its own name', () => {
    const html = `<tw-storydata name="Twice" startnode="1" ifid="${IFID}" hidden>
<script type="text/twine-javascript">first();</script>
<script type="text/twine-javascript">second();</script>
<tw-passagedata pid="1" name="Start" tags="" position="100,100" size="100,100">Hello</tw-passagedata>
</tw-storydata>`;
    const { story, diagnostics } = decompileHTML(html);
    expect(replacements(diagnostics)).toEqual([]);
    const scripts = story.passages.filter((p) => p.tags.includes('script'));
    expect(scripts.map((p) => [p.name, p.text])).toEqual([
      ['Story JavaScript', 'first();'],
      ['Story JavaScript 2', 'second();'],
    ]);
  });
});

describe('HTML round trips with passages named like the story stylesheet or script', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-html-names-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const CASES = [
    { tag: 'stylesheet', name: 'Story Stylesheet', code: 'body { color: red; }' },
    { tag: 'script', name: 'Story JavaScript', code: 'globalThis.essentialSetup = true;' },
  ] as const;

  for (const archive of ['twine2-archive', 'twine1-archive'] as const) {
    for (const { tag, name, code } of CASES) {
      it(`keeps a real "${name}" passage and the ${tag} through ${archive} and back`, async () => {
        const source = [
          ':: StoryData',
          JSON.stringify({ ifid: 'D674C58C-DEFA-4F70-B7A2-27742230C0FC' }),
          '',
          ':: Start',
          `[[${name}]]`,
          '',
          `:: ${name}`,
          'This is a real story passage.',
          '',
          `:: Code [${tag}]`,
          code,
          '',
        ].join('\n');
        const first = await compile({ sources: [{ filename: 'story.tw', content: source }], outputMode: archive });
        expect(first.diagnostics).toEqual([]);

        const { story, diagnostics } = decompileHTML(first.output);
        expect(diagnostics).toEqual([]);
        expect(story.passages.find((p) => p.name === name)).toMatchObject({
          tags: [],
          text: 'This is a real story passage.',
        });
        expect(story.passages.filter((p) => p.tags.includes(tag)).map((p) => p.text)).toEqual([code]);

        const file = join(dir, 'story.html');
        writeFileSync(file, first.output, 'utf-8');
        const again = await compile({ sources: [file], outputMode: archive });
        expect(again.diagnostics).toEqual([]);
        expect(again.output).toBe(first.output);
      });
    }
  }
});

describe('HTML whitespace round trips through compile()', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-html-trim-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const SOURCE = [
    ':: StoryData',
    JSON.stringify({ ifid: 'D674C58C-DEFA-4F70-B7A2-27742230C0FC' }),
    '',
    ':: StoryTitle',
    'Spaced',
    '',
    ':: Start',
    '  indented content  ',
    '',
  ].join('\n');

  for (const archive of ['twine2-archive', 'twine1-archive'] as const) {
    describe(`output mode ${archive}`, () => {
      async function archived(): Promise<string> {
        const first = await compile({
          sources: [{ filename: 'story.tw', content: SOURCE }],
          outputMode: archive,
          trim: false,
        });
        expect(first.story.passages.find((p) => p.name === 'Start')?.text).toBe('  indented content  ');
        const file = join(dir, 'story.html');
        writeFileSync(file, first.output, 'utf-8');
        return file;
      }

      it('keeps passage whitespace with trim off', async () => {
        const again = await compile({ sources: [await archived()], outputMode: 'json', trim: false });
        expect(again.story.passages.find((p) => p.name === 'Start')?.text).toBe('  indented content  ');
      });

      it('trims passage whitespace with trim on', async () => {
        const again = await compile({ sources: [await archived()], outputMode: 'json' });
        expect(again.story.passages.find((p) => p.name === 'Start')?.text).toBe('indented content');
      });
    });
  }
});

describe('decompileHTML — story IFID', () => {
  const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
  const html = (ifidAttr: string): string =>
    `<tw-storydata name="T" startnode="1" ${ifidAttr} format="Test Format" format-version="1.0.0">` +
    `<tw-passagedata pid="1" name="Start" tags="">Hello</tw-passagedata></tw-storydata>`;

  it('reports an invalid ifid attribute and keeps the value as written, uppercased', () => {
    const { story, diagnostics } = decompileHTML(html('ifid="not-a-uuid"'));
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message:
          'Cannot parse "tw-storydata" content attribute "ifid" as an IFID; value "not-a-uuid" (invalid IFID length: 10).',
      },
    ]);
    expect(story.ifid).toBe('NOT-A-UUID');
  });

  it('reports a missing or empty ifid attribute and leaves the IFID empty', () => {
    for (const attr of ['', 'ifid=""']) {
      const { story, diagnostics } = decompileHTML(html(attr));
      expect(diagnostics).toEqual([
        {
          level: 'warning',
          message: 'Story IFID not found; the "tw-storydata" content attribute "ifid" is missing or empty.',
        },
      ]);
      expect(story.ifid).toBe('');
    }
  });

  it('accepts a valid bare or wrapped ifid without a diagnostic', () => {
    for (const value of [IFID, IFID.toLowerCase(), `UUID://${IFID}//`]) {
      const { story, diagnostics } = decompileHTML(html(`ifid="${value}"`));
      expect(diagnostics).toEqual([]);
      expect(story.ifid).toBe(IFID);
    }
  });
});

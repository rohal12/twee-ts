/**
 * Regression tests for the confirmed defects of issue #244 (H1–H17), each named by its id, and for the hidden
 * StorySettings case of #149. The oracle is parse5 (as browsers parse, scripting enabled), never the code under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';
import { modifyHead } from '../src/modules.js';
import { insertViteClient, viteWaitingPage } from '../src/html-structure.js';
import { toTwine2Archive } from '../src/output-twine2.js';
import { toTwine1Archive } from '../src/output-twine1.js';
import { createStory } from '../src/story.js';
import { normalizeIFID } from '../src/ifid.js';
import * as templateModule from '../src/template.js';
import * as modulesModule from '../src/modules.js';
import type { Diagnostic, Passage } from '../src/types.js';
import { attr, elements, parseDocument, textContent } from './helpers/html.js';
import { allNodes, documentHead } from './helpers/html-oracle.js';
import { judgeHeadFile, judgeModule, judgeViteClient } from './helpers/insertion-judges.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const D = '<!doctype html><html>';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-244-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Inject a module that sets an attribute through `modifyHead()`; returns the output and the diagnostics. */
function injectModule(template: string): { output: string; diagnostics: Diagnostic[] } {
  const file = join(dir, 'probe.js');
  writeFileSync(file, "document.documentElement.setAttribute('data-mod', '1')");
  const diagnostics: Diagnostic[] = [];
  return { output: modifyHead(template, [file], undefined, diagnostics), diagnostics };
}

/** The injected module script as the browser builds it: where it is and what text it has. */
function moduleScript(output: string): { parent: string | undefined; text: string } | undefined {
  const doc = parseDocument(output);
  const script = allNodes(doc).find(
    (n) => 'attrs' in n && n.attrs.some((a) => a.name === 'id' && a.value === 'script-module-probe'),
  );
  if (script === undefined || !('attrs' in script)) return undefined;
  return { parent: script.parentNode === documentHead(doc) ? 'head' : 'elsewhere', text: textContent(script) };
}

describe('#244 RC1: the head is found by an HTML parser, not a partial tokenizer', () => {
  const cases: Record<string, string> = {
    'H1: a comment ending in --!>': `${D}<head><title>t</title><!-- a --!></head><body>B<!-- c --></body></html>`,
    'H1: the abrupt empty comment <!-->': `${D}<head><title>t</title><!--></head><body>B<!-- c --></body></html>`,
    'H1: the abrupt empty comment <!--->': `${D}<head><title>t</title><!---></head><body>B<!-- c --></body></html>`,
    'H2: a bogus comment from </ and a space': `${D}<head><title>t</title></ </head> ><meta name=x></head><body>B</body></html>`,
    'H2: a bogus comment from </!': `${D}<head><title>t</title></! </head> ></head><body>B</body></html>`,
    'H3: script data, double escaped': `<head><title>t</title><script>if (0) document.write("<!--<script>"); var s = "</script></head>"; // -->\n</script></head><body>B</body>`,
    'H4: noscript is raw text with scripting on': `${D}<head><title>t</title><noscript></head></noscript></head><body>B</body></html>`,
    'H4: noframes is raw text': `${D}<head><title>t</title><noframes></head></noframes></head><body>B</body></html>`,
    'H5: template content is inert': `${D}<head><title>t</title><template></head></template></head><body>B</body></html>`,
    'H6: = starts an attribute name': `${D}<head><title>t</title><meta ="></head><body>B<i title="x"></i></body></html>`,
    'H6: = after a quoted value starts a new attribute name': `${D}<head><title>t</title><meta a="x"="></head><body>B<i title="x"></i></body></html>`,
  };

  for (const [name, template] of Object.entries(cases)) {
    it(`${name}: injects a running module into the real head`, () => {
      const { output, diagnostics } = injectModule(template);
      expect(moduleScript(output)).toEqual({
        parent: 'head',
        text: "document.documentElement.setAttribute('data-mod', '1')",
      });
      // In the H2 cases, the text " >" after the bogus comment ends the head before the closing head tag.
      expect(diagnostics.map((d) => d.message.replace(/ at line .*/, ''))).toEqual(
        name.startsWith('H2')
          ? [
              'The HTML has no closing head tag that ends its head; the modules and head file were injected where the head ends,',
            ]
          : [],
      );
      expect(judgeModule(template)).toBeUndefined();
      expect(judgeHeadFile(template)).toBeUndefined();
    });
  }

  it.each([
    ['H4: xmp', `${D}<head><title>t</title><body><xmp></head></xmp></body></html>`],
    ['H4: iframe', `${D}<head><title>t</title><body><iframe></head></iframe></body></html>`],
    ['H4: noembed', `${D}<head><title>t</title><body><noembed></head></noembed></body></html>`],
    ['H4: plaintext', `${D}<head><title>t</title><body><plaintext></head>`],
    ['H5: CDATA in SVG', `${D}<head><title>t</title><body><svg><![CDATA[ a > </head> ]]></svg></body></html>`],
  ])(
    '%s: injects into the head, before the body that the template starts without a closing head tag',
    (_name, template) => {
      const { output } = injectModule(template);
      expect(moduleScript(output)?.parent).toBe('head');
      expect(judgeModule(template)).toBeUndefined();
    },
  );
});

describe('#244 RC2: no structural location by string matching', () => {
  it('H7: puts the Vite client into an implied head after the doctype, keeping standards mode', () => {
    for (const template of [
      '<!doctype html><html><title>t</title><body>B</body></html>',
      '<!doctype html><title>t</title><p>B',
      '<!doctype html><!--><html><head><title>t</title></head><body>B<!-- --></body></html>',
      '<!doctype html><!-- a --!><html><head><title>t</title></head><body>B<!-- --></body></html>',
    ]) {
      const output = insertViteClient(template, '/@vite/client');
      expect(parseDocument(output).mode).toBe('no-quirks');
      expect(judgeViteClient(template)).toBeUndefined();
    }
  });

  /** Compile a one-passage story with a Twine 1 format whose header is `header`. */
  async function twine1(header: string) {
    const formats = join(dir, 'formats');
    mkdirSync(join(formats, 'h8'), { recursive: true });
    writeFileSync(join(formats, 'h8', 'header.html'), header);
    return compile({
      sources: [{ filename: 's.tw', content: `:: StoryData\n{"ifid":"${IFID}"}\n:: StoryTitle\nT\n:: Start\nHello` }],
      formatId: 'h8',
      formatPaths: [formats],
      useTweegoPath: false,
      noRemote: true,
    });
  }

  /** The comment right before the element with id `storeArea`, if any. */
  function commentBeforeStoreArea(output: string): string | undefined {
    const [store] = elements(output, (e) => attr(e, 'id') === 'storeArea');
    const siblings = store?.parentNode?.childNodes ?? [];
    const previous = store === undefined ? undefined : siblings[siblings.indexOf(store) - 1];
    return previous !== undefined && 'data' in previous ? previous.data : undefined;
  }

  it('H8a: does not take a store-area look-alike in a comment, so creates no fake element', async () => {
    const { output, diagnostics } = await twine1(
      '<!doctype html><html><head><title>x</title><!-- legacy: <div id="store-area"> --></head><body><div id="storeArea" data-size="STORY_SIZE" hidden>"STORY"</div></body></html>',
    );
    expect(commentBeforeStoreArea(output)).toBe(` UUID://${IFID}// `);
    expect(elements(output, (e) => attr(e, 'id') === 'store-area')).toEqual([]);
    expect(output).toContain('<!-- legacy: <div id="store-area"> -->');
    expect(diagnostics).toEqual([]);
  });

  it('H8b: leaves a store area look-alike in a script string as it is', async () => {
    const { output } = await twine1(
      `<!doctype html><html><head><title>x</title><script>var tpl = '<div id="storeArea">';</script></head><body><div id="storeArea" data-size="STORY_SIZE" hidden>"STORY"</div></body></html>`,
    );
    expect(output).toContain(`<script>var tpl = '<div id="storeArea">';</script>`);
    expect(commentBeforeStoreArea(output)).toBe(` UUID://${IFID}// `);
  });

  it.each([
    ['single quotes', `<div id='storeArea' data-size="STORY_SIZE" hidden>"STORY"</div>`],
    ['upper case', `<DIV ID=storeArea data-size="STORY_SIZE" hidden>"STORY"</DIV>`],
    ['another attribute first', `<div hidden id="storeArea" data-size="STORY_SIZE">"STORY"</div>`],
  ])('H8c: adds the IFID comment before a store area written with %s', async (_label, div) => {
    const { output } = await twine1(`<!doctype html><html><head><title>x</title></head><body>${div}</body></html>`);
    expect(commentBeforeStoreArea(output)).toBe(` UUID://${IFID}// `);
  });

  it('H8c: warns when a Twine 1 format has no store area for the IFID comment', async () => {
    const { diagnostics } = await twine1('<!doctype html><html><head></head><body><p>"STORY"</p></body></html>');
    expect(diagnostics).toContainEqual({
      level: 'warning',
      message:
        'Story format "h8" has no element with the id "store-area" or "storeArea"; the IFID comment was not added.',
    });
  });

  it('H17: the scanner and the dead closing-head and body regular expressions are gone', () => {
    expect(Object.keys(templateModule)).not.toContain('CLOSING_HEAD_TAG');
    expect(Object.keys(templateModule)).not.toContain('BODY_START_TAG');
    expect(Object.keys(modulesModule)).not.toContain('scanHeadTags');
    expect(Object.keys(modulesModule)).not.toContain('findHeadStartEnd');
  });
});

describe('#244 RC3: values are escaped for the context they land in', () => {
  /** A SugarCube-shaped template: the name in the title, in body text, and in JavaScript strings. */
  const SUGARCUBE_LIKE =
    '<!DOCTYPE html><html><head><title>{{STORY_NAME}}</title></head><body><h1>{{STORY_NAME}}</h1>{{STORY_DATA}}' +
    '<script id="script-sugarcube">var title = unescape("{{STORY_NAME}}"), id = generateName("{{STORY_NAME}}"), ' +
    "single = '{{STORY_NAME}}', tpl = `{{STORY_NAME}}`;</script></body></html>";

  async function compileWithName(name: string) {
    const formats = join(dir, 'formats');
    mkdirSync(join(formats, 'sc-1'), { recursive: true });
    writeFileSync(
      join(formats, 'sc-1', 'format.js'),
      `window.storyFormat(${JSON.stringify({ name: 'SC', version: '1.0.0', source: SUGARCUBE_LIKE })});`,
    );
    return compile({
      sources: [
        { filename: 's.tw', content: `:: StoryData\n{"ifid":"${IFID}"}\n:: StoryTitle\n${name}\n:: Start\nHi` },
      ],
      formatId: 'sc-1',
      formatPaths: [formats],
      useTweegoPath: false,
      noRemote: true,
    });
  }

  /** What SugarCube's Util.unescape() does: decode the five references Twine 2 escapes with. */
  const unescape = (s: string): string =>
    s.replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_m, ref: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[ref] ?? '',
    );

  it.each([
    'Back\\',
    'Line\\nTwo',
    'a\\Sb',
    'Tab\there',
    'Quotes "dq" \'sq\' & <b> </script>',
    'Template `${x}`',
    'Sep\u2028arator',
  ])('H9: keeps the name %j in every JavaScript string, and the script valid', async (name) => {
    const { output, diagnostics } = await compileWithName(name);
    expect(diagnostics).toEqual([]);
    const [script] = elements(output, (e) => attr(e, 'id') === 'script-sugarcube');
    const source = script === undefined ? '' : textContent(script);
    const context = { unescape, generateName: (s: string) => s, title: '', id: '', single: '', tpl: '' };
    new Script(source).runInNewContext(context);
    expect(unescape(context.title)).toBe(name);
    expect(unescape(context.single)).toBe(name);
    expect(unescape(context.tpl)).toBe(name);
    const doc = parseDocument(output);
    expect(textContent(elements(doc, (e) => e.tagName === 'title')[0] ?? doc)).toBe(name);
    expect(textContent(elements(doc, (e) => e.tagName === 'h1')[0] ?? doc)).toBe(name);
  });

  it.each(['/a&lt/', '/a"b/', "/x'y/", '/a b/'])(
    'H10: writes the Vite base %j into the client src as it is',
    (base) => {
      const src = `${base}@vite/client`;
      for (const html of [
        insertViteClient('<!doctype html><html><head></head><body></body></html>', src),
        viteWaitingPage(src),
      ]) {
        const clients = elements(html, (e) => e.tagName === 'script' && attr(e, 'type') === 'module');
        expect(clients.map((c) => attr(c, 'src'))).toEqual([src]);
      }
    },
  );
});

describe('#244 RC4: the decompiler reads HTML as a browser does', () => {
  const storyData = (passages: string, name = 'Real'): string =>
    `<tw-storydata name="${name}" startnode="1" ifid="${IFID}" hidden>${passages}</tw-storydata>`;
  const passage = (name: string, text: string): string =>
    `<tw-passagedata pid="1" name="${name}" tags="" position="0,0" size="100,100">${text}</tw-passagedata>`;
  const real = storyData(passage('Start', 'real text'));
  const fake = storyData(passage('Start', 'FAKE'), 'Fake');

  it.each([
    ['template content', `<!doctype html><head><template>${fake}</template></head><body>${real}`],
    [
      'a double-escaped script',
      `<!doctype html><body><script>/*<!--<script>*/ var a = 1; </script>${fake}<script> /*-->*/</script>${real}`,
    ],
    ['an abrupt empty comment', `<!doctype html><body><!-->${real}<!-- ${fake} -->`],
    ['a --!> comment end', `<!doctype html><body><!-- x --!>${real}<!-- ${fake} -->`],
    ['xmp raw text', `<!doctype html><body><xmp>${fake}</xmp>${real}`],
    ['noscript raw text', `<!doctype html><body><noscript>${fake}</noscript>${real}`],
  ])('H11: decompiles the story a story format finds, past a fake in %s', (_label, html) => {
    const { story } = decompileHTML(html, { trim: false });
    expect(story.name).toBe('Real');
    expect(story.passages.find((p) => p.name === 'Start')?.text).toBe('real text');
  });

  it('H11: finds the Twine 1 store area as getElementById() does, past a fake in template content', () => {
    const html =
      '<!doctype html><head><template><div id="storeArea"><div tiddler="Fake">x</div></div></template></head>' +
      '<body><div id="storeArea"><div tiddler="Start">real</div></div>';
    expect(decompileHTML(html).story.passages.map((p) => p.name)).toEqual(['Start']);
  });

  it.each([
    ['an inline element', 'a<b>bold</b>c', 'aboldc'],
    ['a paragraph', 'a<p>b', 'ab'],
    ['a comment', 'a<!-- c -->b', 'ab'],
  ])('H12: reads passage text as textContent, with %s', (_label, text, expected) => {
    const { story } = decompileHTML(`<!doctype html><body>${storyData(passage('Start', text))}`, { trim: false });
    expect(story.passages.find((p) => p.name === 'Start')?.text).toBe(expected);
  });

  it('H13: preprocesses the input stream: line breaks become LF, NUL is dropped from text and is U+FFFD in attributes', () => {
    const html = `<!doctype html><body>${storyData(passage('St\0art', 'a\r\nb\rc\0d'))}`;
    const { story } = decompileHTML(html, { trim: false });
    const p = story.passages.find((q) => q.name !== 'StoryData');
    expect(p).toEqual({ name: 'St�art', tags: [], text: 'a\nb\ncd', metadata: { position: '0,0', size: '100,100' } });
  });
});

describe('#244 RC5: text HTML cannot carry is reported', () => {
  it('H14: reports NUL in a passage name, its text and a link to it', async () => {
    const { diagnostics } = await compile({
      sources: [{ filename: 's.tw', content: `:: StoryData\n{"ifid":"${IFID}"}\n:: Start\n[[A\0B]]\n:: A\0B\nx` }],
      outputMode: 'twine2-archive',
    });
    expect(diagnostics.filter((d) => d.level === 'error').map((d) => d.message)).toEqual([
      'The text of passage "Start" contains U+0000, which HTML cannot carry: the browser drops it or reads it as U+FFFD. Remove it.',
      'The name of passage "A\0B" contains U+0000, which HTML cannot carry: the browser drops it or reads it as U+FFFD. Remove it.',
    ]);
  });

  it('H14: reports a lone surrogate in the story name and a tag', () => {
    const story = createStory();
    story.name = 'a\uD800b';
    story.ifid = normalizeIFID(IFID);
    story.passages.push({ name: 'Start', tags: ['t\uDC00'], text: 'x' });
    const diagnostics: Diagnostic[] = [];
    toTwine1Archive(story, 'Start', { diagnostics });
    expect(diagnostics.map((d) => d.message)).toEqual([
      'The story name contains U+D800, which HTML cannot carry: the browser drops it or reads it as U+FFFD. Remove it.',
      'The tag "t\uDC00" of passage "Start" contains U+DC00, which HTML cannot carry: the browser drops it or reads it as U+FFFD. Remove it.',
    ]);
  });

  it('H14: carries a carriage return in names, tags and text as a character reference, through a round trip', () => {
    const story = createStory();
    story.ifid = normalizeIFID(IFID);
    const passages: Passage[] = [{ name: 'A\rB', tags: [], text: 'line\rbreak\r\n' }];
    story.passages.push(...passages);
    for (const html of [toTwine2Archive(story, 'A\rB'), toTwine1Archive(story, 'A\rB')]) {
      const back = decompileHTML(html, { trim: false }).story.passages.find((p) => p.name !== 'StoryData');
      expect(back?.name).toBe('A\rB');
      expect(back?.text).toBe('line\rbreak\r\n');
    }
  });

  it('H14: warns about a carriage return in a script passage, which the script element cannot carry', () => {
    const story = createStory();
    story.ifid = normalizeIFID(IFID);
    story.passages.push({ name: 'Code', tags: ['script'], text: 'var a = 1;\r\nvar b = 2;' });
    const diagnostics: Diagnostic[] = [];
    toTwine2Archive(story, 'Start', { diagnostics });
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message:
          'The script passage "Code" has a carriage return at line 1, which the HTML parser reads as a line feed in a ' +
          'script element.',
      },
    ]);
  });

  it('H14: reports a tag holding whitespace, which reads back as several tags', () => {
    const story = createStory();
    story.ifid = normalizeIFID(IFID);
    story.passages.push({ name: 'Start', tags: ['a b'], text: 'x' });
    const diagnostics: Diagnostic[] = [];
    toTwine2Archive(story, 'Start', { diagnostics });
    expect(diagnostics.map((d) => d.level)).toEqual(['error']);
  });
});

describe('#244 RC6: lossy encodings are reported', () => {
  const obfuscated = (extra: string) =>
    `:: StoryData\n{"ifid":"${IFID}"}\n:: StorySettings\nobfuscate:rot13\n:: Start\nHi\n${extra}`;

  it('H15: reports a passage whose obfuscated name is StorySettings', async () => {
    const { diagnostics } = await compile({
      sources: [{ filename: 's.tw', content: obfuscated(':: FgbelFrggvatf\njquery:on\n') }],
      outputMode: 'twine1-archive',
    });
    expect(diagnostics).toContainEqual({
      level: 'error',
      message:
        'Passage "FgbelFrggvatf" cannot be obfuscated: ROT13 turns its name to "StorySettings", which the Twine 1 ' +
        'engine reads unencoded, so it would not decode the passage. Rename it, or turn off "obfuscate:rot13".',
    });
  });

  it('H15: reports a passage whose obfuscated tag is Twine.image', async () => {
    const { diagnostics } = await compile({
      sources: [{ filename: 's.tw', content: obfuscated(':: pic [Gjvar.vzntr]\nhello\n') }],
      outputMode: 'twine1-archive',
    });
    expect(diagnostics.filter((d) => d.level === 'error').map((d) => d.message)).toEqual([
      'Passage "pic" cannot be obfuscated: ROT13 turns its tag "Gjvar.vzntr" to "Twine.image", which the Twine 1 ' +
        'engine reads unencoded, so it would not decode the passage. Rename it, or turn off "obfuscate:rot13".',
    ]);
  });

  /** Compile one script passage to a Twine 2 archive and decompile it; returns the text back and the warnings. */
  async function scriptRoundTrip(code: string) {
    const { output, diagnostics } = await compile({
      sources: [
        { filename: 's.tw', content: `:: StoryData\n{"ifid":"${IFID}"}\n:: Start\nHi\n:: Code [script]\n${code}\n` },
      ],
      outputMode: 'twine2-archive',
    });
    const back = decompileHTML(output).story.passages.find((p) => p.tags.includes('script'))?.text;
    return { back, warnings: diagnostics.filter((d) => d.level === 'warning').map((d) => d.message) };
  }

  it.each([
    ['a string', 'var a = "</script>";'],
    ['a comment', '// </script>'],
    ['a regular expression', 'var r = /[</script>]/;'],
    ['an untagged template', 'var t = `</script>`;'],
  ])(
    'H16: keeps the value of </script in %s, and the round trip returns it escaped (the documented exception)',
    async (_label, code) => {
      const { back, warnings } = await scriptRoundTrip(code);
      expect(back).toBe(code.replace(/<(?=\/script)/g, '<\\'));
      expect(warnings).toEqual([]);
    },
  );

  it.each([
    ['code', 'var x = 1 </script/.source.length;', '"</script"'],
    ['a tagged template', 'var t = String.raw`</script>`;', '"</script"'],
    ['an HTML-like comment before a script tag', '<!-- a\nvar s = "<script>";', '"<!--"'],
  ])('H16: warns where escaping </script or <!-- changes the code: %s', async (_label, code, sequence) => {
    const { warnings } = await scriptRoundTrip(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`script passage "Code" has ${sequence} at line 1 outside a string`);
  });
});

describe('#149: obfuscation follows the StorySettings the output carries', () => {
  async function archive(settingsTags: string, tagAliases?: Record<string, string>) {
    return compile({
      sources: [
        {
          filename: 's.tw',
          content: `:: StoryData\n{"ifid":"${IFID}"}\n:: StorySettings ${settingsTags}\nobfuscate:rot13\n:: Start\nHello`,
        },
      ],
      outputMode: 'twine1-archive',
      ...(tagAliases ? { tagAliases } : {}),
    });
  }
  const WARNING = {
    level: 'warning',
    message:
      'The "StorySettings" passage says "obfuscate:rot13", but it is not written to the output (it is tagged ' +
      '"Twine.private"), so the story engine could not decode obfuscated passages; they are written unobfuscated.',
  };

  it('writes the passages plain, with a warning, when StorySettings is Twine.private', async () => {
    const { output, diagnostics } = await archive('[Twine.private]');
    expect(output).toContain('tiddler="Start"');
    expect(output).toContain('>Hello</div>');
    expect(output).not.toContain('Fgneg');
    expect(diagnostics).toContainEqual(WARNING);
    expect(decompileHTML(output).story.passages.find((p) => p.name === 'Start')?.text).toBe('Hello');
  });

  it('does so for a tag that an alias maps to Twine.private', async () => {
    const { output, diagnostics } = await archive('[hidden]', { hidden: 'Twine.private' });
    expect(output).toContain('tiddler="Start"');
    expect(diagnostics).toContainEqual(WARNING);
  });

  it('obfuscates when StorySettings is written (control)', async () => {
    const { output, diagnostics } = await archive('[stylesheet]');
    expect(output).toContain('tiddler="Fgneg"');
    expect(diagnostics).not.toContainEqual(WARNING);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compile } from '../src/compiler.js';
import { findHeadStartEnd, loadHeadContent, loadModules, scanHeadTags } from '../src/modules.js';

describe('scanHeadTags: text that only looks like markup', () => {
  it('skips a lone < in text and finds the tags after it', () => {
    const html = '<html><head><title>a</title><p>1 < 2</p></head><body>x</body></html>';
    expect(scanHeadTags(html).closingHead).toBe(html.indexOf('</head>'));
    expect(scanHeadTags(html).bodyStart).toBe(html.indexOf('<body>'));
  });

  it('finds nothing after an unterminated doctype or processing instruction', () => {
    expect(scanHeadTags('<!doctype html <body')).toEqual({ closingHead: undefined, bodyStart: undefined });
    expect(scanHeadTags('<?xml version="1.0" <body')).toEqual({
      closingHead: undefined,
      bodyStart: undefined,
    });
  });

  it('ends a tag with an unterminated quoted attribute value at the end of the text', () => {
    expect(scanHeadTags('<p class="open </head><body>')).toEqual({ closingHead: undefined, bodyStart: undefined });
  });

  it('reads an attribute value after whitespace following the equals sign, quoted or not', () => {
    const html = '<head data-x =  "a>b" data-y=  c></head><body>';
    expect(scanHeadTags(html).closingHead).toBe(html.indexOf('</head>'));
    expect(findHeadStartEnd(html)).toBe(html.indexOf('></head>') + 1);
  });
});

describe('head scanning follows HTML comment and script states', () => {
  it.each(['<!-- hidden --!>', '<!-->', '<!--->', '<!-- hidden -->'])('resumes after comment %j', (comment) => {
    const html = `${comment}<head></head><body>`;
    expect(findHeadStartEnd(html)).toBe(comment.length + 6);
    expect(scanHeadTags(html)).toEqual({ closingHead: comment.length + 6, bodyStart: comment.length + 13 });
  });

  it('keeps tags inside a comment whose end-bang sequence is incomplete hidden', () => {
    expect(scanHeadTags('<!-- hidden --! </head><body>')).toEqual({ closingHead: undefined, bodyStart: undefined });
  });

  it.each([
    '<script>const x="<!--<script></script></head><body>";</script>',
    '<script>const x="<!--<SCRIPT ></ScRiPt ></head><body>";</script>',
    '<script>const x="<!--<script/ ></script/ ></head><body>";</script>',
    '<script>const x="<!--<script><script></script></head><body>";</script>',
    '<script>const x="<!--<script></scripture></script></head><body>";</script>',
  ])('does not end a double-escaped script at an inner end tag in %j', (script) => {
    const html = `<head>${script}</head><body>`;
    expect(scanHeadTags(html)).toEqual({ closingHead: script.length + 6, bodyStart: script.length + 13 });
  });

  it.each([
    '<script><!--><script></script>',
    '<script><!--<script>--></script>',
    '<script><!--<script></script>--></script>',
    '<script><!--<scripture></script>',
    '<script><!--<script!></script>',
  ])('recognizes the first end tag after leaving an escaped state in %j', (script) => {
    const html = `${script}</head><body>`;
    expect(scanHeadTags(html)).toEqual({ closingHead: script.length, bodyStart: script.length + 7 });
  });

  it('keeps an unclosed double-escaped script as text', () => {
    expect(scanHeadTags('<script><!--<script></script></head><body>')).toEqual({
      closingHead: undefined,
      bodyStart: undefined,
    });
  });

  it('finds the head opener after a double-escaped script, not one inside its text', () => {
    const script = '<script>const x="<!--<script></script><head>";</script>';
    expect(findHeadStartEnd(`${script}<head></head><body>`)).toBe(script.length + 6);
  });

  it.each(['iframe', 'xmp', 'noembed', 'noframes', 'noscript'])(
    'ignores tags in %s text with scripting enabled',
    (name) => {
      const context = `<${name}></head><body><head></${name}>`;
      const html = `${context}<head></head><body>`;
      expect(findHeadStartEnd(html)).toBe(context.length + 6);
      expect(scanHeadTags(html)).toEqual({ closingHead: context.length + 6, bodyStart: context.length + 13 });
    },
  );

  it.each([
    '<!doctype html SYSTEM "a <head </head <body">',
    "<!doctype html SYSTEM 'a <head </head <body'>",
    '<!doctype html PUBLIC "a <head </head <body" "b <head </head <body">',
    '<!DOCTYPE html SYSTEM"a <head </head <body">',
  ])('keeps quoted doctype identifier text from becoming tags in %j', (doctype) => {
    const html = `${doctype}<head></head><body>`;
    expect(findHeadStartEnd(html)).toBe(doctype.length + 6);
    expect(scanHeadTags(html)).toEqual({ closingHead: doctype.length + 6, bodyStart: doctype.length + 13 });
  });

  it.each(['<!doctype html SYSTEM "a > ', "<!doctype html SYSTEM 'a > ", '<!doctype html PUBLIC "a > '])(
    'resumes HTML at an abruptly terminated quoted doctype identifier %j',
    (doctype) => {
      // WHATWG abrupt-doctype-{public,system}-identifier and Chrome both close at this `>`.
      expect(scanHeadTags(`${doctype}<head></head><body>`)).toEqual({
        closingHead: doctype.length + 6,
        bodyStart: doctype.length + 13,
      });
      expect(findHeadStartEnd(`${doctype}<head>`)).toBe(doctype.length + 6);
    },
  );

  it('keeps source offsets in UTF-16 code units across Unicode and CRLF', () => {
    const prefix = '<!-- 😀\r\n -->';
    expect(findHeadStartEnd(`${prefix}<head></head><body>`)).toBe(prefix.length + 6);
    expect(scanHeadTags(`${prefix}<head></head><body>`)).toEqual({
      closingHead: prefix.length + 6,
      bodyStart: prefix.length + 13,
    });
  });

  it('retains explicit head boundaries in independently parsed header/footer fragments', () => {
    expect(findHeadStartEnd('<head>')).toBe(6);
    expect(scanHeadTags('</head><body>')).toEqual({ closingHead: 0, bodyStart: 7 });
  });

  it('does not treat an arbitrary doctype quote as opening an identifier', () => {
    const doctype = '<!doctype html unknown "ignored >';
    expect(findHeadStartEnd(`${doctype}<head>`)).toBe(doctype.length + 6);
  });

  it('never resumes markup after a plaintext opener, even at a purported closing tag', () => {
    expect(scanHeadTags('<plaintext></head><body></plaintext></head><body>')).toEqual({
      closingHead: undefined,
      bodyStart: undefined,
    });
  });

  it('ignores head and body tags in nested inert templates', () => {
    const template = '<template></head><body><head><template></head><body></template></template>';
    expect(scanHeadTags(`<head>${template}</head><body>`)).toEqual({
      closingHead: template.length + 6,
      bodyStart: template.length + 13,
    });
    expect(findHeadStartEnd(`${template}<body>`)).toBeUndefined();
  });

  it('uses tree context for templates nested through a table', () => {
    const template = '<template><table><template></head><body><head></template></table></template>';
    expect(scanHeadTags(`<head>${template}</head><body>`)).toEqual({
      closingHead: template.length + 6,
      bodyStart: template.length + 13,
    });
  });

  it('keeps foreign script/style CDATA in foreign context rather than HTML raw text', () => {
    const foreign =
      '<svg><style><![CDATA[literal > </head><body>]]></style><script><![CDATA[literal > </head><body>]]></script></svg>';
    expect(scanHeadTags(`${foreign}</head><body>`)).toEqual({
      closingHead: foreign.length,
      bodyStart: foreign.length + 7,
    });
  });

  it('recognizes HTML script text at a foreign integration point', () => {
    const foreign =
      '<svg><foreignObject><script>const x="<!--<script></script></head><body>";</script></foreignObject></svg>';
    expect(scanHeadTags(`${foreign}</head><body>`)).toEqual({
      closingHead: foreign.length,
      bodyStart: foreign.length + 7,
    });
  });

  it('resumes HTML after a tag that exits foreign content', () => {
    const foreign = '<svg><g><p>HTML</p>';
    expect(findHeadStartEnd(`${foreign}<head>`)).toBe(foreign.length + 6);
  });

  it('treats CDATA-like markup outside foreign content as a bogus comment', () => {
    const comment = '<![CDATA[literal >';
    expect(scanHeadTags(`${comment}</head><body>`)).toEqual({
      closingHead: comment.length,
      bodyStart: comment.length + 7,
    });
  });

  it.each(['svg', 'math'])('ignores CDATA look-alikes in %s after an omitted head end tag', (name) => {
    const beforeBody = '<head><title>Review</title>';
    const foreign = `<${name}><![CDATA[literal > </head><body><head>]]></${name}>`;
    expect(scanHeadTags(`${beforeBody}<body>${foreign}`)).toEqual({
      closingHead: undefined,
      bodyStart: beforeBody.length,
    });
  });

  it.each(['svg', 'math'])('resumes after a self-closing %s root', (name) => {
    const foreign = `<${name} data-value="quoted />"/>`;
    expect(findHeadStartEnd(`${foreign}<head>`)).toBe(foreign.length + 6);
  });

  it('keeps an unquoted slash in an attribute value from self-closing a foreign root', () => {
    const foreign = '<svg data-value=x/><![CDATA[literal > </head><body>]]></svg>';
    expect(scanHeadTags(`${foreign}</head><body>`)).toEqual({
      closingHead: foreign.length,
      bodyStart: foreign.length + 7,
    });
  });
});

describe('public compilation preserves HTML tokenizer boundaries', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-head-states-'));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  for (const kind of ['twine1', 'twine2'] as const) {
    it.each([
      ['comment end bang', '<!-- hidden --!>', ''],
      ['double-escaped script', '', '<script>const x="<!--<script></script></head>";</script>'],
      ['noscript text', '', '<noscript>literal </head><body></noscript>'],
      ['noframes text', '', '<noframes>literal </head><body></noframes>'],
      ['doctype system identifier', '<!doctype html SYSTEM "literal <head </head <body">', ''],
      ['nested template', '', '<template>literal </head><body><template></head><body></template></template>'],
    ])(`injects outside the %s in ${kind} HTML`, async (_label, before, script) => {
      const formats = join(tmpDir, 'formats');
      const id = 'review';
      const dir = join(formats, id);
      mkdirSync(dir, { recursive: true });
      const template = `${before}<html><head>${script}</head><body>${kind === 'twine2' ? '{{STORY_DATA}}' : '<div id="storeArea">"STORY"</div>'}</body></html>`;
      if (kind === 'twine2') {
        writeFileSync(
          join(dir, 'format.js'),
          `window.storyFormat(${JSON.stringify({ name: 'Review', version: '1.0.0', source: template })});`,
        );
      } else {
        writeFileSync(join(dir, 'header.html'), template);
      }
      const headFile = join(tmpDir, 'head.html');
      const meta = '<meta name="review" content="injected">';
      writeFileSync(headFile, meta);
      const result = await compile({
        sources: [
          {
            filename: 'story.tw',
            content:
              ':: StoryTitle\nReview\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nHello',
          },
        ],
        formatId: id,
        formatPaths: [formats],
        headFile,
        noRemote: true,
        useTweegoPath: false,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.output.startsWith(`${before}<html><head>${script}${meta}\n</head><body>`)).toBe(true);
    });

    it.each(['svg', 'math'])(`injects before the real body boundary preceding %s CDATA in ${kind}`, async (name) => {
      const formats = join(tmpDir, 'formats');
      const dir = join(formats, 'review');
      mkdirSync(dir, { recursive: true });
      const prefix = '<html><head><title>Review</title>';
      const foreign = `<${name}><![CDATA[literal > </head><body>]]></${name}>`;
      const template = `${prefix}<body>${foreign}${kind === 'twine2' ? '{{STORY_DATA}}' : '<div id="storeArea">"STORY"</div>'}</body></html>`;
      if (kind === 'twine2') {
        writeFileSync(
          join(dir, 'format.js'),
          `window.storyFormat(${JSON.stringify({ name: 'Review', version: '1.0.0', source: template })});`,
        );
      } else {
        writeFileSync(join(dir, 'header.html'), template);
      }
      const headFile = join(tmpDir, 'head.html');
      const meta = '<meta name="review" content="injected">';
      writeFileSync(headFile, meta);
      const result = await compile({
        sources: [
          {
            filename: 'story.tw',
            content:
              ':: StoryTitle\nReview\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nHello',
          },
        ],
        formatId: 'review',
        formatPaths: [formats],
        headFile,
        noRemote: true,
        useTweegoPath: false,
      });
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.message).toContain('injected before its body start tag');
      expect(result.output.startsWith(`${prefix}${meta}\n<body>${foreign}`)).toBe(true);
    });
  }
});

describe('loadModules: font types', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-modules-fonts-'));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it.each(['otf', 'ttf', 'woff', 'woff2'])('embeds a .%s file as a base64 @font-face', (ext) => {
    const file = join(tmpDir, `Face.${ext}`);
    writeFileSync(file, 'font-bytes');
    const result = loadModules([file]);
    expect(result).toContain('@font-face');
    expect(result).toContain(Buffer.from('font-bytes').toString('base64'));
  });

  it('warns instead of throwing when the head file cannot be read', () => {
    const diagnostics: { level: string; message: string }[] = [];
    const content = loadHeadContent([], join(tmpDir, 'missing.html'), diagnostics as never);
    expect(content).toBe('');
    expect(diagnostics.some((d) => d.level === 'warning' && d.message.includes('missing.html'))).toBe(true);
  });
});

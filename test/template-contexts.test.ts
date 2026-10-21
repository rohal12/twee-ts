/**
 * Where a placeholder sits (as parse5 reports it) and how the value is escaped there (issue #244 RC3), one context
 * at a time; the property tests in html-insertion-property.test.ts check the values against the oracle.
 */
import { describe, it, expect } from 'vitest';
import { analyzeTemplate } from '../src/html-structure.js';
import type { PlaceholderOccurrence } from '../src/html-structure.js';
import { escapeForContext } from '../src/escape.js';
import { fillFormatTemplate } from '../src/template.js';
import type { Placeholder } from '../src/template.js';
import { evaluateJavaScript } from './helpers/javascript.js';

/** The site of each `{{X}}` (or `"X"`) in `template`. */
function sites(template: string) {
  const occurrences: PlaceholderOccurrence[] = [...template.matchAll(/\{\{X\}\}|"X"/g)].map((m) => {
    const d = m[0].startsWith('{') ? 2 : 1;
    return { start: m.index, end: m.index + m[0].length, innerStart: m.index + d, innerEnd: m.index + m[0].length - d };
  });
  return analyzeTemplate(template, occurrences).sites;
}

describe('placeholder sites', () => {
  it.each([' ', '\t', '\n', '\f', '\r', '\u00a0', '\u2003', '\uFEFF'])(
    'preserves script contexts around long %j runs (#496)',
    (space) => {
      const padding = space.repeat(16_000);
      const ascii = [' ', '\t', '\n', '\f', '\r'].includes(space);
      expect(sites(`<script type="text/javascript${padding}x">"{{X}}"</script>`)[0]?.context).toEqual({
        kind: 'raw-text',
        element: 'script',
      });
      expect(sites(`<script type="${padding}TEXT/JAVASCRIPT${padding}">"{{X}}"</script>`)[0]?.context).toEqual(
        ascii
          ? { kind: 'script', module: false, js: { kind: 'string', quote: '"', whole: false }, escapable: false }
          : { kind: 'raw-text', element: 'script' },
      );
    },
  );

  it.each([
    ['<title>{{X}}</title>', { kind: 'text', dropsLeadingNewline: false }],
    ['<p>{{X}}</p>', { kind: 'text', dropsLeadingNewline: false }],
    ['<pre>{{X}}</pre>', { kind: 'text', dropsLeadingNewline: true }],
    ['<pre>a{{X}}</pre>', { kind: 'text', dropsLeadingNewline: false }],
    ['<template>{{X}}</template>', { kind: 'text', dropsLeadingNewline: false }],
    ['<svg><text>{{X}}</text></svg>', { kind: 'text', dropsLeadingNewline: false }],
    ['<svg><![CDATA[{{X}}]]></svg>', { kind: 'raw-text', element: 'svg' }],
    ['<svg><![CDATA[a]]>{{X}}</svg>', { kind: 'text', dropsLeadingNewline: false }],
    ['<xmp>{{X}}</xmp>', { kind: 'raw-text', element: 'xmp' }],
    ['<plaintext>{{X}}', { kind: 'raw-text', element: 'plaintext' }],
    // The tree builder reopens the i element inside plaintext and puts the text there; it is still raw text.
    ['<p><i>a</p><plaintext>{{X}}', { kind: 'raw-text', element: 'plaintext' }],
    ['<noscript>{{X}}</noscript>', { kind: 'text', dropsLeadingNewline: false }],
    ['<!-- {{X}} -->', { kind: 'comment' }],
    ['<p title="{{X}}">', { kind: 'attribute', quote: '"', url: false }],
    ["<p title = '{{X}}'>", { kind: 'attribute', quote: "'", url: false }],
    ['<p title={{X}}>', { kind: 'attribute', quote: '', url: false }],
    ['<a href="{{X}}">', { kind: 'attribute', quote: '"', url: true }],
    ['<svg><a xlink:href="{{X}}"></a></svg>', { kind: 'attribute', quote: '"', url: true }],
    ['<p{{X}}>', { kind: 'markup' }],
    ['<p {{X}}=1>', { kind: 'markup' }],
    ['<!DOCTYPE {{X}}>', { kind: 'markup' }],
    ['<p a="1" a="{{X}}">', { kind: 'markup' }],
    ['<style>a::after { content: "{{X}}" }</style>', { kind: 'style', css: { kind: 'string', quote: '"' } }],
    ['<style>a { b: {{X}} }</style>', { kind: 'style', css: { kind: 'code' } }],
    ['<script type="text/template">{{X}}</script>', { kind: 'raw-text', element: 'script' }],
    [
      '<script type="application/ld+json">{"a": "{{X}}"}</script>',
      { kind: 'json', js: { kind: 'string', quote: '"', whole: false }, escapable: false },
    ],
    [
      '<script type="module">a("{{X}}")</script>',
      { kind: 'script', module: true, js: { kind: 'string', quote: '"', whole: false }, escapable: false },
    ],
    [
      '<script language="javascript">a("{{X}}")</script>',
      { kind: 'script', module: false, js: { kind: 'string', quote: '"', whole: false }, escapable: false },
    ],
    ['<script language="vbscript">a("{{X}}")</script>', { kind: 'raw-text', element: 'script' }],
    [
      '<script language="">a("{{X}}")</script>',
      { kind: 'script', module: false, js: { kind: 'string', quote: '"', whole: false }, escapable: false },
    ],
    ['<script type=" ">a("{{X}}")</script>', { kind: 'raw-text', element: 'script' }],
    [
      '<script type="">a("{{X}}")</script>',
      { kind: 'script', module: false, js: { kind: 'string', quote: '"', whole: false }, escapable: false },
    ],
    ['<script type="text/javascript; charset=utf-8">a("{{X}}")</script>', { kind: 'raw-text', element: 'script' }],
    [
      '<script><!--\na("{{X}}")</script>',
      { kind: 'script', module: false, js: { kind: 'string', quote: '"', whole: false }, escapable: true },
    ],
  ])('%s', (template, context) => {
    expect(sites(template)[0]?.context).toEqual(context);
  });

  it.each([
    ['svg', 'text', { kind: 'raw-text', element: 'text' }],
    ['math', 'mrow', { kind: 'raw-text', element: 'mrow' }],
    // MathML text integration points read CDATA syntax as an HTML bogus comment.
    ['math', 'mi', { kind: 'comment' }],
  ])('keeps CDATA state across placeholders and separate %s/%s text nodes', (root, element, raw) => {
    const content = '{{X}}<![CDATA[{{X}}{{X}}]]>{{X}}<![CDATA[{{X}}]]><![CDATA[{{X}}]]>{{X}}';
    const template = `<${root}><${element}>${content}</${element}><${element}>{{X}}</${element}></${root}>`;
    const text = { kind: 'text', dropsLeadingNewline: false };
    expect(sites(template).map((site) => site.context)).toEqual([text, raw, raw, text, raw, raw, text, text]);
  });

  it('tells how the delimiters of a quoted placeholder are read', () => {
    expect(sites('<script>a = "X";</script>')[0]?.delimiters).toBe('string');
    expect(sites('<div data-size="X">')[0]?.delimiters).toBe('attribute');
    expect(sites('<div>"X"</div>')[0]?.delimiters).toBe('inside');
    expect(sites('<div title="a"X"">')[0]?.delimiters).toBe('split');
  });

  it('makes markers from private-use characters the template does not hold', () => {
    const template = `<p>\uE000\uE001{{X}}\uF8FF</p>`;
    expect(sites(template)[0]?.context).toEqual({ kind: 'text', dropsLeadingNewline: false });
  });
});

describe('escapeForContext', () => {
  it.each([
    [{ kind: 'text', dropsLeadingNewline: false }, 'a&<>"\'\rb', 'a&amp;&lt;&gt;&quot;&#39;&#13;b'],
    [{ kind: 'attribute', quote: '"', url: false }, 'a "b"', 'a &quot;b&quot;'],
    [{ kind: 'attribute', quote: '', url: false }, 'a=b`c\td', 'a&#61;b&#96;c&#9;d'],
    [{ kind: 'attribute', quote: '"', url: true }, 'a b&c', 'a%20b%26c'],
    [{ kind: 'comment' }, '-a--b-', '&#45;a&#45;-b&#45;'],
    [
      { kind: 'script', module: false, js: { kind: 'string', quote: '"', whole: false }, escapable: false },
      'a\\b\n"',
      'a\\u005cb\\u000a&quot;',
    ],
    [
      { kind: 'script', module: false, js: { kind: 'template', tagged: false }, escapable: false },
      '`${a}`',
      '\\`\\${a}\\`',
    ],
    [{ kind: 'script', module: false, js: { kind: 'block-comment' }, escapable: false }, 'a*/b', 'a* /b'],
    [{ kind: 'script', module: false, js: { kind: 'line-comment', start: 0 }, escapable: false }, 'a\nb', 'a b'],
    [
      { kind: 'json', js: { kind: 'string', quote: '"', whole: false }, escapable: false },
      '"</script>\u2028',
      '\\"\\u003c/script>\\u2028',
    ],
    [{ kind: 'style', css: { kind: 'string', quote: "'" } }, "'<\n\\", "\\'\\3c \\a \\\\"],
    [{ kind: 'style', css: { kind: 'comment' } }, 'a*/<', 'a* /&lt;'],
  ] as const)('escapes for %j', (context, value, expected) => {
    expect(escapeForContext(value, context)).toBe(expected);
  });

  it.each([
    { kind: 'attribute', quote: '', url: false },
    { kind: 'script', module: false, js: { kind: 'regexp', flags: '' }, escapable: false },
    { kind: 'script', module: false, js: { kind: 'code' }, escapable: false },
    { kind: 'script', module: false, js: { kind: 'unparsable', reason: 'x' }, escapable: false },
    { kind: 'json', js: { kind: 'string', quote: "'", whole: false }, escapable: false },
    { kind: 'style', css: { kind: 'code' } },
    { kind: 'raw-text', element: 'xmp' },
    { kind: 'markup' },
  ] as const)('cannot escape for %j', (context) => {
    // An unquoted attribute value cannot be empty.
    expect(escapeForContext(context.kind === 'attribute' ? '' : 'x', context)).toBeUndefined();
  });
});

describe('fillFormatTemplate: placeholders where no escaping helps', () => {
  const name = (token = '{{STORY_NAME}}'): Placeholder => ({
    token,
    occurrences: 'all',
    value: { kind: 'text', text: 'N' },
  });
  const fill = (template: string, placeholders: readonly Placeholder[]) =>
    fillFormatTemplate({ template, placeholders, owner: 'F' });

  it.each([
    ['<p{{STORY_NAME}}>', 'inside a tag or doctype, or where the HTML parser drops it'],
    ['<script>var {{STORY_NAME}} = 1;</script>', 'in a script (JavaScript code)'],
    ['<script>a("{{STORY_NAME}}</script>', 'in a script (unparsable: Unterminated string constant)'],
    ['<script type="application/json">{{STORY_NAME}}</script>', 'in a JSON script (code)'],
    ['<style>a { b: {{STORY_NAME}} }</style>', 'in a style element (CSS code)'],
    ['<xmp>{{STORY_NAME}}</xmp>', 'in the raw text of a "xmp" element'],
    ['<script>var a = "\\{{STORY_NAME}}";</script>', 'in a script (JavaScript string)'],
  ])('warns for %s and writes the value as Tweego does', (template, where) => {
    const { output, diagnostics } = fill(template, [name()]);
    expect(output).toBe(template.replace('{{STORY_NAME}}', 'N'));
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message: expect.stringContaining(
          `the placeholder {{STORY_NAME}} at line 1, column ${template.indexOf('{{') + 1} is ${where};`,
        ),
      },
    ]);
  });

  it('writes the value into an unquoted attribute value without a warning', () => {
    expect(fill('<p title={{STORY_NAME}}>', [name()])).toEqual({ output: '<p title=N>', diagnostics: [] });
  });

  it('writes a quoted placeholder as a JavaScript string, an attribute value or quoted text', () => {
    const quoted = (text: string): Placeholder => ({
      token: '"X"',
      occurrences: 'all',
      value: { kind: 'quoted', text },
    });
    expect(fill('<script>a = "X";</script>', [quoted('a"</script>')]).output).toBe(
      '<script>a = "a\\"\\x3C/script>";</script>',
    );
    expect(fill('<div data-size="X"></div>', [quoted('6')]).output).toBe('<div data-size="6"></div>');
    expect(fill('<p>"X"</p>', [quoted('<b>')]).output).toBe('<p>"&lt;b&gt;"</p>');
    // A text placeholder whose quotes are an attribute value's quotes cannot keep them.
    const text: Placeholder = { token: '"X"', occurrences: 'all', value: { kind: 'text', text: 'v' } };
    const split = fill('<p title="X"></p>', [text]);
    expect(split.output).toBe('<p title=v></p>');
    expect(split.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('is in an attribute value;')]);
    const apart = fill('<p title="a"X""></p>', [quoted('6')]);
    expect(apart.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('is inside a tag')]);
  });

  it('leaves a placeholder that is only in the footer alone, and fills one with no occurrence with nothing', () => {
    const result = fillFormatTemplate({
      template: '<html><head></head><body>',
      placeholders: [name()],
      tail: {
        data: '<div tiddler="a"></div>',
        footer: '{{STORY_NAME}}</body></html>',
        probe: '<div tiddler=""></div>',
      },
      owner: 'F',
    });
    expect(result.output).toBe('<html><head></head><body><div tiddler="a"></div>{{STORY_NAME}}</body></html>');
  });

  it('writes nothing for an empty pre-1.4 story', () => {
    const result = fillFormatTemplate({
      template: '<html><head></head><body><div id="storeArea">',
      placeholders: [],
      tail: { data: '', footer: '</div></body></html>', probe: '<div tiddler=""></div>' },
      owner: 'F',
    });
    expect(result.output).toBe('<html><head></head><body><div id="storeArea"></div></body></html>');
  });

  it('keeps the line feed of a value at the start of a textarea', () => {
    const { output } = fill('<textarea>{{STORY_NAME}}</textarea>', [
      { token: '{{STORY_NAME}}', occurrences: 'all', value: { kind: 'text', text: '\nN' } },
    ]);
    expect(output).toBe('<textarea>\n\nN</textarea>');
  });

  it('warns when the head content does not stay in the head', () => {
    for (const head of ['<!-- open', '<script>', '<template>', 'text', '<div>x</div>']) {
      const { diagnostics } = fillFormatTemplate({
        template: '<html><head><title>t</title></head><body><p>b</p></body></html>',
        placeholders: [],
        head,
        owner: 'F',
      });
      expect(diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('do not stay in the head')]);
    }
  });
});

describe('tagged template placeholder values (#480)', () => {
  it.each([
    'function(s) { return s.raw[0]; }',
    'function named(s) { return s.raw[0]; }',
    'async function(s) { return s.raw[0]; }',
    '(function(s) { return s.raw[0]; })',
    'String.raw',
  ])('diagnoses function-expression and other tags: %s', (tag) => {
    const result = fillFormatTemplate({
      template: `<script>let x=${tag}\`{{X}}\`;</script>`,
      owner: 'F',
      placeholders: [{ token: '{{X}}', occurrences: 'all', value: { kind: 'text', text: 'a\\b' } }],
    });
    expect(result.diagnostics.map((d) => d.level)).toEqual(['warning']);
    expect(result.diagnostics[0]?.message).toContain('JavaScript template');
  });

  it.each([
    '(function*() { yield `{{X}}`; })().next().value',
    '(function*() { yield* [`{{X}}`]; })().next().value',
    '(async function() { return await `{{X}}`; })()',
    '(async function*() { yield await `{{X}}`; })().next().then(s => s.value)',
  ])('preserves cooked values after contextual operators: %s', async (expression) => {
    const result = fillFormatTemplate({
      template: `<script>return ${expression};</script>`,
      owner: 'F',
      placeholders: [{ token: '{{X}}', occurrences: 'all', value: { kind: 'text', text: 'a\\b' } }],
    });
    expect(result.diagnostics).toEqual([]);
    expect(await evaluateJavaScript(result.output.slice('<script>'.length, -'</script>'.length))).toBe('a\\b');
  });

  it.each(['a\\b', '`', '${x}', '$', '\n', '\r', '\u2028', '\u2029'])(
    'diagnoses a value requiring raw-text changes: %j',
    (text) => {
      const result = fillFormatTemplate({
        template: '<script>let x=String.raw`{{X}}`;</script>',
        owner: 'F',
        placeholders: [{ token: '{{X}}', occurrences: 'all', value: { kind: 'text', text } }],
      });
      expect(result.diagnostics.map((d) => d.level)).toEqual(['warning']);
      expect(result.diagnostics[0]?.message).toContain('JavaScript template');
    },
  );
  it('preserves plain raw text without warning', () => {
    expect(
      fillFormatTemplate({
        template: '<script>let x=String.raw`{{X}}`;</script>',
        owner: 'F',
        placeholders: [{ token: '{{X}}', occurrences: 'all', value: { kind: 'text', text: 'Alpha' } }],
      }),
    ).toEqual({ output: '<script>let x=String.raw`Alpha`;</script>', diagnostics: [] });
  });
});

it('diagnoses raw changes required at a tagged template boundary', () => {
  const result = fillFormatTemplate({
    template: '<script>let x=String.raw`<{{X}}`;</script>',
    owner: 'F',
    placeholders: [{ token: '{{X}}', occurrences: 'all', value: { kind: 'text', text: '/script x' } }],
  });
  expect(result.diagnostics.map((d) => d.level)).toEqual(['warning']);
});

it('selects the first supported occurrence past an unsupported tagged template', () => {
  expect(
    fillFormatTemplate({
      template: '<script>let x=String.raw`{{X}}`;let y="{{X}}";let z="{{X}}";</script>',
      owner: 'F',
      placeholders: [{ token: '{{X}}', occurrences: 'first', value: { kind: 'text', text: 'a\\b' } }],
    }),
  ).toEqual({
    output: '<script>let x=String.raw`{{X}}`;let y="a\\u005cb";let z="{{X}}";</script>',
    diagnostics: [],
  });
});

it('selects the first supported site using the preceding replacement rather than its token', () => {
  expect(
    fillFormatTemplate({
      template: '<script>let x=String.raw`<{{A}}{{B}}`;let y="{{B}}";</script>',
      owner: 'F',
      placeholders: [
        { token: '{{B}}', occurrences: 'first', value: { kind: 'text', text: ' x' } },
        { token: '{{A}}', occurrences: 'all', value: { kind: 'text', text: '/script' } },
      ],
    }),
  ).toEqual({
    output: '<script>let x=String.raw`</script{{B}}`;let y=" x";</script>',
    diagnostics: [],
  });
});

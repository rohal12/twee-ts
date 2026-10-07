/**
 * A value must form nothing with the template text right before or after its placeholder (issue #244 RC3): no
 * character reference, tag, end tag, comment end, `</script`, `<!--`, `-->`, escape sequence or line break pair.
 */
import { describe, it, expect, vi } from 'vitest';
import { fillFormatTemplate } from '../src/template.js';
import { analyzeTemplate, locateHeadStart } from '../src/html-structure.js';
import { escapeForContext } from '../src/escape.js';
import { codeEscapeDiagnostics } from '../src/html-output-check.js';
import type { InsertionContext } from '../src/escape.js';
import { judgeStoryName } from './helpers/insertion-judges.js';

function fillName(template: string, text: string) {
  return fillFormatTemplate({
    template,
    placeholders: [{ token: '{{STORY_NAME}}', occurrences: 'all', value: { kind: 'text', text } }],
    owner: 'B',
  });
}

describe('escaping at the boundary with the template text', () => {
  it.each([
    ['<script>a("<{{STORY_NAME}}")</script>', '/script x', '<script>a("<\\u{2f}script x")</script>'],
    [
      '<script type="application/json">{"a": "<{{STORY_NAME}}"}</script>',
      '/script x',
      '<script type="application/json">{"a": "<\\u002fscript x"}</script>',
    ],
    [
      '<style>a::after { content: "<{{STORY_NAME}}" }</style>',
      '/style x',
      '<style>a::after { content: "<\\2f style x" }</style>',
    ],
    ['<script><!--\na("{{STORY_NAME}}>")</script>', 'a--', '<script><!--\na("a-\\u{2d}>")</script>'],
    ['<script>a("{{STORY_NAME}}>")</script>', 'a--', '<script>a("a-->")</script>'],
    ['<script>/*{{STORY_NAME}}/*/</script>', 'a*', '<script>/*a* /*/</script>'],
    ['<script>/**{{STORY_NAME}}*/</script>', '/a', '<script>/** /a*/</script>'],
    ['<script>/*<{{STORY_NAME}}*/</script>', '/script x', '<script>/*< /script x*/</script>'],
    ['<script>//{{STORY_NAME}}\n</script>', 'a\nb', '<script>//a b\n</script>'],
    ['<style>/*{{STORY_NAME}}/ */</style>', '*', '<style>/** / */</style>'],
    ['<p>\r{{STORY_NAME}}</p>', '\nb', '<p>\r&#10;b</p>'],
    ['<p>&am{{STORY_NAME}}</p>', 'p;', '<p>&am&#112;;</p>'],
    ['<p title="&am{{STORY_NAME}}">x</p>', 'p;', '<p title="&am&#112;;">x</p>'],
    ['<p>&lt;{{STORY_NAME}}</p>', 'p;', '<p>&lt;p;</p>'],
    ['<title></ti{{STORY_NAME}}</title>', 'tle x', '<title></ti&#116;le x</title>'],
    ['<p><{{STORY_NAME}}</p>', 'b>', '<p><&#98;&gt;</p>'],
    ['</{{STORY_NAME}}>', 'a', '</&#97;>'],
    ['<!{{STORY_NAME}}>', 'doctype x', '<!&#100;octype x>'],
    ['<!-- a--{{STORY_NAME}} -->', '!x', '<!-- a--&#33;x -->'],
    ['<!-- a-{{STORY_NAME}} -->', '-x', '<!-- a-&#45;x -->'],
    ['<textarea>{{STORY_NAME}}\n</textarea>', '', '<textarea>\n\n</textarea>'],
    ['<pre>{{STORY_NAME}}</pre>', 'a', '<pre>a</pre>'],
    ['<script><!--\na("{{STORY_NAME}}->")</script>', 'a-', '<script><!--\na("a\\u{2d}->")</script>'],
    ['<p>{{STORY_NAME}}', '', '<p>'],
  ])('%j with %j', (template, value, expected) => {
    const { output, diagnostics } = fillName(template, value);
    expect(output).toBe(expected);
    expect(diagnostics).toEqual([]);
    expect(judgeStoryName(`<!doctype html><html><head></head><body>${template}</body></html>`, value)).toBeUndefined();
  });

  it.each([
    ['</{{STORY_NAME}}>', ''],
    ['<!-- a--!{{STORY_NAME}}> -->', ''],
    ['<p>&am{{STORY_NAME}}p;</p>', ''],
    ['<style>a::after { content: "\\{{STORY_NAME}}" }</style>', 'x'],
    ['<script type="application/json">{"a": "\\{{STORY_NAME}}"}</script>', 'x'],
  ])('warns for %j with %j, where no escaping helps', (template, value) => {
    const { diagnostics } = fillName(template, value);
    expect(diagnostics.map((d) => d.level)).toEqual(['warning']);
  });
});

describe('quoted placeholders where their quotes cannot be kept', () => {
  const quoted = (template: string) =>
    fillFormatTemplate({
      template,
      placeholders: [{ token: '"X"', occurrences: 'all', value: { kind: 'quoted', text: 'v' } }],
      owner: 'B',
    });

  it('warns in raw text', () => {
    expect(quoted('<xmp>"X"</xmp>').diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('is in the raw text of a "xmp" element'),
    ]);
  });

  it('warns in an attribute merged into the html element, whose quotes are not known', () => {
    expect(quoted('<html><body><html a="X">').diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('is where its delimiters are read apart from it'),
    ]);
  });
});

describe('structure location edge cases', () => {
  it('finds a head start tag past the first 64 KiB, and an implied head after a long prefix', () => {
    const filler = `<!-- ${'x'.repeat(70000)} -->`;
    const late = `<!doctype html>${filler}<html><head></head><body></body></html>`;
    expect(locateHeadStart(late)).toEqual({ offset: late.indexOf('<head>') + 6, how: 'start-tag' });
    const implied = `<!doctype html>${filler}<p>x</p>`;
    expect(locateHeadStart(implied)).toEqual({ offset: implied.indexOf('<p>'), how: 'implied-start' });
  });

  it('reads an attribute merged into the html element as having no recorded quote', () => {
    const occurrence = { start: 31, end: 45, innerStart: 33, innerEnd: 43 };
    const template = '<html><body><html title="x" a="{{STORY_NAME}}">';
    expect(template.slice(occurrence.start, occurrence.end)).toBe('{{STORY_NAME}}');
    expect(analyzeTemplate(template, [occurrence]).sites[0]?.context).toEqual({
      kind: 'attribute',
      quote: '',
      url: false,
    });
  });

  it('gives up on a template that holds every private-use character', () => {
    let pua = '';
    for (let code = 0xe000; code <= 0xf8ff; code++) pua += String.fromCharCode(code);
    const template = `<p>${pua}{{X}}</p>`;
    const at = template.indexOf('{{X}}');
    const analyze = (): unknown =>
      analyzeTemplate(template, [{ start: at, end: at + 5, innerStart: at + 2, innerEnd: at + 3 }]);
    expect(analyze).toThrow('Too many placeholders to analyze in this template.');
    expect(analyze).toThrow(expect.objectContaining({ name: 'TweeTsError', code: 'FORMAT_UNAVAILABLE' }));
  });
});

describe('unknown variants are rejected', () => {
  it('throws for an insertion context it does not know', () => {
    const unknown = (context: unknown): InsertionContext => context as InsertionContext;
    expect(() => escapeForContext('x', unknown({ kind: 'nope' }))).toThrow('Unhandled insertion context');
    // Within a script or style element, a context it does not know is one where no escaping keeps the value.
    expect(escapeForContext('x', unknown({ kind: 'script', js: { kind: 'nope' } }))).toBeUndefined();
    expect(escapeForContext('x', unknown({ kind: 'style', css: { kind: 'nope' } }))).toBeUndefined();
  });
});

describe('code escape diagnostics: locations (#309)', () => {
  it('numbers lines from the start of the part, across parts and carriage returns', () => {
    const text = 'a\nb\r\nc`</script>`\nmodule\n\n`</script>`';
    const parts = [
      { label: 'script passage "A"', start: 0 },
      { label: 'module "m.js"', start: text.indexOf('module') },
    ] as const;
    expect(codeEscapeDiagnostics('script', { text, parts }).map((d) => d.message)).toEqual([
      'The script passage "A" has a carriage return at line 2, which the HTML parser reads as a line feed in a script element.',
      expect.stringContaining('The script passage "A" has "</script" at line 3 '),
      expect.stringContaining('The module "m.js" has "</script" at line 3 '),
    ]);
  });

  it('does work that grows linearly with the number of warnings', () => {
    const scanned = (sites: number): number => {
      const text = 'const x = String.raw`\n' + '</script>\n'.repeat(sites) + '`;';
      const split = vi.spyOn(String.prototype, 'split');
      try {
        const diagnostics = codeEscapeDiagnostics('script', { text, parts: [{ label: 'module "m.js"', start: 0 }] });
        expect(diagnostics).toHaveLength(sites);
        return split.mock.contexts.reduce((sum: number, c) => sum + (c as string).length, 0);
      } finally {
        split.mockRestore();
      }
    };
    expect(scanned(4000)).toBeLessThanOrEqual(scanned(1000) * 8 + 100_000);
    expect(scanned(4000)).toBeLessThan(500_000);
  });
});

describe('code escape diagnostics', () => {
  const warnings = (text: string) =>
    codeEscapeDiagnostics('script', { text, parts: [{ label: 'module "m.js"', start: 0 }] });

  it('warns for <!-- escaped in a u or v regular expression, not in another', () => {
    expect(warnings('var r = /<!--/u; var s = "<script>";')).toHaveLength(1);
    expect(warnings('var r = /<!--/; var s = "<script>";')).toEqual([]);
  });

  it('warns for </style outside a CSS string or comment', () => {
    const style = (text: string) =>
      codeEscapeDiagnostics('style', { text, parts: [{ label: 'module "m.css"', start: 0 }] });
    expect(style('a { content: "</style>"; } /* </style> */')).toEqual([]);
    expect(style('a { b: </style> }').map((d) => d.message)).toEqual([
      expect.stringContaining('The module "m.css" has "</style" at line 1 outside a string'),
    ]);
  });
});

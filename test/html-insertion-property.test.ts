/**
 * Property tests for HTML insertion (issue #244), with parse5 as the oracle:
 * - P1/P2: for random templates built from a grammar of tokenizer-state fragments, every insertion lands where it
 *   belongs (modules, head file and Vite client exactly once as elements of the head; IFID comment before the store
 *   area; story data as live elements) and the rest of the document is unchanged;
 * - P3: for random values and random template text around a placeholder, in every insertion context, the reader of
 *   that context gets the value back (HTML text and attributes decoded, JavaScript, JSON and CSS strings evaluated),
 *   or there is a diagnostic.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Script } from 'node:vm';
import { fillFormatTemplate } from '../src/template.js';
import { failures, judgeStoryName } from './helpers/insertion-judges.js';
import { attr, elements, parseDocument, textContent } from './helpers/html.js';

/** Fragments that change the tokenizer state or the tree-construction context, and look-alikes of targets. */
const FRAGMENTS = [
  '<!--',
  '-->',
  '--!>',
  '<!-->',
  '<!--->',
  '</ ',
  '</!',
  '<?x',
  '<!x',
  '>',
  '"',
  "'",
  '=',
  'a',
  ' ',
  '&',
  '&amp',
  '<script>',
  '</script>',
  '<script type="text/template">',
  '<style>',
  '</style>',
  '<title>',
  '</title>',
  '<textarea>',
  '</textarea>',
  '<xmp>',
  '</xmp>',
  '<iframe>',
  '</iframe>',
  '<noembed>',
  '</noembed>',
  '<noframes>',
  '</noframes>',
  '<noscript>',
  '</noscript>',
  '<template>',
  '</template>',
  '<svg>',
  '</svg>',
  '<math>',
  '</math>',
  '<![CDATA[',
  ']]>',
  '<meta a=',
  '<meta ',
  '<i ',
  '<p>',
  '<table>',
  '<select>',
  '<frameset>',
  '<plaintext>',
  '</head>',
  '<head>',
  '<body>',
  '</body>',
  '<html>',
  '<div id="storeArea">',
  "<div id='store-area'>",
  '{{STORY_NAME}}',
  '{{STORY_DATA}}',
  '"STORY"',
  '<!DOCTYPE html>',
];

const fragmentText = fc.array(fc.constantFrom(...FRAGMENTS), { minLength: 0, maxLength: 7 }).map((f) => f.join(''));

/** A template: a Twine-shaped document with random fragments in the head, the body and before the document. */
const template = fc
  .tuple(fragmentText, fragmentText, fragmentText, fc.boolean())
  .map(
    ([before, head, body, doctype]) =>
      `${doctype ? '<!doctype html>' : ''}${before}<html><head><title>{{STORY_NAME}}</title>${head}</head><body>${body}` +
      '<div id="storeArea" data-size="STORY_SIZE" hidden>"STORY"</div>{{STORY_DATA}}' +
      '<script>var n = "{{STORY_NAME}}";</script></body></html>',
  );

describe('P1/P2: a closing head tag the parser ignores', () => {
  // The `</head>` inside the open template is ignored by the parser but recorded as the head's end tag.
  const template =
    '<html><head><title>{{STORY_NAME}}</title><template></head><!--</head><body>' +
    '<div id="storeArea" data-size="STORY_SIZE" hidden>"STORY"</div>{{STORY_DATA}}' +
    '<script>var n = "{{STORY_NAME}}";</script></body></html>';

  it('never puts the modules or the head file into the template element', () => {
    expect(failures('random', template)).toEqual([]);
  });
});

describe('P1/P2: insertions into random templates', { timeout: 120_000 }, () => {
  it('place every insertion where it belongs and leave the rest of the document as it was', () => {
    fc.assert(
      fc.property(template, (t) => {
        expect(failures('random', t)).toEqual([]);
      }),
      { numRuns: 250 },
    );
  });
});

/** Characters that interact with escaping, around and inside a value. */
const RISKY = [
  '&',
  'a',
  '#',
  ';',
  '=',
  '<',
  '/',
  '!',
  '-',
  '>',
  '\\',
  '$',
  '{',
  '*',
  '"',
  "'",
  '`',
  '\n',
  '\r',
  '\u2028',
  ' ',
  'é',
  '\u0001',
];
const risky = (max: number) => fc.string({ unit: fc.constantFrom(...RISKY), maxLength: max });
const value = fc.string({
  unit: fc.oneof(fc.constantFrom(...RISKY), fc.string({ unit: 'grapheme', maxLength: 1 })),
  maxLength: 12,
});

describe('P3: a value keeps its meaning in every context', { timeout: 120_000 }, () => {
  /** Templates with the placeholder in one context, between `pre` and `post`. */
  const markupContexts: readonly ((pre: string, post: string) => string)[] = [
    (pre, post) => `<title>${pre}{{STORY_NAME}}${post}</title>`,
    (pre, post) => `<p>${pre}{{STORY_NAME}}${post}</p>`,
    (pre, post) => `<textarea>${pre}{{STORY_NAME}}${post}</textarea>`,
    (pre, post) => `<p title="${pre}{{STORY_NAME}}${post}">x</p>`,
    (pre, post) => `<p title='${pre}{{STORY_NAME}}${post}'>x</p>`,
    (pre, post) => `<p title=${pre}{{STORY_NAME}}${post}>x</p>`,
    (pre, post) => `<a href="${pre}{{STORY_NAME}}${post}">x</a>`,
    (pre, post) => `<!--${pre}{{STORY_NAME}}${post}-->`,
    (pre, post) => `<svg><text>${pre}{{STORY_NAME}}${post}</text></svg>`,
    (pre, post) => `<noscript>${pre}{{STORY_NAME}}${post}</noscript>`,
    (pre, post) => `<script>/*${pre}{{STORY_NAME}}${post}*/</script>`,
    (pre, post) => `<script>//${pre}{{STORY_NAME}}${post}\n</script>`,
    (pre, post) => `<style>/*${pre}{{STORY_NAME}}${post}*/</style>`,
  ];

  it('keeps the value, or warns, in markup contexts with any text around it', () => {
    fc.assert(
      fc.property(fc.constantFrom(...markupContexts), risky(4), risky(4), value, (context, pre, post, name) => {
        const t = `<!doctype html><html><head></head><body>${context(pre, post)}</body></html>`;
        expect(judgeStoryName(t, name)).toBeUndefined();
      }),
      { numRuns: 1500 },
    );
  });

  function fill(t: string, name: string) {
    return fillFormatTemplate({
      template: t,
      placeholders: [{ token: '{{STORY_NAME}}', occurrences: 'all', value: { kind: 'text', text: name } }],
      owner: 'P',
    });
  }

  /** The value of `v` that the first script of `html` defines, or `undefined` when it does not run. */
  function scriptValue(html: string): unknown {
    const [script] = elements(html, (e) => e.tagName === 'script');
    const context: { v?: unknown } = {};
    try {
      new Script(script === undefined ? '' : textContent(script)).runInNewContext(context);
    } catch {
      return undefined;
    }
    return context.v;
  }

  /** Twine 2's escaping of the story name (lodash `escape()`): the five characters HTML text needs. */
  const twineEscape = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

  /** JavaScript string text without quotes, escapes or line breaks: written the same in each kind of literal. */
  const plain = fc.string({
    unit: fc.constantFrom('a', '&', '<', '/', '!', '-', '>', '$', '{', '*', ' ', '#', ';'),
    maxLength: 4,
  });

  it.each([
    ['a double-quoted string', (pre: string, post: string) => `var v = "${pre}{{STORY_NAME}}${post}";`],
    ['a single-quoted string', (pre: string, post: string) => `var v = '${pre}{{STORY_NAME}}${post}';`],
    ['a template literal', (pre: string, post: string) => `var v = \`${pre}{{STORY_NAME}}${post}\`;`],
    ['a module script string', (pre: string, post: string) => `var v = "${pre}{{STORY_NAME}}${post}";`],
  ])('gives %s the HTML-escaped value (as Twine 2 does), or warns', (label, code) => {
    const type = label === 'a module script string' ? ' type="module"' : '';
    fc.assert(
      fc.property(plain, plain, value, (pre, post, name) => {
        const t = `<!doctype html><html><head><script${type}>${code(pre, post)}</script></head><body></body></html>`;
        // Only templates whose literal holds the text around the placeholder as written (no `${` substitution).
        fc.pre(scriptValue(t.replace('{{STORY_NAME}}', '').replace(' type="module"', '')) === pre + post);
        const { output, diagnostics } = fill(t, name);
        if (diagnostics.length > 0) return;
        const evaluated = type === '' ? scriptValue(output) : scriptValue(output.replace(' type="module"', ''));
        expect(evaluated).toBe(pre + twineEscape(name) + post);
      }),
      { numRuns: 400 },
    );
  });

  it('gives a JSON data block the value', () => {
    fc.assert(
      fc.property(plain, plain, value, (pre, post, name) => {
        const t = `<script type="application/json">{"v": "${pre}{{STORY_NAME}}${post}"}</script>`;
        const { output, diagnostics } = fill(t, name);
        expect(diagnostics).toEqual([]);
        const [script] = elements(output, (e) => e.tagName === 'script');
        expect(JSON.parse(script === undefined ? '' : textContent(script))).toEqual({ v: pre + name + post });
      }),
      { numRuns: 400 },
    );
  });

  /** CSS Syntax Level 3: the value of a string token's content. */
  function cssString(body: string): string {
    return body.replace(
      /\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|\n|(.))/gs,
      (_m, hex: string | undefined, ch: string | undefined) => {
        if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
        return ch ?? '';
      },
    );
  }

  it.each([
    ['double', '"'],
    ['single', "'"],
  ])('gives a %s-quoted CSS string the value', (_label, quote) => {
    fc.assert(
      fc.property(plain, plain, value, (pre, post, name) => {
        const t = `<style>a::after { content: ${quote}${pre}{{STORY_NAME}}${post}${quote}; }</style>`;
        const { output, diagnostics } = fill(t, name.replace(/\r/g, ''));
        expect(diagnostics).toEqual([]);
        const [style] = elements(output, (e) => e.tagName === 'style');
        const css = style === undefined ? '' : textContent(style);
        const body = css.slice(css.indexOf(quote) + 1, css.lastIndexOf(quote));
        expect(cssString(body)).toBe(pre + name.replace(/\r/g, '') + post);
      }),
      { numRuns: 400 },
    );
  });

  it('warns where a backslash in the template would escape the value', () => {
    const { diagnostics } = fill('<script>var v = "\\{{STORY_NAME}}";</script>', 'n');
    expect(diagnostics.map((d) => d.level)).toEqual(['warning']);
  });

  it('percent-encodes the value in a URL attribute', () => {
    const { output } = fill('<a href="https://example.com/?title={{STORY_NAME}}">x</a>', 'A&B #1');
    expect(elements(output, (e) => e.tagName === 'a').map((a) => attr(a, 'href'))).toEqual([
      'https://example.com/?title=A%26B%20%231',
    ]);
    expect(parseDocument(output).mode).toBe('quirks');
  });
});

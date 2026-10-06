import { describe, it, expect } from 'vitest';
import { fillFormatTemplate } from '../src/template.js';
import type { Placeholder, PlaceholderValue } from '../src/template.js';

function text(token: string, occurrences: Placeholder['occurrences'], value: string): Placeholder {
  return { token, occurrences, value: { kind: 'text', text: value } };
}

function fill(template: string, placeholders: readonly Placeholder[], extra: { head?: string } = {}) {
  return fillFormatTemplate({ template, placeholders, owner: 'T', ...extra });
}

describe('fillFormatTemplate', () => {
  it('replaces every occurrence of an "all" placeholder and only the first of a "first" placeholder', () => {
    const result = fill('<p>{{A}} {{B}} {{A}} {{B}}</p>', [text('{{A}}', 'all', 'a'), text('{{B}}', 'first', 'b')]);
    expect(result.output).toBe('<p>a b a {{B}}</p>');
    expect(result.diagnostics).toEqual([]);
  });

  it('never scans inserted text for placeholders', () => {
    const result = fill('<title>{{A}}</title><body>{{B}}</body>', [
      text('{{A}}', 'all', '{{B}}'),
      { token: '{{B}}', occurrences: 'first', value: { kind: 'markup', html: '{{A}}</head>', probe: '<i></i>' } },
    ]);
    expect(result.output).toBe('<title>{{B}}</title><body>{{A}}</head></body>');
  });

  it('inserts replacement patterns such as $& and $1 literally', () => {
    expect(fill('<p>[{{A}}]</p>', [text('{{A}}', 'first', "$& $1 $$ $` $'")]).output).toBe(
      '<p>[$&amp; $1 $$ $` $&#39;]</p>',
    );
  });

  it('returns the template unchanged without placeholders or head content', () => {
    expect(fill('{{A}}', []).output).toBe('{{A}}');
  });

  it('finds placeholders left to right without overlapping, as one pass does', () => {
    const quoted = (token: string, value: string): Placeholder => ({
      token,
      occurrences: 'first',
      value: { kind: 'text', text: value },
    });
    // `"TIME"` takes the quote that `"STORY"` would start with.
    expect(fill('<p>"TIME"STORY"</p>', [quoted('"TIME"', 't'), quoted('"STORY"', 's')]).output).toBe('<p>tSTORY"</p>');
  });

  it('takes the first occurrence of a markup placeholder that is in HTML text', () => {
    const data: PlaceholderValue = { kind: 'markup', html: '<i>data</i>', probe: '<i></i>' };
    const result = fill('<!-- {{D}} --><title>{{D}}</title><body>{{D}}{{D}}</body>', [
      { token: '{{D}}', occurrences: 'first', value: data },
    ]);
    expect(result.output).toBe('<!-- {{D}} --><title>{{D}}</title><body><i>data</i>{{D}}</body>');
    expect(result.diagnostics).toEqual([]);
  });

  it('inserts a markup placeholder found only outside HTML text where Tweego does, with an error', () => {
    const result = fill('<title>{{D}}</title>', [
      { token: '{{D}}', occurrences: 'first', value: { kind: 'markup', html: '<i>x</i>', probe: '<i></i>' } },
    ]);
    expect(result.output).toBe('<title><i>x</i></title>');
    expect(result.diagnostics).toEqual([
      {
        level: 'error',
        message:
          'T: the placeholder {{D}} at line 1, column 8 is in text; it is not where the HTML parser reads it as ' +
          'elements of the page, so the browser will not see the inserted story data. It was replaced as Tweego ' +
          'replaces it.',
      },
    ]);
  });

  it('places head content before the closing head tag on its own line', () => {
    expect(fill('<head><title>x</title></head><body></body>', [], { head: '<meta>' }).output).toBe(
      '<head><title>x</title><meta>\n</head><body></body>',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { fillFormatTemplate } from '../src/template.js';

describe('nested attribute languages report unsupported placeholders (#244)', () => {
  it.each([
    ['onclick', "window.titleValue='{{X}}'"],
    ['onload', 'titleValue=&quot;{{X}}&quot;'],
    ['style', 'font-family: &quot;{{X}}&quot;'],
    ['srcdoc', '<p>{{X}}</p>'],
  ])('%s warns for either HTML quote and every title', (attribute, content) => {
    for (const quote of ['"', "'"]) {
      for (const title of ["O'Brien", 'a\\b', 'line\nbreak', '<b>literal</b>', '']) {
        const template = `<iframe ${attribute}=${quote}${content.replaceAll(quote, quote === '"' ? '&quot;' : '&#39;')}${quote}></iframe>`;
        const result = fillFormatTemplate({
          template,
          owner: 'Nested format',
          placeholders: [{ token: '{{X}}', occurrences: 'all', value: { kind: 'text', text: title } }],
        });
        expect(result.diagnostics).toEqual([
          expect.objectContaining({ level: 'warning', message: expect.stringContaining(attribute) }),
        ]);
        expect(result.diagnostics[0]?.message).toContain('cannot escape');
      }
    }
  });

  it.each(['onclick', 'style', 'srcdoc'])('warns for a whole quoted %s placeholder', (attribute) => {
    const result = fillFormatTemplate({
      template: `<iframe ${attribute}="X"></iframe>`,
      owner: 'Twine 1 format',
      placeholders: [{ token: '"X"', occurrences: 'first', value: { kind: 'quoted', text: "O'Brien" } }],
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: 'warning', message: expect.stringContaining(attribute) }),
    ]);
  });

  it('keeps ordinary attributes supported, including similarly named data attributes', () => {
    const result = fillFormatTemplate({
      template: '<p title="{{X}}" data-onclick="{{X}}" data-srcdoc="{{X}}">{{X}}</p>',
      owner: 'Ordinary format',
      placeholders: [{ token: '{{X}}', occurrences: 'all', value: { kind: 'text', text: "O'Brien" } }],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain('title="O&#39;Brien"');
  });
});

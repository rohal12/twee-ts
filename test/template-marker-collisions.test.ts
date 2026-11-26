/** HTML character decoding cannot impersonate an internal placeholder marker (#581). */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { cleanUp, tempDir } from './helpers/plugins.js';
import { fillFormatTemplate } from '../src/template.js';
import { attr, elements, scriptTexts, textContent } from './helpers/html.js';
import { evaluateJavaScript } from './helpers/javascript.js';

afterEach(cleanUp);

const value = 'Back\\';
const tokens = ['{{STORY_NAME}}', '{{OTHER}}'];
const encodings = [
  (code: number) => `&#${String(code)};`,
  (code: number) => `&#x${code.toString(16)};`,
  (code: number) => `&#X000${code.toString(16).toUpperCase()};`,
  (code: number) => String.fromCharCode(code),
];

describe('template marker provenance (#581)', () => {
  it.each(
    encodings.flatMap((encode, encoding) =>
      ['text', 'attribute', 'template'].map((place) => ({ encode, encoding, place })),
    ),
  )('keeps script, JSON, CSS and text contexts with encoding $encoding in $place', ({ encode, place }) => {
    const decoy = Array.from(
      { length: 8 },
      (_, i) => encode(0xe000 + i) + encode(0xe008).repeat((tokens[i % 2]?.length ?? 0) - 5),
    ).join('');
    const earlier =
      place === 'text'
        ? `<p>${decoy}</p>`
        : place === 'attribute'
          ? `<p title="${decoy}"></p>`
          : `<template>${decoy}</template>`;
    // Eight occurrences: the original marker filler would be U+E008.
    const template =
      earlier +
      `<script>values=["${tokens[0]}","${tokens[1]}"];</script>` +
      `<script type="application/json">["${tokens[0]}","${tokens[1]}"]</script>` +
      `<style>a{content:"${tokens[0]}${tokens[1]}"}</style>` +
      `<div title="${tokens[0]}">${tokens[1]}</div>`;
    const result = fillFormatTemplate({
      template,
      placeholders: tokens.map((token) => ({ token, occurrences: 'all', value: { kind: 'text', text: value } })),
      owner: 'Collision',
    });
    const scripts = scriptTexts(result.output);
    expect(evaluateJavaScript(`${scripts[0] ?? ''}; return values;`)).toEqual([value, value]);
    expect(JSON.parse(scripts[1] ?? '')).toEqual([value, value]);
    expect(elements(result.output, (e) => e.tagName === 'style').map(textContent)).toEqual([
      'a{content:"Back\\\\Back\\\\"}',
    ]);
    const div = elements(result.output, (e) => e.tagName === 'div')[0];
    expect(div && attr(div, 'title')).toBe(value);
    expect(div && textContent(div)).toBe(value);
    expect(result.diagnostics).toEqual([]);
  });
  it.each(encodings)('reserves references in dropped duplicate attribute values', (encode) => {
    const token = '{{STORY_NAME}}';
    const decoy = encode(0xe002) + encode(0xe003).repeat(token.length - 5);
    const result = fillFormatTemplate({
      template: `<p ${token}="ok" ${token}="${decoy}"></p><script>value="${token}";</script>`,
      placeholders: [{ token, occurrences: 'all', value: { kind: 'text', text: value } }],
      owner: 'Dropped collision',
    });
    expect(evaluateJavaScript(`${scriptTexts(result.output)[0] ?? ''}; return value;`)).toBe(value);
    expect(result.diagnostics.map((d) => d.message)).not.toContainEqual(expect.stringContaining('in a script'));
  });

  it.each(encodings)('preserves whole quoted JSON placeholders with decoded decoys', (encode) => {
    const token = '"START_AT"';
    const decoy = encode(0xe000) + encode(0xe001).repeat(token.length - 3);
    const result = fillFormatTemplate({
      template: `<p>${decoy}</p><script type="application/json">[${token}]</script>`,
      placeholders: [{ token, occurrences: 'all', value: { kind: 'quoted', text: value } }],
      owner: 'Quoted collision',
    });
    expect(JSON.parse(scriptTexts(result.output)[0] ?? '')).toEqual([value]);
    expect(result.diagnostics).toEqual([]);
  });

  it('preserves story titles through public format compilation with a numeric decoy', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'probe'));
    const decoy = '&#57344;' + '&#57346;'.repeat('{{STORY_NAME}}'.length - 5);
    const template =
      `<html><head></head><body><p>${decoy}</p>` +
      '<script>title="{{STORY_NAME}}";</script>{{STORY_DATA}}</body></html>';
    writeFileSync(
      join(dir, 'probe', 'format.js'),
      'storyFormat(' + JSON.stringify({ name: 'Probe', version: '1.0.0', source: template }) + ');',
    );
    const result = await compile({
      sources: [
        {
          filename: 'story.tw',
          content: `:: StoryTitle\n${value}\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nHello`,
        },
      ],
      formatId: 'probe',
      formatPaths: [dir],
      useTweegoPath: false,
      noRemote: true,
    });
    expect(evaluateJavaScript(`${scriptTexts(result.output)[0] ?? ''}; return title;`)).toBe(value);
    expect(result.diagnostics).toEqual([]);
  });
});

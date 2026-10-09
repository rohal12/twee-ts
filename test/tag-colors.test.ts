/**
 * Tag colors (#294): one accepted set, the Twine 2 HTML output specification's named colors and CSS hex colors,
 * applied in every output mode that writes Twine 2 story data, with a warning for each color left out.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import type { CompileOptions, OutputMode } from '../src/types.js';
import { attr, elements } from './helpers/html.js';
import { parseJsonObject } from './helpers/json.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const FORMAT_DIR = join(__dirname, 'fixtures', 'storyformats');

const NAMED = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];

/** Each color, and whether Twine 2 story data carries it. */
const COLORS: readonly (readonly [color: string, kept: boolean])[] = [
  ...NAMED.map((c) => [c, true] as const),
  ...NAMED.map((c) => [c.toUpperCase(), true] as const),
  ['Red', true],
  ['rEd', true],
  ['GREEN', true],
  ['re d', false],
  ['ʀed', false],
  ['none', false],
  ['', false],
  ['rgb(1,2,3)', false],
  ['#', false],
  ['#1', false],
  ['#12', false],
  ['#123', true],
  ['#1234', true],
  ['#12345', false],
  ['#123456', true],
  ['#1234567', false],
  ['#12345678', true],
  ['#123456789', false],
  ['#abcDEF', true],
  ['#ABCDEF12', true],
  ['#12345g', false],
  ['123456', false],
  [' #123', false],
  ['#123 ', false],
];

const MODES: readonly OutputMode[] = ['html', 'twine2-archive', 'json'];

const htmlOptions = {
  formatId: 'test-format-1',
  formatPaths: [FORMAT_DIR],
  useTweegoPath: false,
  noRemote: true,
} satisfies Partial<CompileOptions>;

async function build(colors: Readonly<Record<string, string>>, outputMode: OutputMode) {
  const storyData = JSON.stringify({ ifid: IFID, 'tag-colors': colors });
  return compile({
    ...htmlOptions,
    sources: [{ filename: 'story.tw', content: `:: StoryTitle\nT\n\n:: StoryData\n${storyData}\n\n:: Start\nHi` }],
    outputMode,
  });
}

/** The tag colors an output carries, in its order. */
function written(output: string, mode: OutputMode): [string, string][] {
  if (mode === 'json') {
    const colors = parseJsonObject(output)['tag-colors'] ?? {};
    return Object.entries(colors as Record<string, string>);
  }
  return elements(output, (e) => e.tagName === 'tw-tag').map((e) => [attr(e, 'name') ?? '', attr(e, 'color') ?? '']);
}

describe.each(MODES)('tag colors in %s output (#294)', (mode) => {
  it.each(COLORS)('%j is kept: %s', async (color, kept) => {
    const result = await build({ t: color }, mode);
    expect(written(result.output, mode)).toEqual(kept ? [['t', color]] : []);
    expect(result.diagnostics.map((d) => d.level)).toEqual(kept ? [] : ['warning']);
  });

  it('keeps the valid colors in order and warns once for each one left out', async () => {
    const result = await build({ a: 'Red', b: 'rgb(1,2,3)', c: '#12345', d: 'green', e: '#fA0' }, mode);
    expect(written(result.output, mode)).toEqual([
      ['a', 'Red'],
      ['d', 'green'],
      ['e', '#fA0'],
    ]);
    expect(result.diagnostics).toEqual([
      {
        level: 'warning',
        message:
          'The color "rgb(1,2,3)" of tag "b" is not a Twine 2 tag color, so it is left out. Use gray, red, orange, ' +
          'yellow, green, blue or purple, or a hex color (#rgb, #rgba, #rrggbb or #rrggbbaa).',
      },
      {
        level: 'warning',
        message:
          'The color "#12345" of tag "c" is not a Twine 2 tag color, so it is left out. Use gray, red, orange, ' +
          'yellow, green, blue or purple, or a hex color (#rgb, #rgba, #rrggbb or #rrggbbaa).',
      },
    ]);
  });
});

describe('tag colors in Twee output', () => {
  it('keeps StoryData as written, every color included, without a warning', async () => {
    const result = await build({ a: 'rgb(1,2,3)', b: 'green' }, 'twee3');
    expect(result.output).toContain('"tag-colors": {\n\t\t"a": "rgb(1,2,3)",\n\t\t"b": "green"\n\t}');
    expect(result.diagnostics).toEqual([]);
  });
});

/**
 * The story fields Twine 2 output writes as attributes (options, format, format version) are checked for text HTML
 * cannot carry, and an active option must stay one token (#271).
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';
import type { OutputMode } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const BASE = {
  noRemote: true,
  useTweegoPath: false,
  formatId: 'test-format-1',
  formatPaths: ['test/fixtures/storyformats'],
} as const;
const MODES: readonly OutputMode[] = ['twine2-archive', 'html'];

async function diagnosticsFor(outputMode: OutputMode, data: Record<string, unknown>): Promise<string[]> {
  const content = `:: StoryTitle\nT\n\n:: StoryData\n${JSON.stringify({ ifid: IFID, ...data })}\n\n:: Start\nHello.`;
  const result = await compile({ ...BASE, outputMode, sources: [{ filename: 'probe.tw', content }] });
  return result.diagnostics.filter((d) => d.level === 'error').map((d) => d.message);
}

describe.each(MODES)('story fields in %s output', (mode) => {
  it.each([
    ['a NUL in an option', { options: ['debu\u0000g'] }],
    ['a lone surrogate in an option', { options: ['debu\ud800g'] }],
    ['white space in an option', { options: ['foo bar'] }],
    ['a next-line character in an option', { options: ['foo\u0085bar'] }],
    ['an empty option', { options: [''] }],
  ])('rejects %s', async (_name, data) => {
    expect(await diagnosticsFor(mode, data)).not.toEqual([]);
  });

  it.each([
    ['an ordinary option', { options: ['debug'] }],
    ['an Unicode option', { options: ['dé﻿bug', '日本'] }],
    ['no options', {}],
  ])('accepts %s', async (_name, data) => {
    expect(await diagnosticsFor(mode, data)).toEqual([]);
  });

  it('keeps an accepted option through the HTML round trip', async () => {
    const content = `:: StoryTitle\nT\n\n:: StoryData\n{"ifid":"${IFID}","options":["dé﻿bug"]}\n\n:: Start\nHello.`;
    const result = await compile({ ...BASE, outputMode: mode, sources: [{ filename: 'p.tw', content }] });
    const back = decompileHTML(Buffer.from(result.output, 'utf8').toString('utf8')).story;
    expect([...back.twine2.options.keys()]).toEqual(['dé﻿bug']);
  });
});

describe('format and version', () => {
  it.each([
    ['a NUL in the format name', { format: 'Sug\u0000arCube', 'format-version': '2.0.0' }],
    ['a NUL in the format version', { format: 'SugarCube', 'format-version': '2.\u00000.0' }],
  ])('twine2-archive rejects %s', async (_name, data) => {
    expect(await diagnosticsFor('twine2-archive', data)).not.toEqual([]);
  });

  it.each([
    ['a NUL in the format name', { format: 'Sug\u0000arCube', 'format-version': '2.0.0' }],
    ['a NUL in the format version', { format: 'SugarCube', 'format-version': '2.\u00000.0' }],
  ])('html does not check the StoryData fields the selected format replaces: %s', async (_name, data) => {
    expect(await diagnosticsFor('html', data)).toEqual([]);
  });
});

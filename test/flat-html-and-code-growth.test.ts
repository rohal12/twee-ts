import { describe, expect, it } from 'vitest';
import { parse, serialize } from 'parse5';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';
import { parseHtml } from '../src/html-structure.js';
import { toTwine2Archive } from '../src/output-twine2.js';
import { createStory } from '../src/story.js';
import { growth, LINEAR_GROWTH } from './helpers/growth.js';

const STORY =
  '<tw-storydata name="Probe" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC">' +
  '<tw-passagedata pid="1" name="Start">hi</tw-passagedata></tw-storydata>';

describe('flat HTML foster parenting (#381)', () => {
  it.each(['<table>x</table>', '<table><b>x</b>y</table>', '<table>x<tr><td>a</td></tr>z</table>', '<p>x</p>'])(
    'keeps parse5 tree and source locations for %s',
    (unit) => {
      const html = STORY + unit.repeat(20);
      expect(parseHtml(html)).toEqual(parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: true }));
      expect(serialize(parseHtml(html))).toBe(serialize(parse(html)));
    },
  );

  it('decompiles shallow table siblings in linear time', { timeout: 120_000 }, () => {
    expect(growth((n) => STORY + '<table>x</table>'.repeat(n), decompileHTML, 8000)).toBeLessThan(LINEAR_GROWTH);
  });

  it('imports a source with many shallow tables without changing its passages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-flat-html-'));
    try {
      const source = join(dir, 'story.html');
      writeFileSync(source, STORY + '<table>x</table>'.repeat(8000));
      const result = await compile({ sources: [source], outputMode: 'json' });
      expect(result.diagnostics).toEqual([]);
      expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('hi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('many uniquely named code passages (#463)', () => {
  it.each(['script', 'stylesheet'] as const)('renders %s passages in linear time', { timeout: 120_000 }, (kind) => {
    const make = (n: number) => ({
      ...createStory(),
      passages: Array.from({ length: n }, (_, i) => ({
        name: `P${String(i)}`,
        tags: [kind],
        text: kind === 'script' ? 'void 0;' : 'a{color:red}',
      })),
    });
    expect(growth(make, (story) => toTwine2Archive(story, 'Start', { diagnostics: [] }), 4000)).toBeLessThan(
      LINEAR_GROWTH,
    );
  });
});

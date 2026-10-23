import { describe, expect, it, vi } from 'vitest';
import { defaultTreeAdapter, parse, serialize } from 'parse5';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';
import { analyzeTemplate, parseHtml } from '../src/html-structure.js';
import { LINEAR_GROWTH } from './helpers/growth.js';

const story =
  '<tw-storydata name="Probe" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC">' +
  '<tw-passagedata pid="1" name="Start">hi</tw-passagedata></tw-storydata>';

describe('formatting-tag recovery (#381)', () => {
  it.each(['decompile', 'source', 'template'] as const)('uses linear sibling work through %s', async (mode) => {
    let reads = 0;
    const create = defaultTreeAdapter.createElement.bind(defaultTreeAdapter);
    const spy = vi.spyOn(defaultTreeAdapter, 'createElement').mockImplementation((...args) => {
      const element = create(...args);
      element.childNodes = new Proxy(element.childNodes, {
        get(target, property, receiver): unknown {
          if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      return element;
    });
    const root = mkdtempSync(join(tmpdir(), 'twee-recovery-'));
    const work = async (n: number): Promise<number> => {
      const markup = '<b><p>' + '<i></i>'.repeat(n) + '</b>';
      reads = 0;
      const html =
        mode === 'template'
          ? serialize(analyzeTemplate(`<html><head></head><body>${markup}${story}</body></html>`, []).doc)
          : markup + story;
      const path = join(root, 'story.html');
      writeFileSync(path, html);
      const result = mode === 'source' ? await compile({ sources: [path], outputMode: 'json' }) : decompileHTML(html);
      expect(result.diagnostics).toEqual([]);
      expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('hi');
      return reads;
    };
    try {
      const small = await work(250);
      const large = await work(1000);
      expect(small).toBeGreaterThan(0);
      expect(large).toBeLessThan(small * LINEAR_GROWTH);
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    '<b><p><i></i>text<span>x</span></b>',
    '<b><p><template><div>x</div></template><em>y</em></b>',
    '<a><b><div><i>x</a>y</b>z',
    '<b><table>text<tr><td>x</b>y</table>',
  ])('preserves the recovered DOM, parent pointers and source locations for %s', (html) => {
    const actual = parseHtml(html);
    const expected = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: true });
    expect(serialize(actual)).toBe(serialize(expected));
    expect(actual).toEqual(expected);
  });
});

/** Unique attributes must not cause pairwise tokenizer work (#493). */
import { describe, expect, it, vi } from 'vitest';
import { parse, serialize, Tokenizer } from 'parse5';
import type { Token } from 'parse5';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';
import { htmlText, parseHtml, scriptsJQueryRuns, wikifiedElementAttributes } from '../src/html-structure.js';
import { LINEAR_GROWTH } from './helpers/growth.js';

const attributes = (n: number): string => Array.from({ length: n }, (_, i) => `a${String(i)}="x"`).join(' ');
const story = (attrs: string): string =>
  `<tw-storydata name="Probe" ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC" ${attrs}>` +
  '<tw-passagedata pid="1" name="Start">hi</tw-passagedata></tw-storydata>';

// Expose parse5's protected hook solely to count reads of its real attribute arrays. No parser is mocked.
interface AttributeHook {
  _createAttr(first: string): void;
  currentToken: Token.Token | null;
}

describe('HTML attributes (#493)', () => {
  it.each([
    {
      kind: 'document',
      read: (attrs: string): unknown =>
        decompileHTML(story(attrs)).story.passages.find((p) => p.name === 'Start')?.text,
      expected: 'hi',
    },
    {
      kind: 'fragment',
      read: (attrs: string): unknown => scriptsJQueryRuns(`<script ${attrs}>globalThis.value=42;</script>`),
      expected: [{ kind: 'classic', code: 'globalThis.value=42;' }],
    },
    { kind: 'visible text', read: (attrs: string): unknown => htmlText(`<div ${attrs}>hi</div>`), expected: 'hi' },
  ])('uses linear attribute-array work in a $kind', ({ read, expected }) => {
    let reads = 0;
    const wrapped = new WeakSet<object>();
    const prototype = Tokenizer.prototype as unknown as AttributeHook;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with its original tokenizer receiver below.
    const createAttr = prototype._createAttr;
    const spy = vi.spyOn(prototype, '_createAttr').mockImplementation(function (this: AttributeHook, first) {
      createAttr.call(this, first);
      const token = this.currentToken;
      if (token !== null && 'attrs' in token && !wrapped.has(token)) {
        wrapped.add(token);
        token.attrs = new Proxy(token.attrs, {
          get(target, property, receiver): unknown {
            if (property === 'length' || (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)))
              reads += 1;
            return Reflect.get(target, property, receiver);
          },
        });
      }
    });
    const work = (n: number): number => {
      reads = 0;
      expect(read(attributes(n))).toEqual(expected);
      return reads;
    };
    try {
      const small = work(250);
      const large = work(1000);
      expect(small).toBeGreaterThan(0);
      expect(large).toBeLessThan(small * LINEAR_GROWTH);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    '<div A="first" a="second" __proto__="safe" constructor="own" a0="last"></div>',
    '<svg viewBox="first" viewbox="second" xlink:href="link" xml:lang="en" xmlns="uri"></svg>',
    '<math definitionURL="first" definitionurl="second"><mi X="first" x="second">x</mi></math>',
    '<div a="first" A="second"></div><div a="new"></div></div ignored="x">',
    `<div ${'A="first" a="second" '.repeat(1000)}></div>`,
    `<div ${attributes(1000)}></div>`,
  ])('matches parse5 attributes and source locations: %.70s', (html) => {
    const expected = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: true });
    expect(parseHtml(html)).toEqual(expected);
    expect(serialize(parseHtml(html, false))).toBe(serialize(expected));
  });

  it('keeps first values, case folding and namespaced fragment attributes', () => {
    expect(wikifiedElementAttributes('<svg A="first" a="second" viewBox="box" xlink:href="link">')).toEqual(
      new Map([
        ['a', 'first'],
        ['viewBox', 'box'],
        ['xlink:href', 'link'],
      ]),
    );
  });

  it('preserves foreign fragment context and raw text when reading script elements', () => {
    expect(
      scriptsJQueryRuns('<svg><script type="text/javascript">a&lt;b</script></svg><script>c&lt;d</script>'),
    ).toEqual([
      { kind: 'classic', code: 'a<b' },
      { kind: 'classic', code: 'c&lt;d' },
    ]);
  });

  it('imports a story with many distinct attributes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-html-attributes-'));
    try {
      const source = join(dir, 'story.html');
      writeFileSync(source, story(attributes(16_000)));
      const result = await compile({ sources: [source], outputMode: 'json' });
      expect(result.diagnostics).toEqual([]);
      expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('hi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

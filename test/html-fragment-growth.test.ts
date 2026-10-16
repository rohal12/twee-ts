import { describe, expect, it, vi } from 'vitest';
import { defaultTreeAdapter } from 'parse5';
import { compile } from '../src/compiler.js';
import { storyInspect } from '../src/inspect.js';
import { lint } from '../src/lint.js';
import {
  HtmlNestingError,
  MAX_HTML_DEPTH,
  scriptsJQueryRuns,
  wikifiedElementAttributes,
} from '../src/html-structure.js';
import { LINEAR_GROWTH } from './helpers/growth.js';

describe('HTML fragment extraction (#381)', () => {
  it.each(['inspect', 'lint'] as const)('uses linear sibling-array work through %s', async (mode) => {
    let reads = 0;
    const create = defaultTreeAdapter.createElement.bind(defaultTreeAdapter);
    // Observe real array work without changing parsing: detaching the first child with splice shifts every sibling.
    const wrapped = vi.spyOn(defaultTreeAdapter, 'createElement').mockImplementation((...args) => {
      const element = create(...args);
      element.childNodes = new Proxy(element.childNodes, {
        get(target, property, receiver): unknown {
          if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      return element;
    });
    const work = async (n: number): Promise<number> => {
      const sources = [
        {
          filename: 'a.tw',
          content:
            ':: StoryTitle\nProbe\n:: StoryData\n' +
            '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\n<scripture></scripture>' +
            '<i></i>'.repeat(n) +
            '<script>$.wiki("[[Room]]")</script>\n:: Room\nx',
        },
      ];
      reads = 0;
      const result =
        mode === 'inspect'
          ? storyInspect((await compile({ sources, outputMode: 'json' })).story)
          : await lint({ sources });
      expect(result.orphans).not.toContain('Room');
      expect(result.brokenLinks).toEqual([]);
      return reads;
    };
    try {
      const small = await work(250);
      const large = await work(1000);
      expect(small).toBeGreaterThan(0);
      expect(large).toBeLessThan(small * LINEAR_GROWTH);
    } finally {
      wrapped.mockRestore();
    }
  });

  it.each([
    ['<script>$.wiki("[[Room]]")</script>', [{ kind: 'classic', code: '$.wiki("[[Room]]")' }]],
    [
      '<template><script>bad()</script></template><script type="module">ok()</script>',
      [{ kind: 'module', code: 'ok()' }],
    ],
    ['<table>x</table><script type="application/json">{}</script>', []],
    ['<noscript><script>bad()</script></noscript>', []],
  ])('preserves script classification for %s', (html, expected) => {
    expect(scriptsJQueryRuns(html)).toEqual(expected);
  });

  it('keeps element attribute and empty-fragment behavior', () => {
    expect([...(wikifiedElementAttributes('<table><tr><td data-passage="Room">') ?? [])]).toEqual([
      ['data-passage', 'Room'],
    ]);
    expect(wikifiedElementAttributes('<td data-passage="Room">')).toEqual(new Map());
    expect(wikifiedElementAttributes('')).toEqual(new Map());
    expect(wikifiedElementAttributes('text')).toBeUndefined();
  });

  it('continues to reject excessively nested fragments', () => {
    expect(() => scriptsJQueryRuns('<div>'.repeat(MAX_HTML_DEPTH + 1))).toThrow(HtmlNestingError);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { defaultTreeAdapter, parse, serialize } from 'parse5';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';
import { parseHtml } from '../src/html-structure.js';
import { toTwine2Archive } from '../src/output-twine2.js';
import { createStory } from '../src/story.js';
import { LINEAR_GROWTH } from './helpers/growth.js';
import { measureTextWork } from './helpers/text-work.js';

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

  it('decompiles shallow table siblings with linear sibling-array work', () => {
    let reads = 0;
    const createElement = defaultTreeAdapter.createElement.bind(defaultTreeAdapter);
    // Count actual indexed reads, including searches and splice shifts, while preserving the tree semantics.
    // A forward scan of the growing body on every table makes this count quadratic (#381).
    const wrapped = vi.spyOn(defaultTreeAdapter, 'createElement').mockImplementation((...args) => {
      const element = createElement(...args);
      element.childNodes = new Proxy(element.childNodes, {
        get(target, property, receiver): unknown {
          if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      return element;
    });
    const work = (n: number): number => {
      reads = 0;
      const result = decompileHTML(STORY + '<table>x</table>'.repeat(n));
      expect(result.story.passages.find((p) => p.name === 'Start')?.text).toBe('hi');
      return reads;
    };
    try {
      const small = work(250);
      const large = work(1000);
      expect(small).toBeGreaterThan(0);
      expect(large).toBeLessThan(small * LINEAR_GROWTH);
    } finally {
      wrapped.mockRestore();
    }
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
  it.each(['script', 'stylesheet'] as const)(
    'renders %s passages with linear string work',
    { timeout: 120_000 },
    (kind) => {
      const make = (n: number) => ({
        ...createStory(),
        passages: Array.from({ length: n }, (_, i) => ({
          name: `P${String(i)}`,
          tags: [kind],
          text: kind === 'script' ? 'void 0;' : 'a{color:red}',
        })),
      });
      const render = (n: number) => {
        const story = make(n);
        return measureTextWork(() => toTwine2Archive(story, 'Start', { diagnostics: [] }));
      };
      const small = render(250);
      const large = render(1000);
      expect(large.value).toContain(`twine-user-${kind} #1000: "P999"`);
      expect(small.work).toBeGreaterThan(0);
      expect(large.work).toBeLessThan(small.work * LINEAR_GROWTH);
    },
  );
});

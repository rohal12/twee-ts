/**
 * P4 (issue #244): compile → decompile is the identity on the story model, over what HTML can carry: passage names,
 * tags and text with HTML-special characters, carriage returns, and (Twine 1) ROT13 obfuscation. The documented
 * exceptions are code passages, which come back joined and with `</script`, `</style` and double-escaped `<!--`
 * written with a backslash, and text HTML cannot carry, which compiling reports instead.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { toTwine2Archive } from '../src/output-twine2.js';
import { toTwine1Archive } from '../src/output-twine1.js';
import { decompileHTML } from '../src/html-parser.js';
import { createStory } from '../src/story.js';
import { normalizeIFID } from '../src/ifid.js';
import { rot13, scriptContentEscape, styleContentEscape } from '../src/escape.js';
import { splitTweeFields } from '../src/twee-syntax.js';
import type { Diagnostic, Passage, Story } from '../src/types.js';

const IFID = normalizeIFID('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
const SPECIAL = new Set([
  'StoryTitle',
  'StoryData',
  'StorySettings',
  'StoryIncludes',
  'Story JavaScript',
  'Story Stylesheet',
]);

/** Characters that HTML, the tiddler escaping or the Twee model treat specially. */
const TRICKY = [
  '&',
  '<',
  '>',
  '"',
  "'",
  '\\',
  'n',
  's',
  't',
  '\n',
  '\t',
  '\r',
  ' ',
  '=',
  '-',
  '!',
  '#',
  ';',
  '\u00a0',
  'é',
  '😀',
  'a',
  'Z',
];
const text = fc.string({
  unit: fc.oneof(fc.constantFrom(...TRICKY), fc.string({ unit: 'grapheme', maxLength: 1 })),
  maxLength: 16,
});
const name = text.filter((n) => n.length > 0 && !SPECIAL.has(n) && !SPECIAL.has(rot13(n)));
/** A tag as Twee reads one: no white space, not empty. */
const tag = text.filter((t) => splitTweeFields(t).length === 1 && splitTweeFields(t)[0] === t);
const passage = fc.record({ name, tags: fc.uniqueArray(tag, { maxLength: 3 }), text });
const passages = fc.uniqueArray(passage, { selector: (p) => p.name, minLength: 1, maxLength: 6 });

function storyOf(list: readonly Passage[]): Story {
  const story = createStory();
  story.ifid = IFID;
  story.passages.push(...list);
  return story;
}

/** The ordinary passages of a decompiled story: name, tags, text. */
function decompiled(html: string): Passage[] {
  const { story, diagnostics } = decompileHTML(html, { trim: false });
  expect(diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  return story.passages
    .filter((p) => !SPECIAL.has(p.name))
    .map((p) => ({ name: p.name, tags: [...p.tags], text: p.text }));
}

describe('P4: compile → decompile returns the story', { timeout: 120_000 }, () => {
  it('for Twine 2 archives', () => {
    fc.assert(
      fc.property(passages, (list) => {
        const ordinary = list.filter((p) => !p.tags.some((t) => ['script', 'stylesheet', 'Twine.private'].includes(t)));
        const diagnostics: Diagnostic[] = [];
        const html = toTwine2Archive(storyOf(ordinary), ordinary[0]?.name ?? '', { diagnostics });
        expect(diagnostics).toEqual([]);
        expect(decompiled(html)).toEqual(ordinary.map((p) => ({ ...p, tags: [...p.tags] })));
      }),
      { numRuns: 300 },
    );
  });

  it('for Twine 1 archives, obfuscated or not', () => {
    fc.assert(
      fc.property(passages, fc.boolean(), (list, obfuscate) => {
        const ordinary = list.filter(
          (p) =>
            !p.tags.includes('Twine.private') &&
            !p.tags.includes('Twine.image') &&
            !p.tags.map(rot13).includes('Twine.image'),
        );
        const settings: Passage[] = obfuscate ? [{ name: 'StorySettings', tags: [], text: 'obfuscate:rot13' }] : [];
        const diagnostics: Diagnostic[] = [];
        const html = toTwine1Archive(storyOf([...settings, ...ordinary]), '', { diagnostics });
        expect(diagnostics).toEqual([]);
        expect(decompiled(html)).toEqual(ordinary.map((p) => ({ ...p, tags: [...p.tags] })));
      }),
      { numRuns: 300 },
    );
  });

  it('for a script and a stylesheet passage, but for the documented escapes', () => {
    const code = fc.string({
      unit: fc.constantFrom('<', '/', 'script', 'style', '!--', '-->', '<script>', 'x', '"', '\n', ' '),
      maxLength: 12,
    });
    fc.assert(
      fc.property(code, code, (script, style) => {
        const story = storyOf([
          { name: 'Start', tags: [], text: 'x' },
          { name: 'S', tags: ['script'], text: script },
          { name: 'C', tags: ['stylesheet'], text: style },
        ]);
        const html = toTwine2Archive(story, 'Start');
        const back = decompileHTML(html, { trim: false }).story.passages;
        // Whitespace alone is no script or stylesheet.
        const expected = (t: string, escape: (s: string) => string): string[] => (t.trim() === '' ? [] : [escape(t)]);
        expect(back.filter((p) => p.tags.includes('script')).map((p) => p.text)).toEqual(
          expected(script, scriptContentEscape),
        );
        expect(back.filter((p) => p.tags.includes('stylesheet')).map((p) => p.text)).toEqual(
          expected(style, styleContentEscape),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('reports text HTML cannot carry instead of writing a different story', () => {
    const bad = fc.constantFrom('\u0000', '\uD800', '\uDFFF');
    fc.assert(
      fc.property(passage, bad, fc.constantFrom('name', 'text', 'tag'), (p, c, where) => {
        const broken: Passage =
          where === 'name'
            ? { ...p, name: p.name + c }
            : where === 'text'
              ? { ...p, text: p.text + c }
              : { ...p, tags: [...p.tags, `t${c}`] };
        for (const archive of [toTwine2Archive, toTwine1Archive]) {
          const diagnostics: Diagnostic[] = [];
          archive(storyOf([broken]), broken.name, { diagnostics });
          expect(diagnostics.some((d) => d.level === 'error')).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

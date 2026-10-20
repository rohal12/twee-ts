/** SugarCube's tag-name grammar and wildcard end searches must take bounded work (#487, #488). */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compile, lint, storyInspect } from '../src/index.js';
import { findPassageLinks, htmlEndTagAt } from '../src/sugarcube-macros.js';
import { countTextWords } from '../src/word-count.js';
import { growth, LINEAR_GROWTH } from './helpers/growth.js';

it.each([
  ['x---', true],
  ['X-É.𐀀', true],
  ['x-\u200C', true],
  ['div', true],
  ['x.abc', false],
  ['xé', false],
  ['x-!', false],
  ['x-\u037E', false],
])('reads the end-tag name %s according to SugarCube', (name, valid) => {
  const text = `</${name} \t>`;
  expect(htmlEndTagAt(text, 0)).toEqual(valid ? { name: name.toLowerCase(), end: text.length } : undefined);
});

it('keeps SugarCube wildcard matching for short custom-element names', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('.', 'a', '-', 'é', 'É', 'K', 'ſ', 'ß', 'σ', 'ς', '𐀀'), { maxLength: 8 }),
      fc.array(fc.constantFrom('a', 'A', 'b', '.', '-', 'é', 'É', 'K', 'S', 'σ', 'Σ', '\n', ' ', '𐀀'), {
        maxLength: 10,
      }),
      (parts, ending) => {
        const name = `x-${parts.join('')}`;
        const closer = `</x-${ending.join('')}>`;
        // SugarCube lowercases the start-tag name before building its case-insensitive regex.
        const expected = new RegExp(`<\\/${name.toLowerCase()}\\s*>`, 'i').test(closer);
        expect(findPassageLinks(`<${name} data-passage="R">${closer}`)).toEqual(
          expected ? [{ via: 'data-passage', passage: 'R' }] : [],
        );
      },
    ),
  );
});

it.each([
  ['x-...', '</x-ABC>', true],
  ['x-...', '</x-A\nC>', false],
  ['x-é', '</X-É \t>', true],
  ['x-K', '</x-K>', true],
  ['x-k', '</x-K>', false],
  ['x-ſ', '</x-S>', false],
  ['x-σ', '</x-ς>', true],
  ['x-ß', '</x-SS>', false],
  ['x-𐀀', '</x-𐀀>', true],
  ['x-..', '</x-𐀀>', true],
])('keeps non-Unicode regex semantics for %s and %s', (name, closer, linked) => {
  expect(findPassageLinks(`<${name} data-passage="R">${closer}`)).toEqual(
    linked ? [{ via: 'data-passage', passage: 'R' }] : [],
  );
});

it('finds a real closer for a long name and shares the budget across names', () => {
  const name = 'x-' + '.'.repeat(64_000);
  expect(findPassageLinks(`<${name} data-passage="R"></${name}>`)).toEqual([{ via: 'data-passage', passage: 'R' }]);
  expect(findPassageLinks(hostile(4000) + hostile(5000))).toEqual([]);
});

const hostile = (n: number) => `<x-${'.'.repeat(n)} data-passage="R">` + '</x-'.repeat(n * 10);

describe('tag scanning growth', () => {
  it('bounds malformed custom-element end tags', { timeout: 120_000 }, () => {
    expect(
      growth(
        (n) => '</x' + '-'.repeat(n) + '!',
        (text) => countTextWords(text, 'whitespace'),
        2000,
      ),
    ).toBeLessThan(LINEAR_GROWTH);
  });

  it('bounds wildcard closing-tag searches', { timeout: 120_000 }, () => {
    expect(growth(hostile, findPassageLinks, 2000)).toBeLessThan(LINEAR_GROWTH);
  });
});

it('handles hostile names through compilation, inspection and lint', async () => {
  const text = hostile(4000);
  const sources = [{ filename: 'story.tw', content: `:: StoryTitle\nT\n:: Start\n${text}` }];
  const result = await compile({ sources, outputMode: 'json', wordCountMethod: 'whitespace' });
  expect(result.diagnostics).toEqual([]);
  expect(storyInspect(result.story).links.get('Start')).toEqual([]);
  expect((await lint({ sources })).brokenLinks).toEqual([]);
});

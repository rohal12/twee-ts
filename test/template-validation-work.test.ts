/** Rejected markup and exceptional empty values share a bounded structural validation budget (#499). */
import { describe, expect, it, vi } from 'vitest';
import { Tokenizer } from 'parse5';
import { fillFormatTemplate } from '../src/template.js';
import type { Placeholder } from '../src/template.js';
import { LINEAR_GROWTH } from './helpers/growth.js';

const DATA: Placeholder = {
  token: '{{STORY_DATA}}',
  occurrences: 'first',
  value: { kind: 'markup', html: '<tw-storydata>story</tw-storydata>', probe: '<tw-storydata></tw-storydata>' },
};
const EMPTY: Placeholder = { token: '{{EMPTY}}', occurrences: 'all', value: { kind: 'text', text: '' } };
const fill = (template: string, placeholder = DATA) =>
  fillFormatTemplate({ template, placeholders: [placeholder], owner: 'Story format "Budget"' });

describe('template structural validation work (#499)', () => {
  it.each([
    ['all rejected markup', (n: number) => '<select>{{STORY_DATA}}</select>'.repeat(n), DATA],
    [
      'rejected markup before a usable occurrence',
      (n: number) => '<select>{{STORY_DATA}}</select>'.repeat(n) + '<main>{{STORY_DATA}}</main>',
      DATA,
    ],
    ['empty sibling boundaries', (n: number) => '<p>&am{{EMPTY}}p;</p>'.repeat(n), EMPTY],
  ] as const)('bounds total parsed input for %s', (_name, make, placeholder) => {
    const work = (n: number): number => {
      let parsed = 0;
      // Observe actual input consumed by parse5, retaining its parser and all tree checks.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the original tokenizer receiver.
      const write = Tokenizer.prototype.write;
      const spy = vi.spyOn(Tokenizer.prototype, 'write').mockImplementation(function (this: Tokenizer, ...args) {
        parsed += args[0].length;
        write.apply(this, args);
      });
      try {
        expect(() => fill(make(n), placeholder)).toThrow(
          expect.objectContaining({
            name: 'TweeTsError',
            code: 'FORMAT_UNAVAILABLE',
            message: expect.stringMatching(/Story format "Budget".*structural validation work limit/),
          }),
        );
        // Includes the initial analysis parse as well as probes, and bounds work even for one oversized input.
        expect(parsed).toBeLessThan(make(n).length * 70);
        return parsed;
      } finally {
        spy.mockRestore();
      }
    };
    const small = work(128);
    const large = work(512);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeLessThan(small * LINEAR_GROWTH);
  });

  it('keeps the first usable markup occurrence after rejected sites within the budget', () => {
    const rejected = '<select>{{STORY_DATA}}</select>'.repeat(12);
    expect(fill(rejected + '<main>{{STORY_DATA}}</main><aside>{{STORY_DATA}}</aside>')).toEqual({
      output: rejected + '<main><tw-storydata>story</tw-storydata></main><aside>{{STORY_DATA}}</aside>',
      diagnostics: [],
    });
  });

  it('retains the error and first-site fallback when every markup occurrence is rejected', () => {
    const result = fill('<select>{{STORY_DATA}}</select><select>{{STORY_DATA}}</select>');
    expect(result.output).toBe('<select><tw-storydata>story</tw-storydata></select><select>{{STORY_DATA}}</select>');
    expect(result.diagnostics).toEqual([{ level: 'error', message: expect.stringContaining('{{STORY_DATA}}') }]);
  });

  it.each(['', 'literal {{STORY_DATA}}'])('fills many ordinary text sites without structural probes: %j', (text) => {
    const template = '<p>{{EMPTY}}</p>'.repeat(1000);
    expect(fill(template, { ...EMPTY, value: { kind: 'text', text } })).toEqual({
      output: `<p>${text}</p>`.repeat(1000),
      diagnostics: [],
    });
  });

  it('keeps warnings for empty boundaries that would change text', () => {
    const result = fill('<p>&am{{EMPTY}}p;</p>'.repeat(3), EMPTY);
    expect(result.output).toBe('<p>&amp;</p>'.repeat(3));
    expect(result.diagnostics).toHaveLength(3);
  });

  it('shares the budget between rejected markup and empty boundary checks', () => {
    const template = '<select>{{STORY_DATA}}</select>'.repeat(40) + '<p>&am{{EMPTY}}p;</p>'.repeat(40);
    expect(() => fillFormatTemplate({ template, placeholders: [DATA, EMPTY], owner: 'Mixed checks' })).toThrow(
      expect.objectContaining({ code: 'FORMAT_UNAVAILABLE' }),
    );
  });

  it('reuses successful empty-removal checks when validating final edits', () => {
    const template = '<script>let x="<!{{EMPTY}}--";</script>'.repeat(40);
    expect(fill(template, EMPTY)).toEqual({
      output: '<script>let x="<!--";</script>'.repeat(40),
      diagnostics: [],
    });
  });
});

import { describe, it, expect } from 'vitest';
import { CLOSING_HEAD_TAG, fillTemplate, fillTemplateParts, literal } from '../src/template.js';
import type { TemplateSlot } from '../src/template.js';

function slot(token: string, occurrences: TemplateSlot['occurrences'], value: string): TemplateSlot {
  return { pattern: literal(token), occurrences, replacement: () => value };
}

describe('fillTemplate', () => {
  it('replaces every match of an "all" slot and only the first match of a "first" slot', () => {
    const result = fillTemplate('{{A}} {{B}} {{A}} {{B}}', [slot('{{A}}', 'all', 'a'), slot('{{B}}', 'first', 'b')]);
    expect(result).toBe('a b a {{B}}');
  });

  it('never scans inserted text for placeholders', () => {
    const result = fillTemplate('<title>{{A}}</title><body>{{B}}</body>', [
      slot('{{A}}', 'all', '{{B}}'),
      slot('{{B}}', 'first', '{{A}}'),
    ]);
    expect(result).toBe('<title>{{B}}</title><body>{{A}}</body>');
  });

  it('inserts replacement patterns such as $& and $1 literally', () => {
    const result = fillTemplate('[{{A}}]', [slot('{{A}}', 'first', "$& $1 $$ $` $'")]);
    expect(result).toBe("[$& $1 $$ $` $']");
  });

  it('passes the matched text to the replacement', () => {
    const head: TemplateSlot = { pattern: CLOSING_HEAD_TAG, occurrences: 'first', replacement: (m) => `<meta>${m}` };
    expect(fillTemplate('<head></HEAD ></head>', [head])).toBe('<head><meta></HEAD ></head>');
  });

  it('builds a replacement only for a placeholder that is present', () => {
    let calls = 0;
    const counted: TemplateSlot = { pattern: literal('{{A}}'), occurrences: 'first', replacement: () => `${++calls}` };
    expect(fillTemplate('no placeholder', [counted])).toBe('no placeholder');
    expect(calls).toBe(0);
  });

  it('returns the template unchanged without slots', () => {
    expect(fillTemplate('{{A}}', [])).toBe('{{A}}');
  });

  it('escapes regular expression characters in literal tokens', () => {
    expect(fillTemplate('a.b a+b', [slot('a.b', 'all', 'x')])).toBe('x a+b');
  });
});

describe('fillTemplateParts', () => {
  it('keeps verbatim parts unscanned and shares "first" slots across scanned parts', () => {
    const once = slot('{{B}}', 'first', 'b');
    const result = fillTemplateParts([
      { kind: 'scan', text: '{{A}}|', slots: [slot('{{A}}', 'all', 'a')] },
      { kind: 'verbatim', text: '{{A}}{{B}}' },
      { kind: 'scan', text: '|{{A}}{{B}}', slots: [once] },
      { kind: 'scan', text: '|{{B}}', slots: [once] },
    ]);
    expect(result).toBe('a|{{A}}{{B}}|{{A}}b|{{B}}');
  });
});

describe('CLOSING_HEAD_TAG', () => {
  const matches = (s: string): boolean => new RegExp(CLOSING_HEAD_TAG).test(s);

  it.each(['</head>', '</HEAD>', '</Head>', '</head >', '</head\n>', '</head\t>', '</head/>', '</head foo>'])(
    'matches %j',
    (tag) => {
      expect(matches(tag)).toBe(true);
    },
  );

  it.each(['</header>', '</heading>', '<head>', '</ head>', '</hea>'])('does not match %j', (tag) => {
    expect(matches(tag)).toBe(false);
  });
});

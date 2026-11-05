import { describe, expect, it } from 'vitest';
import { checkEntryStyleBase } from '../src/plugins/vite-entry.js';

const entry = (style: string) => ({ style, script: '', files: new Set<string>(), assets: new Map<string, string>() });
const html = (href: string) => `<html><head><base href="${href}"></head><body></body></html>`;

describe('entry stylesheet URL values with a document base (#289)', () => {
  it.each([
    String.raw`url("https\3a //cdn.example/a.png")`,
    String.raw`url(https\3a //cdn.example/a.png)`,
    String.raw`url("\64 ata:image/png;base64,AAAA")`,
    String.raw`url("\2f published/a.png")`,
    String.raw`url("https\
://cdn.example/a.png")`,
    'url("https\\\r\n://cdn.example/a.png")',
    String.raw`url("https\00003a //cdn.example/\110000.png")`,
  ])('allows a decoded absolute or root-relative value: %s', (value) => {
    expect(() => {
      checkEntryStyleBase(html('/elsewhere/'), entry(`body { background: ${value} }`));
    }).not.toThrow();
  });

  it.each([String.raw`url("\2f published/a.png")`, String.raw`url(\2f published/a.png)`])(
    'rejects a decoded root-relative value with an origin-changing base: %s',
    (value) => {
      expect(() => {
        checkEntryStyleBase(html('https://elsewhere.example/'), entry(`body { background: ${value} }`));
      }).toThrow(/base.*relative.*stylesheet/i);
    },
  );

  it('uses the first live base element', () => {
    expect(() => {
      checkEntryStyleBase(
        `${html('/elsewhere/')}<base href="https://ignored.example/">`,
        entry('body { background: url(/published/a.png) }'),
      );
    }).not.toThrow();
  });

  it('checks later relative URLs after an allowed root-relative one', () => {
    expect(() => {
      checkEntryStyleBase(html('/elsewhere/'), entry('body { background: url(/a.png), url(b.png) }'));
    }).toThrow(/base.*relative.*stylesheet/i);
  });

  it.each(['https:elsewhere.example', 'http:elsewhere.example'])(
    'rejects root-relative CSS when the base can specify an origin on another deployment scheme: %s',
    (href) => {
      expect(() => {
        checkEntryStyleBase(html(href), entry('body { background: url(/published/a.png) }'));
      }).toThrow(/base.*relative.*stylesheet/i);
    },
  );

  it.each(['data:text/plain,hi', 'javascript:alert(1)'])(
    'allows stylesheet assets when the browser ignores the base URL scheme: %s',
    (href) => {
      expect(() => {
        checkEntryStyleBase(html(href), entry('body { background: url(/published/a.png) }'));
      }).not.toThrow();
    },
  );

  it.each(['https:image.png', 'http:image.png', 'file:image.png'])(
    'rejects a scheme-prefixed CSS value that still resolves against the base: %s',
    (value) => {
      expect(() => {
        checkEntryStyleBase(html('/elsewhere/'), entry(`body { background: url(${value}) }`));
      }).toThrow(/base.*relative.*stylesheet/i);
    },
  );

  it.each(['', '#fragment'])('allows relative CSS when the base preserves its resolution: %s', (href) => {
    expect(() => {
      checkEntryStyleBase(html(href), entry('body { background: url(image.png) }'));
    }).not.toThrow();
  });

  it.each([2, 16])('rejects a relative URL with %i parent segments without clamping away the difference', (depth) => {
    expect(() => {
      checkEntryStyleBase(html('../'), entry(`body { background: url(${'../'.repeat(depth)}image.png) }`));
    }).toThrow(/base.*relative.*stylesheet/i);
  });
});

/**
 * Issue #244 RC2: HTML structure is found by parsing (src/html-structure.ts), never by matching markup text. The
 * ESLint rule that keeps it so (eslint.config.js) catches each way of matching, and src passes it.
 */
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { HTML_STRUCTURE_RESTRICTIONS } from '../scripts/html-structure-restrictions.mjs';

const linter = new Linter();
const restricted = (code: string): number =>
  linter.verify(code, [{ rules: { 'no-restricted-syntax': ['error', ...HTML_STRUCTURE_RESTRICTIONS] } }]).length;

describe('the HTML structure lint rule', () => {
  it.each([
    "html.indexOf('</head');",
    "html.includes('<BODY>');",
    'html.split(`<div id="storeArea"`);',
    "tag === '<head>';",
    "new RegExp('</head');",
    '/<\\/head\\s*>/i.test(html);',
    "html.replace('store-area', x);",
  ])('reports %s', (code) => {
    expect(restricted(code)).toBe(1);
  });

  it.each(["const help = 'Module files to inject into <head>.';", "html.indexOf('</script');", "name === 'head';"])(
    'leaves %s alone',
    (code) => {
      expect(restricted(code)).toBe(0);
    },
  );
});

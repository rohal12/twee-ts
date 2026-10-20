/** A preceding numeric escape must not consume a substituted character (#486). */
import { afterAll, describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { fillFormatTemplate } from '../src/template.js';
import { launchChromium } from './helpers/chromium.js';

function fill(template: string, value: string) {
  return fillFormatTemplate({
    template,
    owner: 'Probe',
    placeholders: [{ token: '{{NAME}}', occurrences: 'all', value: { kind: 'text', text: value } }],
  });
}

const browser = await launchChromium();
afterAll(async () => browser?.close());

const JS_CASES = [
  ['0', '1', '\0', true],
  ['0', '8', '\0', true],
  ['0', 'A', '\0', true],
  ['1', '2', '\x01', false],
  ['12', '3', '\n', false],
  ['4', '7', '\x04', false],
  ['40', '7', ' ', false],
  ['001', '2', '\x01', false],
  ['0', '9', '\0', true],
  ['1', '8', '\x01', false],
  ['x41', 'B', 'A', true],
  ['u0041', 'B', 'A', true],
  ['\\0', '1', '\\0', true],
] as const;

describe('JavaScript numeric escape boundaries', () => {
  it.each(
    JS_CASES.flatMap(([escape, value, prefix, strict]) =>
      ['"', "'"].map((quote) => ({ escape, value, prefix, strict, quote })),
    ),
  )('preserves \\$escape before $value in $quote quotes', ({ escape, value, prefix, strict, quote }) => {
    const template = `<script>${strict ? '"use strict";' : ''}globalThis.value=${quote}\\${escape}{{NAME}}${quote}</script>`;
    const result = fill(template, value);
    const context: { value?: string } = {};
    new Script(result.output.slice(8, -9)).runInNewContext(context);
    expect(context.value).toBe(prefix + value);
    expect(result.diagnostics).toEqual([]);
  });

  it.each(['', ' type="module"'])('preserves null escapes in templates%s', (attributes) => {
    const result = fill(`<script${attributes}>globalThis.value=\`\\0{{NAME}}\`</script>`, '1');
    const context: { value?: string } = {};
    new Script(result.output.slice(result.output.indexOf('>') + 1, -9)).runInNewContext(context);
    expect(context.value).toBe('\0' + '1');
    expect(result.diagnostics).toEqual([]);
  });

  it('diagnoses raw changes in tagged templates', () => {
    expect(fill('<script>String.raw`\\0{{NAME}}`</script>', '1').diagnostics).toHaveLength(1);
  });
});

const CSS_CASES = ['4', '41', '041', '0041', '00041', '000041'].flatMap((escape) =>
  ['B', ' ', '\t', 'G'].flatMap((value) => ['"', "'"].map((quote) => ({ escape, value, quote }))),
);

describe.runIf(browser !== undefined || process.env['CI'] !== undefined)('CSS numeric escape boundaries', () => {
  it.each(CSS_CASES)('preserves \\$escape before $value in $quote quotes', async ({ escape, value, quote }) => {
    if (browser === undefined) throw new Error('No Chromium could be launched: set CHROME_PATH.');
    const result = fill(
      `<style>#probe::before{content:${quote}\\${escape}{{NAME}}${quote}}</style><p id="probe">`,
      value,
    );
    const page = await browser.newPage();
    try {
      await page.setContent(result.output);
      // Compare CSSOM serialization with a separate, fully terminated reference string.
      const content = await page.evaluate<string>(
        "getComputedStyle(document.querySelector('#probe'), '::before').content",
      );
      await page.setContent(
        `<style>#probe::before{content:${quote}\\${escape} ${value}${quote}}</style><p id="probe">`,
      );
      expect(content).toBe(
        await page.evaluate<string>("getComputedStyle(document.querySelector('#probe'), '::before').content"),
      );
      expect(result.diagnostics).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

it('keeps escape state across adjacent and empty substitutions', () => {
  const result = fill('<style>a{content:"\\41{{NAME}}{{NAME}}B"}</style>', '');
  expect(result.diagnostics).toHaveLength(1);
  expect(fill('<script>globalThis.value="\\0{{NAME}}{{NAME}}"</script>', '1').diagnostics).toEqual([]);
});

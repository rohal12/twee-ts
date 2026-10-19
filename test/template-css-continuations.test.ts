/** Public format compilation and Chromium agree on CSS continued strings, including decoded CRLF (#484). */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { launchChromium } from './helpers/chromium.js';
import { elements, textContent } from './helpers/html.js';

const browser = await launchChromium();
afterAll(async () => {
  await browser?.close();
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-css-continuation-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CASES = ['\n', '\r\n', '\r', '\f'].flatMap((newline) => ['"', "'"].map((quote) => ({ newline, quote })));
const TITLE = 'A&B "quoted" \'single\' \\tail';

async function build(newline: string, quote: string, escaped = true) {
  const format = join(dir, 'probe');
  mkdirSync(format, { recursive: true });
  const source =
    '<!doctype html><html><head><style>' +
    `#probe::before { content: ${quote}prefix${escaped ? '\\' : ''}${newline}{{STORY_NAME}}${quote}; }` +
    '</style></head><body><div id="probe"></div>{{STORY_DATA}}</body></html>';
  writeFileSync(
    join(format, 'format.js'),
    `storyFormat(${JSON.stringify({ name: 'Probe', version: '1.0.0', source })});`,
  );
  return compile({
    sources: [
      {
        filename: 's.tw',
        content: `:: StoryData\n{"ifid":"12345678-1234-4234-8234-123456789ABC"}\n:: StoryTitle\n${TITLE}\n:: Start\nHi`,
      },
    ],
    formatPaths: [dir],
    formatId: 'probe',
    noRemote: true,
    useTweegoPath: false,
  });
}

it.each(CASES)('keeps string escaping after $newline in $quote quotes', async ({ newline, quote }) => {
  const result = await build(newline, quote);
  const lf = await build('\n', quote);
  expect(
    elements(result.output, (e) => e.tagName === 'style').map((e) => textContent(e).replaceAll('\f', '\n')),
  ).toEqual(elements(lf.output, (e) => e.tagName === 'style').map(textContent));
  expect(result.diagnostics).toEqual([]);
});

it.each(CASES)('still warns after unescaped $newline in $quote quotes', async ({ newline, quote }) => {
  const result = await build(newline, quote, false);
  expect(result.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('CSS code')]);
});

describe.runIf(browser !== undefined || process.env['CI'] !== undefined)('Chromium CSS values', () => {
  it.each(CASES)('displays the title after escaped $newline in $quote quotes', async ({ newline, quote }) => {
    if (browser === undefined) throw new Error('No Chromium could be launched: set CHROME_PATH.');
    const result = await build(newline, quote);
    const page = await browser.newPage();
    try {
      await page.setContent(result.output);
      const value = await page.evaluate<string>(
        `JSON.parse(getComputedStyle(document.querySelector('#probe'), '::before').content)`,
      );
      expect(value).toBe(`prefix${TITLE}`);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

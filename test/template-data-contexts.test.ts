/** JSON literals and CSS URL tokens keep their language's boundaries during template filling (#544, #545). */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { fillFormatTemplate } from '../src/template.js';
import { launchChromium } from './helpers/chromium.js';
import { attr, elements, scriptTexts, textContent } from './helpers/html.js';

const browser = await launchChromium();
afterAll(async () => browser?.close());

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-template-data-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function build(template: string, value: string, version: 1 | 2) {
  mkdirSync(join(dir, 'probe'), { recursive: true });
  const twine1 = version === 1;
  writeFileSync(
    join(dir, 'probe', twine1 ? 'header.html' : 'format.js'),
    twine1 ? template : `storyFormat(${JSON.stringify({ name: 'Probe', version: '1.0.0', source: template })});`,
  );
  return compile({
    sources: [
      {
        filename: 's.tw',
        content: `:: StoryTitle\n${value}\n:: StoryData\n{"ifid":"12345678-1234-4234-8234-123456789ABC"}\n:: ${value.replaceAll('\\', '\\\\')}\nHi`,
      },
    ],
    startPassage: value,
    formatPaths: [dir],
    formatId: 'probe',
    noRemote: true,
    useTweegoPath: false,
  });
}

function jsonTemplate(value: string, occurrences: 'first' | 'all' = 'all') {
  return fillFormatTemplate({
    template: '<script type="application/json">{"start":"START_AT","again":"START_AT"}</script><p>after</p>',
    placeholders: [{ token: '"START_AT"', occurrences, value: { kind: 'quoted', text: value } }],
    owner: 'JSON',
  });
}

describe('whole quoted JSON replacements (#544)', () => {
  it.each([
    '',
    'Room',
    "Alice's Room",
    '"quoted"',
    '\\path',
    '<Room>',
    '</script><script>bad',
    ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)),
    '\u2028\u2029',
    '\ud800',
  ])('preserves %j in valid JSON and keeps the script whole', (value) => {
    const result = jsonTemplate(value);
    expect(scriptTexts(result.output)).toHaveLength(1);
    expect(JSON.parse(scriptTexts(result.output)[0] ?? '')).toEqual({ start: value, again: value });
    expect(elements(result.output, (e) => e.tagName === 'p').map(textContent)).toEqual(['after']);
    expect(result.diagnostics).toEqual([]);
  });

  it('round-trips arbitrary UTF-16 values through JSON.parse', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 65535 }), { maxLength: 80 }), (codes) => {
        const value = String.fromCharCode(...codes);
        const result = jsonTemplate(value);
        expect(JSON.parse(scriptTexts(result.output)[0] ?? '')).toEqual({ start: value, again: value });
        expect(result.diagnostics).toEqual([]);
      }),
      { seed: 544, numRuns: 100 },
    );
  });

  it('retains first-only substitution semantics', () => {
    const result = jsonTemplate("Alice's <Room>", 'first');
    expect(JSON.parse(scriptTexts(result.output)[0] ?? '')).toEqual({ start: "Alice's <Room>", again: 'START_AT' });
    expect(result.diagnostics).toEqual([]);
  });

  it.each(["Alice's Room", '<Room>', 'A\\B"C', '</script>'])('compiles a Twine 1 start named %j', async (start) => {
    const result = await build(
      '<html><head><script type="application/json">{"start":"START_AT"}</script></head>' +
        '<body><div id="storeArea">"STORY"</div></body></html>',
      start,
      1,
    );
    expect(JSON.parse(scriptTexts(result.output)[0] ?? '')).toEqual({ start });
    expect(result.diagnostics).toEqual([]);
  });
});

const URL_NAMES = ['url', 'URL', String.raw`\75rl`, String.raw`u\72 l`];

async function cssBuild(name: string, closeComment: boolean) {
  return build(
    '<html><head><style id="probe-style">#probe{' +
      `background-image:${name}(https://example.test/*{{STORY_NAME}}${closeComment ? '*' : ''}/image.png);` +
      'font-family:"{{STORY_NAME}}"}</style></head><body><div id="probe"></div>{{STORY_DATA}}</body></html>',
    'a*/b',
    2,
  );
}

describe('CSS URL substitutions (#545)', () => {
  it.each(URL_NAMES.flatMap((name) => [false, true].map((closeComment) => ({ name, closeComment }))))(
    'diagnoses URL content in $name with closing comment $closeComment and reads the next string',
    async ({ name, closeComment }) => {
      const result = await cssBuild(name, closeComment);
      expect(
        elements(result.output, (e) => e.tagName === 'style' && attr(e, 'id') === 'probe-style').map(textContent),
      ).toEqual([
        `#probe{background-image:${name}(https://example.test/*a*/b${closeComment ? '*' : ''}/image.png);font-family:"a*/b"}`,
      ]);
      expect(result.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('CSS code')]);
    },
  );
});

describe.runIf(browser !== undefined || process.env['CI'] !== undefined)('Chromium CSS URL values (#545)', () => {
  it.each(URL_NAMES)('retains a valid declaration in %s and the following string', async (name) => {
    if (browser === undefined) throw new Error('No Chromium could be launched: set CHROME_PATH.');
    const result = await cssBuild(name, true);
    const page = await browser.newPage();
    try {
      await page.route('**/*', (route) => route.abort());
      await page.setContent(result.output);
      expect(
        await page.evaluate<string>('document.querySelector("#probe-style").sheet.cssRules[0].style.backgroundImage'),
      ).toBe('url("https://example.test/*a*/b*/image.png")');
      expect(
        await page.evaluate<string>('document.querySelector("#probe-style").sheet.cssRules[0].style.fontFamily'),
      ).toBe('"a*/b"');
      expect(result.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('CSS code')]);
    } finally {
      await page.close();
    }
  });
});

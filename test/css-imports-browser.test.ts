/**
 * The test oracle of css-imports.test.ts, in a real browser (#352): Chromium parses the joined story stylesheet, and
 * the imports it keeps as rules in the style sheet (`CSSImportRule`) are the ones the scanner must not report. This
 * checks the table of what may come before an `@import` (test/helpers/css-imports.ts), except for the cases the
 * browsers differ about, and a generated differential: sequences of rules, stray tokens and unfinished statements, one
 * source each, with an import among them.
 *
 * The browser is the one at `CHROME_PATH`, else Playwright's own Chromium, else an installed Google Chrome (which the
 * CI runners have). Without any, the tests are skipped, except in CI, where they fail.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser, LaunchOptions, Page } from 'playwright-core';
import fc from 'fast-check';
import { ineffectiveImportDiagnostics } from '../src/css-imports.js';
import { JOINER, PREDECESSORS, sourcesOf } from './helpers/css-imports.js';

/** Launches the first Chromium that starts, or gives undefined. */
async function launchChromium(): Promise<Browser | undefined> {
  const path = process.env['CHROME_PATH'];
  const attempts: LaunchOptions[] = [
    ...(path === undefined || path === '' ? [] : [{ executablePath: path }]),
    {},
    { channel: 'chrome' },
  ];
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch {
      // Not installed there: try the next.
    }
  }
  return undefined;
}

const browser = await launchChromium();
afterAll(async () => {
  await browser?.close();
});

/** The `href` of every import rule the browser keeps of each stylesheet text. A string, as the page evaluates it. */
const KEPT_IMPORTS = `(texts) => texts.map((css) => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const hrefs = [...style.sheet.cssRules].filter((rule) => rule.href !== undefined).map((rule) => rule.href);
  style.remove();
  return hrefs;
})`;

async function keptImports(page: Page, texts: readonly string[]): Promise<string[][]> {
  return await page.evaluate<string[][]>(`(${KEPT_IMPORTS})(${JSON.stringify(texts)})`);
}

describe.runIf(browser !== undefined || process.env['CI'] !== undefined)(
  'which @import rules Chromium keeps (#352)',
  { timeout: 60_000 },
  () => {
    const open = async (): Promise<Page> => {
      if (browser === undefined) throw new Error('No Chromium could be launched: set CHROME_PATH.');
      return browser.newPage();
    };

    it('agrees with the table of what may come before an import', async () => {
      const page = await open();
      const cases = PREDECESSORS.filter((p) => p.engines !== 'varies');
      const modes = cases.flatMap((p) =>
        (p.where === 'sources' ? [true] : [false, true]).map((split) => ({ p, split })),
      );
      const kept = await keptImports(
        page,
        modes.map(({ p, split }) => sourcesOf(p.css, split).join(split ? JOINER : '')),
      );
      await page.close();

      const verdicts = modes.map(({ p, split }, i) => ({
        name: `${p.name}${split ? ' (sources)' : ''}`,
        // The import ends in `i.css`: kept, unless something before it ends the place for imports.
        ignored: !(kept[i] ?? []).some((href) => href.endsWith('/i.css')),
        expected: p.blocks,
      }));

      expect(verdicts.filter((v) => v.ignored !== v.expected)).toEqual([]);
    });

    // Statements that build to a sequence: each is a source of its own, the imports numbered. An unterminated `url(`
    // is not among them: the browser reads it on into the sources that follow, up to a `)`, which the scanner does
    // not (it ends there with the source, so what follows is reported as swallowed).
    const piece = (n: number): fc.Arbitrary<string> =>
      fc.oneof(
        { weight: 3, arbitrary: fc.constant(`@import "m${String(n)}.css";`) },
        { weight: 1, arbitrary: fc.constant(`@import "m${String(n)}.css"`) },
        fc.constantFrom(
          '',
          '/* c */',
          '<!-- -->',
          '@layer a;',
          '@layer a, b;',
          '@layer c { p {} }',
          '@namespace x url(y);',
          'a {}',
          'a { color: red;',
          'a { color: red; }',
          '@media print {}',
          '@media print {',
          '}',
          ';',
          'a;',
          'a {};',
          '@font-face { font-family: x }',
          '@page {}',
          'b { background: url(x) }',
          'b { background: url(a{b) }',
          ')',
          ']',
          'color: red;',
          '@supports (a: b) {}',
          '@scope (a) {}',
          'a { content: "}" }',
          'a { b: url("x;y") }',
          '"x',
          "'x'",
          '\\@x',
          '/* a { */',
          '/* a',
          '{}',
          '@layer {}',
        ),
      );
    const sequence = fc
      .integer({ min: 1, max: 6 })
      .chain((length) => fc.tuple(...Array.from({ length }, (_, n) => piece(n))));

    it('agrees with the scanner on generated sequences of sources', async () => {
      const page = await open();
      await fc.assert(
        fc.asyncProperty(sequence, async (pieces) => {
          const [kept] = await keptImports(page, [pieces.join(JOINER)]);
          const reported = ineffectiveImportDiagnostics(pieces.map((text, i) => ({ label: `s${String(i)}.`, text })));
          const ignoredByScanner = new Set(reported.map((d) => Number(/^s(\d+)\./.exec(d.message)?.[1])));
          // An import is kept as a rule when it is valid; a piece without one reports nothing.
          const ignoredByBrowser = new Set(
            pieces.flatMap((text, i) =>
              text.startsWith('@import') &&
              !(kept ?? []).some((href) => href.replace(/^.*\//, '') === `m${String(i)}.css`)
                ? [i]
                : [],
            ),
          );

          expect([...ignoredByScanner].sort()).toEqual([...ignoredByBrowser].sort());
        }),
        { numRuns: 300 },
      );
      await page.close();
    });
  },
);

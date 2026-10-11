/**
 * The test oracle of css-imports.test.ts, in real browsers (#352): the stylesheet that real compile() output writes
 * (the style element of Twine 2 HTML and of the archive, read with parse5, and the `style` of JSON output) is put in a
 * style element, and the imports the browser keeps as rules (`CSSImportRule`) are the ones the compiler must not
 * report. It checks the table of what may come before an `@import` (test/helpers/css-imports.ts) and a generated
 * differential: sequences of rules, stray tokens and unfinished statements, a `.css` file each, with imports among
 * them.
 *
 * Each engine runs when it starts: Chromium (at `CHROME_PATH`, else Playwright's own, else an installed Google
 * Chrome), Firefox (at `FIREFOX_PATH`, else Playwright's) and WebKit (at `WEBKIT_PATH`, else Playwright's). Without
 * Chromium the tests are skipped, except in CI, where they fail; without Firefox or WebKit just that engine is skipped.
 * `CSS_IMPORTS_RUNS` sets the number of generated sequences (default 300).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { chromium, firefox, webkit } from 'playwright-core';
import type { Browser, BrowserType, LaunchOptions, Page } from 'playwright-core';
import fc from 'fast-check';
import { compile } from '../src/compiler.js';
import { PREDECESSORS, sourcesOf } from './helpers/css-imports.js';
import { attr, elements, textContent } from './helpers/html.js';

interface Engine {
  readonly name: string;
  readonly type: BrowserType;
  readonly pathVariable: string;
  readonly channel?: string;
}

const ENGINES: readonly Engine[] = [
  { name: 'Chromium', type: chromium, pathVariable: 'CHROME_PATH', channel: 'chrome' },
  { name: 'Firefox', type: firefox, pathVariable: 'FIREFOX_PATH' },
  { name: 'WebKit', type: webkit, pathVariable: 'WEBKIT_PATH' },
];

/** Launches the first browser of the engine that starts, or gives undefined. */
async function launch({ type, pathVariable, channel }: Engine): Promise<Browser | undefined> {
  const path = process.env[pathVariable];
  const attempts: LaunchOptions[] = [
    ...(path === undefined || path === '' ? [] : [{ executablePath: path }]),
    {},
    ...(channel === undefined ? [] : [{ channel }]),
  ];
  for (const options of attempts) {
    try {
      return await type.launch(options);
    } catch {
      // Not installed there: try the next.
    }
  }
  return undefined;
}

const browsers = new Map(await Promise.all(ENGINES.map(async (e) => [e.name, await launch(e)] as const)));
afterAll(async () => {
  await Promise.all(
    [...browsers.values()].map(async (b) => {
      await b?.close();
    }),
  );
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

/** The file name of an imported stylesheet, from the `href` of its rule. */
const fileOf = (href: string): string => href.replace(/^.*\//, '');

const IFID = '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}';
const STORY = `:: StoryTitle\nT\n\n:: StoryData\n${IFID}\n\n:: Start\nHello\n`;

type Mode = 'html' | 'twine2-archive' | 'json';

/** What a build writes of the story stylesheet, and the import warnings it gives. */
interface Built {
  readonly style: string;
  readonly warned: ReadonlySet<string>;
}

const builds = new Map<string, Promise<Built>>();

/** Builds a story with the stylesheets as `.css` files `s0.css`, `s1.css`, and so on, and reads its stylesheet. */
function build(texts: readonly string[], mode: Mode): Promise<Built> {
  const key = `${mode}\n${JSON.stringify(texts)}`;
  const known = builds.get(key);
  if (known !== undefined) return known;
  const built = (async (): Promise<Built> => {
    const result = await compile({
      formatPaths: ['test/fixtures/storyformats-sugarcube'],
      useTweegoPath: false,
      noRemote: true,
      outputMode: mode,
      sources: [
        { filename: 'story.tw', content: STORY },
        ...texts.map((content, i) => ({ filename: `s${String(i)}.css`, content })),
      ],
    });
    const style =
      mode === 'json'
        ? (JSON.parse(result.output) as { style: string }).style
        : elements(result.output, (e) => e.tagName === 'style' && attr(e, 'id') === 'twine-user-stylesheet')
            .map(textContent)
            .join('');
    const warned = result.diagnostics.flatMap((d) =>
      d.message.includes('@import') ? [/^Stylesheet passage "(s\d+)\.css"/.exec(d.message)?.[1] ?? d.message] : [],
    );
    return { style, warned: new Set(warned) };
  })();
  builds.set(key, built);
  return built;
}

const MODES: readonly Mode[] = ['html', 'twine2-archive', 'json'];
const RUNS = Number(process.env['CSS_IMPORTS_RUNS'] ?? '300');

/** Pieces that only some browsers know as rules: the compiler warns after them, and a browser may keep the import. */
const SOME_BROWSERS: readonly string[] = [
  '@-moz-document url-prefix() {}',
  '@-moz-keyframes k {}',
  '@function --f() { result: 1 }',
  '@view-transition { navigation: auto }',
  '@page a, b {}',
];

// Statements that build a sequence: each is a `.css` file of its own, the imports numbered by their place.
const piece = (n: number): fc.Arbitrary<string> =>
  fc.oneof(
    { weight: 3, arbitrary: fc.constant(`@import "m${String(n)}.css";`) },
    { weight: 1, arbitrary: fc.constant(`@import "m${String(n)}.css"`) },
    fc.constantFrom(
      '/* c */',
      '<!-- -->',
      '@layer a;',
      '@layer a, b;',
      '@layer a',
      '@layer a, b { p {} }',
      '@layer c { p {} }',
      '@layer { p {} }',
      '@layer;',
      '@namespace x url(y);',
      '@namespace x url(y)',
      '@namespace;',
      '@import;',
      '@import foo;',
      '@charset "UTF-8";',
      '@foo bar {}',
      '@foo bar;',
      '@media print;',
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
      'b { background: url(x',
      'url(',
      'a { b: url(a"b) }',
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
      '#a {}',
      '1px {}',
      'a ! {}',
      '*/',
      '/ a {}',
      '#1a {}',
      '#a1 {}',
      '@keyframes {}',
      '@keyframes k {}',
      '@supports foo {}',
      '@page 1 {}',
      '@property x {}',
      '@counter-style {}',
      '@-o-keyframes k {}',
      '@document url(x) {}',
      '@-moz-document url(x) {}',
      ...SOME_BROWSERS,
      '@page a, b {}',
    ),
  );
const sequence = fc
  .integer({ min: 1, max: 6 })
  .chain((length) => fc.tuple(...Array.from({ length }, (_, n) => piece(n))));

for (const engine of ENGINES) {
  const browser = browsers.get(engine.name);
  // Chromium is required in CI; the other engines run where they are installed.
  describe.runIf(browser !== undefined || (engine.name === 'Chromium' && process.env['CI'] !== undefined))(
    `which @import rules ${engine.name} keeps (#352)`,
    { timeout: 600_000 },
    () => {
      const open = async (): Promise<Page> => {
        if (browser === undefined) throw new Error(`No ${engine.name} could be launched: set ${engine.pathVariable}.`);
        return browser.newPage();
      };

      it.each(MODES)('agrees with the table of what may come before an import, in %s output', async (mode) => {
        const rows = PREDECESSORS.flatMap((p) =>
          (p.where === 'sources' ? [true] : [false, true]).map((split) => ({ p, split })),
        );
        const builtRows = await Promise.all(rows.map(({ p, split }) => build(sourcesOf(p.css, split), mode)));
        const page = await open();
        const kept = await keptImports(
          page,
          builtRows.map((b) => b.style),
        );
        await page.close();

        const verdicts = rows.map(({ p, split }, i) => {
          const own = split ? 's1' : 's0';
          const ignored = !(kept[i] ?? []).some((href) => fileOf(href) === 'i.css');
          const warned = builtRows[i]?.warned.has(own) ?? false;
          return {
            name: `${p.name}${split ? ' (sources)' : ''}`,
            // A browser that does not know the at-rule keeps the import; it may not ignore what the compiler keeps.
            disagrees: p.engines === 'some' ? ignored && !warned : ignored !== warned,
            // Nothing else is reported: the predecessor's own imports are kept.
            others: [...(builtRows[i]?.warned ?? [])].filter((s) => s !== own),
          };
        });

        expect(verdicts.filter((v) => v.disagrees || v.others.length > 0)).toEqual([]);
      });

      it('agrees with the compiler on generated sequences of sources', async () => {
        const page = await open();
        await fc.assert(
          fc.asyncProperty(sequence, fc.constantFrom<Mode>('html', 'json'), async (pieces, mode) => {
            const { style, warned } = await build(pieces, mode);
            const [kept] = await keptImports(page, [style]);
            // An import is kept as a rule when it is valid; a piece without one is not reported.
            const ignoredByBrowser = pieces.flatMap((text, i) =>
              text.startsWith('@import "') && !(kept ?? []).some((href) => fileOf(href) === `m${String(i)}.css`)
                ? [`s${String(i)}`]
                : [],
            );

            // With a piece only some browsers know, a browser may keep an import the compiler warns about, not the reverse.
            const partial = pieces.some((text) => SOME_BROWSERS.includes(text));
            const actual = partial ? ignoredByBrowser.filter((source) => !warned.has(source)) : [...warned].sort();
            const expected = partial ? [] : ignoredByBrowser.sort();

            expect(actual).toEqual(expected);
          }),
          { numRuns: RUNS },
        );
        await page.close();
      });
    },
  );
}

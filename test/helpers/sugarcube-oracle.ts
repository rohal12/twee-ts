/**
 * SugarCube 2 itself as a word count oracle: a story built with the real format runs in Chromium, and each text is
 * wikified as passage markup into an element of the page. The words are the runs of non-white-space characters (Go's
 * white space, as `splitTweeFields` reads it) in the text the reader can see: text nodes whose element is rendered,
 * joined as they come, with a line break (`<br>`, which SugarCube makes of a line feed) as white space.
 *
 * The format is SugarCube 2.37.3 as released (BSD-2-Clause, its LICENSE beside it), kept in
 * `test/fixtures/sugarcube-oracle/sugarcube-2`, apart from the format folders the format discovery tests read; it is
 * checked against its SHA-256 before use. Without a browser, `openSugarCubeOracle` gives undefined.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compile } from '../../src/index.js';
import { launchChromium } from './chromium.js';
import { splitTweeFields } from '../../src/twee-syntax.js';

/** The folder holding `sugarcube-2/format.js`. */
const FORMATS_DIR = join(import.meta.dirname, '..', 'fixtures', 'sugarcube-oracle');
/** The SHA-256 of SugarCube 2.37.3's `format.js`. */
const FORMAT_SHA256 = '14bf79a105ab303aea48fc7443f4d937aa1bcca3fb5c68be571369ce591fe041';

/** The format folder, once its `format.js` is the one this oracle is for. */
function checkedFormatsDir(): string {
  const digest = createHash('sha256')
    .update(readFileSync(join(FORMATS_DIR, 'sugarcube-2', 'format.js')))
    .digest('hex');
  if (digest !== FORMAT_SHA256) {
    throw new Error(
      `test/fixtures/sugarcube-oracle/sugarcube-2/format.js has SHA-256 ${digest}, not ${FORMAT_SHA256}.`,
    );
  }
  return FORMATS_DIR;
}

export interface SugarCubeOracle {
  /** The words the reader sees for each text, or `undefined` where SugarCube shows an error. */
  readonly count: (texts: readonly string[]) => Promise<(number | undefined)[]>;
  readonly close: () => Promise<void>;
}

/**
 * Run in the page (as source, so this module needs no DOM types): wikifies each text into an element of the page and
 * gives the text the reader sees, or null where SugarCube shows an error. A text node is seen when its element is
 * rendered (not hidden, not inside an iframe) and the browser lays the text out in boxes, which it doesn't for text an
 * SVG or MathML element doesn't render; white space between rendered elements still parts words, and a textarea's
 * text, shown as its value, has no boxes of its own but counts.
 */
const SHOWN_TEXTS = `(sources) => sources.map((source) => {
  const range = document.createRange();
  const shown = (node) => {
    const element = node.parentElement;
    if (!element.checkVisibility() || element.closest('iframe') !== null) return false;
    // A textarea shows its text as its value, which has no boxes of its own.
    if (node.textContent.trim() === '' || element.localName === 'textarea') return true;
    range.selectNodeContents(node);
    return range.getClientRects().length > 0;
  };
  const out = document.createElement('div');
  document.body.append(out);
  try {
    new SugarCube.Wikifier(out, source);
    if (out.querySelector('.error-view, .error') !== null) return null;
    let text = '';
    const walker = document.createTreeWalker(out, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node instanceof Element) {
        if (node.localName === 'br') text += ' ';
      } else if (shown(node)) {
        text += node.textContent;
      }
    }
    return text;
  } finally {
    out.remove();
  }
})`;

const STORY = `:: StoryTitle\nOracle\n\n:: StoryData\n{"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC", "format": "SugarCube", "format-version": "2.37.3"}\n\n:: Start\nReady\n`;

export async function openSugarCubeOracle(): Promise<SugarCubeOracle | undefined> {
  const formats = checkedFormatsDir();
  const browser = await launchChromium();
  if (browser === undefined) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-sugarcube-oracle-'));
  const result = await compile({
    sources: [{ filename: 'story.tw', content: STORY }],
    formatPaths: [formats],
    useTweegoPath: false,
    noRemote: true,
  });
  const file = join(dir, 'story.html');
  writeFileSync(file, result.output);
  const page = await browser.newPage();
  await page.goto(`file://${file}`);
  await page.waitForFunction("document.querySelector('#passages .passage') !== null");
  return {
    count: async (texts) => {
      const shown: unknown = await page.evaluate(`(${SHOWN_TEXTS})(${JSON.stringify(texts)})`);
      if (!Array.isArray(shown)) throw new Error('The page gave no texts.');
      return shown.map((text: unknown) => (typeof text === 'string' ? splitTweeFields(text).length : undefined));
    },
    close: async () => {
      await browser.close();
      rmSync(dirname(file), { recursive: true, force: true });
    },
  };
}

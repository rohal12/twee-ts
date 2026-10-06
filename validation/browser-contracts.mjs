/** Real Chromium smoke of compiler-produced HTML using a real supplied SugarCube format. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'htmlparser2';
import { compile } from '../dist/index.js';
import { sha256 } from './evidence.mjs';
import { readFileSync } from 'node:fs';
const formatPath = process.env.BROWSER_FORMAT_PATH;
assert(formatPath, 'Set BROWSER_FORMAT_PATH to a directory containing a real SugarCube format');
const root = mkdtempSync(join(tmpdir(), 'twee-browser-'));
try {
  const head = join(root, 'head.html');
  const module = join(root, 'module.js');
  writeFileSync(head, '<script>document.documentElement.dataset.reviewHead="yes";</script>');
  writeFileSync(module, 'document.documentElement.dataset.reviewModule="yes";');
  const result = await compile({
    sources: [
      {
        filename: 'browser.tw',
        content:
          ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: StoryTitle\nBrowser Validation\n:: Start\nBrowser smoke &amp; &lt;ok&gt;\n:: Script [script]\ndocument.documentElement.dataset.reviewInline="yes";',
      },
    ],
    formatId: 'sugarcube-2',
    formatPaths: [formatPath],
    useTweegoPath: false,
    noRemote: true,
    headFile: head,
    modules: [module],
  });
  assert(!result.diagnostics.some((d) => d.level === 'error'));
  const file = join(root, 'story.html');
  writeFileSync(file, result.output);
  const dom = execFileSync(
    process.env.CHROME_BINARY ?? 'google-chrome',
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--user-data-dir=${join(root, 'profile')}`,
      '--dump-dom',
      '--virtual-time-budget=3000',
      '--timeout=10000',
      pathToFileURL(file).href,
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 5 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const document = parseDocument(dom);
  let passage;
  let html;
  const visit = (node) => {
    if (node.name === 'html') html = node;
    if (node.attribs?.['data-passage'] === 'Start' && node.attribs.class?.split(' ').includes('passage'))
      passage = node;
    for (const child of node.children ?? []) visit(child);
  };
  visit(document);
  const text = (node) => (node.data ?? '') + (node.children ?? []).map(text).join('');
  assert(passage, 'SugarCube did not render Start');
  assert.match(text(passage), /Browser smoke & <ok>/);
  for (const key of ['data-review-head', 'data-review-module', 'data-review-inline'])
    assert.equal(html.attribs[key], 'yes', `${key} did not execute`);
  console.log(
    JSON.stringify({
      status: 'pass',
      browser: execFileSync(process.env.CHROME_BINARY ?? 'google-chrome', ['--version'], { encoding: 'utf8' }).trim(),
      format: 'SugarCube',
      formatSha256: sha256(readFileSync(join(formatPath, 'sugarcube-2', 'format.js'))),
      limits: ['Smoke of initial passage and injected scripts; not exhaustive gameplay or every external engine.'],
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from '../src/compiler.js';
import { launchChromium } from './helpers/chromium.js';
import { STORY } from './helpers/plugins.js';

const browser = await launchChromium();
const root = mkdtempSync(join(tmpdir(), 'twee-hashbang-browser-'));
afterAll(async () => {
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(browser !== undefined || process.env['CI'] !== undefined)('SugarCube script hashbangs (#348)', () => {
  it.each(['first', 'last', 'all', 'single'] as const)('initializes scripts with %s hashbangs', async (position) => {
    if (browser === undefined) throw new Error('No Chromium could be launched: set CHROME_PATH.');
    const result = await compile({
      sources: [
        { filename: 'story.tw', content: STORY },
        { filename: 'first.js', content: `${position !== 'last' ? '#!/usr/bin/env node\n' : ''}window.first = true;` },
        ...(position === 'single'
          ? []
          : [
              {
                filename: 'last.js',
                content: `${position !== 'first' ? '#!/usr/bin/env node\n' : ''}window.last = true;`,
              },
            ]),
      ],
      formatId: 'sugarcube-2',
      formatPaths: ['test/fixtures/sugarcube-oracle'],
      useTweegoPath: false,
      noRemote: true,
    });
    expect(result.diagnostics).toEqual([]);
    const file = join(root, `${position}.html`);
    writeFileSync(file, result.output);
    const page = await browser.newPage();
    try {
      await page.goto(pathToFileURL(file).href);
      await page.waitForSelector('.passage');
      expect(await page.evaluate('[window.first, window.last]')).toEqual([
        true,
        position === 'single' ? undefined : true,
      ]);
      expect(await page.locator('.error-view').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});

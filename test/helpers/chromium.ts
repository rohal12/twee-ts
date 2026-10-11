/**
 * The browser for browser tests: the one at `CHROME_PATH`, else Playwright's own Chromium, else an installed Google
 * Chrome (which the CI runners have).
 */
import { chromium } from 'playwright-core';
import type { Browser, LaunchOptions } from 'playwright-core';

/** Launches the first Chromium that starts, or gives undefined. */
export async function launchChromium(): Promise<Browser | undefined> {
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

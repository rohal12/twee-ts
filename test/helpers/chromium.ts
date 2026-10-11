/**
 * The browsers for browser tests: Chromium at `CHROME_PATH`, else Playwright's own Chromium, else an installed Google
 * Chrome (which the CI runners have); other engines at their own variable, else Playwright's.
 */
import { chromium } from 'playwright-core';
import type { Browser, BrowserType, LaunchOptions } from 'playwright-core';

/** A browser engine to launch: its Playwright type, the variable naming its executable, and a channel to try last. */
export interface Engine {
  readonly name: string;
  readonly type: BrowserType;
  readonly pathVariable: string;
  readonly channel?: string;
}

export const CHROMIUM: Engine = { name: 'Chromium', type: chromium, pathVariable: 'CHROME_PATH', channel: 'chrome' };

/** Launches the first browser of the engine that starts, or gives undefined. */
export async function launchBrowser({ type, pathVariable, channel }: Engine): Promise<Browser | undefined> {
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

/** Launches the first Chromium that starts, or gives undefined. */
export async function launchChromium(): Promise<Browser | undefined> {
  return launchBrowser(CHROMIUM);
}

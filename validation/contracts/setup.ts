/**
 * The cases run against the build in dist/, which must exist.
 *
 * The contract cases never reach the network: a request to anything but the loopback servers the
 * cases start fails, so no case can pass on what a real server happens to answer.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

for (const file of ['index.js', 'plugins/vite.js', 'bin/twee-ts.js']) {
  if (!existsSync(resolve(import.meta.dirname, '../../dist', file))) {
    throw new Error(`dist/${file} is missing: run pnpm run build before the contract cases.`);
  }
}

const realFetch = globalThis.fetch;

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

beforeAll(() => {
  globalThis.fetch = (input, init) => {
    const url = requestUrl(input);
    if (url.hostname !== '127.0.0.1') {
      return Promise.reject(new Error(`the contract cases forbid network access: ${url.href}`));
    }
    return realFetch(input, init);
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

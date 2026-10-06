/**
 * A Twine 1 format downloaded from an index builds from the files that were downloaded and verified:
 * its `code.js` and `userlib.js` come from that download, whether or not the cache could be written
 * (#277), and a later build from the cache uses the cached, verified bytes.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { sha256Hex } from '../src/format-cache.js';
import { entryPath, indexJson, isolateFormatEnvironment, startFormatServer } from './helpers/format-server.js';

const tempRoot = isolateFormatEnvironment('twine1-components');

const HEADER =
  '<!doctype html><html><head><script>"SUGARCANE"</script><script>"USER_LIB"</script></head>' +
  '<body><div id="storeArea">"STORY"</div></body></html>';
const CODE = 'globalThis.codeRan = true;';
const USERLIB = 'globalThis.userLibRan = true;';
const FILES: Readonly<Record<string, string>> = { 'header.html': HEADER, 'code.js': CODE, 'userlib.js': USERLIB };
const STORY = [
  {
    filename: 'story.tw',
    content: ':: StoryData\n{"ifid":"12345678-1234-4234-8234-123456789ABC"}\n\n:: StoryTitle\nT\n\n:: Start\nHi',
  },
];

/** A server with an index listing `listed` files of the Twine 1 format RemoteOne, and those files. */
async function serve(listed: readonly string[]) {
  const checksums = Object.fromEntries(listed.map((file) => [file, sha256Hex(FILES[file] ?? '')]));
  const entry = { name: 'RemoteOne', version: '1.0.0', files: listed, checksums };
  const routes = Object.fromEntries(
    listed.map((file) => [`/${entryPath('RemoteOne', '1.0.0', file, 'twine1')}`, FILES[file] ?? '']),
  );
  const server = await startFormatServer({ '/index.json': indexJson([], [entry]), ...routes });
  return {
    sources: STORY,
    formatId: 'remoteone-1',
    useTweegoPath: false,
    useDefaultFormatIndices: false,
    formatIndices: [`${server.origin}/index.json`],
    outputMode: 'html' as const,
  };
}

/** Makes the cache unwritable: a regular file where its folder must be. */
function blockCache(): void {
  mkdirSync(tempRoot(), { recursive: true });
  writeFileSync(join(tempRoot(), 'cache'), 'block');
}

describe('a Twine 1 format downloaded from an index', () => {
  it.each([
    ['code.js', ['header.html', 'code.js'], [CODE], [USERLIB]],
    ['code.js and userlib.js', ['header.html', 'code.js', 'userlib.js'], [CODE, USERLIB], []],
  ] as const)('uses the downloaded %s when the cache cannot be written', async (_name, listed, present, absent) => {
    const options = await serve(listed);
    blockCache();
    const result = await compile(options);
    const html = Buffer.from(result.output).toString('utf8');
    for (const text of present) expect(html).toContain(text);
    for (const text of absent) expect(html).not.toContain(text);
    expect(result.diagnostics.filter((d) => d.level === 'warning').map((d) => d.message)).toEqual([
      expect.stringContaining('to the format cache'),
    ]);
  });

  it('uses the same components from a writable cache, and again from the cache offline', async () => {
    const options = await serve(['header.html', 'code.js', 'userlib.js']);
    const online = Buffer.from((await compile(options)).output).toString('utf8');
    expect(online).toContain(CODE);
    expect(online).toContain(USERLIB);
    const offline = Buffer.from((await compile({ ...options, noRemote: true })).output).toString('utf8');
    expect(offline).toContain(CODE);
    expect(offline).toContain(USERLIB);
  });
});

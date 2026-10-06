/**
 * Several compiles, in one process and in several processes, sharing one format cache: each gets
 * its own sources' format, the shared download is complete and checked, and no temporary files
 * are left behind.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from '../src/compiler.js';
import { listCachedFormats } from '../src/format-cache.js';
import {
  isolateFormatEnvironment,
  entryPath,
  formatJs,
  indexEntry,
  indexJson,
  markerOf,
  startFormatServer,
  storySource,
} from './helpers/format-server.js';

const ROOT = resolve(import.meta.dirname, '..');
const TSX_LOADER = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

const tempRoot = isolateFormatEnvironment('format-concurrency');

/** Every file below `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
}

/** A server whose index and format.js answer after a short delay, so that concurrent requests overlap. */
async function slowArchive(marker: string) {
  const text = formatJs('Review', '1.0.0', marker);
  const later =
    (body: string) =>
    (_req: unknown, res: { end: (body: string) => void }): void => {
      setTimeout(() => {
        res.end(body);
      }, 30);
    };
  return startFormatServer({
    '/index.json': later(indexJson([indexEntry('Review', '1.0.0', text)])),
    [`/${entryPath('Review', '1.0.0')}`]: later(text),
    '/format.js': later(formatJs('Review', '1.0.0', `${marker}-URL`)),
  });
}

describe('compiles in one process sharing a cache', () => {
  it('give each project its own sources’ format', async () => {
    const a = await slowArchive('A');
    const b = await slowArchive('B');
    const builds = await Promise.all(
      [a, b, a, b].flatMap((server) => [
        compile({
          sources: storySource('Review', '1.0.0'),
          useTweegoPath: false,
          formatIndices: [`${server.origin}/index.json`],
        }),
        compile({
          sources: storySource('Review', '1.0.0'),
          useTweegoPath: false,
          formatUrls: [`${server.origin}/format.js`],
        }),
      ]),
    );
    expect(builds.map((r) => markerOf(r.output))).toEqual(['A', 'A-URL', 'B', 'B-URL', 'A', 'A-URL', 'B', 'B-URL']);
    expect(listCachedFormats()).toHaveLength(4);
    expect(filesUnder(join(tempRoot(), 'cache')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('compiles in several processes sharing a cache', () => {
  it('all succeed, with one complete copy and no temporary files', async () => {
    const server = await slowArchive('SHARED');
    const script = join(tempRoot(), 'build.mjs');
    writeFileSync(
      script,
      [
        `const { compile } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'index.ts')).href)});`,
        `const result = await compile({`,
        `  sources: [{ filename: 's.tw', content: ':: StoryData\\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Review","format-version":"1.0.0"}\\n\\n:: Start\\nHi' }],`,
        `  useTweegoPath: false,`,
        `  formatIndices: [${JSON.stringify(`${server.origin}/index.json`)}],`,
        `});`,
        `process.stdout.write(JSON.stringify({ marker: /<body>(\\S+) /.exec(result.output)?.[1], diagnostics: result.diagnostics }));`,
      ].join('\n'),
    );
    const env = {
      ...process.env,
      XDG_CACHE_HOME: join(tempRoot(), 'cache'),
      HOME: join(tempRoot(), 'home'),
      USERPROFILE: join(tempRoot(), 'home'),
    };
    const run = (): Promise<{ code: number | null; stdout: string; stderr: string }> =>
      new Promise((done) => {
        const child = spawn(process.execPath, ['--import', TSX_LOADER, script], { env, cwd: tempRoot() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('close', (code) => {
          done({ code, stdout, stderr });
        });
      });
    // The children do not share this process's network guard; they never reach the default
    // archive indices, as the project's own index answers first.
    const results = await Promise.all(Array.from({ length: 6 }, run));
    for (const result of results) {
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ marker: 'SHARED', diagnostics: [] });
    }
    expect(listCachedFormats()).toHaveLength(1);
    const files = filesUnder(join(tempRoot(), 'cache'));
    expect(files.filter((f) => f.endsWith('format.js'))).toHaveLength(1);
    expect(files.filter((f) => f.includes('.tmp-'))).toEqual([]);
  }, 60_000);
});

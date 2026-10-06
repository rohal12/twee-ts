/**
 * The Vite client on a real dev server (issues #223 and #244 H7, H10): exactly one client script element, in the
 * head as the browser builds it (parse5 is the oracle), the rest of the page as the template has it, and the
 * document mode the production build gets.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { attr, elements, parentTag, parseDocument } from './helpers/html.js';

const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello.\n';

const dirs: string[] = [];
let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address !== null && typeof address === 'object' ? (address satisfies AddressInfo).port : 0;
      probe.close(() => {
        done(port);
      });
    });
  });
}

/** Serve a story with a format whose source is `source`, at `base`; returns the served page. */
async function serve(source: string, base = '/'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-vite-client-'));
  dirs.push(dir);
  const files: Record<string, string> = {
    'story/start.tw': STORY,
    'formats/probe-1/format.js': `window.storyFormat(${JSON.stringify({ name: 'Probe', version: '1.0.0', source })});`,
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const port = await freePort();
  server = await createServer({
    configFile: false,
    root: dir,
    base,
    logLevel: 'silent',
    plugins: [
      tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'probe-1',
        compileOptions: { formatPaths: [join(dir, 'formats')], useTweegoPath: false, noRemote: true },
      }),
    ],
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await server.listen();
  return (await fetch(`http://127.0.0.1:${port}${base}`)).text();
}

function clients(html: string, src = '/@vite/client') {
  return elements(html, (e) => e.tagName === 'script' && attr(e, 'src') === src);
}

describe('vite plugin: the client in the served page', { timeout: 30_000 }, () => {
  it.each([
    ['an omitted head start tag (H7)', '<!doctype html><html><title>t</title><body>{{STORY_DATA}}</body></html>'],
    ['an omitted html and head start tag (H7)', '<!doctype html><title>t</title><body>{{STORY_DATA}}'],
    [
      'an abrupt empty comment before the html start tag (H1)',
      '<!doctype html><!--><html><head></head><body>{{STORY_DATA}}<!-- --></body></html>',
    ],
    [
      'a --!> comment end before the head (H1)',
      '<!doctype html><!-- a --!><html><head></head><body>{{STORY_DATA}}<!-- --></body></html>',
    ],
    [
      'a bogus comment hiding a head look-alike (H2)',
      '<!doctype html></ <head> ><html><head></head><body>{{STORY_DATA}}</body></html>',
    ],
    [
      'a head look-alike in a double-escaped script (H3)',
      '<!doctype html><html><script>/*<!--<script>*/ var a = "</script><head>"; /*-->*/</script><head></head><body>{{STORY_DATA}}</body></html>',
    ],
  ])('places one client in the head, in standards mode, with %s', async (_label, source) => {
    const html = await serve(source);
    const found = clients(html);
    expect(found).toHaveLength(1);
    expect(found[0] && parentTag(found[0])).toBe('head');
    expect(parseDocument(html).mode).toBe('no-quirks');
  });

  it('writes a base with a character reference look-alike into the src as it is (H10)', async () => {
    const html = await serve('<!doctype html><html><head></head><body>{{STORY_DATA}}</body></html>', '/a&lt/');
    expect(clients(html, '/a&lt/@vite/client')).toHaveLength(1);
  });
});

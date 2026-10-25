import { readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import { cleanUp, COMPILE, makeProject, startServer, STORY, writeFiles } from './helpers/plugins.js';

afterEach(cleanUp);

const PUBLIC_FILES = {
  'vendor.js': 'export const PUBLIC_SCRIPT = 1;',
  'vendor.css': ':root { --PUBLIC_STYLE: 1; }',
  'vendor.png': Buffer.from('PUBLIC_IMAGE'),
  'vendor.tw': ':: PublicPassage\nPUBLIC_PASSAGE',
};

describe.each(['sources', 'modules'] as const)('Vite public copy history beside %s (#184)', (role) => {
  it.each(['remove files', 'retarget link'] as const)('excludes earlier copies after %s', async (change) => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'story/authored.js': 'globalThis.AUTHORED_SCRIPT = 1;',
      ...Object.fromEntries(Object.entries(PUBLIC_FILES).map(([name, text]) => [`shared/${name}`, text])),
      'next/new.js': 'export const PUBLIC_NEXT = 1;',
      'public/.keep': '',
    });
    const link = join(dir, 'public/vendor');
    symlinkSync(join(dir, 'shared'), link, 'junction');
    const plugin = tweeTsPlugin({
      sources: [join(dir, role === 'sources' ? 'story' : 'story/start.tw')],
      format: 'test-format-1',
      compileOptions: { ...COMPILE, ...(role === 'modules' ? { modules: [join(dir, 'story')] } : {}) },
    });
    const config = {
      root: dir,
      build: { outDir: join(dir, 'story'), emptyOutDir: false },
    };
    await build({ configFile: false, logLevel: 'silent', ...config, plugins: [plugin] });
    if (change === 'remove files') {
      for (const name of Object.keys(PUBLIC_FILES)) rmSync(join(dir, 'shared', name));
    } else {
      unlinkSync(link);
      symlinkSync(join(dir, 'next'), link, 'junction');
    }
    await build({ configFile: false, logLevel: 'silent', ...config, plugins: [plugin] });
    // Vite leaves old copies in place with emptyOutDir:false; they still belong to this plugin's build.
    expect(readFileSync(join(dir, 'story/vendor/vendor.js'), 'utf8')).toBe(PUBLIC_FILES['vendor.js']);
    const html = readFileSync(join(dir, 'story/index.html'), 'utf8');
    expect(html).toContain('AUTHORED_SCRIPT');
    expect(html).toContain('Hello from the story.');
    expect(html).not.toMatch(/PUBLIC_SCRIPT|PUBLIC_STYLE|PUBLIC_PASSAGE|PUBLIC_NEXT|Twine\.image/);
    const { url } = await startServer({ ...config, server: { watch: null }, plugins: [plugin] });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const devHtml = await response.text();
    expect(devHtml).toContain('AUTHORED_SCRIPT');
    expect(devHtml).toContain('Hello from the story.');
    expect(devHtml).not.toMatch(/PUBLIC_SCRIPT|PUBLIC_STYLE|PUBLIC_PASSAGE|PUBLIC_NEXT|Twine\.image/);
  });
});

describe.each(['sources', 'modules'] as const)('Vite public copies beside %s (#184)', (role) => {
  describe.each(['ordinary', 'directory link', 'nested links', 'file links'] as const)('%s', (kind) => {
    it.skipIf(process.platform === 'win32' && kind === 'file links').each(['story', 'story/build', 'dist'])(
      'excludes copies in %s on first and subsequent builds and in dev',
      async (output) => {
        const dir = makeProject({
          'story/start.tw': STORY,
          'story/authored.js': 'globalThis.AUTHORED_SCRIPT = 1;',
          ...Object.fromEntries(Object.entries(PUBLIC_FILES).map(([name, text]) => [`shared/${name}`, text])),
          'public/.keep': '',
          'nested/.keep': '',
        });
        const publicDir = join(dir, 'public');
        if (kind === 'ordinary') {
          for (const [name, text] of Object.entries(PUBLIC_FILES)) {
            writeFiles(dir, { [`public/vendor/${name}`]: text });
          }
        } else if (kind === 'file links') {
          for (const name of Object.keys(PUBLIC_FILES)) {
            symlinkSync(join(dir, 'shared', name), join(publicDir, name), 'file');
          }
        } else {
          const target = kind === 'nested links' ? join(dir, 'nested') : join(dir, 'shared');
          if (kind === 'nested links') symlinkSync(join(dir, 'shared'), join(target, 'inner'), 'junction');
          // Two aliases to the same target must both be inventoried, using their copied names.
          for (const name of ['vendor', 'alias']) symlinkSync(target, join(publicDir, name), 'junction');
        }
        const outDir = join(dir, output);
        const options = {
          sources: [role === 'sources' ? join(dir, 'story') : join(dir, 'story/start.tw')],
          format: 'test-format-1',
          compileOptions: { ...COMPILE, ...(role === 'modules' ? { modules: [join(dir, 'story')] } : {}) },
        };
        const config = { root: dir, build: { outDir, emptyOutDir: false } };
        const expectClean = (html: string): void => {
          expect(html).toContain('AUTHORED_SCRIPT');
          expect(html).toContain('Hello from the story.');
          expect(html).not.toMatch(/PUBLIC_SCRIPT|PUBLIC_STYLE|PUBLIC_PASSAGE|Twine\.image/);
        };
        for (let pass = 0; pass < 2; pass++) {
          await build({ configFile: false, logLevel: 'silent', ...config, plugins: [tweeTsPlugin(options)] });
          expectClean(readFileSync(join(outDir, 'index.html'), 'utf8'));
          const prefix = kind === 'file links' ? '' : kind === 'nested links' ? 'vendor/inner' : 'vendor';
          for (const [name, text] of Object.entries(PUBLIC_FILES)) {
            expect(readFileSync(join(outDir, prefix, name))).toEqual(Buffer.from(text));
          }
        }
        const { url } = await startServer({ ...config, server: { watch: null }, plugins: [tweeTsPlugin(options)] });
        expectClean(await (await fetch(url)).text());
      },
    );
  });
});

it.each(['dangling', 'loop'] as const)('keeps dev available beside a %s public link', async (kind) => {
  const dir = makeProject({ 'story/start.tw': STORY, 'public/.keep': '' });
  const link = join(dir, 'public/unavailable');
  symlinkSync(kind === 'dangling' ? join(dir, 'missing') : link, link, 'junction');
  const { url } = await startServer({
    root: dir,
    server: { watch: null },
    plugins: [tweeTsPlugin({ sources: [join(dir, 'story')], format: 'test-format-1', compileOptions: COMPILE })],
  });
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Hello from the story.');
});

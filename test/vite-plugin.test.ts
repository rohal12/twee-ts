import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';

export const FORMATS = join(__dirname, 'fixtures', 'storyformats');
export const COMPILE = { formatPaths: [FORMATS], useTweegoPath: false, noRemote: true };

export const STORY = `:: StoryData
{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}

:: StoryTitle
Plugin Test

:: Start
Hello from the story.
`;

export const ENTRY = `import './style.css';
const marker: string = 'entry-ok';
(window as unknown as Record<string, string>).marker = marker;
`;

export const STYLE = ':root { --entry-marker: 1; }\n';

const dirs: string[] = [];
export function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-vite-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
  return dir;
}

export function userScript(html: string): string {
  return /<script[^>]*id="twine-user-script"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
}

export function userStylesheet(html: string): string {
  return /<style[^>]*id="twine-user-stylesheet"[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function buildProject(dir: string, plugin: ReturnType<typeof tweeTsPlugin>): Promise<string> {
  const outDir = join(dir, 'dist');
  await build({ configFile: false, root: dir, logLevel: 'silent', build: { outDir }, plugins: [plugin] });
  return outDir;
}

describe('vite plugin: build', { timeout: 30_000 }, () => {
  it('bundles the entry into the story and writes only the HTML', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    const outDir = await buildProject(
      dir,
      tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'app/main.ts'),
        compileOptions: COMPILE,
      }),
    );
    expect(readdirSync(outDir)).toEqual(['index.html']);
    const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(html).toContain('Hello from the story.');
    expect(userScript(html)).toContain('entry-ok');
    expect(userScript(html)).not.toMatch(/^\s*(import|export)\s/m);
    expect(userStylesheet(html)).toContain('--entry-marker');
  });

  it('entry without CSS: no stylesheet passage and no .css file', async () => {
    const dir = makeProject({
      'story/start.tw': STORY,
      'app/main.ts': '(window as unknown as Record<string, number>).n = 1;\n',
    });
    const outDir = await buildProject(
      dir,
      tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'app/main.ts'),
        compileOptions: COMPILE,
      }),
    );
    expect(readdirSync(outDir)).toEqual(['index.html']);
    const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(html).not.toContain('twee-ts-entry.css');
    expect(userScript(html)).toContain('window.n');
  });

  it('fails the build on a malformed passage, naming file and line', async () => {
    const dir = makeProject({
      'story/start.tw': `${STORY}\n:: Broken [unclosed\nText\n`,
      'app/main.ts': ENTRY,
      'app/style.css': STYLE,
    });
    await expect(
      buildProject(
        dir,
        tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'test-format-1',
          entry: join(dir, 'app/main.ts'),
          compileOptions: COMPILE,
        }),
      ),
    ).rejects.toThrow(/start\.tw:\d+: .*Malformed twee source/);
  });

  it('fails the build when the story format is missing', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': ENTRY, 'app/style.css': STYLE });
    await expect(
      buildProject(
        dir,
        tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'no-such-format',
          entry: join(dir, 'app/main.ts'),
          compileOptions: COMPILE,
        }),
      ),
    ).rejects.toThrow(/no-such-format/);
  });

  it('fails the build on a TypeScript syntax error in the entry', async () => {
    const dir = makeProject({ 'story/start.tw': STORY, 'app/main.ts': 'const = ;\n' });
    await expect(
      buildProject(
        dir,
        tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'test-format-1',
          entry: join(dir, 'app/main.ts'),
          compileOptions: COMPILE,
        }),
      ),
    ).rejects.toThrow(/main\.ts/);
  });
});

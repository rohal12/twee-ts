/**
 * Every text HTML output inserts is checked for what HTML cannot carry (U+0000, a lone surrogate), as the story data
 * and the modules are (#365, build side): the head file, the story format's template and the Twine 1 format
 * components. Lint reports the head file too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { lint } from '../src/lint.js';
import type { CompileOptions } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const SOURCES = [
  { filename: 'story.tw', content: `:: StoryTitle\nT\n\n:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start\nHi\n` },
];
const NUL = '\u0000';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-inserted-text-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A Twine 2 format `two-1` whose template is `source`. */
function twine2Format(source: string): void {
  mkdirSync(join(dir, 'two-1'));
  const format = { name: 'Two', version: '1.0.0', source };
  writeFileSync(join(dir, 'two-1', 'format.js'), `window.storyFormat(${JSON.stringify(format)});`);
}

/** A Twine 1 format `one-1` with the template `header` and the other files given. */
function twine1Format(header: string, files: Readonly<Record<string, string>> = {}): void {
  mkdirSync(join(dir, 'one-1'));
  writeFileSync(join(dir, 'one-1', 'header.html'), header);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

const TWINE2_TEMPLATE = '<html><head><title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>';
const TWINE1_TEMPLATE = '<html><head></head><body><div id="storeArea">"STORY"</div></body></html>';

const build = (formatId: string, extra: Partial<CompileOptions> = {}) =>
  compile({ sources: SOURCES, formatId, formatPaths: [dir], useTweegoPath: false, noRemote: true, ...extra });

const errors = (diagnostics: readonly { readonly level: string; readonly message: string }[]): string[] =>
  diagnostics.filter((d) => d.level === 'error').map((d) => d.message);

const cannotCarry = (what: string): string =>
  `${what} contains U+0000, which HTML cannot carry: the browser drops it or reads it as U+FFFD. Remove it.`;

describe('HTML output checks the text it inserts besides the story data', () => {
  it.each([
    [
      'a Twine 2 format',
      () => {
        twine2Format(TWINE2_TEMPLATE);
      },
      'two-1',
    ],
    [
      'a Twine 1 format',
      () => {
        twine1Format(TWINE1_TEMPLATE);
      },
      'one-1',
    ],
  ])('reports U+0000 in the head file, with %s', async (_name, setUp, formatId) => {
    setUp();
    const headFile = join(dir, 'head.html');
    writeFileSync(headFile, `<meta name="a" content="A${NUL}B">`);
    const result = await build(formatId, { headFile });
    expect(errors(result.diagnostics)).toEqual([cannotCarry(`The head file "${headFile}"`)]);
  });

  it('reports U+0000 in a Twine 2 format template', async () => {
    twine2Format(TWINE2_TEMPLATE.replace('<body>', `<body>${NUL}`));
    expect(errors((await build('two-1')).diagnostics)).toEqual([cannotCarry('The story format "Two" 1.0.0')]);
  });

  it('reports U+0000 in a Twine 1 format template', async () => {
    twine1Format(TWINE1_TEMPLATE.replace('<body>', `<body>${NUL}`));
    expect(errors((await build('one-1')).diagnostics)).toEqual([cannotCarry('The story format "one-1"')]);
  });

  it.each([
    ['userlib.js', '"USER_LIB"', 'one-1/userlib.js'],
    ['engine.js', '"ENGINE"', 'engine.js'],
    ['code.js', '"SUGARCANE"', 'one-1/code.js'],
  ])('reports U+0000 in the Twine 1 format component %s', async (_name, token, file) => {
    twine1Format(TWINE1_TEMPLATE.replace('<head>', `<head><script>${token}</script>`), { [file]: `var a = "${NUL}";` });
    expect(errors((await build('one-1')).diagnostics)).toEqual([
      cannotCarry(`The story format component "${join(dir, file)}"`),
    ]);
  });

  it('reports U+0000 in the footer of a pre-1.4 Twine 1 format', async () => {
    twine1Format('<html><head></head><body>', { 'one-1/footer.html': `</body>${NUL}</html>` });
    expect(errors((await build('one-1')).diagnostics)).toEqual([
      cannotCarry(`The story format component "${join(dir, 'one-1', 'footer.html')}"`),
    ]);
  });

  it('builds without a word when no inserted text holds such a character', async () => {
    twine2Format(TWINE2_TEMPLATE);
    const headFile = join(dir, 'head.html');
    writeFileSync(headFile, '<meta name="a" content="b">');
    expect((await build('two-1', { headFile })).diagnostics).toEqual([]);
  });

  it('lint reports U+0000 in the head file, as the build does', async () => {
    const headFile = join(dir, 'head.html');
    writeFileSync(headFile, `<meta name="a" content="A${NUL}B">`);
    expect(errors((await lint({ sources: SOURCES, headFile })).diagnostics)).toEqual([
      cannotCarry(`The head file "${headFile}"`),
    ]);
  });
});

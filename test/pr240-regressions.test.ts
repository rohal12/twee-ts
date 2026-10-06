/**
 * Regression cases from draft PR #240 that main did not yet cover with a test of its own: each passes on main,
 * and each guards a behaviour PR #240 found missing on v1.18.2 (#221, #236, #239, #242, the HTML head boundaries
 * that #244 later reworked) or a gap in an existing test (TWEEGO_PATH with more than one entry).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { createServer } from 'vite';
import { compile, compileIncremental, watch } from '../src/compiler.js';
import { parseFormatJSON } from '../src/format-decode.js';
import { getFormatSearchDirs } from '../src/formats.js';
import { resolvePluginOptions } from '../src/plugins/options.js';
import { toPosix } from '../src/plugins/paths.js';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import type { CompileOptions, CompileResult, FileCacheEntry, OutputMode } from '../src/types.js';
import { judgeHeadFile, judgeModule, judgeViteClient } from './helpers/insertion-judges.js';
import { cleanUp, COMPILE, startBuildWatch, tempDir } from './helpers/plugins.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
/** Symbolic links need privileges on Windows. */
const LINKS = process.platform !== 'win32';

let root: string;
let controller: AbortController | undefined;
let savedTweegoPath: string | undefined;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-pr240-')));
  savedTweegoPath = process.env['TWEEGO_PATH'];
});

afterEach(async () => {
  controller?.abort();
  controller = undefined;
  await cleanUp();
  if (savedTweegoPath === undefined) delete process.env['TWEEGO_PATH'];
  else process.env['TWEEGO_PATH'] = savedTweegoPath;
  rmSync(root, { recursive: true, force: true });
});

const story = (text: string): string => `:: StoryData\n{"ifid":"${IFID}"}\n:: Start\n${text}`;

describe('#236: a later StorySettings replaces everything an earlier one set', () => {
  it('an empty replacement leaves no settings and no legacy IFID', async () => {
    const result = await compile({
      sources: [
        { filename: 'a.tw', content: `:: StorySettings\nifid:${IFID}\nobfuscate:rot13\njquery:off\n:: Start\nhi` },
        { filename: 'b.tw', content: ':: StorySettings\n' },
      ],
      outputMode: 'json',
    });
    expect([...result.story.twine1.settings]).toEqual([]);
    expect(result.story.legacyIFID).toBe('');
  });

  it('keeps a Twine 1 archive Start readable in cold and warm incremental builds', async () => {
    const outputMode: OutputMode = 'twine1-archive';
    const options: CompileOptions = {
      sources: [
        {
          filename: 'first.tw',
          content: `:: StoryData\n{"ifid":"${IFID}"}\n:: StorySettings\nobfuscate:rot13\n:: Start\nHello`,
        },
        { filename: 'second.tw', content: ':: StorySettings\njquery:on' },
      ],
      outputMode,
    };
    const cache = new Map<string, FileCacheEntry>();
    const results = [await compile(options), await compileIncremental(options, cache)];
    results.push(await compileIncremental(options, cache));
    for (const result of results) {
      expect(result.output).toContain('tiddler="Start"');
      expect(result.output).toContain('Hello');
      expect(result.output).not.toContain('Fgneg');
    }
  });
});

describe('#221: a line comment inside the storyFormat() call ends at any line terminator', () => {
  it.each(['\n', '\r', '\r\n', ' ', ' '])('ends leading and inner comments at %j', (end) => {
    const source =
      `// license {${end}window.storyFormat(// wrapper${end}{name:'Review',version:'1.0.0',// field${end}` +
      "source:'<html>{{STORY_DATA}}</html>'});";
    expect(parseFormatJSON(source)?.name).toBe('Review');
  });
});

describe('TWEEGO_PATH with more than one entry', () => {
  function writeFormat(dir: string, marker: string): void {
    mkdirSync(join(dir, 'fixture-1'), { recursive: true });
    const source = `<html><head></head><body>${marker} {{STORY_DATA}}</body></html>`;
    writeFileSync(
      join(dir, 'fixture-1', 'format.js'),
      `window.storyFormat(${JSON.stringify({ name: 'Fixture', version: '1.0.0', source })});`,
    );
  }

  it('splits it with the platform delimiter and lets its later entry win', async () => {
    const first = join(root, 'first-global-formats');
    const second = join(root, 'second-global-formats');
    writeFormat(first, 'FIRST');
    writeFormat(second, 'SECOND');
    // In particular, the ':' of a Windows drive letter is not a delimiter.
    process.env['TWEEGO_PATH'] = [first, second].join(delimiter);
    expect(getFormatSearchDirs([]).slice(-2)).toEqual([first, second]);
    const result = await compile({
      sources: [{ filename: 'story.tw', content: story('Hi') }],
      formatId: 'fixture-1',
      noRemote: true,
    });
    expect(result.output).toContain('<body>SECOND ');
  });
});

describe.skipIf(!LINKS)('#239: watch follows an individually named source link', { timeout: 30_000 }, () => {
  interface Watching {
    readonly events: () => number;
    readonly built: (text: string) => Promise<void>;
  }

  async function startWatch(link: string): Promise<Watching> {
    const builds: CompileResult[] = [];
    let errors = 0;
    controller = await watch({
      sources: [link],
      outputMode: 'json',
      outFile: join(root, 'output.json'),
      onBuild: (r) => builds.push(r),
      onError: () => {
        errors++;
      },
    });
    return {
      events: () => builds.length + errors,
      built: async (text) => {
        await expect.poll(() => builds.at(-1)?.output, { timeout: 10_000, interval: 30 }).toContain(text);
      },
    };
  }

  it('to a target in the same folder, through edits, replacement, deletion, re-creation and retargeting', async () => {
    mkdirSync(join(root, 'links'));
    const target = join(root, 'links', 'actual.tw');
    const link = join(root, 'links', 'story.tw');
    writeFileSync(target, story('BEFORE'));
    symlinkSync('actual.tw', link);
    const w = await startWatch(link);
    await w.built('BEFORE');
    writeFileSync(target, story('EDITED'));
    await w.built('EDITED');
    writeFileSync(join(root, 'replacement.tw'), story('REPLACED'));
    renameSync(join(root, 'replacement.tw'), target);
    await w.built('REPLACED');
    const before = w.events();
    rmSync(target);
    // The link now dangles: a build (or an error) reports it before the target comes back.
    await expect.poll(() => w.events(), { timeout: 10_000 }).toBeGreaterThan(before);
    writeFileSync(target, story('RECREATED'));
    await w.built('RECREATED');
    const other = join(root, 'other', 'story.tw');
    mkdirSync(join(root, 'other'));
    writeFileSync(other, story('RETARGETED'));
    rmSync(link);
    symlinkSync(other, link);
    await w.built('RETARGETED');
    writeFileSync(other, story('RETARGET_EDIT'));
    await w.built('RETARGET_EDIT');
  });

  it('through a chain of links, for an edit of the final target and a retargeted middle link', async () => {
    for (const dir of ['links', 'middle', 'actual']) mkdirSync(join(root, dir));
    const first = join(root, 'actual', 'first.tw');
    const second = join(root, 'actual', 'second.tw');
    const middle = join(root, 'middle', 'story.tw');
    const link = join(root, 'links', 'story.tw');
    writeFileSync(first, story('CHAIN_BEFORE'));
    writeFileSync(second, story('CHAIN_AFTER'));
    symlinkSync(first, middle);
    symlinkSync(middle, link);
    const w = await startWatch(link);
    await w.built('CHAIN_BEFORE');
    writeFileSync(first, story('CHAIN_EDIT'));
    await w.built('CHAIN_EDIT');
    rmSync(middle);
    symlinkSync(second, middle);
    await w.built('CHAIN_AFTER');
    await expect.poll(() => readFileSync(join(root, 'output.json'), 'utf-8')).toContain('CHAIN_AFTER');
  });
});

describe.skipIf(!LINKS)(
  '#242: vite build --watch with sources named through a folder link',
  { timeout: 30_000 },
  () => {
    it('rebuilds for a save of the real file that keeps its modification time', async () => {
      const base = tempDir();
      const real = join(base, 'real');
      const alias = join(base, 'alias');
      mkdirSync(join(real, 'story'), { recursive: true });
      const file = join(real, 'story', 'start.tw');
      writeFileSync(file, story('old text'));
      symlinkSync(real, alias, 'dir');
      const fixed = new Date(1_700_000_000_000);
      utimesSync(file, fixed, fixed);
      const out = join(real, 'build', 'index.html');
      await startBuildWatch({
        root: real,
        build: { outDir: 'build' },
        plugins: [tweeTsPlugin({ sources: [join(alias, 'story')], format: 'test-format-1', compileOptions: COMPILE })],
      });
      expect(readFileSync(out, 'utf-8')).toContain('old text');
      const { atime, mtime } = statSync(file);
      await vi.waitFor(
        () => {
          // The watcher may not be ready right after the first build; the edit is saved again until it is built.
          if (!readFileSync(out, 'utf-8').includes('new text')) {
            writeFileSync(file, story('new text'));
            utimesSync(file, atime, mtime);
          }
          expect(readFileSync(out, 'utf-8')).toContain('new text');
        },
        { timeout: 15_000, interval: 200 },
      );
    });
  },
);

describe.skipIf(!LINKS)('#242: exclude globs for sources named through a folder link', () => {
  /**
   * The story folder is reached through `alias`, a link to `real`, and the glob is written as the compiler
   * reads it: relative to the working directory, through the alias. A watcher reports the real path.
   */
  function project(): { readonly real: string; readonly alias: string; readonly glob: string } {
    const real = join(root, 'real');
    const alias = join(root, 'alias');
    mkdirSync(join(real, 'story', 'art'), { recursive: true });
    writeFileSync(join(real, 'story', 'start.tw'), story('Hi'));
    writeFileSync(join(real, 'story', 'art', 'x.png'), '');
    symlinkSync(real, alias, 'dir');
    const glob = `${toPosix(relative(process.cwd(), join(alias, 'story')))}/art/**`;
    return { real, alias, glob };
  }

  it.each(['vite', 'rollup'] as const)('%s: matches a file by its real path as by its authored one', (kind) => {
    const { real, alias, glob } = project();
    const resolved = resolvePluginOptions(kind, {
      sources: [join(alias, 'story')],
      compileOptions: { exclude: [glob] },
    });
    expect(resolved.excluded(join(alias, 'story', 'art', 'x.png'))).toBe(true);
    expect(resolved.excluded(join(real, 'story', 'art', 'x.png'))).toBe(true);
    expect(resolved.excluded(join(real, 'story', 'start.tw'))).toBe(false);
  });

  it('starts no rebuild in the dev server for a change the watcher reports by the real path', async () => {
    const { real, alias, glob } = project();
    const server = await createServer({
      configFile: false,
      root: real,
      logLevel: 'silent',
      server: { watch: null, port: 0 },
      plugins: [
        tweeTsPlugin({
          sources: [join(alias, 'story')],
          format: 'test-format-1',
          compileOptions: { ...COMPILE, exclude: [glob] },
        }),
      ],
    });
    try {
      await server.listen();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        server.watcher.emit('all', 'change', join(real, 'story', 'art', 'x.png'));
        expect(vi.getTimerCount()).toBe(0);
        server.watcher.emit('all', 'change', join(real, 'story', 'start.tw'));
        expect(vi.getTimerCount()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await server.close();
    }
  });
});

/**
 * Templates whose head boundaries depend on HTML tokenizer or tree-construction states that the #244 regression
 * tests and the fragment grammar of the insertion property test do not spell out.
 */
const HEAD_TEMPLATES: Readonly<Record<string, string>> = {
  'a comment whose --! never closes it': '<!-- hidden --! </head><body>',
  ...Object.fromEntries(
    [
      '<script>const x="<!--<script></script></head><body>";</script>',
      '<script>const x="<!--<SCRIPT ></ScRiPt ></head><body>";</script>',
      '<script>const x="<!--<script/ ></script/ ></head><body>";</script>',
      '<script>const x="<!--<script><script></script></head><body>";</script>',
      '<script>const x="<!--<script></scripture></script></head><body>";</script>',
    ].map((script, i) => [`a double-escaped script ${i + 1}`, `<head>${script}</head><body>`]),
  ),
  ...Object.fromEntries(
    [
      '<script><!--><script></script>',
      '<script><!--<script>--></script>',
      '<script><!--<script></script>--></script>',
      '<script><!--<scripture></script>',
      '<script><!--<script!></script>',
    ].map((script, i) => [`a script that leaves an escaped state ${i + 1}`, `${script}</head><body>`]),
  ),
  'an unclosed double-escaped script': '<script><!--<script></script></head><body>',
  'a head opener inside a double-escaped script':
    '<script>const x="<!--<script></script><head>";</script><head></head><body>',
  ...Object.fromEntries(
    [
      '<!doctype html SYSTEM "a <head </head <body">',
      "<!doctype html SYSTEM 'a <head </head <body'>",
      '<!doctype html PUBLIC "a <head </head <body" "b <head </head <body">',
      '<!DOCTYPE html SYSTEM"a <head </head <body">',
      '<!doctype html SYSTEM "a > ',
      "<!doctype html SYSTEM 'a > ",
      '<!doctype html PUBLIC "a > ',
      '<!doctype html unknown "ignored >',
    ].map((doctype, i) => [`a doctype with a quoted identifier ${i + 1}`, `${doctype}<head></head><body>`]),
  ),
  'astral characters and CRLF before the head': '<!-- 😀\r\n --><head></head><body>',
  'a head start tag alone': '<head>',
  'a closing head tag and a body alone': '</head><body>',
  'nested templates in the head':
    '<head><template></head><body><head><template></head><body></template></template></head><body>',
  'nested templates before the body':
    '<template></head><body><head><template></head><body></template></template><body>',
  'templates nested through a table':
    '<head><template><table><template></head><body><head></template></table></template></head><body>',
  'SVG style and script CDATA':
    '<svg><style><![CDATA[literal > </head><body>]]></style><script><![CDATA[literal > </head><body>]]></script></svg></head><body>',
  'a script at a foreign integration point':
    '<svg><foreignObject><script>const x="<!--<script></script></head><body>";</script></foreignObject></svg></head><body>',
  'a tag that leaves foreign content': '<svg><g><p>HTML</p><head>',
  'CDATA-like markup outside foreign content': '<![CDATA[literal ></head><body>',
  'MathML CDATA after an omitted closing head tag':
    '<head><title>Review</title><body><math><![CDATA[literal > </head><body><head>]]></math>',
  'a self-closing SVG root': '<svg data-value="quoted />"/><head>',
  'a self-closing MathML root': '<math data-value="quoted />"/><head>',
  'an unquoted slash in a foreign root attribute':
    '<svg data-value=x/><![CDATA[literal > </head><body>]]></svg></head><body>',
};

describe('head insertions in templates with tokenizer and tree-context traps', () => {
  it.each(Object.entries(HEAD_TEMPLATES))('%s', (_name, template) => {
    expect({
      module: judgeModule(template),
      headFile: judgeHeadFile(template),
      viteClient: judgeViteClient(template),
    }).toEqual({ module: undefined, headFile: undefined, viteClient: undefined });
  });
});

describe('a compiled story keeps its head file in the real head of the format template', () => {
  const META = '<meta name="review" content="injected">';

  async function build(kind: 'twine1' | 'twine2', template: string): Promise<CompileResult> {
    const formats = join(root, 'formats');
    const dir = join(formats, 'review');
    mkdirSync(dir, { recursive: true });
    if (kind === 'twine2') {
      writeFileSync(
        join(dir, 'format.js'),
        `window.storyFormat(${JSON.stringify({ name: 'Review', version: '1.0.0', source: template })});`,
      );
    } else {
      writeFileSync(join(dir, 'header.html'), template);
    }
    const headFile = join(root, 'head.html');
    writeFileSync(headFile, META);
    return compile({
      sources: [{ filename: 'story.tw', content: `:: StoryTitle\nReview\n${story('Hello')}` }],
      formatId: 'review',
      formatPaths: [formats],
      headFile,
      noRemote: true,
      useTweegoPath: false,
    });
  }

  for (const kind of ['twine1', 'twine2'] as const) {
    const data = kind === 'twine2' ? '{{STORY_DATA}}' : '<div id="storeArea">"STORY"</div>';

    it.each([
      ['a comment ending in --!>', '<!-- hidden --!>', ''],
      ['a double-escaped script', '', '<script>const x="<!--<script></script></head>";</script>'],
      ['noscript text', '', '<noscript>literal </head><body></noscript>'],
      ['noframes text', '', '<noframes>literal </head><body></noframes>'],
      ['a doctype system identifier', '<!doctype html SYSTEM "literal <head </head <body">', ''],
      ['nested templates', '', '<template>literal </head><body><template></head><body></template></template>'],
    ])(`${kind}: injects before the real closing head tag, past %s`, async (_label, before, head) => {
      const result = await build(kind, `${before}<html><head>${head}</head><body>${data}</body></html>`);
      expect(result.diagnostics).toEqual([]);
      expect(result.output.startsWith(`${before}<html><head>${head}${META}\n</head><body>`)).toBe(true);
    });

    it.each(['svg', 'math'])(`${kind}: injects where the head ends, before a body holding %s CDATA`, async (name) => {
      const prefix = '<html><head><title>Review</title>';
      const foreign = `<${name}><![CDATA[literal > </head><body>]]></${name}>`;
      const result = await build(kind, `${prefix}<body>${foreign}${data}</body></html>`);
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        expect.stringContaining('has no closing head tag that ends its head'),
      ]);
      expect(result.output.startsWith(`${prefix}${META}`)).toBe(true);
      expect(result.output).toContain(`<body>${foreign}`);
    });
  }
});

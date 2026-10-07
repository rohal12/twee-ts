/**
 * URLs built from `import.meta.url` in an entry (#274): the entry runs as a classic script inside the
 * story page, so `new URL('./image.png', import.meta.url)` and Vite's worker URLs must give valid URLs that
 * find the files the build writes (or the dev server serves), whichever way the entry is bundled (inside
 * the build as its only input, in a build of its own next to the user's input, or for the dev server),
 * under the default, an absolute and a relative `base`, and for a nested `outputFilename`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import type { BuildEnvironmentOptions, InlineConfig } from 'vite';
import { runInNewContext } from 'node:vm';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  COMPILE,
  STORY,
  buildFiles,
  cleanUp,
  makeProject,
  startServer,
  textOf,
  userScript,
} from './helpers/plugins.js';

afterEach(cleanUp);

const FILES = {
  'story/start.tw': STORY,
  'image.png': Buffer.from([1, 2, 3]),
  'worker.js': 'postMessage(42);',
  'extra.js': 'globalThis.extra = 1;',
};

/** The entries under test: what each reads or builds, and the script that records it in `globalThis.out`. */
const ENTRIES = {
  'an inlined asset URL': 'out.url = new URL("./image.png", import.meta.url).href;',
  'an asset URL that is not inlined': 'out.url = new URL("./image.png?no-inline", import.meta.url).href;',
  'a worker URL': 'new Worker(new URL("./worker.js", import.meta.url), { type: "module" });',
  'a worker imported with ?worker&inline': 'import Worker from "./worker.js?worker&inline"; out.ctor = typeof Worker;',
  'an imported image': 'import image from "./image.png"; out.url = image;',
} as const;

type Branch = 'inside the build' | 'a build of its own' | 'the dev server';
const BRANCHES: readonly Branch[] = ['inside the build', 'a build of its own', 'the dev server'];

interface Observed {
  url?: string;
  ctor?: string;
  worker?: string;
}

/** Runs a story script as the story page would: a classic script, with a Worker that records its URL. */
function run(script: string, pageUrl: string): Observed {
  const out: Observed = {};
  class Worker {
    readonly url: string;
    constructor(url: URL | string) {
      this.url = String(url);
      out.worker = this.url;
    }
  }
  runInNewContext(script, { out, URL, Worker, document: { baseURI: pageUrl }, window: {} });
  return out;
}

/** What is wrong with the files a script found, or undefined: inlined data, a function, or a file that is served or written. */
function foundProblem(out: Observed, check: (found: string) => string | undefined): string | undefined {
  const found = out.url ?? out.worker;
  if (found === undefined)
    return out.ctor === 'function' ? undefined : 'the script found neither a URL nor a constructor';
  if (found.startsWith('data:'))
    return found.startsWith('data:image/png;base64,') ? undefined : `an odd data URL: ${found}`;
  return check(found);
}

async function devProblem(
  common: InlineConfig,
  deployedAt: string,
  outputFilename: string,
): Promise<string | undefined> {
  const { url } = await startServer({ ...common, server: { watch: null } });
  const page = await fetch(`${url}${deployedAt}${outputFilename}`);
  if (page.status !== 200) return `the story page answered ${page.status}`;
  const out = run(userScript(await page.text()), `${url}${deployedAt}${outputFilename}`);
  const problem = foundProblem(out, () => undefined);
  if (problem !== undefined) return problem;
  const found = out.url ?? out.worker;
  if (found === undefined || found.startsWith('data:')) return undefined;
  const asset = await fetch(found);
  if (asset.status !== 200) return `${found} answered ${asset.status}`;
  return asset.headers.get('content-type') === 'application/octet-stream' ? `${found} has no media type` : undefined;
}

async function buildProblem(
  common: InlineConfig,
  branch: Branch,
  dir: string,
  deployedAt: string,
  outputFilename: string,
): Promise<string | undefined> {
  const files = await buildFiles({
    ...common,
    build: branch === 'a build of its own' ? { rolldownOptions: { input: join(dir, 'extra.js') } } : {},
  });
  const out = run(userScript(textOf(files.get(outputFilename))), `http://localhost${deployedAt}${outputFilename}`);
  return foundProblem(out, (found) => {
    // The URL names a file the build wrote, under the folder the story is deployed in.
    const { pathname } = new URL(found);
    return pathname.startsWith(deployedAt) && files.has(pathname.slice(deployedAt.length))
      ? undefined
      : `${found} is no file of the build`;
  });
}

interface Setup {
  readonly base: string;
  readonly outputFilename: string;
}
const SETUPS: readonly Setup[] = [
  { base: '/', outputFilename: 'index.html' },
  { base: '/app/', outputFilename: 'index.html' },
  { base: './', outputFilename: 'index.html' },
  { base: '/', outputFilename: 'nested/story.html' },
  // Vite makes file URLs relative to the page here, which is not the output folder (#289).
  { base: './', outputFilename: 'nested/story.html' },
  { base: './', outputFilename: 'a/b/story.html' },
  { base: '', outputFilename: 'nested/story.html' },
];

describe.each(SETUPS)('an entry under base $base and outputFilename $outputFilename', ({ base, outputFilename }) => {
  describe.each(Object.entries(ENTRIES))('with %s', (_name, code) => {
    it.each(BRANCHES)('gives a script that runs and URLs that find their files: %s', async (branch) => {
      const dir = makeProject({ ...FILES, 'entry.js': `const out = globalThis.out;\n${code}\n` });
      const plugin = tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'entry.js'),
        outputFilename,
        compileOptions: COMPILE,
      });
      const common: InlineConfig = { root: dir, base, publicDir: false, plugins: [plugin] };
      // The page URL is where the story is deployed: under the base, which a relative base leaves at the site root.
      const deployedAt = base === './' || base === '' ? '/' : base;

      const problem =
        branch === 'the dev server'
          ? await devProblem(common, deployedAt, outputFilename)
          : await buildProblem(common, branch, dir, deployedAt, outputFilename);
      expect(problem).toBeUndefined();
    });
  });
});

describe('a relative base and a nested outputFilename (#289)', () => {
  const OWN_INPUT = (dir: string): BuildEnvironmentOptions => ({ rolldownOptions: { input: join(dir, 'extra.js') } });

  it.each(['inside the build', 'a build of its own'] as const)(
    'gives the stylesheet a URL that finds a file that is not inlined: %s',
    async (branch) => {
      const dir = makeProject({
        ...FILES,
        'style.css': 'body { background: url("./image.png?no-inline"); }',
        'entry.js': 'import "./style.css";\n',
      });
      const plugin = tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'entry.js'),
        outputFilename: 'nested/story.html',
        compileOptions: COMPILE,
      });
      const files = await buildFiles({
        root: dir,
        base: './',
        publicDir: false,
        plugins: [plugin],
        build: branch === 'a build of its own' ? OWN_INPUT(dir) : {},
      });
      const html = textOf(files.get('nested/story.html'));
      const style = /<style[^>]*id="twine-user-stylesheet"[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
      const url = /url\("?([^")]+)"?\)/.exec(style)?.[1] ?? '';
      const found = new URL(url, 'http://localhost/nested/story.html').pathname.slice(1);
      expect(url).not.toMatch(/^data:/);
      expect(files.has(found)).toBe(true);
    },
  );

  it.each(['inside the build', 'a build of its own'] as const)(
    "lets the config's own renderBuiltUrl decide first: %s",
    async (branch) => {
      const dir = makeProject({
        ...FILES,
        'entry.js': 'globalThis.out = new URL("./image.png?no-inline", import.meta.url).href;\n',
      });
      const plugin = tweeTsPlugin({
        sources: [join(dir, 'story')],
        format: 'test-format-1',
        entry: join(dir, 'entry.js'),
        outputFilename: 'nested/story.html',
        compileOptions: COMPILE,
      });
      const files = await buildFiles({
        root: dir,
        base: './',
        publicDir: false,
        plugins: [plugin],
        experimental: { renderBuiltUrl: (filename) => `https://cdn.example/${filename}` },
        build: branch === 'a build of its own' ? OWN_INPUT(dir) : {},
      });
      expect(userScript(textOf(files.get('nested/story.html')))).toContain('https://cdn.example/image.png');
    },
  );
});

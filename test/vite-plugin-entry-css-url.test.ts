/**
 * A CSS file an entry imports as a URL (`theme.css?url`, #331) is an asset the story can load later: it stays
 * a file of the build (or of the dev server) and stays out of the Story Stylesheet, which only a stylesheet
 * imported for its effect fills, whichever way the entry is bundled.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import type { InlineConfig } from 'vite';
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
  'extra.js': 'globalThis.extra = 1;',
  'theme.css': 'body { color: red; }',
  'other.css': 'p { color: blue; }',
};

const BRANCHES = ['inside the build', 'a build of its own', 'the dev server'] as const;
const IMPORTS = {
  'theme.css?url': 'import theme from "./theme.css?url";',
  'theme.css?url&no-inline': 'import theme from "./theme.css?url&no-inline";',
} as const;

const stylesheetOf = (html: string): string =>
  /<style[^>]*id="twine-user-stylesheet"[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

interface Seen {
  readonly stylesheet: string;
  readonly script: string;
  /** The theme file a build wrote (the dev server serves the source instead). */
  readonly themeFile: string | undefined;
}

async function devPage(common: InlineConfig, base: string): Promise<Seen> {
  const { url } = await startServer({ ...common, server: { watch: null } });
  const html = await (await fetch(`${url}${base}index.html`)).text();
  return { stylesheet: stylesheetOf(html), script: userScript(html), themeFile: undefined };
}

async function builtPage(common: InlineConfig, ownInput: string | undefined): Promise<Seen> {
  const files = await buildFiles({
    ...common,
    build: ownInput === undefined ? {} : { rolldownOptions: { input: ownInput } },
  });
  const html = textOf(files.get('index.html'));
  const theme = files.get('theme.css');
  return {
    stylesheet: stylesheetOf(html),
    script: userScript(html),
    themeFile: theme === undefined ? undefined : textOf(theme),
  };
}

describe.each(Object.entries(IMPORTS))('an entry importing %s', (_name, importLine) => {
  describe.each(['/', '/app/'])('under base %s', (base) => {
    it.each(BRANCHES)(
      'keeps the file and leaves it out of the stylesheet, while a side-effect import applies: %s',
      async (branch) => {
        const dir = makeProject({
          ...FILES,
          'entry.js': `${importLine}\nimport "./other.css";\nglobalThis.theme = theme;\n`,
        });
        const plugin = tweeTsPlugin({
          sources: [join(dir, 'story')],
          format: 'test-format-1',
          entry: join(dir, 'entry.js'),
          compileOptions: COMPILE,
        });
        const common: InlineConfig = { root: dir, base, publicDir: false, plugins: [plugin] };

        const seen =
          branch === 'the dev server'
            ? await devPage(common, base)
            : await builtPage(common, branch === 'a build of its own' ? join(dir, 'extra.js') : undefined);
        expect(seen.stylesheet).toMatch(/color: ?(blue|#00f)/);
        expect(seen.stylesheet).not.toContain('red');
        expect(seen.themeFile).toBe(branch === 'the dev server' ? undefined : 'body{color:red}\n');
        expect(seen.script).toContain(`${base}theme.css`);
      },
    );
  });
});

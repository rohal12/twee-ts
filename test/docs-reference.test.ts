/**
 * The reference pages agree with the code they describe, so they cannot drift again:
 * - docs/cli.md's option tables list exactly the options the CLI parser accepts, with their short
 *   forms and values, and the help text lists them too;
 * - docs/configuration.md's tables and complete reference list exactly the config keys, with the
 *   types and defaults the config schema gives them;
 * - docs/api.md names every function the package exports, and its type list is every exported type;
 * - every page is in the VitePress sidebar.
 * The option interfaces shown in docs/api.md and docs/plugins.md are checked against the exported
 * types by test/docs-snippets.test.ts (`docs-test: mirror`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeBlocks, codeSpans, documentFiles, docName, REPO, tables } from './helpers/docs.js';
import { OPTIONS, parseCliArgs, usageText } from '../src/cli-request.js';
import { CONFIG_KEYS, CONFIG_SPEC } from '../src/config.js';
import { isKnownFileType } from '../src/media-types.js';

const read = (doc: string): string => readFileSync(join(REPO, doc), 'utf8');

/** The members of a JSON object, or none when the text is not one. */
function jsonObject(text: string): object {
  const value: unknown = JSON.parse(text);
  return typeof value === 'object' && value !== null ? value : {};
}

/** Tweego's options that the CLI accepts only to say so, documented in prose rather than in the tables. */
const PROSE_OPTIONS = ['decompile', 'charset', 'list-charsets'];

interface DocumentedFlag {
  readonly long: string;
  readonly short: string | undefined;
  readonly takesValue: boolean;
}

/** The flags in docs/cli.md's option tables (`-o, --output <file>`). */
function documentedFlags(): DocumentedFlag[] {
  return tables(read('docs/cli.md'))
    .filter((t) => t.header[0] === 'Flag')
    .flatMap((t) => t.rows.flatMap((row) => codeSpans(row[0] ?? '')))
    .map((span) => {
      const long = /--([\w-]+)/.exec(span)?.[1];
      if (long === undefined) throw new Error(`docs/cli.md: no long option in \`${span}\``);
      return { long, short: /(?:^|\s)-(\w)\b/.exec(span)?.[1], takesValue: /<[^>]+>/.test(span) };
    });
}

describe('docs/cli.md', () => {
  const documented = documentedFlags();

  it('lists every option the parser accepts, and no other', () => {
    const parser = Object.keys(OPTIONS).filter((name) => !PROSE_OPTIONS.includes(name));
    expect(documented.map((f) => f.long).sort()).toEqual(parser.sort());
  });

  it('gives each option its short form and its value', () => {
    const options = new Map<string, { readonly type: string; readonly short?: string }>(Object.entries(OPTIONS));
    const actual = documented.map((f) => {
      const option = options.get(f.long);
      return { long: f.long, short: option?.short, takesValue: option?.type === 'string' };
    });
    expect(documented).toEqual(actual);
  });

  it('mentions the options it documents in prose', () => {
    const text = read('docs/cli.md');
    for (const name of PROSE_OPTIONS) expect(text).toContain(`--${name}`);
  });

  it('lists the cache subcommands the parser accepts', () => {
    const table = tables(read('docs/cli.md')).find((t) => t.header[0] === 'Subcommand');
    const subcommands = (table?.rows ?? []).flatMap((row) => codeSpans(row[0] ?? ''));
    expect(subcommands).toEqual(['list', 'clear', 'clear <name>', 'size', 'path']);
    for (const sub of subcommands) {
      const args = ['cache', ...sub.replace('<name>', 'SugarCube').split(' ')];
      expect(parseCliArgs(args).ok, sub).toBe(true);
    }
  });

  it('and the help text list the same options', () => {
    const help = usageText('0.0.0', 'twee-ts.config.json');
    const listed = [...help.matchAll(/^ {2}(?:-\w, )?--([\w-]+)/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual(documented.map((f) => f.long).sort());
  });
});

/** How docs/configuration.md writes the type of each kind of config field. */
const TYPE_NAMES = {
  string: 'string',
  boolean: 'boolean',
  number: 'number',
  enum: 'string',
  'string-array': 'string[]',
  'tag-map': 'Record<string, string>',
} as const;

describe('docs/configuration.md', () => {
  const text = read('docs/configuration.md');
  const rows = tables(text)
    .filter((t) => t.header[0] === 'Key')
    .flatMap((t) =>
      t.rows.map((row) => ({
        key: codeSpans(row[0] ?? '')[0] ?? '',
        type: codeSpans(row[1] ?? '')[0] ?? '',
        defaultCell: row[2] ?? '',
      })),
    );

  it('documents every config key, once', () => {
    expect(rows.map((r) => r.key).sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it('gives each key the type and default of the config schema', () => {
    const specs = new Map(Object.entries(CONFIG_SPEC));
    const actual = rows.map((r) => {
      const spec = specs.get(r.key)?.spec;
      return {
        key: r.key,
        type: spec === undefined ? 'not a config key' : TYPE_NAMES[spec.kind],
        default: spec !== undefined && 'default' in spec ? JSON.stringify(spec.default) : codeSpans(r.defaultCell)[0],
      };
    });
    expect(rows.map((r) => ({ key: r.key, type: r.type, default: codeSpans(r.defaultCell)[0] }))).toEqual(actual);
  });

  it('shows every key in the complete reference, with the schema default', () => {
    const block = codeBlocks(join(REPO, 'docs/configuration.md')).find((b) => b.heading === 'Complete Reference');
    const reference = new Map<string, unknown>(Object.entries(jsonObject(block?.code ?? '{}')));
    expect([...reference.keys()].sort()).toEqual([...CONFIG_KEYS].sort());
    const withDefaults = CONFIG_KEYS.flatMap((key) => {
      const spec = CONFIG_SPEC[key].spec;
      return 'default' in spec ? [[key, spec.default] as const] : [];
    });
    expect(withDefaults.map(([key]) => [key, reference.get(key)])).toEqual(withDefaults);
  });
});

/** The names `src/index.ts` exports, as values and as types. */
function packageExports(): { readonly values: string[]; readonly types: string[] } {
  const source = read('src/index.ts');
  const names = (re: RegExp): string[] =>
    [...source.matchAll(re)].flatMap((m) =>
      (m[1] ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n !== ''),
    );
  return { values: names(/^export \{([^}]*)\}/gm), types: names(/^export type \{([^}]*)\}/gm) };
}

describe('docs/api.md', () => {
  const text = read('docs/api.md');
  const { values, types } = packageExports();

  it('documents every exported function, class and constant', () => {
    const missing = values.filter((name) => !text.includes(`\`${name}`) && !text.includes(`${name}(`));
    expect(missing).toEqual([]);
  });

  it('lists every exported type in its type import', () => {
    const block = codeBlocks(join(REPO, 'docs/api.md')).find((b) => b.heading === 'Types');
    const listed = /import type \{([^}]*)\}/.exec(block?.code ?? '')?.[1] ?? '';
    const names = listed
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '');
    // A name exported as a value and a type (ItemType) may be listed too.
    expect(names.filter((n) => !values.includes(n)).sort()).toEqual([...types].sort());
  });
});

describe('docs/getting-started.md', () => {
  it('lists every file type the loader reads, and no other', () => {
    const table = tables(read('docs/getting-started.md')).find((t) => t.header[0] === 'Extension');
    const documented = (table?.rows ?? []).flatMap((row) => codeSpans(row[0] ?? '')).map((ext) => ext.slice(1));
    const source = /const KNOWN_EXTENSIONS = new Set\(\[([^\]]*)\]\)/.exec(read('src/media-types.ts'))?.[1] ?? '';
    const known = [...source.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(known.length).toBeGreaterThan(0);
    expect(documented.sort()).toEqual(known.sort());
    for (const ext of documented) expect(isKnownFileType(`file.${ext.toUpperCase()}`), ext).toBe(true);
  });
});

/** VitePress's heading slug (@mdit-vue/shared). */
function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase();
}

/** The anchors of a docs page: its headings' slugs, a repeated slug numbered as VitePress numbers it. */
function anchors(page: string): Set<string> {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  let inFence = false;
  for (const line of read(`docs/${page}.md`).split(/\r?\n/)) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^#{1,6}\s+(.*)$/.exec(line);
    if (heading?.[1] === undefined) continue;
    const slug = slugify(heading[1].replace(/`/g, ''));
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    slugs.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return slugs;
}

describe('links between the docs', () => {
  it('point to pages and headings that exist', () => {
    const pages = new Set(
      documentFiles()
        .map(docName)
        .filter((doc) => doc.startsWith('docs/'))
        .map((doc) => doc.replace(/^docs\//, '').replace(/\.md$/, '')),
    );
    const unreleased = /## \[Unreleased\][\s\S]*?(?=\n## \[)/.exec(read('CHANGELOG.md'))?.[0] ?? '';
    const sources: (readonly [string, string, (target: string) => string | undefined])[] = [
      // Links in a docs page: ./page#anchor, #anchor.
      ...documentFiles()
        .map(docName)
        .filter((doc) => doc.startsWith('docs/'))
        .map((doc) => {
          const self = doc.replace(/^docs\//, '').replace(/\.md$/, '');
          return [
            doc,
            read(doc),
            (t: string) => (t.startsWith('#') ? `${self}${t}` : /^\.\/(.*)$/.exec(t)?.[1]),
          ] as const;
        }),
      // The README links to the published site, the changelog to the files.
      ['README.md', read('README.md'), (t: string) => /^https:\/\/rohal12\.github\.io\/twee-ts\/(.+)$/.exec(t)?.[1]],
      [
        'CHANGELOG.md [Unreleased]',
        unreleased,
        (t: string) => /^docs\/(.+?)(?:\.md)?(#.*)?$/.exec(t)?.slice(1).join(''),
      ],
    ];
    const broken = sources.flatMap(([doc, text, resolve]) =>
      [...text.matchAll(/\]\(([^)\s]+)\)/g)].flatMap((m) => {
        const target = resolve(m[1] ?? '');
        if (target === undefined) return [];
        const [page = '', anchor] = target.replace(/\.md(?=#|$)/, '').split('#');
        if (!pages.has(page)) return [`${doc}: ${m[1] ?? ''} (no page ${page})`];
        return anchor === undefined || anchors(page).has(anchor)
          ? []
          : [`${doc}: ${m[1] ?? ''} (no heading #${anchor})`];
      }),
    );
    expect(broken).toEqual([]);
  });
});

describe('the documentation site', () => {
  it('has every page in the sidebar', () => {
    const config = read('docs/.vitepress/config.ts');
    const pages = documentFiles()
      .map(docName)
      .filter((doc) => doc.startsWith('docs/') && doc !== 'docs/index.md')
      .map((doc) => doc.replace(/^docs\//, '/').replace(/\.md$/, ''));
    const missing = pages.filter((page) => !config.includes(`link: '${page}'`));
    expect(missing).toEqual([]);
  });

  it('is linked from the README for every sidebar page', () => {
    const readme = read('README.md');
    const config = read('docs/.vitepress/config.ts');
    const pages = [...config.matchAll(/link: '(\/[\w-]+)'/g)].map((m) => m[1] ?? '');
    const missing = pages.filter((page) => !readme.includes(`rohal12.github.io/twee-ts${page})`));
    expect(missing).toEqual([]);
  });
});

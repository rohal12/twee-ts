/**
 * Reading an entry's `import.meta.glob()` calls and the folders they match in (#341): the calls as Vite reads them,
 * each pattern's scope, what a scope lists, and, against Vite's own import-glob as the oracle, that every file a
 * glob matches lies in its scope.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'vite';
import type { Plugin } from 'vite';
import {
  globCalls,
  moduleGlobScopes,
  scopeAdmits,
  scopeId,
  scopeListing,
  scopesOf,
  scopeWatchTargets,
} from '../src/plugins/vite-glob.js';
import type { GlobCall, GlobScope } from '../src/plugins/vite-glob.js';
import { toPosix } from '../src/plugins/paths.js';
import { cleanUp, makeProject } from './helpers/plugins.js';

afterEach(cleanUp);

const call = (patterns: string[], base?: string, exhaustive = false): GlobCall => ({ patterns, base, exhaustive });

describe('globCalls', () => {
  it.each([
    ["import.meta.glob('./a/*.js')", [call(['./a/*.js'])]],
    ['import.meta.glob(`./a/*.js`)', [call(['./a/*.js'])]],
    ["import.meta.glob(['./a/*.js', '!./a/b.js'])", [call(['./a/*.js', '!./a/b.js'])]],
    ["import.meta.glob('./*.js', { base: './a', eager: true })", [call(['./*.js'], './a')]],
    ["import.meta.glob('./*.js', { 'base': '/a', exhaustive: true })", [call(['./*.js'], '/a', true)]],
    ["import.meta.glob('./a/*.js', { exhaustive: false })", [call(['./a/*.js'])]],
    [
      "const x = () => import.meta.glob('./a/*.js'); const y = import.meta.glob('./b/*');",
      [call(['./a/*.js']), call(['./b/*'])],
    ],
    ['import.meta.glob()', []],
    // Not a pattern Vite takes: no scope comes of it, and Vite fails the bundle.
    ['import.meta.glob(`./${x}/*.js`, { base: dir })', [call([])]],
    ["import.meta.glob(['./a/*.js', 1, ...more])", [call(['./a/*.js'])]],
    ["import.meta.glob('./a/*.js', { ['base']: './b', [key]: 1, ...rest })", [call(['./a/*.js'])]],
    // Not a glob call.
    ["import.meta.globEager('./a/*.js'); import.meta['glob']('./b/*.js'); x.glob('./c/*')", []],
    ['\'import.meta.glob("./a/*.js")\'', []],
  ])('reads %s', (code, expected) => {
    expect(globCalls(`export function f() {}\n${code}`)).toEqual({ ok: true, value: expected });
  });

  it('reports code acorn cannot read', () => {
    const read = globCalls("import.meta.glob<Mod>('./a/*.ts') as Record<string, Mod>");
    expect(read.ok).toBe(false);
  });
});

const ROOT = '/project';
const IMPORTER = '/project/app/entry.js';
const noResolve = (): Promise<undefined> => Promise.resolve(undefined);
const scope = (dir: string, fields: Partial<GlobScope> = {}): GlobScope => ({
  dir,
  deep: false,
  dot: false,
  exhaustive: false,
  suffix: '',
  ...fields,
});

describe('scopesOf', () => {
  it.skipIf(process.platform === 'win32').each([
    ['./widgets/*.js', undefined, false, scope('/project/app/widgets', { suffix: '.js' })],
    ['./widgets/**/*.js', undefined, false, scope('/project/app/widgets', { deep: true, suffix: '.js' })],
    ['./widgets/*/x.js', undefined, false, scope('/project/app/widgets', { deep: true, suffix: 'x.js' })],
    ['./widgets/**', undefined, false, scope('/project/app/widgets', { deep: true })],
    ['./widgets/a.js', undefined, false, scope('/project/app/widgets', { suffix: 'a.js' })],
    ['./widgets/*.{js,ts}', undefined, false, scope('/project/app/widgets')],
    ['./widgets/[ab].JS', undefined, false, scope('/project/app/widgets', { suffix: '.js' })],
    ['./widgets/.*.js', undefined, false, scope('/project/app/widgets', { dot: true, suffix: '.js' })],
    ['./widgets/{.a,b}.js', undefined, false, scope('/project/app/widgets', { dot: true, suffix: '.js' })],
    ['./*.js', undefined, false, scope('/project/app', { suffix: '.js' })],
    ['../shared/*.js', undefined, false, scope('/project/shared', { suffix: '.js' })],
    ['./a/../b/*.js', undefined, false, scope('/project/app/b', { suffix: '.js' })],
    ['/shared/**/*.md', undefined, false, scope('/project/shared', { deep: true, suffix: '.md' })],
    ['**/*.md', undefined, false, scope('/project', { deep: true, suffix: '.md' })],
    ['./*.js', './widgets', false, scope('/project/app/widgets', { suffix: '.js' })],
    ['./*.js', '/lib', false, scope('/project/lib', { suffix: '.js' })],
    ['../*.js', '../lib/x', false, scope('/project/lib', { suffix: '.js' })],
    ['./widgets/*.js', undefined, true, scope('/project/app/widgets', { dot: true, exhaustive: true, suffix: '.js' })],
  ])('places %s (base %s, exhaustive %s)', async (pattern, base, exhaustive, expected) => {
    expect(await scopesOf(call([pattern], base, exhaustive), IMPORTER, ROOT, noResolve)).toEqual([expected]);
  });

  it.skipIf(process.platform === 'win32')('gives a negated pattern no scope', async () => {
    expect(await scopesOf(call(['!./widgets/a.js']), IMPORTER, ROOT, noResolve)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('places a relative pattern of a virtual module at the root', async () => {
    expect(await scopesOf(call(['./widgets/*.js']), undefined, ROOT, noResolve)).toEqual([
      scope('/project/widgets', { suffix: '.js' }),
    ]);
  });

  it.skipIf(process.platform === 'win32').each([
    ['@w/*.js', '/project/app/widgets/*.js', scope('/project/app/widgets', { suffix: '.js' })],
    ['@w/**/*.js', '/project/app/widgets/**/*.js', scope('/project/app/widgets', { deep: true, suffix: '.js' })],
    ['#widgets/*.js', '/project/app/widgets/*.js', scope('/project/app/widgets', { suffix: '.js' })],
    ['@root', '/x', scope('/', { suffix: 'x' })],
  ])('places %s as the resolver resolves it (%s)', async (pattern, resolved, expected) => {
    const resolver = vi.fn(() => Promise.resolve(resolved));
    expect(await scopesOf(call([pattern]), IMPORTER, ROOT, resolver)).toEqual([expected]);
    expect(resolver).toHaveBeenCalledWith(pattern);
  });

  it.each([undefined, 'relative/path'])('gives a pattern that resolves to %s no scope', async (resolved) => {
    expect(await scopesOf(call(['@w/*.js']), IMPORTER, ROOT, () => Promise.resolve(resolved))).toEqual([]);
  });
});

describe('scopeId', () => {
  it('tells scopes apart by every field', () => {
    const base = scope('/a', { suffix: '.js' });
    const variants = [base, { ...base, dir: '/b' }, { ...base, deep: true }, { ...base, dot: true }];
    const more = [
      { ...base, exhaustive: true },
      { ...base, suffix: '.ts' },
    ];
    expect(new Set([...variants, ...more].map(scopeId)).size).toBe(6);
    expect(scopeId({ ...base })).toBe(scopeId(base));
  });
});

describe('scopeListing and scopeAdmits', () => {
  const tree = (): string =>
    makeProject({
      'w/a.js': '',
      'w/b.ts': '',
      'w/C.JS': '',
      'w/.hidden.js': '',
      'w/vite.config.mjs.timestamp-1-ab.mjs': '',
      'w/sub/d.js': '',
      'w/node_modules/m.js': '',
      'w/.dot/f.js': '',
    });

  it('lists the files a shallow scope may match', () => {
    const dir = toPosix(tree());
    expect(scopeListing(scope(`${dir}/w`, { suffix: '.js' })).split('\n')).toEqual(['f:C.JS', 'f:a.js']);
  });

  it('lists the folders of a deep scope, but node_modules and dot folders', () => {
    const dir = toPosix(tree());
    expect(scopeListing(scope(`${dir}/w`, { deep: true, suffix: '.js' })).split('\n')).toEqual([
      'f:C.JS',
      'f:a.js',
      'd:sub',
      'f:sub/d.js',
    ]);
  });

  it('lists everything for an exhaustive scope, but Vite’s temporary config copies', () => {
    const dir = toPosix(tree());
    expect(scopeListing(scope(`${dir}/w`, { deep: true, dot: true, exhaustive: true })).split('\n')).toEqual([
      'd:.dot',
      'f:.dot/f.js',
      'f:.hidden.js',
      'f:C.JS',
      'f:a.js',
      'f:b.ts',
      'd:node_modules',
      'f:node_modules/m.js',
      'd:sub',
      'f:sub/d.js',
    ]);
  });

  it('lists a link as a file, without following it', () => {
    const dir = toPosix(tree());
    symlinkSync(join(dir, 'w/sub'), join(dir, 'w/linked'), 'junction');
    expect(scopeListing(scope(`${dir}/w`, { deep: true }))).toContain('f:linked');
    expect(scopeListing(scope(`${dir}/w`, { deep: true }))).not.toContain('linked/d.js');
  });

  it('lists a missing folder as missing, and an empty one as empty', () => {
    const dir = toPosix(makeProject({ 'empty/.keep': '' }));
    expect(scopeListing(scope(`${dir}/none`))).toBe('\0missing');
    expect(scopeListing(scope(`${dir}/empty`))).toBe('');
  });

  it.each([
    ['w/b.js', false, scope('w', { suffix: '.js' }), true],
    ['w/B.JS', false, scope('w', { suffix: '.js' }), true],
    ['w/b.ts', false, scope('w', { suffix: '.js' }), false],
    ['w/.b.js.swp', false, scope('w', { suffix: '.js' }), false],
    ['w/.b.js', false, scope('w', { suffix: '.js', dot: true }), true],
    ['w/sub/b.js', false, scope('w', { suffix: '.js' }), false],
    ['w/sub/b.js', false, scope('w', { suffix: '.js', deep: true }), true],
    ['w/sub', true, scope('w', { suffix: '.js' }), false],
    ['w/sub', true, scope('w', { suffix: '.js', deep: true }), true],
    ['w/node_modules', true, scope('w', { deep: true }), false],
    ['w/node_modules', true, scope('w', { deep: true, exhaustive: true }), true],
    ['w', true, scope('w', { suffix: '.js' }), true],
    ['other/b.js', false, scope('w', { suffix: '.js', deep: true }), false],
    ['w/x.timestamp-1-ab.mjs', false, scope('w'), false],
  ])('%s (folder: %s) in %o: %s', (path, isDir, inScope, expected) => {
    const dir = tree();
    const at = { ...inScope, dir: toPosix(join(dir, inScope.dir)) };
    expect(scopeAdmits(at, join(dir, path), isDir)).toBe(expected);
  });
});

describe('scopeWatchTargets', () => {
  it('watches each folder once, or the nearest that exists', () => {
    const dir = toPosix(makeProject({ 'w/a.js': '' }));
    const scopes = [scope(`${dir}/w`), scope(`${dir}/w`, { deep: true }), scope(`${dir}/later/deep`)];
    expect(scopeWatchTargets(scopes)).toEqual([`${dir}/w`, dir]);
  });
});

/** A transform hook's context for moduleGlobScopes: resolving with `resolve`, and warnings collected in `warn`. */
const hookContext = (
  resolve: (source: string) => Promise<{ readonly id: string } | null> = () => Promise.resolve(null),
) => ({ resolve: vi.fn(resolve), warn: vi.fn() });

const GLOB_CODE = "export const w = import.meta.glob('./w/*.js');";

describe('moduleGlobScopes', () => {
  it('reads nothing from a module without a glob call', async () => {
    const context = hookContext();
    expect(await moduleGlobScopes(context, 'export default 1;', '/p/a.js', '/p')).toEqual([]);
    expect(context.warn).not.toHaveBeenCalled();
  });

  it('warns about a module acorn cannot read', async () => {
    const context = hookContext();
    const code = "const x: Record<string, unknown> = import.meta.glob('./a/*.ts');";
    expect(await moduleGlobScopes(context, code, '/p/a.ts', '/p')).toEqual([]);
    expect(context.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not read the import.meta.glob() calls of /p/a.ts'),
    );
  });

  it.skipIf(process.platform === 'win32').each([
    ['/p/app/a.js?v=1', '/p/app/w'],
    ['\0virtual:x', '/p/w'],
    ['virtual-module', '/p/w'],
  ])('places the globs of %s', async (id, dir) => {
    const scopes = await moduleGlobScopes(hookContext(), GLOB_CODE, id, '/p');
    expect(scopes.map((s) => s.dir)).toEqual([dir]);
  });

  it.skipIf(process.platform === 'win32')(
    'resolves a pattern as Vite’s import-glob asks, without its query',
    async () => {
      const context = hookContext(() => Promise.resolve({ id: '/p/w/*.js?x' }));
      const code = "import.meta.glob('#w/*.js');";
      expect((await moduleGlobScopes(context, code, '/p/a.js', '/p')).map((s) => s.dir)).toEqual(['/p/w']);
      expect(context.resolve).toHaveBeenCalledWith('#w/*.js', '/p/a.js', {
        custom: { 'vite:import-glob': { isSubImportsPattern: true } },
      });
    },
  );

  it.each([
    ['resolves it to nothing', () => Promise.resolve(null)],
    ['fails', () => Promise.reject(new Error('no'))],
  ])('gives a pattern no scope when the resolver %s', async (_name, resolve) => {
    const context = hookContext(resolve);
    expect(await moduleGlobScopes(context, "import.meta.glob('@w/*.js');", '/p/a.js', '/p')).toEqual([]);
    expect(context.resolve).toHaveBeenCalledWith('@w/*.js', '/p/a.js', {
      custom: { 'vite:import-glob': { isSubImportsPattern: false } },
    });
  });
});

/** The files of the differential project, relative to its root. */
const FILES = [
  'app/entry.js',
  'app/widgets/a.js',
  'app/widgets/b.ts',
  'app/widgets/c.JS',
  'app/widgets/d.json',
  'app/widgets/.hidden.js',
  'app/widgets/sub/e.js',
  'app/widgets/sub/deep/f.js',
  'app/widgets/node_modules/m.js',
  'app/widgets/.dot/g.js',
  'shared/x.js',
  'shared/y.json',
  'shared/nested/z.js',
];

/** Glob calls (their argument lists), each matching at least one file of FILES. */
const CALLS = [
  "'./widgets/*.js'",
  "'./widgets/**/*.js'",
  "'./widgets/*'",
  "'./widgets/**'",
  "'./widgets/*.{js,ts}'",
  "'./widgets/sub/*.js'",
  "['./widgets/*', '!./widgets/a.js']",
  "'./widgets/[ab].*'",
  "'./widgets/a.js'",
  "'./widgets/*.js', { caseSensitive: false }",
  "'./widgets/**/*.js', { exhaustive: true }",
  "'./*.js', { base: './widgets' }",
  "'./*.js', { base: '/shared' }",
  "'/shared/**/*.js'",
  "'../shared/*'",
  "'@shared/**/*.js'",
  "['./widgets/sub/*.js', '/shared/*.json']",
];

describe('scopes against Vite’s import-glob', () => {
  it.each(CALLS)('every file import.meta.glob(%s) matches lies in its scopes', async (args) => {
    const root = makeProject(
      Object.fromEntries(FILES.map((file) => [file, file.endsWith('.json') ? '{}' : 'export default 1;'])),
    );
    const entry = join(root, 'app/entry.js');
    // With the options of the call, eager: every match becomes a module of the bundle.
    const [patterns, options = ''] = args.split(/, (?=\{)/);
    const eager = options === '' ? '{ eager: true }' : options.replace('{', '{ eager: true,');
    writeFileSync(entry, `globalThis.all = import.meta.glob(${patterns ?? ''}, ${eager});`);
    const scopes: GlobScope[] = [];
    const probe: Plugin = {
      name: 'probe',
      async transform(code, id) {
        scopes.push(...(await moduleGlobScopes(this, code, id, root)));
      },
    };
    const out = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      resolve: { alias: { '@shared': join(root, 'shared') } },
      plugins: [probe],
      build: { write: false, rolldownOptions: { input: entry } },
    });
    const outputs = (Array.isArray(out) ? out : [out]).flatMap((result) => ('output' in result ? result.output : []));
    const matched = outputs
      .flatMap((item) => (item.type === 'chunk' ? item.moduleIds : []))
      .filter((id) => !id.startsWith('\0') && id !== toPosix(entry))
      .map((id) => id.replace(/[?#].*$/s, ''));
    expect(matched.length).toBeGreaterThan(0);
    expect(scopes.length).toBeGreaterThan(0);
    for (const file of matched) {
      const holding = scopes.filter((s) => scopeAdmits(s, file, false));
      expect(holding, `${relative(root, file)} is in no scope`).not.toEqual([]);
      const listed = holding.some((s) =>
        scopeListing(s)
          .split('\n')
          .includes(`f:${toPosix(relative(s.dir, file))}`),
      );
      expect(listed, `${relative(root, file)} is listed in no scope`).toBe(true);
    }
  });
});

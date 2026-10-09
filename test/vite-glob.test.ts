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
  readScope,
  scopeAdmits,
  scopeId,
  scopeListing,
  scopesOf,
  scopeWatchTargets,
} from '../src/plugins/vite-glob.js';
import type { GlobCall, GlobScope } from '../src/plugins/vite-glob.js';
import { canonicalPath, fileKey, toPosix } from '../src/plugins/paths.js';
import { cleanUp, makeProject } from './helpers/plugins.js';

afterEach(cleanUp);

const call = (patterns: string[], base?: string, exhaustive = false): GlobCall => ({ patterns, base, exhaustive });

/** Glob calls in module code, and the calls each reads as. */
const MODULE_CALLS: readonly (readonly [string, GlobCall[]])[] = [
  ["import.meta.glob('./a/*.js')", [call(['./a/*.js'])]],
  ['import.meta.glob(`./a/*.js`)', [call(['./a/*.js'])]],
  ["import.meta.glob(['./a/*.js', '!./a/b.js'])", [call(['./a/*.js', '!./a/b.js'])]],
  ["import.meta.glob('./*.js', { base: './a', eager: true })", [call(['./*.js'], './a')]],
  ["import.meta.glob('./*.js', { 'base': '/a', exhaustive: true })", [call(['./*.js'], '/a', true)]],
  ["import.meta.glob('./a/*.js', { exhaustive: false })", [call(['./a/*.js'])]],
  ["import.meta.glob('./a/*.js',)", [call(['./a/*.js'])]],
  ["import.meta.glob ( './a/*.js' ).then((m) => m)", [call(['./a/*.js'])]],
  [
    "const x = () => import.meta.glob('./a/*.js'); const y = import.meta.glob('./b/*');",
    [call(['./a/*.js']), call(['./b/*'])],
  ],
  // Not a pattern Vite takes (no argument, an expression): no scope comes of it, and Vite fails the bundle.
  ['import.meta.glob()', [call([])]],
  ['import.meta.glob(`./${x}/*.js`, { base: dir })', [call([])]],
  ["import.meta.glob(['./a/*.js', 1, ...more])", [call(['./a/*.js'])]],
  ["import.meta.glob('./a/*.js', { ['base']: './b', [key]: 1, ...rest })", [call(['./a/*.js'])]],
  // Not a glob call.
  ["import.meta.globEager('./a/*.js'); import.meta['glob']('./b/*.js'); x.glob('./c/*')", []],
];

/** Text no JavaScript parser reads, which makes the code around it no module. */
const NOT_A_MODULE = '\n<template><div v-if="a < b">@@</div></template>\n';

describe('globCalls', () => {
  it.each(MODULE_CALLS)('reads the module %s whole', (code, expected) => {
    expect(globCalls(`export function f() {}\n${code}`)).toEqual({ calls: expected, unreadable: [] });
  });

  it.each(MODULE_CALLS)('reads %s alike in text that is no module', (code, expected) => {
    expect(globCalls(`${NOT_A_MODULE}${code}${NOT_A_MODULE}`)).toEqual({ calls: expected, unreadable: [] });
  });

  it('counts only real calls in a module', () => {
    const code = "// import.meta.glob('./old/*.js')\nconst s = 'import.meta.glob(\"./b/*.js\")';";
    expect(globCalls(code)).toEqual({ calls: [], unreadable: [] });
  });

  it.each([
    ["const x = import.meta.glob<Mod>('./a/*.ts') as Record<string, Mod>;", [call(['./a/*.ts'])]],
    ["const x: Record<string, unknown> = import.meta.glob('./a/*.ts', { eager: true });", [call(['./a/*.ts'])]],
    [
      "<script setup lang=\"ts\">\nconst w = import.meta.glob<Widget>(['./w/*.vue', '!./w/x.vue'], { base: './a' });\n</script>",
      [call(['./w/*.vue', '!./w/x.vue'], './a')],
    ],
    // As Vite's import-glob reads such text, a call in a comment counts too.
    ["type T = string;\n// import.meta.glob('./old/*.js')", [call(['./old/*.js'])]],
  ])('reads the calls of the TypeScript or component text %s', (code, expected) => {
    expect(globCalls(code)).toEqual({ calls: expected, unreadable: [] });
  });

  it('reports where a call it cannot read is', () => {
    const code = "type T = string;\nimport.meta.glob(./a/*.js); import.meta.glob('./b/*.js');\nimport.meta.glob(";
    expect(globCalls(code)).toEqual({ calls: [call(['./b/*.js'])], unreadable: [17, 75] });
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

  it('follows a link to a folder in a deep scope, listed with its target, and reports the folder', () => {
    const dir = toPosix(tree());
    const outside = toPosix(makeProject({ 'e.js': '', 'deeper/g.js': '' }));
    symlinkSync(outside, join(dir, 'w/linked'), 'junction');
    const read = readScope(scope(`${dir}/w`, { deep: true, suffix: '.js' }));
    expect(read.listing.split('\n')).toEqual([
      'f:C.JS',
      'f:a.js',
      `l:linked>${canonicalPath(outside)}`,
      'd:linked/deeper',
      'f:linked/deeper/g.js',
      'f:linked/e.js',
      'd:sub',
      'f:sub/d.js',
    ]);
    expect(read.linked).toEqual([canonicalPath(outside)]);
  });

  it('lists a folder reached again through a link only once, so a link back above ends', () => {
    const dir = toPosix(tree());
    symlinkSync(join(dir, 'w'), join(dir, 'w/sub/up'), 'junction');
    symlinkSync(join(dir, 'w/sub'), join(dir, 'w/again'), 'junction');
    const read = readScope(scope(`${dir}/w`, { deep: true, suffix: '.js' }));
    expect(read.listing.split('\n')).toEqual([
      'f:C.JS',
      'f:a.js',
      `l:again>${canonicalPath(join(dir, 'w/sub'))}`,
      'f:again/d.js',
      `l:again/up>${canonicalPath(join(dir, 'w'))}`,
      'd:sub',
      'f:sub/d.js',
      `l:sub/up>${canonicalPath(join(dir, 'w'))}`,
    ]);
    expect(read.linked).toEqual([canonicalPath(join(dir, 'w/sub'))]);
  });

  // A link to a file needs a privilege on Windows, which a junction (a link to a folder) does not.
  it.skipIf(process.platform === 'win32')(
    'lists a link to a file, or to nothing, as a file, and does not follow a link in a shallow scope',
    () => {
      const dir = toPosix(tree());
      symlinkSync(join(dir, 'w/a.js'), join(dir, 'w/file-link.js'));
      symlinkSync(join(dir, 'w/none'), join(dir, 'w/dangling.js'));
      symlinkSync(join(dir, 'w/sub'), join(dir, 'w/folder-link.js'), 'junction');
      expect(scopeListing(scope(`${dir}/w`, { suffix: '.js' })).split('\n')).toEqual([
        'f:C.JS',
        'f:a.js',
        'f:dangling.js',
        'f:file-link.js',
      ]);
      expect(readScope(scope(`${dir}/w`, { suffix: '.js' })).linked).toEqual([]);
    },
  );

  it('admits what is added below a linked folder, however the path spells it, in a deep scope only', () => {
    const dir = tree();
    const outside = makeProject({ 'e.js': '' });
    symlinkSync(outside, join(dir, 'w/linked'), 'junction');
    const deep = scope(toPosix(join(dir, 'w')), { deep: true, suffix: '.js' });
    const { linked } = readScope(deep);
    expect(scopeAdmits(deep, join(outside, 'new.js'), false, linked)).toBe(true);
    expect(scopeAdmits(deep, join(outside, 'sub/new.js'), false, linked)).toBe(true);
    expect(scopeAdmits(deep, join(dir, 'w/linked/new.js'), false, linked)).toBe(true);
    expect(scopeAdmits(deep, outside, true, linked)).toBe(true);
    expect(scopeAdmits(deep, join(outside, 'new.ts'), false, linked)).toBe(false);
    expect(scopeAdmits(deep, join(outside, 'new.js'), false, [])).toBe(false);
    expect(scopeAdmits({ ...deep, deep: false }, join(outside, 'new.js'), false, linked)).toBe(false);
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
    expect(scopeAdmits(at, join(dir, path), isDir, [])).toBe(expected);
  });
});

describe('scopeWatchTargets', () => {
  it('watches each folder once, or the nearest that exists', () => {
    const dir = toPosix(makeProject({ 'w/a.js': '' }));
    const scopes = [scope(`${dir}/w`), scope(`${dir}/w`, { deep: true }), scope(`${dir}/later/deep`)];
    expect(scopeWatchTargets(scopes)).toEqual([`${dir}/w`, dir]);
  });

  it('watches the folders a deep scope reaches through links', () => {
    const dir = toPosix(makeProject({ 'w/a.js': '' }));
    const outside = makeProject({ 'e.js': '' });
    symlinkSync(outside, join(dir, 'w/linked'), 'junction');
    expect(scopeWatchTargets([scope(`${dir}/w`, { deep: true })])).toEqual([`${dir}/w`, canonicalPath(outside)]);
    expect(scopeWatchTargets([scope(`${dir}/w`)])).toEqual([`${dir}/w`]);
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

  it.skipIf(process.platform === 'win32')('reads the calls of text that is no module', async () => {
    const context = hookContext();
    const code = "const x: Record<string, unknown> = import.meta.glob<Mod>('./w/*.ts');";
    expect((await moduleGlobScopes(context, code, '/p/a.ts', '/p')).map((s) => s.dir)).toEqual(['/p/w']);
    expect(context.warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('warns about a call it cannot read, and keeps the others', async () => {
    const context = hookContext();
    const code = "type T = string;\n  import.meta.glob(./a/*.ts);\nimport.meta.glob('./w/*.ts');";
    expect((await moduleGlobScopes(context, code, '/p/a.ts', '/p')).map((s) => s.dir)).toEqual(['/p/w']);
    expect(context.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('could not read the import.meta.glob() call at 2:3 of /p/a.ts'),
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
  "'./widgets/linked/*.js'",
];

/** Links of the differential project (link → target, relative to its root): one to a folder, one back above. */
const LINKS = [
  ['app/widgets/linked', 'shared/nested'],
  ['app/widgets/sub/up', 'app/widgets'],
] as const;

describe('scopes against Vite’s import-glob', () => {
  it.each(CALLS)('every file import.meta.glob(%s) matches lies in its scopes', async (args) => {
    const root = makeProject(
      Object.fromEntries(FILES.map((file) => [file, file.endsWith('.json') ? '{}' : 'export default 1;'])),
    );
    for (const [link, target] of LINKS) symlinkSync(join(root, target), join(root, link), 'junction');
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
      const holding = scopes.filter((s) => scopeAdmits(s, file, false, readScope(s).linked));
      expect(holding, `${relative(root, file)} is in no scope`).not.toEqual([]);
      // Vite names a file reached through a link by its real path, which the listing spells through the link.
      const listed = holding.some((s) =>
        scopeListing(s)
          .split('\n')
          .some((line) => line.startsWith('f:') && fileKey(join(s.dir, line.slice(2))) === fileKey(file)),
      );
      expect(listed, `${relative(root, file)} is listed in no scope`).toBe(true);
    }
  });
});

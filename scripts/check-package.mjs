// Checks the packed tarball the way users consume it.
//
//   node scripts/check-package.mjs [path/to/rohal12-twee-ts-x.y.z.tgz]
//   pnpm run check:package      (builds, packs the build, then checks it)
//
// Lints the tarball with publint --strict and Are the Types Wrong (every resolution mode), then
// installs it into a throwaway project and checks, for every entry point:
// - TypeScript consumers: nodenext (ESM), node16 (CJS .cts), bundler and node10 resolution, each
//   with exactOptionalPropertyTypes on and off, skipLibCheck off, on TypeScript 5.9 and 7;
// - runtime: ESM import and CJS require of every subpath, the schema and package.json exports,
//   and a smoke compile;
// - one build graph: each format defines TweeTsError in one file that every entry point reaches;
// - the CLI through the bin link (`npx twee-ts`), and that the CLI and creator-version report the
//   version in the installed package.json (the one the release writes).
// Works on Linux, macOS and Windows. Runs every check, then exits non-zero if any failed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@rohal12/twee-ts';
const ENTRIES = ['', '/vite', '/rollup'];
// Consumer toolchain. TypeScript 7 dropped node10 resolution, so that case runs on 5.9 only.
const TYPESCRIPTS = { ts59: '5.9.3', ts7: '7.0.2' };
const CONSUMER_DEPS = { '@types/node': '22', vite: '8', rollup: '4' };
const PUBLINT = 'publint@0.3.25';
const ATTW = '@arethetypeswrong/cli@0.18.5';

const root = mkdtempSync(join(tmpdir(), 'twee-ts-consumer-'));
const keep = process.env.KEEP_CONSUMER === '1';
let failures = 0;

// Without an argument, pack the current build (run `pnpm run build` first).
const tarball = process.argv[2] ?? packCurrentBuild();

function packCurrentBuild() {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dest = join(root, 'pack');
  mkdirSync(dest);
  const r = spawnSync('npm', ['pack', '--pack-destination', dest, '--loglevel=error'], {
    cwd: repo,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`npm pack failed\n${r.stdout}\n${r.stderr}`);
  return join(dest, r.stdout.trim().split('\n').at(-1) ?? '');
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    // npm and npx are .cmd shims on Windows, which only start through a shell.
    shell: process.platform === 'win32',
    ...options,
  });
  if (r.error) throw new Error(`${cmd} ${args.join(' ')} could not start`, { cause: r.error });
  return r;
}

function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n${e instanceof Error ? e.message : String(e)}\n`);
  }
}

function expectSuccess(r, what) {
  if (r.status !== 0) throw new Error(`${what} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function write(file, content) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

try {
  // ---- package lint ---------------------------------------------------------------------------
  check(`lint: ${PUBLINT} --strict`, () => {
    expectSuccess(run('npx', ['--yes', PUBLINT, '--strict', resolve(tarball)]), 'publint');
  });
  // The default profile ("strict") requires node10, node16 CJS, node16 ESM and bundler to resolve.
  check(`lint: ${ATTW}`, () => {
    expectSuccess(run('npx', ['--yes', ATTW, resolve(tarball)]), 'attw');
  });

  // ---- install ------------------------------------------------------------------------------
  write('package.json', {
    name: 'twee-ts-consumer',
    private: true,
    type: 'module',
    dependencies: {
      [PACKAGE]: `file:${resolve(tarball)}`,
      ...Object.fromEntries(Object.entries(TYPESCRIPTS).map(([alias, v]) => [alias, `npm:typescript@${v}`])),
      ...CONSUMER_DEPS,
    },
  });
  expectSuccess(
    run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts']),
    'npm install',
  );
  const installed = join(root, 'node_modules', ...PACKAGE.split('/'));
  const version = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;
  console.log(`checking ${PACKAGE}@${version} in ${root}`);

  // ---- TypeScript consumers -----------------------------------------------------------------
  // `vite` is how the consumer imports Vite's own types: Vite 7+ has ESM-only types, so a CJS
  // file needs import mode, and node10 resolution cannot see them at all (Vite's limitation, so
  // the node10 consumer checks `.` and `./rollup` only).
  const typeUse = (vite) => `
import { compile, TweeTsError, type CompileOptions, type CompileResult } from '${PACKAGE}';
import { tweeTsPlugin as rollupPlugin, type TweeTsRollupPluginOptions } from '${PACKAGE}/rollup';

const options: CompileOptions = { sources: ['src'], outputMode: 'json' };
export const result: Promise<CompileResult> = compile(options);
export const isError = (e: unknown): boolean => e instanceof TweeTsError;
const rollupOptions: TweeTsRollupPluginOptions = { sources: ['src'] };
export const rollup = rollupPlugin(rollupOptions);
export const name: string = rollup.name;
// Fails as an unused directive if the types resolved to any.
// @ts-expect-error outputMode only takes the listed modes
export const bad: CompileOptions = { sources: [], outputMode: 'pdf' };
${
  vite === 'none'
    ? ''
    : `
import { tweeTsPlugin as vitePlugin, type TweeTsVitePluginOptions } from '${PACKAGE}/vite';
import type { Plugin as VitePlugin } from 'vite'${vite === 'import-mode' ? ` with { 'resolution-mode': 'import' }` : ''};
const viteOptions: TweeTsVitePluginOptions = { sources: ['src'] };
export const vite: VitePlugin = vitePlugin(viteOptions);
`
}`;
  const consumers = [
    {
      dir: 'nodenext',
      file: 'index.ts',
      module: 'nodenext',
      resolution: 'nodenext',
      vite: 'plain',
      ts: ['ts59', 'ts7'],
    },
    {
      dir: 'node16-cjs',
      file: 'index.cts',
      module: 'node16',
      resolution: 'node16',
      vite: 'import-mode',
      ts: ['ts59', 'ts7'],
    },
    { dir: 'bundler', file: 'index.ts', module: 'esnext', resolution: 'bundler', vite: 'plain', ts: ['ts59', 'ts7'] },
    { dir: 'node10', file: 'index.ts', module: 'commonjs', resolution: 'node10', vite: 'none', ts: ['ts59'] },
  ];
  for (const c of consumers) {
    write(`${c.dir}/${c.file}`, typeUse(c.vite));
    for (const eopt of [true, false]) {
      const config = `tsconfig.${eopt ? 'eopt' : 'loose'}.json`;
      write(`${c.dir}/${config}`, {
        compilerOptions: {
          target: 'es2022',
          module: c.module,
          moduleResolution: c.resolution,
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          exactOptionalPropertyTypes: eopt,
          types: ['node'],
          ...(c.resolution === 'node10' ? { esModuleInterop: true } : {}),
        },
        files: [c.file],
      });
      for (const ts of c.ts) {
        check(
          `types: ${c.dir}, exactOptionalPropertyTypes ${eopt ? 'on' : 'off'}, TypeScript ${TYPESCRIPTS[ts]}`,
          () => {
            expectSuccess(
              run(process.execPath, [join(root, 'node_modules', ts, 'bin', 'tsc'), '-p', join(c.dir, config)]),
              'tsc',
            );
          },
        );
      }
    }
  }

  // ---- runtime ------------------------------------------------------------------------------
  const story = `:: StoryTitle\nPackage Check\n\n:: StoryData\n{"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello from the tarball.\n`;
  write(
    'runtime.mjs',
    `
import assert from 'node:assert/strict';
const main = await import('${PACKAGE}');
${ENTRIES.slice(1)
  .map((e) => `assert.equal(typeof (await import('${PACKAGE}${e}')).tweeTsPlugin, 'function');`)
  .join('\n')}
assert.equal(typeof main.compile, 'function');
assert.ok(new main.TweeTsError('x', []) instanceof Error);
import.meta.resolve('${PACKAGE}/schemas/twee-ts.config.schema.json');
import.meta.resolve('${PACKAGE}/package.json');
const r = await main.compile({ sources: [{ filename: 'a.tw', content: ${JSON.stringify(story)} }], outputMode: 'json' });
assert.deepEqual(r.diagnostics.filter((d) => d.level === 'error'), []);
console.log(JSON.parse(r.output)['creator-version']);
`,
  );
  write(
    'runtime.cjs',
    `
const assert = require('node:assert/strict');
const main = require('${PACKAGE}');
${ENTRIES.slice(1)
  .map((e) => `assert.equal(typeof require('${PACKAGE}${e}').tweeTsPlugin, 'function');`)
  .join('\n')}
assert.equal(typeof main.compile, 'function');
assert.ok(new main.TweeTsError('x', []) instanceof Error);
require.resolve('${PACKAGE}/schemas/twee-ts.config.schema.json');
require.resolve('${PACKAGE}/package.json');
main.compile({ sources: [{ filename: 'a.tw', content: ${JSON.stringify(story)} }], outputMode: 'json' }).then((r) => {
  assert.deepEqual(r.diagnostics.filter((d) => d.level === 'error'), []);
  console.log(JSON.parse(r.output)['creator-version']);
});
`,
  );
  for (const file of ['runtime.mjs', 'runtime.cjs']) {
    check(`runtime: ${file} loads every entry point and compiles`, () => {
      const out = expectSuccess(run(process.execPath, [file]), file).trim();
      if (out !== version) throw new Error(`creator-version is ${out}, expected ${version}`);
    });
  }

  // ---- one build graph ----------------------------------------------------------------------
  const dist = join(installed, 'dist');
  const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  const reachable = (entry) => {
    const seen = new Set();
    const stack = [resolve(dist, entry)];
    while (stack.length > 0) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) stack.push(resolve(dirname(file), m[1]));
    }
    return seen;
  };
  const jsFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? jsFiles(join(dir, d.name)) : /\.c?js$/.test(d.name) ? [join(dir, d.name)] : [],
    );
  for (const [format, ext] of [
    ['ESM', '.js'],
    ['CJS', '.cjs'],
  ]) {
    check(`one build graph: ${format} defines TweeTsError once and every entry point reaches it`, () => {
      const definers = jsFiles(dist).filter(
        (f) => f.endsWith(ext) && /\bTweeTsError = class\b/.test(readFileSync(f, 'utf8')),
      );
      if (definers.length !== 1) throw new Error(`TweeTsError is defined in ${definers.length} files: ${definers}`);
      for (const entry of ['index', 'plugins/vite', 'plugins/rollup']) {
        if (!reachable(`${entry}${ext}`).has(definers[0]))
          throw new Error(`${entry}${ext} does not reach ${definers[0]}`);
      }
    });
  }

  // A `{@link name}` in the shipped declarations must name something they declare: a link to a module-private
  // function is a dead link in every consumer's editor (#250 DOC-5).
  check('declarations: every {@link} names something the shipped types declare', () => {
    const declarationFiles = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? declarationFiles(join(dir, d.name)) : /\.d\.c?ts$/.test(d.name) ? [join(dir, d.name)] : [],
      );
    const text = declarationFiles(dist)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const declared = new Set(
      [
        ...text.matchAll(/\b(?:function|class|interface|type|const|let|enum|namespace)\s+([A-Za-z_$][\w$]*)/g),
        ...text.matchAll(/\bas\s+([A-Za-z_$][\w$]*)\s*[,}]/g),
        ...text.matchAll(/^\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\??[:(]/gm),
      ].map((m) => m[1]),
    );
    const broken = [...new Set([...text.matchAll(/\{@link\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].filter(
      (name) => !declared.has(name),
    );
    if (broken.length > 0) throw new Error(`links to undeclared names: ${broken.join(', ')}`);
  });

  // ---- CLI through the bin link ---------------------------------------------------------------
  write('story/a.tw', story);
  check('cli: npx twee-ts --version', () => {
    const out = expectSuccess(run('npx', ['--no-install', 'twee-ts', '--version']), 'twee-ts --version').trim();
    if (out !== `twee-ts v${version}`) throw new Error(`printed "${out}"`);
  });
  check('cli: npx twee-ts compiles a story', () => {
    expectSuccess(run('npx', ['--no-install', 'twee-ts', '--json', '-o', 'out.json', 'story']), 'twee-ts --json');
    const out = JSON.parse(readFileSync(join(root, 'out.json'), 'utf8'));
    if (out.name !== 'Package Check' || out['creator-version'] !== version) {
      throw new Error(`unexpected output: ${JSON.stringify(out).slice(0, 300)}`);
    }
  });

  // The release sets the version in the package.json it publishes; the CLI and creator-version
  // must report that one, not a version baked in at build time.
  check('version: follows the installed package.json', () => {
    const manifest = join(installed, 'package.json');
    const original = readFileSync(manifest, 'utf8');
    const stamped = '99.0.0-release-check';
    writeFileSync(manifest, original.replace(/"version": "[^"]*"/, `"version": "${stamped}"`));
    try {
      const cli = expectSuccess(run('npx', ['--no-install', 'twee-ts', '--version']), 'twee-ts --version').trim();
      if (cli !== `twee-ts v${stamped}`) throw new Error(`CLI printed "${cli}"`);
      for (const file of ['runtime.mjs', 'runtime.cjs']) {
        const out = expectSuccess(run(process.execPath, [file]), file).trim();
        if (out !== stamped) throw new Error(`${file}: creator-version is ${out}`);
      }
    } finally {
      writeFileSync(manifest, original);
    }
  });
} finally {
  if (keep) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} package check(s) failed`);
  process.exit(1);
}
console.log('\nall package checks passed');

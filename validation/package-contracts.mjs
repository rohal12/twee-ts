/** Test the packed distribution in an isolated installed consumer, not repository imports. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { REPO } from './evidence.mjs';
const root = mkdtempSync(join(tmpdir(), 'twee-package-'));
try {
  // npm's JS entry avoids shell-dependent .cmd execution on Windows.
  const npm = process.env.npm_execpath;
  const runNpm = (args, cwd) =>
    npm && /npm-cli\.js$/.test(npm)
      ? execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8' })
      : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
          cwd,
          encoding: 'utf8',
          shell: process.platform === 'win32',
        });
  const packed = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], REPO))[0];
  const files = new Set(packed.files.map((file) => file.path));
  for (const path of [
    'dist/index.js',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/plugins/vite.js',
    'dist/plugins/rollup.js',
    'dist/bin/twee-ts.js',
    'schemas/twee-ts.config.schema.json',
  ])
    assert(files.has(path), `missing published file: ${path}`);
  assert(
    ![...files].some((path) => path.startsWith('src/') || path.startsWith('validation/')),
    'development files leaked into the tarball',
  );
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"type":"module","private":true}');
  runNpm(
    ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(root, packed.filename)],
    consumer,
  );
  writeFileSync(
    join(consumer, 'check.mjs'),
    `import assert from 'node:assert/strict';\nimport {createRequire} from 'node:module';\nimport * as esm from '@rohal12/twee-ts';\nimport {tweeTsPlugin} from '@rohal12/twee-ts/rollup';\nconst cjs=createRequire(import.meta.url)('@rohal12/twee-ts');\nfor(const api of [esm,cjs]) {const r=await api.compile({sources:[{filename:'story.tw',content:':: StoryData\\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\\n:: Start\\nInstalled package'}],outputMode:'json'});assert.equal(JSON.parse(r.output).passages[0].text,'Installed package');}\nassert.equal(typeof tweeTsPlugin,'function');\n`,
  );
  execFileSync(process.execPath, ['check.mjs'], { cwd: consumer, encoding: 'utf8' });
  const cli = join(consumer, 'node_modules', '@rohal12', 'twee-ts', 'dist', 'bin', 'twee-ts.js');
  assert.match(
    execFileSync(process.execPath, [cli, '--version'], { cwd: consumer, encoding: 'utf8' }),
    /\d+\.\d+\.\d+/,
  );
  // npm exec invokes the installed bin shim, including the .cmd shim on Windows.
  // Offline mode prevents an absent/broken local bin from downloading a replacement.
  assert.match(runNpm(['exec', '--offline', '--', 'twee-ts', '--version'], consumer), /twee-ts v\d+\.\d+\.\d+/);
  JSON.parse(
    readFileSync(
      join(consumer, 'node_modules', '@rohal12', 'twee-ts', 'schemas', 'twee-ts.config.schema.json'),
      'utf8',
    ),
  );
  // Peers and type dependencies are explicit links to the lockfile-provisioned
  // installation. Only these dependencies are linked; twee-ts itself remains
  // the unpacked tarball, so repository source types cannot satisfy the probes.
  const dependencies = ['typescript', 'vite', 'rollup', '@types/node'].map((name) => {
    const source = realpathSync(join(REPO, 'node_modules', name));
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    assert.equal(pkg.name, name);
    const target = join(consumer, 'node_modules', name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    return { name, version: pkg.version, source, provision: 'linked lockfile-provisioned installation' };
  });
  writeFileSync(
    join(consumer, 'core-esm.mts'),
    `import {compile, compileIncremental, parseTwee, applyTagAliases} from '@rohal12/twee-ts';
import type {CompileOptions, CompileResult, FileCacheEntry} from '@rohal12/twee-ts';
const options: CompileOptions = {sources: [{filename:'story.tw', content:':: Start\\nHi'}] as const, outputMode:'json'};
const result: CompileResult = await compile(options);
const output: string = result.output;
await compileIncremental(options, new Map<string, FileCacheEntry>());
const aliased = applyTagAliases(parseTwee(':: Logic [library]\\nwindow.x=1').passages, {library:'script'});
const tags: readonly string[] = aliased[0]!.tags;
function rejectedWrites(value: CompileResult): void {
  const passage = value.story.passages[0]!;
  // @ts-expect-error compiled passage tags are readonly
  passage.tags.push('x');
  // @ts-expect-error compiled metadata entries are readonly
  if (passage.metadata) passage.metadata.position = '1,2';
  // @ts-expect-error compiled source locations are readonly
  if (passage.source) passage.source.line = 42;
  // @ts-expect-error compiled metadata maps are readonly
  value.story.twine2.options.set('debug', true);
}
void [output, tags, rejectedWrites];
`,
  );
  writeFileSync(
    join(consumer, 'core-cjs.cts'),
    `import core = require('@rohal12/twee-ts');
const options: core.CompileOptions = {sources:['story.tw'] as const, outputMode:'json'};
const pending: Promise<core.CompileResult> = core.compile(options);
pending.then(result => {
  const output: string = result.output;
  // @ts-expect-error compiled passage collections are readonly in CJS too
  result.story.passages.push({name:'Extra', tags:[], text:''});
  void output;
});
// @ts-expect-error inline source content accepts text or Buffer, not a number
core.compile({sources:[{filename:'story.tw',content:42}]});
`,
  );
  writeFileSync(
    join(consumer, 'plugins.mts'),
    `import {defineConfig as viteConfig} from 'vite';
import type {Plugin as VitePlugin} from 'vite';
import {defineConfig as rollupConfig} from 'rollup';
import type {Plugin as RollupPlugin} from 'rollup';
import {tweeTsPlugin as vitePlugin} from '@rohal12/twee-ts/vite';
import {tweeTsPlugin as rollupPlugin} from '@rohal12/twee-ts/rollup';
const vite: VitePlugin = vitePlugin({sources:['story'], compileOptions:{trim:false}});
const rollup: RollupPlugin = rollupPlugin({sources:['story'], outputFilename:'story.html'});
const rollupInVite: VitePlugin = rollupPlugin({sources:['story']});
viteConfig({plugins:[vite,rollupInVite]});
rollupConfig({input:'entry.js', plugins:[rollup]});
// @ts-expect-error plugin source paths must be strings
vitePlugin({sources:[42]});
// @ts-expect-error compile options retain their public enum types
rollupPlugin({sources:['story'], compileOptions:{outputMode:'invalid'}});
`,
  );
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        types: ['node'],
        skipLibCheck: false,
      },
      files: ['core-esm.mts', 'core-cjs.cts', 'plugins.mts'],
    }),
  );
  const compiler = join(consumer, 'node_modules', 'typescript', 'bin', 'tsc');
  const compilerArgs = [compiler, '--project', join(consumer, 'tsconfig.json')];
  execFileSync(process.execPath, compilerArgs, { cwd: consumer, encoding: 'utf8' });
  const declarations = execFileSync(process.execPath, [...compilerArgs, '--listFilesOnly'], {
    cwd: consumer,
    encoding: 'utf8',
  })
    .trim()
    .split(/\r?\n/)
    .map((file) => resolve(file));
  const isWithin = (parent, file) => {
    const rel = relative(parent, file);
    return (
      rel !== '' &&
      !isAbsolute(rel) &&
      rel !== '..' &&
      !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
    );
  };
  const installed = join(consumer, 'node_modules', '@rohal12', 'twee-ts');
  assert(
    declarations.some((file) => isWithin(join(installed, 'dist'), file)),
    'consumer did not resolve installed declarations',
  );
  assert(
    !declarations.some((file) => isWithin(join(REPO, 'src'), file)),
    'repository source types leaked into consumer',
  );
  console.log(
    JSON.stringify({
      status: 'pass',
      tarballFiles: files.size,
      consumers: ['ESM', 'CJS', 'Rollup', 'CLI', 'installed bin shim', 'schema', 'TypeScript ESM/CJS/Vite/Rollup'],
      typeChecks: ['installed declaration resolution', 'readonly rejection probes', 'typed bundler configurations'],
      dependencies,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

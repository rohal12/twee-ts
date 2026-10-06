/** Test the packed distribution in an isolated installed consumer, not repository imports. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  JSON.parse(
    readFileSync(
      join(consumer, 'node_modules', '@rohal12', 'twee-ts', 'schemas', 'twee-ts.config.schema.json'),
      'utf8',
    ),
  );
  console.log(
    JSON.stringify({ status: 'pass', tarballFiles: files.size, consumers: ['ESM', 'CJS', 'Rollup', 'CLI', 'schema'] }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

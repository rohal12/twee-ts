/** Exercise the installed public plugin against a real supported peer version. Network install is explicit. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO } from './evidence.mjs';
const { values } = parseArgs({ options: { version: { type: 'string' } } });
assert(values.version && /^\d+\.\d+\.\d+$/.test(values.version), 'Pass --version with an exact supported Vite version');
const root = mkdtempSync(join(tmpdir(), 'twee-vite-peer-'));
const npm = (args, cwd) =>
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
try {
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], REPO))[0];
  writeFileSync(join(root, 'package.json'), '{"type":"module","private":true}');
  npm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename), `vite@${values.version}`],
    root,
  );
  mkdirSync(join(root, 'formats', 'review-1'), { recursive: true });
  writeFileSync(
    join(root, 'formats', 'review-1', 'format.js'),
    'window.storyFormat({"name":"Review","version":"1.0.0","source":"<html><head></head><body>{{STORY_DATA}}</body></html>"});',
  );
  writeFileSync(
    join(root, 'story.tw'),
    ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: Start\nVITE_BEFORE',
  );
  writeFileSync(
    join(root, 'check.mjs'),
    `import assert from 'node:assert/strict';\nimport {readFileSync,writeFileSync} from 'node:fs';\nimport {build,createServer,version} from 'vite';\nimport {tweeTsPlugin} from '@rohal12/twee-ts/vite';\nconst plugin=()=>tweeTsPlugin({sources:['story.tw'],format:'review-1',compileOptions:{formatPaths:['formats'],useTweegoPath:false,noRemote:true}});\nawait build({configFile:false,logLevel:'silent',plugins:[plugin()]});\nassert.match(readFileSync('dist/index.html','utf8'),/VITE_BEFORE/);\nconst server=await createServer({configFile:false,logLevel:'silent',plugins:[plugin()],server:{host:'127.0.0.1',port:0}});\ntry {await server.listen();const url='http://127.0.0.1:'+server.httpServer.address().port;assert.match(await (await fetch(url)).text(),/VITE_BEFORE/);writeFileSync('story.tw',readFileSync('story.tw','utf8').replace('VITE_BEFORE','VITE_AFTER'));assert.match(await (await fetch(url)).text(),/VITE_AFTER/);assert((await (await fetch(url)).text()).includes('/@vite/client'));} finally {await server.close();}\nconsole.log(JSON.stringify({status:'pass',vite:version,checks:['installed plugin','build','dev','edit refresh']}));\n`,
  );
  console.log(execFileSync(process.execPath, ['check.mjs'], { cwd: root, encoding: 'utf8' }));
} finally {
  rmSync(root, { recursive: true, force: true });
}

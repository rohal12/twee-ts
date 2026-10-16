import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanUp, makeProject, storyWith, tempDir, writeFiles } from './helpers/plugins.js';
import { BUILD_TIMEOUT_MS, cliNodeArgs } from './helpers/package-build.js';
import { removeDir } from './helpers/remove-dir.js';

let built = '';
let nodeArgs: readonly string[] = [];
beforeAll(() => {
  built = tempDir();
  nodeArgs = cliNodeArgs(built);
}, BUILD_TIMEOUT_MS);
afterEach(cleanUp);
afterAll(() => {
  if (built !== '') removeDir(built);
});

describe.skipIf(process.platform === 'win32')('CLI path boundaries (#465, #467)', () => {
  // A build folder registered with cleanUp() cannot outlive a test, so these related CLI calls share one fixture.
  it('agrees about config sources and format discovery from the config folder and its parent', () => {
    const dir = makeProject({
      'config/a.tw': storyWith('WRONG_STORY'),
      'real/a.tw': storyWith('RIGHT_STORY'),
      'config/twee-ts.config.json': JSON.stringify({ sources: ['pivot/../a.tw'], outputMode: 'json' }),
    });
    mkdirSync(join(dir, 'real/deep'));
    symlinkSync(join(dir, 'real/deep'), join(dir, 'config/pivot'), 'junction');
    const env = {
      ...process.env,
      HOME: join(dir, 'home'),
      USERPROFILE: join(dir, 'home'),
      XDG_CACHE_HOME: join(dir, 'cache'),
      TWEEGO_PATH: '',
    };
    const run = (cwd: string, args: readonly string[]) =>
      spawnSync(process.execPath, [...nodeArgs, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 });
    for (const [cwd, config] of [
      [dir, 'config/twee-ts.config.json'],
      [join(dir, 'config'), 'twee-ts.config.json'],
    ]) {
      const result = run(cwd ?? '', ['--config', config ?? '']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('RIGHT_STORY');
      expect(result.stdout).not.toContain('WRONG_STORY');
    }
    for (const folder of ['config', 'real']) {
      writeFiles(dir, {
        [`${folder}/example/format.js`]: `window.storyFormat(${JSON.stringify({
          name: folder === 'real' ? 'Right Format' : 'Wrong Format',
          version: '1.0.0',
          source: '<html><head></head><body>{{STORY_DATA}}</body></html>',
        })});`,
      });
    }
    writeFiles(dir, { 'config/twee-ts.config.json': JSON.stringify({ formatPaths: ['pivot/..'] }) });
    const list = run(dir, ['--config', 'config/twee-ts.config.json', '--list-formats']);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('example: Right Format 1.0.0');
    expect(list.stdout).not.toContain('Wrong Format');
  });
});

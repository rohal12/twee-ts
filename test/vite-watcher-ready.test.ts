import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createServer } from 'vite';
import { isViteConfigTemp } from '../src/plugins/paths.js';
import { cleanUp, makeProject, NO_DEP_OPTIMIZER, watcherReady } from './helpers/plugins.js';

afterEach(cleanUp);

it(
  'waits for authored files without waiting for an ignored temporary Vite config (#436)',
  { timeout: 20_000 },
  async () => {
    const temporary = 'vite.config.mjs.timestamp-123-deadbeef.mjs';
    const root = makeProject({ 'main.js': 'export const ready = true;', [temporary]: 'export default {};' });
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      ...NO_DEP_OPTIMIZER,
      server: { host: '127.0.0.1', port: 0, watch: { ignored: isViteConfigTemp } },
    });
    try {
      await server.listen();
      await watcherReady(server);
      const main = join(root, 'main.js');
      expect(server.watcher.getWatched()[dirname(main)]).toContain(basename(main));
      expect(existsSync(join(root, temporary))).toBe(true);
    } finally {
      await server.close();
    }
  },
);

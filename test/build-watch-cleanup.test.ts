import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from 'rollup';
import { cleanUp, makeProject, trackBuildWatch } from './helpers/plugins.js';

afterEach(cleanUp);

it('finishes an active build before closing its watcher and removing the project (#436)', async () => {
  const dir = makeProject({ 'entry.js': 'export const value = 1;' });
  const writing = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let written = '';
  trackBuildWatch(
    watch({
      input: join(dir, 'entry.js'),
      output: { dir: join(dir, 'dist'), format: 'es' },
      plugins: [
        {
          name: 'hold-write',
          async writeBundle() {
            writing.resolve(undefined);
            await release.promise;
            writeFileSync(join(dir, 'late.txt'), 'finished');
            written = readFileSync(join(dir, 'late.txt'), 'utf8');
          },
        },
      ],
    }),
  );
  await writing.promise;
  const closing = cleanUp();
  try {
    // Give an incorrectly early close/removal its event-loop turn while writeBundle is still held.
    await new Promise<void>((done) => setImmediate(done));
    expect(existsSync(dir)).toBe(true);
  } finally {
    release.resolve(undefined);
    await closing;
  }
  expect(written).toBe('finished');
  expect(existsSync(dir)).toBe(false);
});

it('disposes the bundle after an output failure before removing the project (#436)', async () => {
  const dir = makeProject({ 'entry.js': 'export const value = 1;' });
  let disposedInProject = false;
  const errors: string[] = [];
  const watcher = trackBuildWatch(
    watch({
      input: join(dir, 'entry.js'),
      output: { dir: join(dir, 'dist'), format: 'es' },
      plugins: [
        {
          name: 'failed-output',
          generateBundle() {
            throw new Error('output rejected');
          },
          closeBundle() {
            disposedInProject = existsSync(dir);
          },
        },
      ],
    }),
  );
  await new Promise<void>((done) => {
    watcher.on('event', (event) => {
      if (event.code === 'ERROR') errors.push(event.error.message);
      if (event.code === 'END') done();
    });
  });
  await cleanUp();
  expect(errors).toEqual(['output rejected']);
  expect(disposedInProject).toBe(true);
  expect(existsSync(dir)).toBe(false);
});

it('closes an idle watcher once even when several callers stop it (#436)', async () => {
  const dir = makeProject({ 'entry.js': 'export const value = 1;' });
  let closed = 0;
  const watcher = trackBuildWatch(
    watch({
      input: join(dir, 'entry.js'),
      output: { dir: join(dir, 'dist'), format: 'es' },
      plugins: [
        {
          name: 'close-count',
          closeWatcher() {
            closed++;
          },
        },
      ],
    }),
  );
  await new Promise<void>((done, fail) => {
    watcher.on('event', (event) => {
      if (event.code === 'ERROR') fail(new Error(event.error.message));
      if (event.code === 'END') done();
    });
  });
  const first = watcher.close();
  const second = watcher.close();
  expect(second).toBe(first);
  await first;
  await cleanUp();
  expect(closed).toBe(1);
  expect(existsSync(dir)).toBe(false);
});

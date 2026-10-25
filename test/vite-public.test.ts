import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { publicFiles } from '../src/plugins/vite-public.js';
import { cleanUp, makeProject } from './helpers/plugins.js';

afterEach(cleanUp);

it('returns no public copies when the public folder is absent', () => {
  const dir = makeProject({});
  expect(publicFiles(join(dir, 'missing'))).toEqual([]);
});

it('keeps every copied name through a linked root and aliases, while terminating cycles', () => {
  const dir = makeProject({ 'public/data.unknown': 'resource', 'shared/vendor.js': 'module' });
  const folder = join(dir, 'public');
  symlinkSync(folder, join(dir, 'linked'), 'junction');
  symlinkSync(folder, join(folder, 'cycle'), 'junction');
  for (const name of ['one', 'two']) symlinkSync(join(dir, 'shared'), join(folder, name), 'junction');
  expect(publicFiles(join(dir, 'linked')).sort()).toEqual(
    ['data.unknown', join('one', 'vendor.js'), join('two', 'vendor.js')].sort(),
  );
});

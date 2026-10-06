/** Differential checks of promised ordinary Twee/archive semantics, not intentional API extensions. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, decompileHTML } from '../dist/index.js';
const binary = process.env.TWEEGO_BINARY;
assert(binary, 'Set TWEEGO_BINARY to a verified Tweego binary; absent differential evidence is not a pass');
const root = mkdtempSync(join(tmpdir(), 'twee-differential-'));
const fixture =
  ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n:: StoryTitle\nDifferential Fixture\n:: Start [location]\nHello & < > Ω\n:: Next\n[[Start]]\n';
let cases = 0;
try {
  const path = join(root, 'story.tw');
  for (const newline of ['\n', '\r\n', '\r']) {
    writeFileSync(path, fixture.replaceAll('\n', newline));
    for (const [mode, flag] of [
      ['twine2-archive', '--archive-twine2'],
      ['twine1-archive', '--archive-twine1'],
    ]) {
      const reference = execFileSync(binary, [flag, path], { encoding: 'utf8', cwd: root });
      const result = await compile({ sources: [path], outputMode: mode });
      const semantic = (html) =>
        decompileHTML(html)
          .story.passages.filter((p) => ['Start', 'Next'].includes(p.name))
          .map((p) => ({ name: p.name, tags: p.tags, text: p.text }));
      assert.deepEqual(semantic(result.output), semantic(reference));
      cases++;
    }
  }
  console.log(
    JSON.stringify({
      status: 'pass',
      cases,
      version: spawnSync(binary, ['--version'], { encoding: 'utf8' }).stderr.trim(),
      limits: ['Two archive modes and ordinary passages; broader compatibility still needs open review.'],
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

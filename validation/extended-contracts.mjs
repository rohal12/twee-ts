/** Deterministic interaction corpus; failures print seed, variant, and public input. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compile, compileIncremental, decompileHTML } from '../dist/index.js';

const { values } = parseArgs({ options: { seed: { type: 'string', default: '236238' } } });
const seed = Number(values.seed);
assert(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'seed must be an unsigned 32-bit integer');
let randomState = seed;
const random = () => (randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const root = mkdtempSync(join(tmpdir(), 'twee-generated-'));
const modes = ['html', 'twee3', 'twee1', 'twine2-archive', 'twine1-archive', 'json'];
const oldCache = process.env.XDG_CACHE_HOME;
process.env.XDG_CACHE_HOME = join(root, 'cache');
let cases = 0;
try {
  const formatPath = join(root, 'format.js');
  writeFileSync(
    formatPath,
    `window.storyFormat(${JSON.stringify({ name: 'Generated', version: '1.0.0', source: '<!doctype html><html><head><title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>' })});`,
  );
  // Direct format URLs are not needed: local format lookup expects a named subdirectory.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, 'formats', 'generated-1'), { recursive: true });
  writeFileSync(join(root, 'formats', 'generated-1', 'format.js'), readFormat());
  function readFormat() {
    return `window.storyFormat(${JSON.stringify({ name: 'Generated', version: '1.0.0', source: '<html><head></head><body>{{STORY_DATA}}</body></html>' })});`;
  }
  for (let i = 0; i < 24; i++) {
    const text = `case_${i}_seed_${seed}: & < > " ' Ω ${Math.floor(random() * 100000)}`;
    const newline = ['\n', '\r\n', '\r'][i % 3];
    const first = `:: StoryData\n{"ifid":"${IFID}","format":"Generated","format-version":"1.0.0"}\n:: StoryTitle\nGenerated ${i}\n:: StorySettings\nobfuscate:rot13\n:: Start [old]\nold text\n:: Secret [Twine.private]\nsecret text\n`;
    const last = `:: StorySettings\njquery:on\n:: Start [alias]\n${text}\n:: Next\n[[Start]]\n`;
    const file = join(root, 'first.tw');
    writeFileSync(file, first.replaceAll('\n', newline));
    for (const mode of modes) {
      for (const sourceKind of ['inline', 'file']) {
        const options = {
          sources: [
            sourceKind === 'file' ? file : { filename: 'first.tw', content: first.replaceAll('\n', newline) },
            { filename: 'last.tw', content: last },
          ],
          outputMode: mode,
          tagAliases: { alias: 'location' },
          trim: i % 2 === 0,
          formatId: 'generated-1',
          formatPaths: [join(root, 'formats')],
          useTweegoPath: false,
          noRemote: true,
        };
        const cache = new Map();
        try {
          const cold = await compile(options);
          const incremental = await compileIncremental(options, cache);
          const warm = await compileIncremental(options, cache);
          // Twine 1 embeds minute timestamps, so compare semantic output rather than a clock race.
          const normalize = (output) => output.replace(/created="\d{12}"/g, 'created="<time>"');
          assert.equal(normalize(warm.output), normalize(cold.output));
          assert.equal(normalize(incremental.output), normalize(cold.output));
          assert.deepEqual(warm.diagnostics, cold.diagnostics);
          assert.equal(warm.story.twine1.settings.has('obfuscate'), false);
          assert.equal(warm.story.passages.find((p) => p.name === 'Start').text, text);
          assert.deepEqual(warm.story.passages.find((p) => p.name === 'Start').tags, ['alias', 'location']);
          if (['html', 'twine2-archive', 'twine1-archive'].includes(mode)) {
            const decoded = decompileHTML(cold.output);
            assert.equal(decoded.story.passages.find((p) => p.name === 'Start')?.text, text);
          }
          cases++;
        } catch (error) {
          throw new Error(
            `seed=${seed} i=${i} mode=${mode} source=${sourceKind} input=${JSON.stringify(last)}: ${error.message}`,
            { cause: error },
          );
        }
      }
    }
  }
} finally {
  if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = oldCache;
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ seed, cases, status: 'pass' }));

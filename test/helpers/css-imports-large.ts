/**
 * Reads a very large stylesheet with the `@import` scan, in a process of its own with a small heap, for
 * css-imports-large.test.ts: `node --import tsx --max-old-space-size=256 css-imports-large.ts <case>`. It prints `ok`
 * and the warnings it found when the scan finished; running out of memory kills the process instead.
 */
import { ineffectiveImportDiagnostics, joinWithLineFeeds } from '../../src/css-imports.js';

/** The size of the input, in characters: a tokenizer that kept its tokens would need gigabytes for it. */
const SIZE = 12_000_000;

/** The stylesheet sources of each case. */
const CASES: Readonly<Record<string, () => string[]>> = {
  semicolons: () => [';'.repeat(SIZE)],
  'layer names': () => [`@layer ${'a.'.repeat(SIZE / 2)}a;\n@import "a.css";`],
  'nested parentheses': () => ['('.repeat(SIZE)],
  'nested blocks': () => ['a{'.repeat(SIZE / 2)],
  imports: () => ['@import"a";'.repeat(SIZE / 11)],
  rules: () => ['a{}'.repeat(SIZE / 3)],
  'one identifier': () => ['a'.repeat(SIZE)],
  'one comment': () => [`/*${' '.repeat(SIZE)}`],
  'one url': () => [`url(${'a'.repeat(SIZE)}`],
  'two sources': () => [';'.repeat(SIZE / 2), `${';'.repeat(SIZE / 2)}@import "a.css";`],
};

const name = process.argv[2] ?? '';
const make = CASES[name];
if (make === undefined) throw new Error(`No case "${name}".`);
const texts = make();
const sources = texts.map((text, i) => ({ label: `source ${String(i)}`, text }));
const found = ineffectiveImportDiagnostics(sources, joinWithLineFeeds(sources));
console.log(`ok ${String(found.length)}`);

/**
 * The Error Handling table of docs/api.md gives the `code` of each failure the API throws (#448): each documented case
 * is thrown here, and the code it throws is the code of the table row that names it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, compileToFile, TweeTsError } from '../src/index.js';
import type { CompileOptions } from '../src/index.js';
import { codeSpans, REPO, tables } from './helpers/docs.js';
import { removeDir } from './helpers/remove-dir.js';

const API = readFileSync(join(REPO, 'docs', 'api.md'), 'utf8');
const SOURCE = ':: StoryTitle\nT\n\n:: Start\nHi\n';

/** The rows of the table under "Error Handling", by the `code` in its first cell. */
function documentedCodes(): ReadonlyMap<string, string> {
  const table = tables(API).find((t) => t.heading === 'Error Handling');
  if (table === undefined) throw new Error('docs/api.md: no table under "Error Handling"');
  return new Map(table.rows.map((row) => [codeSpans(row[0] ?? '')[0] ?? '', row[1] ?? '']));
}

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-docs-error-codes-'));
  // A Twine 1 format whose header asks for the engine's code, which the folder does not have.
  mkdirSync(join(dir, 'formats', 'no-code-1'), { recursive: true });
  writeFileSync(
    join(dir, 'formats', 'no-code-1', 'header.html'),
    '<html><body>"JONAH"<div id="storeArea">"STORY"</div></body></html>',
  );
  writeFileSync(join(dir, 'input.tw'), SOURCE);
});

afterAll(() => {
  removeDir(dir);
});

const inline = [{ filename: 'story.tw', content: SOURCE }];

/** Options for a build with the formats of `dir` only. */
const formats = (formatId: string): CompileOptions => ({
  sources: inline,
  formatId,
  formatPaths: [join(dir, 'formats')],
  useTweegoPath: false,
  noRemote: true,
});

interface Case {
  /** What fails. */
  readonly what: string;
  readonly run: () => Promise<unknown>;
  readonly code: string;
  /** Words the table row of that code uses for the failure. */
  readonly named: string;
}

const cases: readonly Case[] = [
  {
    what: 'an unknown outputMode',
    run: () => compile({ sources: inline, outputMode: 'pdf' as never }),
    code: 'INVALID_OPTIONS',
    named: '`outputMode`',
  },
  {
    what: 'a missing sources option',
    run: () => compile({} as never),
    code: 'INVALID_OPTIONS',
    named: 'missing, of the wrong type',
  },
  {
    what: 'no story format for HTML output',
    run: () => compile(formats('no-such-format')),
    code: 'BUILD_FAILED',
    named: 'No story format is available',
  },
  {
    what: 'a missing head file',
    run: () => compile({ ...formats('no-code-1'), headFile: join(dir, 'missing-head.html') }),
    code: 'INPUT_UNAVAILABLE',
    named: 'head file',
  },
  {
    what: 'an output that would overwrite an input',
    run: () => compileToFile({ sources: [join(dir, 'input.tw')], outFile: join(dir, 'input.tw') }),
    code: 'OUTPUT_IS_INPUT',
    named: 'overwrite an input',
  },
  {
    what: 'a Twine 1 format whose required file is missing',
    run: () => compile(formats('no-code-1')),
    code: 'FORMAT_UNAVAILABLE',
    named: 'Twine 1',
  },
];

describe('the Error Handling table of docs/api.md (#448)', () => {
  const documented = documentedCodes();

  it.each(cases)('gives $code for $what', async ({ run, code, named }) => {
    const error: unknown = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TweeTsError);
    expect((error as TweeTsError).code).toBe(code);
    expect(documented.get(code)).toContain(named);
    // No other row gives the failure.
    const others = [...documented].filter(([other]) => other !== code).map(([, when]) => when);
    expect(others.filter((when) => when.includes(named))).toEqual([]);
  });

  it('does not call a failure an ordinary error when the table gives it a code', () => {
    const ordinary = /^Other failures are ordinary errors:.*$/m.exec(API)?.[0];
    expect(ordinary).toBeDefined();
    expect(ordinary).not.toContain('Twine 1');
  });
});

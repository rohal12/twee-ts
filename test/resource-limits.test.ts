/**
 * Input sizes that reach the engine's limits: no step may exhaust the call stack because of how much input there is
 * (#396), HTML is read in time linear in its size, up to a nesting limit (#381), and a limit of the engine that a
 * build reaches is named rather than reported with the engine's own message (#390).
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fc from 'fast-check';
import { defaultTreeAdapter, parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, compileToFile, resourceLimitError, TweeTsError } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';
import { MAX_HTML_DEPTH, parseHtml } from '../src/html-structure.js';
import { decodeFormatJSON } from '../src/format-decode.js';
import { MAX_STRING_LENGTH } from '../src/util.js';
import type { OutputMode } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'twee-ts-limits-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A story with `count` passages, each with metadata that gives one warning (`position` is not a string). */
function manyWarnings(count: number): string {
  const passages = Array.from({ length: count }, (_, i) => `:: P${String(i)} {"position":5}\nx\n`);
  return ':: StoryTitle\nBig\n\n:: Start\nGo.\n\n' + passages.join('\n');
}

describe('diagnostics of very large inputs (#396)', () => {
  const count = 150_000;
  const source = { filename: 'big.tw', content: manyWarnings(count) };

  it.each<OutputMode>(['twee3', 'twee1', 'json', 'twine2-archive', 'twine1-archive'])(
    'collects one warning per passage for %s output',
    { timeout: 120_000 },
    async (outputMode) => {
      const result = await compile({ sources: [source], outputMode });
      const warnings = result.diagnostics.filter((d) => d.level === 'warning' && d.message.includes('position'));
      expect(warnings.length).toBeGreaterThanOrEqual(count);
    },
  );
});

/** Ways to nest elements, each opener making one element deeper (or one in template content). */
const NESTINGS: readonly (readonly [string, string])[] = [
  ['div', '<div>'],
  ['list items', '<ul><li>'],
  ['templates', '<template>'],
  ['tables', '<table><tr><td>'],
  ['formatting elements', '<b>'],
  ['SVG', '<svg><g>'],
  ['MathML', '<math><mrow>'],
];

const TOO_DEEP = `HTML nests more than ${String(MAX_HTML_DEPTH)} elements deep.`;

type Parse5Node = DefaultTreeAdapterTypes.Node;

/** The most elements on a path from the root down (template contents count as children of their template). */
function maxElementDepth(root: Parse5Node): number {
  let deepest = 0;
  const stack: { node: Parse5Node; depth: number }[] = [{ node: root, depth: 0 }];
  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    const { node } = visit;
    const depth = visit.depth + ('tagName' in node ? 1 : 0);
    deepest = Math.max(deepest, depth);
    for (const child of 'childNodes' in node ? node.childNodes : []) stack.push({ node: child, depth });
    if ('content' in node) stack.push({ node: node.content, depth });
  }
  return deepest;
}

/**
 * The deepest any element lies while parse5 builds the tree of `html`, or in the finished tree: the parser moves
 * nodes (the adoption agency algorithm), so an element can be nested deeper when it is inserted than it ends up.
 * Every depth is counted by walking up to the root.
 */
function deepestEver(html: string): number {
  const templateOf = new Map<Parse5Node, Parse5Node>();
  let deepest = 0;
  const record = (node: Parse5Node): void => {
    let depth = 0;
    for (
      let at: Parse5Node | null | undefined = node;
      at;
      at = 'parentNode' in at ? at.parentNode : templateOf.get(at)
    ) {
      if ('tagName' in at) depth += 1;
    }
    deepest = Math.max(deepest, depth);
  };
  const treeAdapter: typeof defaultTreeAdapter = {
    ...defaultTreeAdapter,
    appendChild(parent, child) {
      defaultTreeAdapter.appendChild(parent, child);
      record(child);
    },
    insertBefore(parent, child, reference) {
      defaultTreeAdapter.insertBefore(parent, child, reference);
      record(child);
    },
    setTemplateContent(template, content) {
      templateOf.set(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
  };
  // Parsed first: `deepest` is what the parse leaves.
  const finished = maxElementDepth(parse(html, { scriptingEnabled: true, treeAdapter }));
  return Math.max(deepest, finished);
}

describe('HTML nesting (#381)', () => {
  it.each(NESTINGS)('rejects %s nested 100,000 deep at once', (_name, opener) => {
    const started = performance.now();
    expect(() => decompileHTML(opener.repeat(100_000))).toThrow(new TweeTsError(TOO_DEEP));
    // Reading up to the limit is a fraction of a second; reading all of it took up to a minute.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('reads elements nested as deep as the limit, and no deeper', () => {
    // `html` and `body` are the first two levels.
    expect(() => parseHtml('<div>'.repeat(MAX_HTML_DEPTH - 2))).not.toThrow();
    expect(() => parseHtml('<div>'.repeat(MAX_HTML_DEPTH - 1))).toThrow(TOO_DEEP);
    // Template contents count as children of their template.
    expect(() => parseHtml('<template>'.repeat(MAX_HTML_DEPTH - 2))).not.toThrow();
    expect(() => parseHtml('<template>'.repeat(MAX_HTML_DEPTH - 1))).toThrow(TOO_DEEP);
  });

  // Misnested formatting elements, tables and templates make the parser move nodes (the adoption agency algorithm,
  // foster parenting), which changes the depth of what lies below them.
  it(
    'rejects exactly the markup whose elements nest too deep, however the parser moves them',
    { timeout: 60_000 },
    () => {
      const tokens = [
        '<b>',
        '</b>',
        '<i>',
        '</i>',
        '<a>',
        '</a>',
        '<nobr>',
        '<div>',
        '</div>',
        '<p>',
        '</p>',
        '<table>',
        '<tr>',
        '<td>',
        '</table>',
        '<template>',
        '</template>',
        '<li>',
        '<ul>',
        '<svg>',
        '</svg>',
        '<select>',
        '<option>',
        'x',
      ];
      // Runs of one token, so that elements nest deep enough to reach the limit.
      const markup = fc
        .array(fc.tuple(fc.constantFrom(...tokens), fc.integer({ min: 1, max: 300 })), { maxLength: 30, size: 'max' })
        .map((runs) => runs.map(([token, count]) => token.repeat(count)).join(''));
      let deepRuns = 0;
      fc.assert(
        fc.property(markup, (html) => {
          const deepest = deepestEver(html);
          if (deepest > MAX_HTML_DEPTH) deepRuns += 1;
          let rejected = false;
          try {
            parseHtml(html, false);
          } catch (e) {
            if (!(e instanceof TweeTsError) || e.message !== TOO_DEEP) throw e;
            rejected = true;
          }
          // Markup never deeper than the limit is read, and markup deeper than it at any time rejected.
          expect({ deepest, rejected }).toEqual({ deepest, rejected: deepest > MAX_HTML_DEPTH });
        }),
        { numRuns: 100 },
      );
      // The generator reaches the limit often enough to test it.
      expect(deepRuns).toBeGreaterThan(10);
    },
  );

  it('reads many elements nested near the limit in time linear in the size', { timeout: 60_000 }, () => {
    const block = '<div>'.repeat(MAX_HTML_DEPTH - 10) + 'x' + '</div>'.repeat(MAX_HTML_DEPTH - 10);
    const time = (blocks: number): number => {
      const started = performance.now();
      parseHtml(block.repeat(blocks), false);
      return performance.now() - started;
    };
    time(10);
    // Four times the blocks take about four times as long: the depth checks cost no more as the document grows.
    expect(time(80)).toBeLessThan(time(20) * 8 + 200);
  });

  it('reports a source nested too deeply as a load error', async () => {
    const path = join(dir, 'deep.html');
    writeFileSync(path, '<div>'.repeat(100_000));
    const result = await compile({ sources: [path], outputMode: 'json' });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'error', message: expect.stringContaining(TOO_DEEP) }),
    );
  });

  it('rejects a head file whose content nests too deeply, as the head insertion reads it', async () => {
    const headFile = join(dir, 'deep-head.html');
    writeFileSync(headFile, '<div>'.repeat(100_000));
    const started = performance.now();
    await expect(
      compile({
        sources: [{ filename: 'a.tw', content: ':: StoryTitle\nT\n\n:: Start\nx\n' }],
        formatId: 'test-format-1',
        formatPaths: [fileURLToPath(new URL('./fixtures/storyformats', import.meta.url))],
        noRemote: true,
        useTweegoPath: false,
        headFile,
      }),
    ).rejects.toThrow(TOO_DEEP);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('takes an output nested too deeply for an authored file, not a build twee-ts made', async () => {
    const folder = mkdtempSync(join(dir, 'story-'));
    writeFileSync(join(folder, 'Start.tw'), ':: StoryTitle\nS\n\n:: Start\nx\n');
    const output = join(folder, 'story.html');
    writeFileSync(output, '<div>'.repeat(100_000));
    await expect(compileToFile({ sources: [folder], outFile: output })).rejects.toMatchObject({
      code: 'OUTPUT_IS_INPUT',
    });
  });
});

describe('limits of the engine (#390)', () => {
  it('names nesting too deep for the JavaScript parser in a format.js', () => {
    expect(decodeFormatJSON(`${'['.repeat(100_000)}window.storyFormat({})`)).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /^The story format file nests too deeply to read \(the JavaScript parser ran out of stack space\) at line 1, column \d+\.$/,
      ),
    });
  });

  it.each([
    ['a text source', 'huge.twee', MAX_STRING_LENGTH + 1],
    ['a media source, read as base64', 'huge.png', Math.floor(MAX_STRING_LENGTH / 4) * 3 + 1],
  ])('rejects %s too large to hold as a string before reading it', async (_name, filename, size) => {
    const path = join(dir, filename);
    // Sparse: no data is written.
    writeFileSync(path, '');
    truncateSync(path, size);
    const result = await compile({ sources: [path], outputMode: 'json' });
    const errors = result.diagnostics.filter((d) => d.level === 'error').map((d) => d.message);
    expect(errors).toContainEqual(
      expect.stringMatching(new RegExp(`^load .*${filename}: File size \\(${String(size)} bytes\\) is greater than`)),
    );
    expect(errors.join('\n')).not.toMatch(/Invalid string length/);
  });

  it.each([
    ['Invalid string length', /longer than a string can be/],
    ['Maximum call stack size exceeded', /ran out of call stack space/],
    ['Invalid array length', /longer than an array can be/],
  ])('names the engine error %s', (message, expected) => {
    const cause = new RangeError(message);
    const error = resourceLimitError(cause);
    expect(error).toBeInstanceOf(TweeTsError);
    expect(error?.message).toMatch(/^The build stopped at a limit of the JavaScript engine: /);
    expect(error?.message).toMatch(expected);
    expect(error?.cause).toBe(cause);
  });

  it('leaves other errors alone', () => {
    expect(resourceLimitError(new RangeError('A timeout must be 0 or more'))).toBeUndefined();
    expect(resourceLimitError(new Error('Invalid string length'))).toBeUndefined();
    expect(resourceLimitError('Invalid string length')).toBeUndefined();
  });

  it('reports an engine limit a build reaches as a TweeTsError', async () => {
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
    try {
      await expect(
        compile({ sources: [{ filename: 'a.tw', content: ':: Start\nx\n' }], outputMode: 'json' }),
      ).rejects.toThrow(/^The build stopped at a limit of the JavaScript engine: a text it builds would be longer/);
    } finally {
      stringify.mockRestore();
    }
  });
});

/**
 * Where the IFID comment goes (#377). It precedes the story data, as Tweego writes it, but never becomes a child node
 * of an element of the template's own that holds the story data: SugarCube 1 reads the first child node of its store
 * area (`<div id="store-area" hidden>{{STORY_DATA}}</div>`) as the `tw-storydata` element, so there the comment goes
 * before the store area, as Tweego places it before a Twine 1 store area.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { compile } from '../src/compiler.js';

type Node = DefaultTreeAdapterTypes.ChildNode | DefaultTreeAdapterTypes.Document;

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const COMMENT = `<!-- UUID://${IFID}// -->`;
const SOURCE = `:: StoryTitle\nT\n\n:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start\nHello\n`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-ifid-comment-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function build(template: string): Promise<string> {
  const id = `custom-${String(Math.random()).slice(2)}`;
  mkdirSync(join(dir, id));
  const format = { name: 'Custom', version: '1.0.0', source: template };
  writeFileSync(join(dir, id, 'format.js'), `window.storyFormat(${JSON.stringify(format)});`);
  const result = await compile({
    sources: [{ filename: 'story.tw', content: SOURCE }],
    formatId: id,
    formatPaths: [dir],
    useTweegoPath: false,
    noRemote: true,
  });
  expect(result.diagnostics).toEqual([]);
  return result.output;
}

function find(node: Node, matches: (n: Node) => boolean): Node | undefined {
  if (matches(node)) return node;
  for (const child of 'childNodes' in node ? node.childNodes : []) {
    const found = find(child, matches);
    if (found) return found;
  }
  return undefined;
}

const isStoryData = (n: Node): boolean => n.nodeName === 'tw-storydata';
const isIFIDComment = (n: Node): boolean => n.nodeName === '#comment' && 'data' in n && n.data === ` UUID://${IFID}// `;

/** The story data's parent's child nodes, by name, and the node that follows the IFID comment. */
function placement(output: string): { siblings: string[]; afterComment: string | undefined } {
  const doc = parse(output);
  const data = find(doc, isStoryData);
  const parent = data && 'parentNode' in data ? data.parentNode : null;
  const comment = find(doc, isIFIDComment);
  const commentParent = comment && 'parentNode' in comment ? comment.parentNode : null;
  const after = commentParent?.childNodes[commentParent.childNodes.findIndex((n) => n === comment) + 1];
  const describe = (n: Node): string =>
    'attrs' in n ? `${n.nodeName}#${n.attrs.find((a) => a.name === 'id')?.value ?? ''}` : n.nodeName;
  return { siblings: parent ? parent.childNodes.map(describe) : [], afterComment: after && describe(after) };
}

describe('the IFID comment', () => {
  it.each([
    ['in body', '<html><body>{{STORY_DATA}}</body></html>', ['#comment', 'tw-storydata#'], 'tw-storydata#'],
    [
      'in body, after other content',
      '<html><body><div id="main"></div>\n{{STORY_DATA}}\n</body></html>',
      ['div#main', '#text', '#comment', 'tw-storydata#', '#text'],
      'tw-storydata#',
    ],
    [
      "in SugarCube 1's store area",
      '<html><body><div id="store-area" hidden>{{STORY_DATA}}</div></body></html>',
      ['tw-storydata#'],
      'div#store-area',
    ],
    [
      'in a nested element',
      '<html><body><main><div id="data">\n{{STORY_DATA}}</div></main></body></html>',
      ['#text', 'tw-storydata#'],
      'div#data',
    ],
    // Written first, the comment is the document's, before the html element the parser creates.
    ['with no body tags', '{{STORY_DATA}}', ['tw-storydata#'], 'html#'],
  ])('%s', async (_, template, siblings, afterComment) => {
    const output = await build(template);
    expect(output.split(COMMENT)).toHaveLength(2);
    expect(placement(output)).toEqual({ siblings, afterComment });
  });

  it('keeps the story data the first child node of the store area SugarCube 1 reads', async () => {
    const output = await build(
      '<!DOCTYPE html><html><head><title>{{STORY_NAME}}</title></head><body>' +
        '<div id="store-area" hidden>{{STORY_DATA}}</div><script>var s = document.getElementById("store-area");</script>' +
        '</body></html>',
    );
    const doc = parse(output);
    const storeArea = find(
      doc,
      (n) => 'attrs' in n && n.attrs.some((a) => a.name === 'id' && a.value === 'store-area'),
    );
    const first = storeArea && 'childNodes' in storeArea ? storeArea.childNodes[0] : undefined;
    expect(first?.nodeName).toBe('tw-storydata');
    expect(output).toContain(`${COMMENT}<div id="store-area" hidden><tw-storydata `);
  });
});

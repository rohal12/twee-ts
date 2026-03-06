/**
 * Twine HTML decompiler: parse compiled Twine 2 or Twine 1 HTML back into a Story model.
 * Ported from storyload.go:loadHTML().
 */
import { parseDocument } from 'htmlparser2';
import type { Passage, PassageMetadata, Diagnostic, IFID } from './types.js';
import { createStory, storyAdd, storyPrepend, marshalStoryData } from './story.js';
import { tiddlerUnescape } from './escape.js';

export interface DecompileResult {
  story: import('./types.js').Story;
  diagnostics: Diagnostic[];
}

// Structural types matching domhandler's API (avoids direct import of domhandler).
interface HtmlNode {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
  data?: string;
}

/**
 * Parse a Twine 2 or Twine 1 compiled HTML file back into a Story model.
 */
export function decompileHTML(html: string): DecompileResult {
  const diagnostics: Diagnostic[] = [];
  const story = createStory();

  const doc = parseDocument(html) as unknown as HtmlNode;

  // Try Twine 2 first (<tw-storydata>), then Twine 1 (<div id="store-area"> or <div id="storeArea">).
  const twine2Data = findElement(doc, 'tw-storydata');
  if (twine2Data) {
    decompileTwine2(twine2Data, story, diagnostics);
    return { story, diagnostics };
  }

  const twine1Data = findElementByIdPattern(doc, /^store(?:-a|A)rea$/);
  if (twine1Data) {
    decompileTwine1(twine1Data, story, diagnostics);
    return { story, diagnostics };
  }

  diagnostics.push({ level: 'error', message: 'Malformed HTML source; story data not found.' });
  return { story, diagnostics };
}

function decompileTwine2(storyData: HtmlNode, story: import('./types.js').Story, diagnostics: Diagnostic[]): void {
  // Parse tw-storydata attributes.
  let startnode = 0;
  const attrs = storyData.attribs ?? {};

  if (attrs['name']) story.name = attrs['name'];
  if (attrs['startnode']) {
    const parsed = parseInt(attrs['startnode'], 10);
    if (Number.isNaN(parsed)) {
      diagnostics.push({
        level: 'warning',
        message: `Cannot parse "tw-storydata" content attribute "startnode" as an integer; value "${attrs['startnode']}".`,
      });
    } else {
      startnode = parsed;
    }
  }
  if (attrs['ifid']) story.ifid = attrs['ifid'].toUpperCase() as IFID;
  if (attrs['zoom']) {
    const parsed = parseFloat(attrs['zoom']);
    if (Number.isNaN(parsed)) {
      diagnostics.push({
        level: 'warning',
        message: `Cannot parse "tw-storydata" content attribute "zoom" as a float; value "${attrs['zoom']}".`,
      });
    } else {
      story.twine2.zoom = parsed;
    }
  }
  if (attrs['format']) story.twine2.format = attrs['format'];
  if (attrs['format-version']) story.twine2.formatVersion = attrs['format-version'];
  if (attrs['options']) {
    for (const opt of attrs['options'].split(/\s+/).filter((s: string) => s.length > 0)) {
      story.twine2.options.set(opt, true);
    }
  }

  // Process child elements.
  // htmlparser2 uses type 'style'/'script' for those elements instead of 'tag'.
  for (const node of storyData.children ?? []) {
    if (node.type !== 'tag' && node.type !== 'style' && node.type !== 'script') continue;

    switch (node.name) {
      case 'style':
      case 'script': {
        const text = getTextContent(node).trim();
        if (text.length === 0) continue;
        const name = node.name === 'style' ? 'Story Stylesheet' : 'Story JavaScript';
        const tags = node.name === 'style' ? ['stylesheet'] : ['script'];
        storyAdd(story, { name, tags, text }, diagnostics);
        break;
      }

      case 'tw-tag': {
        const tagAttrs = node.attribs ?? {};
        const tagName = tagAttrs['name'] ?? '';
        const tagColor = tagAttrs['color'] ?? '';
        if (tagName) story.twine2.tagColors.set(tagName, tagColor);
        break;
      }

      case 'tw-passagedata': {
        let pid = 0;
        const pAttrs = node.attribs ?? {};
        const name = pAttrs['name'] ?? '';
        const tags = pAttrs['tags'] ? pAttrs['tags'].split(/\s+/).filter((s: string) => s.length > 0) : [];
        const metadata: PassageMetadata = {};

        if (pAttrs['pid']) {
          const parsed = parseInt(pAttrs['pid'], 10);
          if (Number.isNaN(parsed)) {
            diagnostics.push({
              level: 'warning',
              message: `Cannot parse "tw-passagedata" content attribute "pid" as an integer; value "${pAttrs['pid']}".`,
            });
          } else {
            pid = parsed;
          }
        }

        if (pAttrs['position']) metadata.position = pAttrs['position'];
        if (pAttrs['size']) metadata.size = pAttrs['size'];

        if (pid === startnode && pid !== 0) {
          story.twine2.start = name;
        }

        const text = getTextContent(node).trim();
        const passage: Passage = { name, tags, text };
        if (metadata.position || metadata.size) {
          passage.metadata = metadata;
        }
        storyAdd(story, passage, diagnostics);
        break;
      }
    }
  }

  // Prepend StoryData passage with serialized metadata.
  storyPrepend(story, { name: 'StoryData', tags: [], text: marshalStoryData(story) }, diagnostics);
}

function decompileTwine1(storeArea: HtmlNode, story: import('./types.js').Story, diagnostics: Diagnostic[]): void {
  for (const node of storeArea.children ?? []) {
    if (node.type !== 'tag' || node.name !== 'div') continue;
    const nodeAttrs = node.attribs ?? {};
    if (!('tiddler' in nodeAttrs)) continue;

    const name = nodeAttrs['tiddler'] ?? '';
    const tags = nodeAttrs['tags'] ? nodeAttrs['tags'].split(/\s+/).filter((s: string) => s.length > 0) : [];
    const metadata: PassageMetadata = {};

    if (nodeAttrs['twine-position']) metadata.position = nodeAttrs['twine-position'];

    const rawContent = getTextContent(node);
    const text = tiddlerUnescape(rawContent).trim();

    const passage: Passage = { name, tags, text };
    if (metadata.position) {
      passage.metadata = metadata;
    }
    storyAdd(story, passage, diagnostics);
  }
}

function findElement(node: HtmlNode, tagName: string): HtmlNode | undefined {
  if (node.type === 'tag' && node.name === tagName) return node;
  for (const child of node.children ?? []) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function findElementByIdPattern(node: HtmlNode, idPattern: RegExp): HtmlNode | undefined {
  if (node.type === 'tag' && node.attribs?.['id'] && idPattern.test(node.attribs['id'])) return node;
  for (const child of node.children ?? []) {
    const found = findElementByIdPattern(child, idPattern);
    if (found) return found;
  }
  return undefined;
}

function getTextContent(el: HtmlNode): string {
  let text = '';
  for (const child of el.children ?? []) {
    if (child.type === 'text' && child.data) {
      text += child.data;
    }
  }
  return text;
}

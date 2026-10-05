/**
 * Twine HTML decompiler: parse compiled Twine 2 or Twine 1 HTML back into a Story model.
 * Ported from storyload.go:loadHTML().
 */
import { parseDocument } from 'htmlparser2';
import type { Passage, PassageMetadata, Diagnostic, DecompileOptions } from './types.js';
import { createStory, storyAdd, storyPrepend, marshalStoryData, unmarshalStorySettings } from './story.js';
import { rot13, tiddlerUnescape } from './escape.js';
import { normalizeIFID } from './ifid.js';

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
 * Tweego always trims passage text; here `trim: false` keeps it exactly, as for Twee sources.
 */
export function decompileHTML(html: string, options: DecompileOptions = {}): DecompileResult {
  const diagnostics: Diagnostic[] = [];
  const story = createStory();
  const passageText = options.trim === false ? (text: string) => text : (text: string) => text.trim();

  const doc = parseDocument(html) as unknown as HtmlNode;

  // Try Twine 2 first (<tw-storydata>), then Twine 1 (<div id="store-area"> or <div id="storeArea">).
  const twine2Data = findElement(doc, 'tw-storydata');
  if (twine2Data) {
    decompileTwine2(twine2Data, story, passageText, diagnostics);
    return { story, diagnostics };
  }

  const twine1Data = findElementByIdPattern(doc, /^store(?:-a|A)rea$/);
  if (twine1Data) {
    decompileTwine1(twine1Data, story, passageText, diagnostics);
    return { story, diagnostics };
  }

  diagnostics.push({ level: 'error', message: 'Malformed HTML source; story data not found.' });
  return { story, diagnostics };
}

/** Turns stored passage text into passage text: trimmed at both ends, or kept as is. */
type PassageText = (text: string) => string;

function decompileTwine2(
  storyData: HtmlNode,
  story: import('./types.js').Story,
  passageText: PassageText,
  diagnostics: Diagnostic[],
): void {
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
  if (attrs['ifid']) story.ifid = normalizeIFID(attrs['ifid']);
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
  if (attrs['tags']) story.twine2.tags = attrs['tags'];
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
        const content = getTextContent(node);
        // Whitespace alone is no stylesheet or script, whether or not the text is trimmed.
        if (content.trim().length === 0) continue;
        const text = passageText(content);
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

        const text = passageText(getTextContent(node));
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

function decompileTwine1(
  storeArea: HtmlNode,
  story: import('./types.js').Story,
  passageText: PassageText,
  diagnostics: Diagnostic[],
): void {
  const passages = (storeArea.children ?? []).filter(isTiddler).map((node) => tiddlerToPassage(node, passageText));

  // The Twine 1 writer ROT13-encodes every tiddler but StorySettings when StorySettings says
  // `obfuscate:rot13`, so read the settings before adding (and so interpreting) anything else.
  const obfuscated = isRot13Obfuscated(passages);
  for (const p of passages) {
    const passage = obfuscated && p.name !== 'StorySettings' ? { ...p, text: rot13(p.text) } : p;
    storyAdd(story, passage, diagnostics);
  }
}

function isTiddler(node: HtmlNode): boolean {
  return node.type === 'tag' && node.name === 'div' && node.attribs !== undefined && 'tiddler' in node.attribs;
}

function tiddlerToPassage(node: HtmlNode, passageText: PassageText): Passage {
  const nodeAttrs = node.attribs ?? {};
  const name = nodeAttrs['tiddler'] ?? '';
  const tags = nodeAttrs['tags'] ? nodeAttrs['tags'].split(/\s+/).filter((s: string) => s.length > 0) : [];
  const text = passageText(tiddlerUnescape(getTextContent(node)));

  const passage: Passage = { name, tags, text };
  const position = nodeAttrs['twine-position'];
  if (position) {
    passage.metadata = { position };
  }
  return passage;
}

/** Whether the StorySettings tiddlers turn on ROT13 obfuscation, read the way the writer reads them. */
function isRot13Obfuscated(passages: readonly Passage[]): boolean {
  const settings = createStory();
  for (const p of passages) {
    // Diagnostics are dropped here; storyAdd() reports them when the passage is added.
    if (p.name === 'StorySettings') unmarshalStorySettings(settings, p.text, []);
  }
  return settings.twine1.settings.get('obfuscate') === 'rot13';
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

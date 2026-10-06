/**
 * Module/head injection into <head>.
 * Ported from module.go + io.go:modifyHead(). The renderers inject through `placeHead()` while filling the
 * format template, so the closing head tag is looked for in the template only, never in inserted story data.
 */
import type { Diagnostic } from './types.js';
import { normalizedFileExt, mediaTypeFromExt, fontFormatHint, slugify } from './media-types.js';
import { readUTF8, readBase64, fileStem } from './util.js';
import { cssStringEscape, scriptContentEscape, styleContentEscape } from './escape.js';
import { fillTemplate } from './template.js';
import type { TemplateSlot } from './template.js';

/**
 * Load modules and return HTML tags to inject before the closing head tag. `diagnostics` receives a warning for
 * each module that is not valid UTF-8 (it is read as Windows-1252).
 */
export function loadModules(filenames: string[], diagnostics?: Diagnostic[]): string {
  const processed = new Set<string>();
  const headTags: string[] = [];

  for (const filename of filenames) {
    if (processed.has(filename)) continue;

    const ext = normalizedFileExt(filename);
    let tag: string | null = null;

    switch (ext) {
      case 'css':
        tag = loadModuleTagged('style', filename, diagnostics);
        break;
      case 'js':
        tag = loadModuleTagged('script', filename, diagnostics);
        break;
      case 'otf':
      case 'ttf':
      case 'woff':
      case 'woff2':
        tag = loadModuleFont(filename);
        break;
      default:
        continue;
    }

    if (tag) headTags.push(tag);
    processed.add(filename);
  }

  return headTags.join('\n');
}

function loadModuleTagged(tag: 'script' | 'style', filename: string, diagnostics?: Diagnostic[]): string | null {
  const source = readUTF8(filename, diagnostics).trim();
  if (source.length === 0) return null;

  const family = fileStem(filename);
  const idSlug = `${tag}-module-${slugify(family)}`;
  const mimeType = tag === 'script' ? 'text/javascript' : 'text/css';
  const content = tag === 'script' ? scriptContentEscape(source) : styleContentEscape(source);

  return `<${tag} id="${idSlug}" type="${mimeType}">${content}</${tag}>`;
}

function loadModuleFont(filename: string): string | null {
  const source = readBase64(filename);
  const family = fileStem(filename);
  const idSlug = `style-module-${slugify(family)}`;
  const ext = normalizedFileExt(filename);
  const mediaType = mediaTypeFromExt(ext);
  const hint = fontFormatHint(ext);

  return `<style id="${idSlug}" type="text/css">@font-face {\n\tfont-family: "${cssStringEscape(family)}";\n\tsrc: url("data:${mediaType};base64,${source}") format("${hint}");\n}</style>`;
}

/**
 * Load the module tags and head file content to inject into the head (see `placeHead()`), joined by newlines,
 * or `''` when there is nothing to inject.
 */
export function loadHeadContent(modulePaths: string[], headFile?: string, diagnostics?: Diagnostic[]): string {
  const parts: string[] = [];

  if (modulePaths.length > 0) {
    const modules = loadModules(modulePaths, diagnostics).trim();
    if (modules.length > 0) parts.push(modules);
  }

  if (headFile) {
    try {
      const source = readUTF8(headFile, diagnostics).trim();
      if (source.length > 0) parts.push(source);
    } catch (e) {
      diagnostics?.push({
        level: 'warning',
        message: `Failed to read head file "${headFile}": ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return parts.join('\n');
}

/** Where the head content goes in a template, and the warning when that is not before a closing head tag. */
export interface HeadPlacement {
  /** The template slot that inserts the content, or `undefined` when there is nothing to insert or nowhere to. */
  readonly slot: TemplateSlot | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Place `content` in a template, given the texts that `fillTemplateParts()` scans for the slot (the template, and
 * the footer of a pre-1.4 Twine 1 format):
 *
 * - on its own line before the first closing head tag, as Tweego does; the tag may use any letter case and
 *   whitespace before its `>`, and is kept as written;
 * - in a template with no closing head tag (HTML lets a document leave it out), on its own line before the first
 *   body start tag, where the HTML parser still puts it in the head, with a warning (Tweego drops it);
 * - in a template with neither, nowhere, with a warning.
 *
 * `owner` names the template in the warnings. Empty `content` needs no slot and gets no warning.
 */
export function placeHead(content: string, texts: readonly string[], owner: string): HeadPlacement {
  if (content.length === 0) return { slot: undefined, diagnostics: [] };
  const scans = texts.map((text) => ({ text, tags: scanHeadTags(text) }));
  if (scans.some(({ tags }) => tags.closingHead !== undefined)) {
    return { slot: beforeTag(CLOSING_HEAD_PREFIX, 'closingHead', content), diagnostics: [] };
  }
  if (scans.some(({ tags }) => tags.bodyStart !== undefined)) {
    const message = `${owner} has no closing head tag; the modules and head file were injected before its body start tag.`;
    return { slot: beforeTag(BODY_START_PREFIX, 'bodyStart', content), diagnostics: [{ level: 'warning', message }] };
  }
  const message = `${owner} has no closing head tag and no body start tag; the modules and head file were not injected.`;
  return { slot: undefined, diagnostics: [{ level: 'warning', message }] };
}

/** `</head` in any letter case, followed by whitespace, `/` or `>`; the rest of the tag is left alone. */
const CLOSING_HEAD_PREFIX = '<\\/[Hh][Ee][Aa][Dd](?=[\\t\\n\\f\\r />])';
/** `<body` in any letter case, followed by whitespace, `/` or `>` (so not `<bodyx>`). */
const BODY_START_PREFIX = '<[Bb][Oo][Dd][Yy](?=[\\t\\n\\f\\r />])';

/** The offsets of the first real closing head tag, body start tag and head start tag end in an HTML text. */
interface HeadTags {
  readonly closingHead: number | undefined;
  readonly bodyStart: number | undefined;
}

/** Elements whose content is text, so a tag written there is not a tag. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title']);

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isLetter = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z]$/.test(c);

/**
 * Find the first closing head tag and body start tag that HTML would read as tags: not those in a comment, in
 * the text of a script, style, textarea or title element, or in a quoted attribute value. A small scanner, not
 * a full HTML tokenizer; it needs no more than the tags and where they end.
 */
export function scanHeadTags(html: string): HeadTags {
  const { closingHead, bodyStart } = scanTags(html);
  return { closingHead, bodyStart };
}

/**
 * The offset just after the first real head start tag, where content goes to come first in the head; found like
 * the tags of `scanHeadTags()`, so not one in a comment, a script or an attribute value. `undefined` without one.
 */
export function findHeadStartEnd(html: string): number | undefined {
  return scanTags(html).headStartEnd;
}

function scanTags(html: string): HeadTags & { readonly headStartEnd: number | undefined } {
  let closingHead: number | undefined;
  let bodyStart: number | undefined;
  let headStartEnd: number | undefined;
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html[lt + 1];
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
    } else if (next === '!' || next === '?') {
      // A doctype, CDATA section or processing instruction ends at the first `>`.
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
    } else if (next === '/' && isLetter(html[lt + 2])) {
      const { name, end } = readTag(html, lt + 2);
      if (name === 'head' && closingHead === undefined) closingHead = lt;
      i = end;
    } else if (isLetter(next)) {
      const { name, end } = readTag(html, lt + 1);
      if (name === 'body' && bodyStart === undefined) bodyStart = lt;
      if (name === 'head' && headStartEnd === undefined) headStartEnd = end;
      i = RAW_TEXT_ELEMENTS.has(name) ? rawTextEnd(html, name, end) : end;
    } else {
      i = lt + 1;
    }
    if (closingHead !== undefined && bodyStart !== undefined) break;
  }

  return { closingHead, bodyStart, headStartEnd };
}

/** Read a tag whose name starts at `from`: its lowercase name, and the offset after its `>` (or the end). */
function readTag(html: string, from: number): { name: string; end: number } {
  let i = from;
  while (i < html.length && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>') i++;
  const name = html.slice(from, i).toLowerCase();
  // Attributes: a value after `=` may be quoted, and may then hold a `>`.
  while (i < html.length && html[i] !== '>') {
    if (html[i] !== '=') {
      i++;
      continue;
    }
    i++;
    while (isSpace(html[i])) i++;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      i = close === -1 ? html.length : close + 1;
    }
  }
  return { name, end: Math.min(i + 1, html.length) };
}

/** The offset of the end tag that closes a raw text element, given where its text starts (or the end). */
function rawTextEnd(html: string, name: string, from: number): number {
  const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
  close.lastIndex = from;
  return close.exec(html)?.index ?? html.length;
}

/**
 * The slot that inserts `content` on its own line before the first real tag of the kind `which` names (see
 * `scanHeadTags()`), which is kept as written. A look-alike inside a script or comment is left alone.
 */
function beforeTag(pattern: string, which: 'closingHead' | 'bodyStart', content: string): TemplateSlot {
  const cache = new Map<string, number | undefined>();
  const offsetIn = (text: string): number | undefined => {
    if (!cache.has(text)) cache.set(text, scanHeadTags(text)[which]);
    return cache.get(text);
  };
  return {
    pattern,
    occurrences: 'first',
    replacement: (match) => `${content}\n${match}`,
    accepts: (text, offset) => offsetIn(text) === offset,
  };
}

/**
 * Inject modules and head file content into `html` the way the renderers inject it into a format template (see
 * `placeHead()`), adding any warning to `diagnostics`.
 */
export function modifyHead(html: string, modulePaths: string[], headFile?: string, diagnostics?: Diagnostic[]): string {
  const placement = placeHead(loadHeadContent(modulePaths, headFile, diagnostics), [html], 'The HTML');
  diagnostics?.push(...placement.diagnostics);
  return placement.slot === undefined ? html : fillTemplate(html, [placement.slot]);
}

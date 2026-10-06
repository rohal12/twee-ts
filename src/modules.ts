/**
 * Module/head injection into <head>.
 * Ported from module.go + io.go:modifyHead(). The renderers inject through `placeHead()` while filling the
 * format template, so the closing head tag is looked for in the template only, never in inserted story data.
 */
import { Parser } from 'parse5';
import type { DefaultTreeAdapterMap, Token } from 'parse5';
import type { Diagnostic } from './types.js';
import { normalizedFileExt, mediaTypeFromExt, fontFormatHint, slugify } from './media-types.js';
import { readUTF8, readBase64, baseNameWithoutExt } from './util.js';
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

  const family = baseNameWithoutExt(filename);
  const idSlug = `${tag}-module-${slugify(family)}`;
  const mimeType = tag === 'script' ? 'text/javascript' : 'text/css';
  const content = tag === 'script' ? scriptContentEscape(source) : styleContentEscape(source);

  return `<${tag} id="${idSlug}" type="${mimeType}">${content}</${tag}>`;
}

function loadModuleFont(filename: string): string | null {
  const source = readBase64(filename);
  const family = baseNameWithoutExt(filename);
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

/**
 * Find explicit head/body boundaries outside text, comments, attributes, inert templates and foreign CDATA.
 * Browser scripting is enabled, as required by story engines and the Vite client. Offsets address the original
 * text; parsing never serializes or repairs the template. Explicit HTML tokens remain usable in separate
 * header/footer fragments even when document tree construction would ignore them.
 */
export function scanHeadTags(html: string): HeadTags {
  const { closingHead, bodyStart } = scanTags(html);
  return { closingHead, bodyStart };
}

/** The offset after the first explicit HTML head opener outside inert template content. */
export function findHeadStartEnd(html: string): number | undefined {
  return scanTags(html).headStartEnd;
}

/**
 * parse5 owns tokenizer states and tree context. These exported callbacks are marked internal by parse5;
 * its bundled version is pinned, and fragment/template/foreign-content regression tests guard this adapter.
 * Observe HTML dispatch rather than every token: foreign tags and inert template content cannot capture
 * injection. Keeping explicit tokens (rather than only DOM node locations) preserves fragment placement.
 */
class HeadBoundaryParser extends Parser<DefaultTreeAdapterMap> {
  closingHead: number | undefined;
  bodyStart: number | undefined;
  headStartEnd: number | undefined;

  override _startTagOutsideForeignContent(token: Token.TagToken): void {
    if (this.openElements.tmplCount === 0 && token.location !== null) {
      if (token.tagName === 'head' && this.headStartEnd === undefined) this.headStartEnd = token.location.endOffset;
      if (token.tagName === 'body' && this.bodyStart === undefined) this.bodyStart = token.location.startOffset;
    }
    super._startTagOutsideForeignContent(token);
  }

  override _endTagOutsideForeignContent(token: Token.TagToken): void {
    if (
      !this.currentNotInHTML &&
      this.openElements.tmplCount === 0 &&
      token.tagName === 'head' &&
      this.closingHead === undefined
    ) {
      this.closingHead = token.location?.startOffset;
    }
    super._endTagOutsideForeignContent(token);
  }
}

function scanTags(html: string): HeadTags & { readonly headStartEnd: number | undefined } {
  const parser = new HeadBoundaryParser({ sourceCodeLocationInfo: true, scriptingEnabled: true });
  parser.tokenizer.write(html, true);
  return { closingHead: parser.closingHead, bodyStart: parser.bodyStart, headStartEnd: parser.headStartEnd };
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

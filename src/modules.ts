/**
 * Module/head injection into <head>.
 * Ported from module.go + io.go:modifyHead(). The renderers inject through `placeHead()` while filling the
 * format template, so the closing head tag is looked for in the template only, never in inserted story data.
 */
import type { Diagnostic } from './types.js';
import { normalizedFileExt, mediaTypeFromExt, fontFormatHint, slugify } from './media-types.js';
import { readUTF8, readBase64, baseNameWithoutExt } from './util.js';
import { cssStringEscape, scriptContentEscape, styleContentEscape } from './escape.js';
import { BODY_START_TAG, CLOSING_HEAD_TAG, fillTemplate } from './template.js';
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
  const found = (tag: string): boolean => texts.some((text) => new RegExp(tag).test(text));
  if (found(CLOSING_HEAD_TAG)) return { slot: beforeTag(CLOSING_HEAD_TAG, content), diagnostics: [] };
  if (found(BODY_START_TAG)) {
    const message = `${owner} has no closing head tag; the modules and head file were injected before its body start tag.`;
    return { slot: beforeTag(BODY_START_TAG, content), diagnostics: [{ level: 'warning', message }] };
  }
  const message = `${owner} has no closing head tag and no body start tag; the modules and head file were not injected.`;
  return { slot: undefined, diagnostics: [{ level: 'warning', message }] };
}

/** The slot that inserts `content` on its own line before the first match of `tag`, which is kept as written. */
function beforeTag(tag: string, content: string): TemplateSlot {
  return { pattern: tag, occurrences: 'first', replacement: (match) => `${content}\n${match}` };
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

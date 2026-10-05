/**
 * Module/head injection into <head>.
 * Ported from module.go + io.go:modifyHead(). The renderers inject through `headSlot()` while filling the
 * format template, so the closing head tag is looked for in the template only, never in inserted story data.
 */
import type { Diagnostic } from './types.js';
import { normalizedFileExt, mediaTypeFromExt, fontFormatHint, slugify } from './media-types.js';
import { readUTF8, readBase64, baseNameWithoutExt } from './util.js';
import { scriptContentEscape, styleContentEscape } from './escape.js';
import { CLOSING_HEAD_TAG, fillTemplate } from './template.js';
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

  return `<style id="${idSlug}" type="text/css">@font-face {\n\tfont-family: "${family}";\n\tsrc: url("data:${mediaType};base64,${source}") format("${hint}");\n}</style>`;
}

/**
 * Load the module tags and head file content to inject before the closing head tag, joined by newlines,
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

/**
 * The template slot that inserts `content` on its own line before the first closing head tag (as Tweego does),
 * or `undefined` when `content` is empty. The tag may use any letter case and whitespace before its `>`, and is
 * kept as written.
 */
export function headSlot(content: string): TemplateSlot | undefined {
  if (content.length === 0) return undefined;
  return { pattern: CLOSING_HEAD_TAG, occurrences: 'first', replacement: (tag) => `${content}\n${tag}` };
}

/**
 * Inject modules and head file content before the first closing head tag of `html`.
 */
export function modifyHead(html: string, modulePaths: string[], headFile?: string, diagnostics?: Diagnostic[]): string {
  const slot = headSlot(loadHeadContent(modulePaths, headFile, diagnostics));
  return slot === undefined ? html : fillTemplate(html, [slot]);
}

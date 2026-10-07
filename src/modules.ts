/**
 * Module/head injection into the head.
 * Ported from module.go + io.go:modifyHead(). The renderers inject the head content while filling the format
 * template (`fillFormatTemplate()`), so the end of the head is looked for in the template only, never in inserted
 * story data.
 */
import type { Diagnostic } from './types.js';
import { normalizedFileExt, mediaTypeFromExt, fontFormatHint, slugify } from './media-types.js';
import { readUTF8, readBase64, fileStem } from './util.js';
import { cssStringEscape, scriptContentEscape, styleContentEscape } from './escape.js';
import { codeEscapeDiagnostics, unrepresentableTextDiagnostic } from './html-output-check.js';
import { fillFormatTemplate } from './template.js';

/**
 * Load modules and return HTML tags to inject at the end of the head. `diagnostics` receives a warning for each
 * module that is not valid UTF-8 (it is read as Windows-1252), an error for text HTML cannot carry (U+0000, lone
 * surrogates), a warning for code that escaping it for its element changes (see `codeEscapeDiagnostics()`), and a
 * warning for each module whose element id another module already has (see `moduleIds()`). A caller that loads
 * the modules of one page in several calls passes the same `idFor` to each, so the ids stay unique across them.
 */
export function loadModules(
  filenames: string[],
  diagnostics?: Diagnostic[],
  idFor: ModuleIdFor = moduleIds(diagnostics),
): string {
  const processed = new Set<string>();
  const headTags: string[] = [];

  for (const filename of filenames) {
    if (processed.has(filename)) continue;

    const ext = normalizedFileExt(filename);
    let tag: string | null = null;

    switch (ext) {
      case 'css':
        tag = loadModuleTagged('style', filename, idFor, diagnostics);
        break;
      case 'js':
        tag = loadModuleTagged('script', filename, idFor, diagnostics);
        break;
      case 'otf':
      case 'ttf':
      case 'woff':
      case 'woff2':
        tag = loadModuleFont(filename, idFor);
        break;
      default:
        continue;
    }

    if (tag) headTags.push(tag);
    processed.add(filename);
  }

  return headTags.join('\n');
}

/** Gives a module element its id from the id its file stem gives (`base`), unique in the page. */
export type ModuleIdFor = (base: string, filename: string) => string;

/**
 * The ids of a page's module elements. A module gets the id its file stem gives, as in Tweego
 * (`script-module-<stem>`, `style-module-<stem>` for stylesheets and fonts). When an earlier module already has
 * that id (two files with the same stem, or stems that slugify alike), it gets the first free id of `<id>-2`,
 * `<id>-3` and so on instead, and `diagnostics` receives a warning naming both modules.
 */
export function moduleIds(diagnostics?: Diagnostic[]): ModuleIdFor {
  const owners = new Map<string, string>();
  return (base, filename) => {
    let id = base;
    for (let n = 2; owners.has(id); n++) id = `${base}-${String(n)}`;
    const first = owners.get(base);
    if (first !== undefined) {
      diagnostics?.push({
        level: 'warning',
        message: `The modules "${first}" and "${filename}" would both have the element id "${base}"; "${filename}" has the id "${id}" instead.`,
      });
    }
    owners.set(id, filename);
    return id;
  };
}

function loadModuleTagged(
  tag: 'script' | 'style',
  filename: string,
  idFor: ModuleIdFor,
  diagnostics?: Diagnostic[],
): string | null {
  const source = readUTF8(filename, diagnostics).trim();
  if (source.length === 0) return null;
  const unrepresentable = unrepresentableTextDiagnostic(`The module "${filename}"`, source);
  if (unrepresentable !== undefined) diagnostics?.push(unrepresentable);
  diagnostics?.push(
    ...codeEscapeDiagnostics(tag, { text: source, parts: [{ label: `module "${filename}"`, start: 0 }] }),
  );

  const family = fileStem(filename);
  const idSlug = idFor(`${tag}-module-${slugify(family)}`, filename);
  const mimeType = tag === 'script' ? 'text/javascript' : 'text/css';
  const content = tag === 'script' ? scriptContentEscape(source) : styleContentEscape(source);

  return `<${tag} id="${idSlug}" type="${mimeType}">${content}</${tag}>`;
}

function loadModuleFont(filename: string, idFor: ModuleIdFor): string | null {
  const source = readBase64(filename);
  const family = fileStem(filename);
  const idSlug = idFor(`style-module-${slugify(family)}`, filename);
  const ext = normalizedFileExt(filename);
  const mediaType = mediaTypeFromExt(ext);
  const hint = fontFormatHint(ext);

  return `<style id="${idSlug}" type="text/css">@font-face {\n\tfont-family: "${cssStringEscape(family)}";\n\tsrc: url("data:${mediaType};base64,${source}") format("${hint}");\n}</style>`;
}

/**
 * Load the module tags and head file content to inject into the head (see `placeHead()`), joined by newlines,
 * or `''` when there is nothing to inject.
 */
export function loadHeadContent(
  modulePaths: string[],
  headFile?: string,
  diagnostics?: Diagnostic[],
  idFor?: ModuleIdFor,
): string {
  const parts: string[] = [];

  if (modulePaths.length > 0) {
    const modules = loadModules(modulePaths, diagnostics, idFor).trim();
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
 * Inject modules and head file content into `html` the way the renderers inject it into a format template: at the
 * end of the head, found by parsing (see `fillFormatTemplate()`), adding any warning to `diagnostics`.
 */
export function modifyHead(html: string, modulePaths: string[], headFile?: string, diagnostics?: Diagnostic[]): string {
  const head = loadHeadContent(modulePaths, headFile, diagnostics);
  const filled = fillFormatTemplate({ template: html, placeholders: [], head, owner: 'The HTML' });
  diagnostics?.push(...filled.diagnostics);
  return filled.output;
}

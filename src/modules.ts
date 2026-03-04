/**
 * Module/head injection into <head>.
 * Ported from module.go + io.go:modifyHead().
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { normalizedFileExt, mediaTypeFromExt, fontFormatHint, slugify } from './media-types.js';

/** Read a file as UTF-8 with BOM stripping. */
function readUTF8(filename: string): string {
  let content = readFileSync(filename, 'utf-8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Read a file as base64. */
function readBase64(filename: string): string {
  return readFileSync(filename).toString('base64');
}

/**
 * Load modules and return HTML tags to inject before </head>.
 */
export function loadModules(filenames: string[]): string {
  const processed = new Set<string>();
  const headTags: string[] = [];

  for (const filename of filenames) {
    if (processed.has(filename)) continue;

    const ext = normalizedFileExt(filename);
    let tag: string | null = null;

    switch (ext) {
      case 'css':
        tag = loadModuleTagged('style', filename);
        break;
      case 'js':
        tag = loadModuleTagged('script', filename);
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

function loadModuleTagged(tag: string, filename: string): string | null {
  const source = readUTF8(filename).trim();
  if (source.length === 0) return null;

  const family = basename(filename).split('.')[0]!;
  const idSlug = `${tag}-module-${slugify(family)}`;
  const mimeType = tag === 'script' ? 'text/javascript' : 'text/css';

  return `<${tag} id="${idSlug}" type="${mimeType}">${source}</${tag}>`;
}

function loadModuleFont(filename: string): string | null {
  const source = readBase64(filename);
  const family = basename(filename).split('.')[0]!;
  const idSlug = `style-module-${slugify(family)}`;
  const ext = normalizedFileExt(filename);
  const mediaType = mediaTypeFromExt(ext);
  const hint = fontFormatHint(ext);

  return `<style id="${idSlug}" type="text/css">@font-face {\n\tfont-family: "${family}";\n\tsrc: url("data:${mediaType};base64,${source}") format("${hint}");\n}</style>`;
}

/**
 * Inject modules and head file content before </head>.
 */
export function modifyHead(html: string, modulePaths: string[], headFile?: string): string {
  const parts: string[] = [];

  if (modulePaths.length > 0) {
    const modules = loadModules(modulePaths).trim();
    if (modules.length > 0) parts.push(modules);
  }

  if (headFile) {
    try {
      const source = readUTF8(headFile).trim();
      if (source.length > 0) parts.push(source);
    } catch {
      // ignore missing head file
    }
  }

  if (parts.length > 0) {
    parts.push('</head>');
    return html.replace('</head>', parts.join('\n'));
  }
  return html;
}

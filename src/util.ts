/**
 * Shared file I/O utilities.
 */
import { readFileSync } from 'node:fs';
import { parse as parsePath } from 'node:path';

/** Read a file as UTF-8 with BOM stripping and line ending normalization. */
export function readUTF8(filename: string): string {
  let content = readFileSync(filename, 'utf-8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return content;
}

/** Read a file as base64. */
export function readBase64(filename: string): string {
  return readFileSync(filename).toString('base64');
}

/** Get the filename without extension, falling back to the full basename for dotfiles. */
export function baseNameWithoutExt(filename: string): string {
  const { name, ext } = parsePath(filename);
  return name || ext;
}
